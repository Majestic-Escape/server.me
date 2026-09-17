// Payment / order / refund state machine. Every transition is a conditional
// update whose filter names the state we expect to leave, so two callers
// (double click, callback + webhook, retry, two tabs) can never both apply
// the same transition; the loser simply observes the state the winner left.
//
//   Payment:  created ──▶ paid ──▶ refund initiated ──▶ refunded
//                 └──▶ failed              └──(Razorpay error)──▶ paid
//   Booking:  paymentStatus unpaid ──▶ paid ──▶ refunded
//
// Amounts are integer paise end to end (services/pricing.js).
const crypto = require("crypto");
const mongoose = require("mongoose");
const Booking = require("../models/Booking");
const Payment = require("../models/Payment");
const ListingProperty = require("../models/ListingProperty");
const { getRazorpay } = require("./razorpayClient");
const { quoteStay } = require("./pricing");
const inventory = require("./inventory");
const attention = require("./attention");

class PaymentError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

const ACCEPTED_RAZORPAY_STATUSES = new Set(["captured", "authorized"]);
const PLACEHOLDER_PREFIX = "pending_";
const PLACEHOLDER_STALE_MS = 2 * 60_000;

function orderShape(payment) {
  return {
    id: payment.orderId,
    entity: "order",
    amount: payment.amount,
    currency: payment.currency,
    receipt: `bk_${payment.bookingId}`,
    status: "created",
  };
}

function quoteShape(q) {
  return {
    nights: q.nights,
    basePrice: q.basePrice,
    subTotal: q.subTotal,
    serviceFee: q.serviceFee,
    gst: q.gst,
    total: q.total,
    totalPaise: q.totalPaise,
    currency: q.currency,
  };
}

// Fresh, server-side quote for a booking's dates against the live listing.
async function freshQuoteForBooking(booking) {
  const listing = await ListingProperty.findById(booking.propertyId).lean();
  if (!listing) throw new PaymentError(404, "LISTING_NOT_FOUND", "Listing not found");
  if (listing.status && listing.status !== "active") {
    throw new PaymentError(409, "LISTING_INACTIVE", "This stay is no longer available for booking");
  }
  const nights = inventory.nightsBetween(booking.checkIn, booking.checkOut);
  if (!nights.length) throw new PaymentError(400, "INVALID_DATES", "Booking dates are invalid");
  let quote;
  try {
    quote = quoteStay({ basePrice: listing.basePrice, nights: nights.length });
  } catch (err) {
    throw new PaymentError(409, "PRICING_UNAVAILABLE", "Pricing for this stay is unavailable right now");
  }
  return { listing, nights, quote };
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Creates (or returns the existing open) Razorpay order for a booking.
// The client's `amount` is only ever *checked*; the charged amount is the
// server quote, which must still equal the quote the booking was created
// with — otherwise PRICE_CHANGED and the customer must reconfirm.
async function createOrderForBooking({ booking, user, clientAmount, clientCurrency }) {
  if (booking.action !== "user") {
    throw new PaymentError(409, "BOOKING_NOT_PAYABLE", "This booking cannot be paid");
  }
  if (booking.status !== "pending" || booking.paymentStatus !== "unpaid") {
    throw new PaymentError(409, "BOOKING_NOT_PAYABLE", `Booking is ${booking.status} / ${booking.paymentStatus}`, {
      status: booking.status,
      paymentStatus: booking.paymentStatus,
    });
  }
  if (booking.needsAttention) {
    // Money was already captured for this booking; an admin is deciding.
    throw new PaymentError(409, "BOOKING_NOT_PAYABLE", "This booking is under review. Please contact support.", {
      status: booking.status,
      paymentStatus: booking.paymentStatus,
      needsAttention: booking.needsAttention,
    });
  }
  if (clientCurrency && clientCurrency !== "INR") {
    throw new PaymentError(400, "UNSUPPORTED_CURRENCY", "Only INR is supported");
  }
  const { nights, quote } = await freshQuoteForBooking(booking);
  // The nights must be ours before money changes hands: extend the hold, or
  // take the nights again if the hold expired (or predates the index) and
  // they are still free.
  const held = await inventory.secureHold({ propertyId: booking.propertyId, bookingId: booking._id, nights });
  if (!held.ok) {
    throw new PaymentError(409, "DATES_UNAVAILABLE", "Sorry, someone has already booked these dates");
  }
  await Booking.updateOne({ _id: booking._id }, { $set: { holdExpiresAt: inventory.holdExpiry() } });

  if (!booking.quote || booking.quote.totalPaise !== quote.totalPaise) {
    // The listing changed since the customer saw the price. Never charge the
    // old or the new figure silently: hand back the fresh quote to reconfirm.
    throw new PaymentError(409, "PRICE_CHANGED", "The price for this stay has changed. Please review and confirm again.", {
      quote: quoteShape(quote),
      confirmedTotalPaise: booking.quote ? booking.quote.totalPaise : null,
    });
  }
  if (clientAmount !== undefined && clientAmount !== null && Number(clientAmount) !== quote.totalPaise) {
    throw new PaymentError(409, "AMOUNT_MISMATCH", "Payable amount does not match the server quote", {
      quote: quoteShape(quote),
      expectedAmount: quote.totalPaise,
    });
  }

  // One open order per booking. Reuse it on retry.
  const existing = await Payment.findOne({ bookingId: booking._id, status: "created" });
  if (existing && !existing.orderId.startsWith(PLACEHOLDER_PREFIX)) {
    if (existing.amount === quote.totalPaise) {
      return { order: orderShape(existing), quote: quoteShape(quote), reused: true };
    }
    // Stale open order for a different amount (cannot happen while the price
    // is locked, but never let it be paid): retire it before creating another.
    await Payment.updateOne({ _id: existing._id, status: "created" }, { $set: { status: "failed" } });
  }

  // Take the per-booking lock (partial unique index on status: created)
  // *before* calling Razorpay so a concurrent request cannot create a second
  // Razorpay order.
  const placeholder = new Payment({
    orderId: `${PLACEHOLDER_PREFIX}${crypto.randomUUID()}`,
    amount: quote.totalPaise,
    currency: "INR",
    bookingId: booking._id,
    propertyId: booking.propertyId,
    customerDetails: {
      name: `${user.firstName || ""} ${user.lastName || ""}`.trim(),
      email: user.email,
      contact: user.phoneNumber,
    },
    status: "created",
  });
  try {
    await placeholder.save();
  } catch (err) {
    if (!inventory.isDuplicateKeyError(err)) throw err;
    // Someone else holds the lock: wait for their real order id.
    for (let i = 0; i < 10; i++) {
      await sleep(300);
      const winner = await Payment.findOne({ bookingId: booking._id, status: "created" });
      if (!winner) break; // their attempt failed and was cleaned up → retry below
      if (!winner.orderId.startsWith(PLACEHOLDER_PREFIX)) {
        return { order: orderShape(winner), quote: quoteShape(quote), reused: true };
      }
      if (Date.now() - winner.createdAt.getTime() > PLACEHOLDER_STALE_MS) {
        // Crashed mid-creation: the placeholder never got its order id.
        await Payment.deleteOne({ _id: winner._id, orderId: winner.orderId });
        break;
      }
    }
    throw new PaymentError(409, "ORDER_IN_PROGRESS", "Payment is already being set up. Please retry.");
  }

  let order;
  try {
    order = await getRazorpay().orders.create({
      amount: quote.totalPaise,
      currency: "INR",
      receipt: `bk_${booking._id}`,
      notes: { bookingId: String(booking._id), propertyId: String(booking.propertyId) },
    });
  } catch (err) {
    await Payment.deleteOne({ _id: placeholder._id });
    throw new PaymentError(502, "ORDER_FAILED", "Failed to create order");
  }
  if (order.amount !== quote.totalPaise || order.currency !== "INR") {
    await Payment.deleteOne({ _id: placeholder._id });
    throw new PaymentError(502, "ORDER_FAILED", "Payment gateway returned an unexpected order");
  }
  placeholder.orderId = order.id;
  await placeholder.save();
  return { order: orderShape(placeholder), quote: quoteShape(quote), reused: false };
}

function verifySignature({ orderId, paymentId, signature }) {
  if (!orderId || !paymentId || !signature) return false;
  const expected = crypto
    .createHmac("sha256", getRazorpay().key_secret)
    .update(`${orderId}|${paymentId}`)
    .digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(String(signature));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Records a successful Razorpay payment for an order. Idempotent: the same
// payment applied twice (callback + webhook, retries) is a no-op; a
// different payment for an already-paid order is refused.
async function applyPaymentSuccess({ orderId, razorpayPayment, paymentMethod, source }) {
  const payment = await Payment.findOne({ orderId });
  if (!payment) throw new PaymentError(404, "ORDER_NOT_FOUND", "Order not found");

  const rp = razorpayPayment;
  const mismatch =
    !rp ||
    rp.order_id !== orderId ||
    Number(rp.amount) !== payment.amount ||
    (rp.currency || "INR") !== payment.currency ||
    !ACCEPTED_RAZORPAY_STATUSES.has(rp.status);
  if (mismatch) {
    throw new PaymentError(400, "PAYMENT_MISMATCH", "Payment does not match the order", {
      expectedAmount: payment.amount,
      expectedCurrency: payment.currency,
    });
  }

  if (payment.status !== "created") {
    if (payment.status === "paid" && payment.paymentId === rp.id) {
      const booking = await Booking.findById(payment.bookingId);
      await attention.retryAlert(booking);
      return { payment, booking, alreadyProcessed: true };
    }
    throw new PaymentError(409, "PAYMENT_STATE", `Order is ${payment.status}`);
  }

  const updated = await Payment.findOneAndUpdate(
    { _id: payment._id, status: "created" },
    {
      $set: {
        status: "paid",
        paymentId: rp.id,
        paymentMethod: paymentMethod || rp.method || "unknown",
        razorpayStatus: rp.status,
        paidAt: new Date(),
      },
    },
    { new: true },
  );
  if (!updated) {
    // Lost the race to the other path (callback vs webhook).
    const current = await Payment.findById(payment._id);
    if (current && current.status === "paid" && current.paymentId === rp.id) {
      const booking = await Booking.findById(current.bookingId);
      await attention.retryAlert(booking);
      return { payment: current, booking, alreadyProcessed: true };
    }
    throw new PaymentError(409, "PAYMENT_STATE", `Order is ${current ? current.status : "unknown"}`);
  }

  const booking = await Booking.findById(updated.bookingId);
  if (!booking) throw new PaymentError(404, "BOOKING_NOT_FOUND", "Booking not found");
  const listing = await ListingProperty.findById(booking.propertyId).select("bookingType basePrice").lean();
  const manual = !!(listing && listing.bookingType && listing.bookingType.manual);
  const nextStatus = manual ? "pending" : "confirmed";
  const nights = inventory.nightsBetween(booking.checkIn, booking.checkOut);

  // The captured amount must be the server's quote for the stay. Orders
  // opened by this backend always are (create-order enforces it); an order
  // opened by the pre-S backend carries whatever the client sent, so it is
  // checked against the booking's locked quote or, failing that, a fresh
  // one. Money already captured is never refunded here: the booking is
  // queued for an admin instead of being confirmed.
  let expectedPaise = booking.quote && booking.quote.totalPaise;
  if (!Number.isFinite(expectedPaise)) {
    try {
      expectedPaise = quoteStay({ basePrice: listing && listing.basePrice, nights: nights.length }).totalPaise;
    } catch (err) {
      expectedPaise = null;
    }
  }
  if (expectedPaise === null || updated.amount !== expectedPaise) {
    await attention.flag(booking._id, "amount_mismatch", {
      orderId,
      paymentId: rp.id,
      capturedPaise: updated.amount,
      expectedPaise,
      source,
    });
    const flagged = await Booking.findById(booking._id);
    return { payment: updated, booking: flagged, alreadyProcessed: false, source, needsAttention: "amount_mismatch" };
  }

  await Booking.findOneAndUpdate(
    { _id: booking._id, paymentStatus: "unpaid" },
    {
      $set: {
        paymentStatus: "paid",
        payment: updated._id,
        status: booking.status === "pending" ? nextStatus : booking.status,
        holdExpiresAt: null,
        updatedAt: new Date(),
      },
    },
  );

  const secured = await inventory.securePermanent({ propertyId: booking.propertyId, bookingId: booking._id, nights });
  if (!secured.ok) {
    // The hold expired and another booking took some nights before this
    // payment completed. Money has been taken; never confirm silently.
    await Booking.updateOne(
      { _id: booking._id },
      { $set: { status: "pending" } },
    );
    await attention.flag(booking._id, "inventory_conflict", {
      orderId,
      paymentId: rp.id,
      source,
      takenBy: [...new Set((secured.conflicts || []).map((c) => String(c.bookingId)))],
    });
  }
  const fresh = await Booking.findById(booking._id);
  return { payment: updated, booking: fresh, alreadyProcessed: false, source };
}

// Refunds the captured pay-in of a booking exactly once (full amount, as the
// existing flows do). Returns { refunded, already, payment, refund }.
async function refundBookingPayment({ booking, reason }) {
  const bookingId = new mongoose.Types.ObjectId(String(booking._id));
  const now = new Date();
  const payment = await Payment.findOneAndUpdate(
    { bookingId, paymentType: "pay-in", status: "paid", paymentId: { $ne: null } },
    { $set: { status: "refund initiated", refundInitiatedAt: now } },
    { new: true },
  );
  if (!payment) {
    const existing = await Payment.findOne({ bookingId, paymentType: { $in: ["pay-in", "refunded"] } }).sort({ createdAt: -1 });
    if (!existing) return { refunded: false, reason: "NO_PAYMENT" };
    if (existing.status === "refunded") return { refunded: true, already: true, payment: existing };
    if (existing.status === "refund initiated") {
      throw new PaymentError(409, "REFUND_IN_PROGRESS", "A refund is already in progress for this booking");
    }
    return { refunded: false, reason: "NOT_PAID", payment: existing };
  }

  let refund;
  try {
    refund = await getRazorpay().payments.refund(payment.paymentId, {
      amount: payment.amount,
      speed: "normal",
      notes: { notes_key_1: "Full Refund", reason: reason || "" },
      receipt: `Refund No. ${bookingId}`,
    });
    if (!refund || !refund.id) throw new Error("empty refund response");
  } catch (err) {
    // Nothing left the gateway: put the payment back so it can be retried.
    await Payment.updateOne(
      { _id: payment._id, status: "refund initiated" },
      { $set: { status: "paid", refundInitiatedAt: null } },
    );
    throw new PaymentError(502, "REFUND_FAILED", "Payment refund failed", {
      gateway: err.error || err.message,
    });
  }

  const finalize = () =>
    Payment.updateOne(
      { _id: payment._id, status: "refund initiated" },
      {
        $set: {
          status: "refunded",
          paymentType: "refunded",
          refundId: refund.id,
          refundAmount: refund.amount,
          refundedAt: new Date(),
        },
      },
    );
  try {
    await finalize();
  } catch (err) {
    // Money has been refunded at the gateway; the local record must follow.
    console.error("[payments] CRITICAL refund recorded at gateway but not in DB; retrying", {
      bookingId: String(bookingId),
      paymentId: payment.paymentId,
      refundId: refund.id,
    });
    await finalize();
  }
  await Booking.updateOne(
    { _id: bookingId },
    { $set: { paymentStatus: "refunded", refundAmount: refund.amount / 100, updatedAt: new Date() } },
  );
  return { refunded: true, already: false, payment, refund };
}

module.exports = {
  PaymentError,
  createOrderForBooking,
  verifySignature,
  applyPaymentSuccess,
  refundBookingPayment,
  freshQuoteForBooking,
  quoteShape,
};

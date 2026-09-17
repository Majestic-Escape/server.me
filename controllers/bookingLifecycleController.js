// Booking lifecycle with the server as the authority (Batch S).
//
// Replaces the old createBooking / markBookingAsPaid / confirm* / cancel* /
// terminate* / update / delete / unblock handlers in bookingController.js.
// Nothing financial or inventory-related is taken from the request body:
// identity comes from the token, price from services/pricing.js, nights from
// the validated dates, availability from services/inventory.js, and every
// status change is a conditional update.
const mongoose = require("mongoose");
const Booking = require("../models/Booking");
const Payment = require("../models/Payment");
const ListingProperty = require("../models/ListingProperty");
const inventory = require("../services/inventory");
const { quoteStay, zeroQuote } = require("../services/pricing");
const { refundBookingPayment, PaymentError } = require("../services/payments");
const notify = require("../services/bookingNotifications");
const attention = require("../services/attention");
const authz = require("../middleware/authz");
const { isObjectId, rejectInvalidId } = require("../middleware/validateObjectId");

// Product limits are OFF unless configured: neither the pre-S backend nor the
// booking calendar (which only disables past and taken dates) ever limited
// stay length or how far ahead a stay may start, and introducing such a rule
// is a business decision, not a hardening step. MAX_BOOKING_NIGHTS /
// MAX_BOOKING_HORIZON_DAYS enable a limit when set (> 0). What always
// applies is the abuse ceiling below: one request cannot hold more than a
// year of nights (the same cap host calendar blocks already have).
const MAX_BOOKING_NIGHTS = Number(process.env.MAX_BOOKING_NIGHTS) || 0;
const MAX_BOOKING_HORIZON_DAYS = Number(process.env.MAX_BOOKING_HORIZON_DAYS) || 0;
const ABUSE_MAX_NIGHTS = 366;
const MAX_GUEST_ROWS = 50;
const POPULATE = "userId hostId propertyId payment";
const TERMINAL = ["rejected", "cancelled"];

const moderateSeconds = Number(process.env.MODERATE_POLICY_DAYS) * 24 * 60 * 60;
const flexibleSeconds = Number(process.env.FLEXIBLE_POLICY_DAYS) * 60 * 60; // (hours — unchanged)

function fail(res, status, code, message, extra = {}) {
  return res.status(status).json({ success: false, code, message, statusCode: status, ...extra });
}
function handleError(res, err, fallback = "Request failed") {
  if (err instanceof PaymentError) return fail(res, err.status, err.code, err.message, err.extra);
  console.error(fallback, err);
  return fail(res, 500, "SERVER_ERROR", fallback);
}
function nonNegInt(v, fallback = 0) {
  if (v === undefined || v === null || v === "") return fallback;
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 ? n : null;
}
// Same rule the old checkout applied client-side: the first policy flag that
// is true, in the order the listing stores them (moderate is the default).
function policyFromListing(listing) {
  const ct = listing.cancellationType || {};
  const hit = Object.entries(ct).find(([key, v]) => v === true && ["strict", "moderate", "flexible"].includes(key));
  return hit ? hit[0] : "moderate";
}
function sanitizeGuestData(raw) {
  const clean = { adults: [], children: [] };
  if (!raw || typeof raw !== "object") return clean;
  for (const key of ["adults", "children"]) {
    const rows = Array.isArray(raw[key]) ? raw[key].slice(0, MAX_GUEST_ROWS) : [];
    clean[key] = rows
      .filter((r) => r && typeof r.name === "string" && r.name.trim())
      .map((r) => ({ name: String(r.name).trim().slice(0, 120), age: Number.isFinite(Number(r.age)) ? Number(r.age) : undefined }));
  }
  return clean;
}

// Validates and normalises the stay window. Instants are kept as sent (the
// wire format every reader already uses); nights come from the UTC days.
function validateStay(checkIn, checkOut, { forBlock = false } = {}) {
  const inDate = new Date(checkIn);
  const outDate = new Date(checkOut);
  if (Number.isNaN(inDate.getTime()) || Number.isNaN(outDate.getTime())) {
    return { error: "Invalid date format" };
  }
  const nights = inventory.nightsBetween(inDate, outDate);
  if (!nights.length) return { error: "checkIn must be earlier than checkOut" };
  if (nights.length > ABUSE_MAX_NIGHTS) return { error: "Stays and blocks are limited to one year" };
  if (!forBlock) {
    const today = inventory.utcDay(new Date());
    // The calendar already refuses past dates; the server allows one day of
    // grace so a same-day check-in chosen west of UTC is not "yesterday".
    if (nights[0].getTime() < today.getTime() - inventory.DAY_MS) return { error: "checkIn cannot be in the past" };
    if (MAX_BOOKING_NIGHTS > 0 && nights.length > MAX_BOOKING_NIGHTS) {
      return { error: `Stays are limited to ${MAX_BOOKING_NIGHTS} nights` };
    }
    if (MAX_BOOKING_HORIZON_DAYS > 0 && (nights[0] - today) / inventory.DAY_MS > MAX_BOOKING_HORIZON_DAYS) {
      return { error: `Bookings can be made up to ${MAX_BOOKING_HORIZON_DAYS} days ahead` };
    }
  }
  return { inDate, outDate, nights };
}

async function loadBooking(res, bookingId, populate = POPULATE) {
  if (!isObjectId(bookingId)) {
    fail(res, 400, "INVALID_ID", "Invalid bookingId");
    return null;
  }
  const booking = await Booking.findById(bookingId).populate(populate);
  if (!booking) {
    fail(res, 404, "BOOKING_NOT_FOUND", "Booking not found");
    return null;
  }
  return booking;
}

// ---------------------------------------------------------------------------
// POST /booking/   (guest booking, or host calendar block with action: "host")
// ---------------------------------------------------------------------------
exports.createBooking = async (req, res) => {
  try {
    const actor = await authz.resolveActor(req);
    if (!actor || actor.kind !== "user" || !actor.user) return fail(res, 403, "FORBIDDEN", "Only signed-in users can book");
    const body = req.body || {};
    const { propertyId, checkIn, checkOut } = body;
    if (!propertyId || !checkIn || !checkOut) {
      return fail(res, 400, "VALIDATION", "propertyId, checkIn and checkOut are required");
    }
    if (rejectInvalidId(res, propertyId, "propertyId")) return;
    const listing = await ListingProperty.findById(propertyId).lean();
    if (!listing) return fail(res, 404, "LISTING_NOT_FOUND", "Listing not found");
    if (!listing.host) return fail(res, 409, "LISTING_INACTIVE", "This stay is not bookable");

    const isHostBlock = body.action === "host";
    if (isHostBlock && !authz.isListingHost(actor, listing)) {
      return fail(res, 403, "FORBIDDEN", "Only the listing's host can block dates");
    }
    if (!isHostBlock && listing.status !== "active") {
      return fail(res, 409, "LISTING_INACTIVE", "This stay is no longer available for booking");
    }

    const stay = validateStay(checkIn, checkOut, { forBlock: isHostBlock });
    if (stay.error) return fail(res, 400, "INVALID_DATES", stay.error);
    const { inDate, outDate, nights } = stay;

    // Guests (blocks carry the fixed 1/0/0 the calendar sends).
    const adults = isHostBlock ? 1 : nonNegInt(body.adults, null);
    const children = isHostBlock ? 0 : nonNegInt(body.children, 0);
    const infants = isHostBlock ? 0 : nonNegInt(body.infants, 0);
    if (adults === null || adults < 1 || children === null || infants === null) {
      return fail(res, 400, "INVALID_GUESTS", "adults must be at least 1; children and infants must be whole numbers");
    }
    const capacity = Number(listing.guests);
    if (!isHostBlock && Number.isFinite(capacity) && capacity > 0 && adults + children > capacity) {
      return fail(res, 400, "OVER_CAPACITY", `This stay allows up to ${capacity} guests`);
    }

    // Authoritative price.
    let quote;
    if (isHostBlock) {
      quote = zeroQuote(nights.length);
    } else {
      try {
        quote = quoteStay({ basePrice: listing.basePrice, nights: nights.length });
      } catch (err) {
        return fail(res, 409, "PRICING_UNAVAILABLE", "Pricing for this stay is unavailable right now");
      }
    }

    // Optional idempotency key: an exact replay returns the same booking.
    const idemKey = typeof req.headers["idempotency-key"] === "string" ? req.headers["idempotency-key"].slice(0, 200) : undefined;
    if (idemKey) {
      const replay = await Booking.findOne({ idempotencyKey: `${actor.id}:${idemKey}` });
      if (replay) return res.status(200).json({ success: true, data: replay, replayed: true });
    }

    const bookingId = new mongoose.Types.ObjectId();
    const reserved = await inventory.reserveNights({
      propertyId: listing._id,
      nights,
      bookingId,
      kind: isHostBlock ? "block" : "booking",
    });
    if (!reserved.ok) {
      // Same user, same dates, still-open hold → idempotent double submit.
      if (!isHostBlock) {
        const ownerIds = [...new Set(reserved.conflicts.map((c) => String(c.bookingId)))];
        const own = await Booking.findOne({
          _id: { $in: ownerIds },
          userId: actor.id,
          propertyId: listing._id,
          checkIn: inDate,
          checkOut: outDate,
          status: "pending",
          paymentStatus: "unpaid",
          holdExpiresAt: { $gt: new Date() },
        });
        if (own) {
          // The listing may have been repriced since the first submit (the
          // client re-quoted and the customer confirmed the new figure). An
          // unpaid hold is moved to the fresh quote; create-order still
          // verifies the client's amount against it, so nothing unseen is
          // ever charged.
          if (!own.quote || own.quote.totalPaise !== quote.totalPaise) {
            await Booking.updateOne(
              { _id: own._id, status: "pending", paymentStatus: "unpaid" },
              {
                $set: {
                  price: quote.total,
                  subTotal: quote.subTotal,
                  quote: {
                    basePrice: quote.basePrice,
                    nights: quote.nights,
                    subTotalPaise: quote.subTotalPaise,
                    serviceFeePaise: quote.serviceFeePaise,
                    gstPaise: quote.gstPaise,
                    totalPaise: quote.totalPaise,
                    currency: "INR",
                  },
                  updatedAt: new Date(),
                },
              },
            );
            const repriced = await Booking.findById(own._id);
            return res.status(200).json({ success: true, data: repriced, replayed: true, repriced: true });
          }
          return res.status(200).json({ success: true, data: own, replayed: true });
        }
      }
      return fail(res, 409, "DATES_UNAVAILABLE", "Selected dates overlap with an existing booking");
    }

    // Secondary check for legacy rows that predate the night index.
    const legacyOverlap = await Booking.exists({
      propertyId: listing._id,
      status: { $nin: TERMINAL },
      paymentStatus: "paid",
      checkIn: { $lt: outDate },
      checkOut: { $gt: inDate },
    });
    if (legacyOverlap) {
      await inventory.releaseNights(bookingId);
      return fail(res, 409, "DATES_UNAVAILABLE", "Selected dates overlap with an existing booking");
    }

    const booking = new Booking({
      _id: bookingId,
      userId: actor.id,
      hostId: listing.host,
      propertyId: listing._id,
      source: "local",
      action: isHostBlock ? "host" : "user",
      checkIn: inDate,
      checkOut: outDate,
      nights: nights.length,
      guests: adults + children,
      adults,
      children,
      infants,
      guestData: sanitizeGuestData(body.guestData),
      price: quote.total,
      subTotal: quote.subTotal,
      currency: "INR",
      cancellationPolicy: policyFromListing(listing),
      status: isHostBlock ? "confirmed" : "pending",
      paymentStatus: isHostBlock ? "paid" : "unpaid",
      quote: {
        basePrice: quote.basePrice,
        nights: quote.nights,
        subTotalPaise: quote.subTotalPaise,
        serviceFeePaise: quote.serviceFeePaise,
        gstPaise: quote.gstPaise,
        totalPaise: quote.totalPaise,
        currency: "INR",
      },
      holdExpiresAt: isHostBlock ? null : inventory.holdExpiry(),
      idempotencyKey: idemKey ? `${actor.id}:${idemKey}` : undefined,
    });
    try {
      await booking.save();
    } catch (err) {
      await inventory.releaseNights(bookingId);
      if (inventory.isDuplicateKeyError(err) && idemKey) {
        const replay = await Booking.findOne({ idempotencyKey: `${actor.id}:${idemKey}` });
        if (replay) return res.status(200).json({ success: true, data: replay, replayed: true });
      }
      throw err;
    }
    // A host block may target a pending listing, which an admin may be
    // deleting at this very moment (Batch A2). The delete's blocker check
    // cannot see an insert that lands after its snapshot, so the block
    // re-checks the listing and undoes itself if the listing is gone; the
    // delete's post-commit sweep covers the remaining interleavings.
    if (isHostBlock) {
      const stillThere = await ListingProperty.exists({ _id: listing._id });
      if (!stillThere) {
        await Booking.deleteOne({ _id: booking._id });
        await inventory.releaseNights(booking._id);
        return fail(res, 404, "LISTING_NOT_FOUND", "Listing not found");
      }
    }
    return res.status(201).json({ success: true, data: booking });
  } catch (err) {
    return handleError(res, err, "createBooking error");
  }
};

// ---------------------------------------------------------------------------
// POST /booking/updateStatus  — legacy client call after payment.
// The payment itself is recorded by /payment/verify-payment (or the webhook);
// this endpoint only sends the notifications, once.
// ---------------------------------------------------------------------------
exports.markBookingAsPaid = async (req, res) => {
  try {
    const actor = await authz.resolveActor(req);
    const booking = await loadBooking(res, req.body.bookingId);
    if (!booking) return;
    if (!(authz.isBookingGuest(actor, booking) || authz.isAdmin(actor))) return authz.forbid(res);
    if (booking.needsAttention) {
      return fail(res, 409, "UNDER_REVIEW", "Payment received; the booking is being reviewed by our team", { needsAttention: booking.needsAttention });
    }
    if (booking.paymentStatus !== "paid") {
      return fail(res, 409, "PAYMENT_NOT_RECORDED", "Payment has not been verified for this booking");
    }
    const sent = await sendPaidNotifications(booking);
    if (sent.error === "PAYMENT_NOT_FOUND") return fail(res, 404, "PAYMENT_NOT_FOUND", "Payment not found");
    if (sent.error) return fail(res, 502, "NOTIFY_FAILED", "Booking is paid but notifications could not be sent");
    return res.status(200).json({ success: true, data: booking, alreadyNotified: !!sent.alreadyNotified });
  } catch (err) {
    return handleError(res, err, "markBookingAsPaid error");
  }
};

// The post-payment e-mails (host/admins/guest, invoice) exactly once.
async function sendPaidNotifications(booking) {
  const payment = booking.payment || (await Payment.findOne({ bookingId: booking._id, status: { $in: ["paid", "refund initiated", "refunded"] } }));
  if (!payment) return { error: "PAYMENT_NOT_FOUND" };
  const claimed = await Booking.findOneAndUpdate(
    { _id: booking._id, "notifications.paidAt": null },
    { $set: { "notifications.paidAt": new Date() } },
  );
  if (!claimed) return { alreadyNotified: true };
  const manual = !!(booking.propertyId && booking.propertyId.bookingType && booking.propertyId.bookingType.manual);
  try {
    await notify.notifyPaid(booking, payment, { manual });
  } catch (err) {
    console.error("notifyPaid failed", err.message);
    await Booking.updateOne({ _id: booking._id }, { $set: { "notifications.paidAt": null } });
    return { error: "NOTIFY_FAILED" };
  }
  return { sent: true };
}

// PATCH /booking/instant/confirm — legacy client call; confirmation itself
// happened at payment for instant-book listings. Only schedules reminders once.
exports.confirmInstantBooking = async (req, res) => {
  try {
    const actor = await authz.resolveActor(req);
    const booking = await loadBooking(res, req.body.bookingId);
    if (!booking) return;
    if (!(authz.isBookingGuest(actor, booking) || authz.isAdmin(actor))) return authz.forbid(res);
    if (booking.needsAttention) return fail(res, 409, "UNDER_REVIEW", "Payment received; the booking is being reviewed by our team", { needsAttention: booking.needsAttention });
    if (booking.paymentStatus !== "paid") return fail(res, 409, "PAYMENT_NOT_RECORDED", "Payment has not been verified for this booking");
    if (booking.status !== "confirmed") return fail(res, 409, "NOT_CONFIRMED", "This booking requires host approval");
    const claimed = await Booking.findOneAndUpdate(
      { _id: booking._id, "notifications.confirmedAt": null },
      { $set: { "notifications.confirmedAt": new Date() } },
    );
    if (claimed) {
      try {
        await notify.notifyInstantConfirmed(booking);
      } catch (err) {
        console.error("notifyInstantConfirmed failed", err.message);
      }
    }
    return res.status(200).json({ success: true });
  } catch (err) {
    return handleError(res, err, "confirmInstantBooking error");
  }
};

// PATCH /booking/host/confirm — host approves a paid, manual booking.
exports.confirmBooking = async (req, res) => {
  try {
    const actor = await authz.resolveActor(req);
    const booking = await loadBooking(res, req.body.bookingId);
    if (!booking) return;
    if (!(authz.isBookingHost(actor, booking) || authz.isAdmin(actor))) return authz.forbid(res);
    if (booking.needsAttention) return fail(res, 409, "UNDER_REVIEW", "This booking is being reviewed by the Majestic Escape team", { needsAttention: booking.needsAttention });
    if (booking.paymentStatus !== "paid") return fail(res, 409, "PAYMENT_NOT_RECORDED", "Booking is not paid");
    if (booking.status === "confirmed") return res.status(200).json({ success: true, alreadyConfirmed: true });
    const updated = await Booking.findOneAndUpdate(
      { _id: booking._id, status: "pending", paymentStatus: "paid" },
      { $set: { status: "confirmed", updatedAt: new Date() } },
      { new: true },
    ).populate(POPULATE);
    if (!updated) return fail(res, 409, "INVALID_TRANSITION", `Cannot confirm a ${booking.status} booking`);
    const payment = updated.payment || (await Payment.findOne({ bookingId: updated._id, status: { $in: ["paid", "refund initiated", "refunded"] } }));
    if (!payment) return fail(res, 404, "PAYMENT_NOT_FOUND", "Payment not found");
    const claimed = await Booking.findOneAndUpdate(
      { _id: updated._id, "notifications.confirmedAt": null },
      { $set: { "notifications.confirmedAt": new Date() } },
    );
    if (claimed) {
      try {
        await notify.notifyHostConfirmed(updated, payment);
      } catch (err) {
        console.error("notifyHostConfirmed failed", err.message);
      }
    }
    return res.status(200).json({ success: true });
  } catch (err) {
    return handleError(res, err, "confirmBooking error");
  }
};

// Shared cancellation core: authorise → (refund) → conditional status change
// → release nights → notify. A refund failure leaves the booking untouched.
async function cancelCore({ req, res, bookingId, allowed, nextStatus, refund, notifyFn, label }) {
  const actor = await authz.resolveActor(req);
  const booking = await loadBooking(res, bookingId);
  if (!booking) return;
  if (!allowed(actor, booking)) return authz.forbid(res);
  if (TERMINAL.includes(booking.status)) {
    return fail(res, 409, "ALREADY_CLOSED", `Booking is already ${booking.status}`);
  }
  let refundResult = { refunded: false };
  const shouldRefund = typeof refund === "function" ? refund(booking) : !!refund;
  // The refund is driven by the captured payment row, not by the booking's
  // paymentStatus: a booking parked in the attention queue (money captured,
  // booking not marked paid) must still be refundable through admin cancel.
  if (shouldRefund && (booking.paymentStatus === "paid" || booking.needsAttention)) {
    refundResult = await refundBookingPayment({ booking, reason: label }); // throws PaymentError on gateway failure
  }
  const closeSet = { status: nextStatus, holdExpiresAt: null, updatedAt: new Date() };
  if (booking.needsAttention) {
    closeSet.needsAttention = null;
    closeSet.attentionResolvedAt = new Date();
    closeSet.attentionResolution = `${label} by ${actor.id}`;
  }
  const updated = await Booking.findOneAndUpdate(
    { _id: booking._id, status: { $nin: TERMINAL } },
    { $set: closeSet },
    { new: true },
  ).populate(POPULATE);
  if (!updated) return fail(res, 409, "ALREADY_CLOSED", "Booking was closed by another request");
  await inventory.releaseNights(updated._id);
  try {
    await notifyFn(updated);
  } catch (err) {
    console.error(`${label}: notifications failed`, err.message);
  }
  return res.status(200).json({
    success: true,
    message: refundResult.refunded ? "Refund issued and booking terminated" : "Booking cancelled without refund",
    refunded: !!refundResult.refunded,
    data: updated,
  });
}

// PATCH /booking/host/cancel — host rejects (full refund)
exports.cancelBooking = (req, res) =>
  cancelCore({
    req, res, bookingId: req.body.bookingId, nextStatus: "rejected", refund: true, label: "host-reject",
    allowed: (a, b) => authz.isBookingHost(a, b) || authz.isAdmin(a),
    notifyFn: notify.notifyHostRejected,
  }).catch((err) => handleError(res, err, "cancelBooking error"));

// PATCH /booking/admin/cancel — admin cancels (full refund)
exports.cancelAdminBooking = (req, res) =>
  cancelCore({
    req, res, bookingId: req.body.bookingId, nextStatus: "cancelled", refund: true, label: "admin-cancel",
    allowed: (a) => authz.isAdmin(a),
    notifyFn: notify.notifyAdminCancelled,
  }).catch((err) => handleError(res, err, "cancelAdminBooking error"));

// PATCH /booking/host/terminate — host cancels a confirmed stay (full refund)
exports.terminateBooking = (req, res) =>
  cancelCore({
    req, res, bookingId: req.body.bookingId, nextStatus: "cancelled", refund: true, label: "host-terminate",
    allowed: (a, b) => authz.isBookingHost(a, b) || authz.isAdmin(a),
    notifyFn: notify.notifyHostTerminated,
  }).catch((err) => handleError(res, err, "terminateBooking error"));

// PATCH /booking/user/terminate — guest cancels; refund only inside the
// policy window (unchanged rule: moderate = days, flexible = hours).
exports.terminateUserBooking = (req, res) =>
  cancelCore({
    req, res, bookingId: req.body.bookingId, nextStatus: "cancelled", label: "user-terminate",
    allowed: (a, b) => authz.isBookingGuest(a, b) || authz.isAdmin(a),
    refund: (booking) => {
      const secondsToCheckIn = (new Date(booking.checkIn) - new Date()) / 1000;
      return (
        (booking.cancellationPolicy === "moderate" && secondsToCheckIn >= moderateSeconds) ||
        (booking.cancellationPolicy === "flexible" && secondsToCheckIn >= flexibleSeconds)
      );
    },
    notifyFn: notify.notifyUserTerminated,
  }).catch((err) => handleError(res, err, "terminateUserBooking error"));

// POST /booking/unblock-dates/:propertyId — host removes a calendar block.
exports.unblockDates = async (req, res) => {
  try {
    const actor = await authz.resolveActor(req);
    const { propertyId } = req.params;
    const { selectedDate } = req.body || {};
    const listing = await ListingProperty.findById(propertyId).select("host").lean();
    if (!listing) return fail(res, 404, "LISTING_NOT_FOUND", "Listing not found");
    if (!(authz.isListingHost(actor, listing) || authz.isAdmin(actor))) return authz.forbid(res);
    const day = inventory.utcDay(selectedDate);
    if (!day) return fail(res, 400, "INVALID_DATES", "Invalid date");
    const to = new Date(day.getTime() + inventory.DAY_MS);
    const block = await Booking.findOne({
      propertyId,
      source: "local",
      action: "host",
      status: { $nin: TERMINAL },
      checkIn: { $lt: to },
      checkOut: { $gt: day },
    });
    if (!block) return fail(res, 404, "NOT_FOUND", "No booking found for that date");
    const unblock = await Booking.findOneAndUpdate(
      { _id: block._id, status: { $nin: TERMINAL } },
      { $set: { status: "cancelled", updatedAt: new Date() } },
      { new: true },
    );
    await inventory.releaseNights(block._id);
    return res.json({ success: true, data: unblock });
  } catch (err) {
    return handleError(res, err, "unblockDates error");
  }
};

// PUT /booking/:bookingId — admin-only, whitelisted guest details.
exports.updateBooking = async (req, res) => {
  try {
    const actor = await authz.resolveActor(req);
    if (!authz.isAdmin(actor)) return authz.forbid(res, "Admin access required");
    if (rejectInvalidId(res, req.params.bookingId, "bookingId")) return;
    const patch = {};
    for (const key of ["adults", "children", "infants"]) {
      if (req.body[key] !== undefined) {
        const n = nonNegInt(req.body[key], null);
        if (n === null) return fail(res, 400, "VALIDATION", `${key} must be a whole number`);
        patch[key] = n;
      }
    }
    if (patch.adults !== undefined || patch.children !== undefined) {
      const current = await Booking.findById(req.params.bookingId).select("adults children").lean();
      if (!current) return fail(res, 404, "BOOKING_NOT_FOUND", "Booking not found");
      patch.guests = (patch.adults ?? current.adults ?? 0) + (patch.children ?? current.children ?? 0);
    }
    if (req.body.guestData !== undefined) patch.guestData = sanitizeGuestData(req.body.guestData);
    if (typeof req.body.flag === "boolean") patch.flag = req.body.flag;
    patch.updatedAt = new Date();
    const booking = await Booking.findByIdAndUpdate(req.params.bookingId, { $set: patch }, { new: true });
    if (!booking) return fail(res, 404, "BOOKING_NOT_FOUND", "Booking not found");
    return res.status(200).json({ success: true, data: booking });
  } catch (err) {
    return handleError(res, err, "updateBooking error");
  }
};

// DELETE /booking/:bookingId — admin-only; paid bookings must be refunded first.
exports.deleteBooking = async (req, res) => {
  try {
    const actor = await authz.resolveActor(req);
    if (!authz.isAdmin(actor)) return authz.forbid(res, "Admin access required");
    if (rejectInvalidId(res, req.params.bookingId, "bookingId")) return;
    const booking = await Booking.findById(req.params.bookingId);
    if (!booking) return fail(res, 404, "BOOKING_NOT_FOUND", "Booking not found");
    if (booking.paymentStatus === "paid" && booking.action === "user") {
      return fail(res, 409, "PAID_BOOKING", "Refund/cancel the booking before deleting it");
    }
    await Booking.deleteOne({ _id: booking._id });
    await inventory.releaseNights(booking._id);
    return res.status(200).json({ success: true, message: "Booking deleted successfully" });
  } catch (err) {
    return handleError(res, err, "deleteBooking error");
  }
};

// PATCH /booking/modal-close — guest dismissed the payment modal. No-op on
// the record (it never changed anything), kept for client compatibility.
exports.updateCloseModal = async (req, res) => {
  try {
    const actor = await authz.resolveActor(req);
    const booking = await loadBooking(res, req.body.bookingId, "");
    if (!booking) return;
    if (!(authz.isBookingGuest(actor, booking) || authz.isAdmin(actor))) return authz.forbid(res);
    return res.json({ success: true, data: booking });
  } catch (err) {
    return handleError(res, err, "updateCloseModal error");
  }
};

// GET /booking/:bookingId — guest, host or admin of that booking.
exports.getBookingById = async (req, res) => {
  try {
    const actor = await authz.resolveActor(req);
    const booking = await loadBooking(res, req.params.bookingId);
    if (!booking) return;
    if (!(authz.isBookingGuest(actor, booking) || authz.isBookingHost(actor, booking) || authz.isAdmin(actor))) {
      return authz.forbid(res);
    }
    return res.status(200).json({ success: true, data: booking });
  } catch (err) {
    return handleError(res, err, "getBookingById error");
  }
};

// GET /booking/admin/attention — the operational queue (admin only).
exports.listAttention = async (req, res) => {
  try {
    const actor = await authz.resolveActor(req);
    if (!authz.isAdmin(actor)) return authz.forbid(res, "Admin access required");
    const items = await attention.list();
    return res.status(200).json({ success: true, count: items.length, data: items });
  } catch (err) {
    return handleError(res, err, "listAttention error");
  }
};

// PATCH /booking/admin/attention/resolve { bookingId, resolution: "keep" | "dismiss" }
// "keep" re-secures the nights and restores the paid status; "dismiss" only
// clears the flag (the admin acted otherwise, e.g. refunded via admin cancel).
exports.resolveAttention = async (req, res) => {
  try {
    const actor = await authz.resolveActor(req);
    if (!authz.isAdmin(actor)) return authz.forbid(res, "Admin access required");
    const booking = await loadBooking(res, req.body.bookingId, "propertyId");
    if (!booking) return;
    if (!["keep", "dismiss"].includes(req.body.resolution)) {
      return fail(res, 400, "VALIDATION", 'resolution must be "keep" or "dismiss"');
    }
    const manualListing = !!(booking.propertyId && booking.propertyId.bookingType && booking.propertyId.bookingType.manual);
    const result = await attention.resolve({ booking, resolution: req.body.resolution, manualListing, actorId: actor.id });
    if (!result.ok) return fail(res, result.code === "DATES_UNAVAILABLE" ? 409 : 400, result.code, result.code === "DATES_UNAVAILABLE" ? "The nights are still taken by another booking" : "Invalid resolution");
    const fresh = await Booking.findById(booking._id).populate(POPULATE);
    if (result.resolution === "keep") {
      // The booking now stands as a normally paid one: send the post-payment
      // e-mails it never got (once); the usual instant/host flow then applies.
      const sent = await sendPaidNotifications(fresh);
      if (sent.error) console.error("resolveAttention: notifications failed", sent.error);
    }
    return res.status(200).json({ success: true, data: fresh, ...result });
  } catch (err) {
    return handleError(res, err, "resolveAttention error");
  }
};

module.exports.validateStay = validateStay;
module.exports.MAX_BOOKING_NIGHTS = MAX_BOOKING_NIGHTS;

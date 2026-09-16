// controllers/paymentController.js
const Razorpay = require("razorpay");
const crypto = require("crypto");
const Payment = require("../models/Payment");
const User = require("../models/User");
const Booking = require("../models/Booking");
const { parseMDYToUTC } = require("../utils/convertDate");
const BankDetail = require("../models/BankDetail");
const axios = require("axios");
const cron = require("node-cron");

const { generateUniqueString } = require("../utils/generateString");
const HostPayout = require("../models/HostPayout");
const Configure = require("../models/Configure");
const { getRazorpay } = require("../services/razorpayClient");
const {
  PaymentError,
  createOrderForBooking,
  verifySignature,
  applyPaymentSuccess,
} = require("../services/payments");
const authz = require("../middleware/authz");
const { isObjectId } = require("../middleware/validateObjectId");
const razorpay = getRazorpay();


const auth = Buffer.from(
  `${razorpay.key_id.trim()}:${razorpay.key_secret.trim()}`,
).toString("base64");
const API_URL = process.env.RAZORPAY_API;
const ADMIN_ACCOUNT = process.env.ADMIN_ACCOUNT;
// helper: parse "MM/DD/YYYY" or "M/D/YYYY"

// Usage in your route:

exports.fetch = async (req, res) => {
  try {
    const { paymentType, search, searchList, from, to } = req.query;
    const date = parseMDYToUTC(from, to);

    if (process.env.NEXT_PUBLIC_ENV === "dev") {
      console.log(date.from, date.to);
    }

    const filter = {};
    if (paymentType && paymentType != "all") {
      filter.paymentType = paymentType;
    }

    if (from && !to) {
      // only from date given
      filter.createdAt = { $gte: date.from };
    } else if (from && to) {
      // both from and to date given
      filter.createdAt = {
        $gte: date.from,
        $lte: date.to,
      };
    }

    let data;
    if (!searchList) {
      data = await Payment.find(filter).populate("propertyId");
    }
    if (searchList) {
      if (searchList == "date-desc") {
        data = await Payment.find(filter)
          .populate("propertyId")
          .sort({ createdAt: -1 });
      } else if (searchList == "date-asc") {
        data = await Payment.find(filter)
          .populate("propertyId")
          .sort({ createdAt: 1 });
      } else if (searchList == "amount-desc") {
        data = await Payment.find(filter)
          .populate("propertyId")
          .sort({ amount: -1 });
      } else {
        data = await Payment.find(filter)
          .populate("propertyId")
          .sort({ amount: 1 });
      }
    }

    if (!data) {
      return res.status(400).json({
        success: false,
        error: "Payment data not available",
      });
    }
    if (search) {
      data = data.filter(
        (b) =>
          b.propertyId.title.toLowerCase().includes(search.toLowerCase()) ||
          b.paymentId.toLowerCase().includes(search.toLowerCase()) ||
          b.customerDetails.name.toLowerCase().includes(search.toLowerCase()),
      );
    }

    res.json({
      success: true,
      data: data,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: "Failed to create order",
    });
  }
};
// Create a new order — Batch S: the amount is the server quote, never the
// client's; one open order per booking; the caller must own the booking.
exports.createOrder = async (req, res) => {
  try {
    const actor = await authz.resolveActor(req);
    if (!actor || actor.kind !== "user" || !actor.user) {
      return res.status(403).json({ success: false, code: "FORBIDDEN", error: "Only the booking's guest can pay" });
    }
    const { bookingId, currency, amount } = req.body || {};
    if (!isObjectId(String(bookingId))) {
      return res.status(400).json({ success: false, code: "INVALID_ID", error: "Invalid bookingId" });
    }
    const booking = await Booking.findById(bookingId);
    if (!booking) return res.status(404).json({ success: false, code: "BOOKING_NOT_FOUND", error: "Booking not found" });
    if (!authz.isBookingGuest(actor, booking)) {
      return res.status(403).json({ success: false, code: "FORBIDDEN", error: "Only the booking's guest can pay" });
    }
    const { order, quote, reused } = await createOrderForBooking({
      booking,
      user: actor.user,
      clientAmount: amount,
      clientCurrency: currency,
    });
    return res.json({ success: true, data: order, quote, reused });
  } catch (error) {
    if (error instanceof PaymentError) {
      return res.status(error.status).json({ success: false, code: error.code, error: error.message, ...error.extra });
    }
    console.error("Create order error:", error);
    return res.status(500).json({ success: false, error: "Failed to create order" });
  }
};

// Verify payment — Batch S: signature + Razorpay-side amount/order/currency/
// status checks, then idempotent conditional transitions. The booking is
// marked paid here (and confirmed for instant-book listings); the legacy
// /booking/updateStatus call only sends notifications afterwards.
exports.verifyPayment = async (req, res) => {
  try {
    const actor = await authz.resolveActor(req);
    if (!actor || actor.kind !== "user" || !actor.user) {
      return res.status(403).json({ success: false, code: "FORBIDDEN", error: "Only the booking's guest can verify a payment" });
    }
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature, paymentMethod } = req.body || {};
    if (typeof razorpay_order_id !== "string" || typeof razorpay_payment_id !== "string") {
      return res.status(400).json({ success: false, code: "VALIDATION", error: "razorpay_order_id and razorpay_payment_id are required" });
    }
    const stored = await Payment.findOne({ orderId: razorpay_order_id });
    if (!stored) return res.status(404).json({ success: false, code: "ORDER_NOT_FOUND", error: "Not found" });
    const booking = await Booking.findById(stored.bookingId).select("userId").lean();
    if (!booking || !authz.isBookingGuest(actor, booking)) {
      return res.status(403).json({ success: false, code: "FORBIDDEN", error: "This order does not belong to you" });
    }
    if (!verifySignature({ orderId: razorpay_order_id, paymentId: razorpay_payment_id, signature: razorpay_signature })) {
      // A bad signature never touches the order's state (an attacker must not
      // be able to flip a real order to "failed").
      return res.status(400).json({ success: false, code: "INVALID_SIGNATURE", error: "Invalid signature" });
    }
    const rp = await getRazorpay().payments.fetch(razorpay_payment_id);
    if (!rp) return res.status(404).json({ success: false, error: "Payment method not found" });
    const result = await applyPaymentSuccess({
      orderId: razorpay_order_id,
      razorpayPayment: rp,
      paymentMethod: paymentMethod || rp.method,
      source: "callback",
    });
    return res.status(200).json({
      success: true,
      data: result.payment,
      booking: { _id: result.booking?._id, status: result.booking?.status, paymentStatus: result.booking?.paymentStatus },
      alreadyProcessed: result.alreadyProcessed,
      message: "Payment verified successfully",
    });
  } catch (error) {
    if (error instanceof PaymentError) {
      return res.status(error.status).json({ success: false, code: error.code, error: error.message, ...error.extra });
    }
    console.error("Payment verification error:", error);
    return res.status(500).json({ success: false, error: "Payment verification failed" });
  }
};

// Get payment details
// Only a party to the booking (guest, host) or an admin may read a payment.
async function canReadPayment(req, payment) {
  const actor = await authz.resolveActor(req);
  if (!actor) return false;
  if (authz.isAdmin(actor)) return true;
  const booking = await Booking.findById(payment.bookingId).select("userId hostId").lean();
  return !!booking && (authz.isBookingGuest(actor, booking) || authz.isBookingHost(actor, booking));
}

exports.getPayment = async (req, res) => {
  try {
    const payment = await Payment.findOne({
      $or: [{ paymentId: req.params.id }, { orderId: req.params.id }],
    });
    if (!payment) {
      return res.status(404).json({
        success: false,
        error: "Payment not found",
      });
    }
    if (!(await canReadPayment(req, payment))) {
      return res.status(403).json({ success: false, code: "FORBIDDEN", error: "Not allowed" });
    }
    res.json({
      success: true,
      data: payment,
    });
  } catch (error) {
    console.error("Get payment error:", error);
    res.status(500).json({
      success: false,
      error: "Failed to fetch payment details",
    });
  }
};

exports.getPaymentByBooking = async (req, res) => {
  try {
    if (!isObjectId(String(req.query.id))) {
      return res.status(400).json({ success: false, code: "INVALID_ID", error: "Invalid booking id" });
    }
    const payment = await Payment.findOne({
      bookingId: req.query.id,
    });
    if (!payment) {
      return res.status(404).json({
        success: false,
        error: "Payment not found",
      });
    }
    if (!(await canReadPayment(req, payment))) {
      return res.status(403).json({ success: false, code: "FORBIDDEN", error: "Not allowed" });
    }
    res.json({
      success: true,
      data: payment,
    });
  } catch (error) {
    console.error("Get payment error:", error);
    res.status(500).json({
      success: false,
      error: "Failed to fetch payment details",
    });
  }
};
// exports.payout = async (req, res) => {
//   try {
//     const { hostId, bookingId, userId, amount, property, propertyId } =
//       req.body;
//     process.env.ENV === 'dev' && if (process.env.NEXT_PUBLIC_ENV === "dev") {
//   console.log("enter");
// }
//     const bank = await BankDetail.find({ hostId: hostId });
//     if (!bank) {
//       return res.status(404).json({
//         success: false,
//         error: "Bank details not found",
//       });
//     }
//     process.env.ENV === 'dev' && if (process.env.NEXT_PUBLIC_ENV === "dev") {
//   console.log("enter2");
// }
//     if (!amount || amount < 100) {
//       return res.status(400).json({
//         success: false,
//         error: "Amount too small. Minimum payout is ₹1",
//       });
//     }
//     process.env.ENV === 'dev' && if (process.env.NEXT_PUBLIC_ENV === "dev") {
//   console.log("enter3");
// }
//     const payout = await axios.post(
//       "https://sandbox.razorpay.com/v1/payouts",
//       {
//         account_number: "123456789", //"your_razorpayx_account_number",
//         fund_account_id: "fa_RQyP0KAFLr9kNp", //"host_bank_account_id",
//         amount: 500000, // amount in paise (₹5000)
//         currency: "INR",
//         mode: "UPI", // or IMPS/NEFT/RTGS
//         purpose: "payout", // or refund, cashback, etc.
//         // scheduled_at: Math.floor(Date.now() / 1000) + 86400 * 3, 24 hours later
//         queue_if_low_balance: true,
//         reference_id: `payout_${bookingId}_${Date.now()}`, //`payout_${bookingId}_${Date.now()}`,
//         narration: `Payout for booking ${bookingId}`,
//         notes: {
//           booking_id: bookingId,
//           user_id: userId,
//           host_id: hostId,
//           property: property,
//           property_id: propertyId,
//         },
//       },
//       {
//         auth: {
//           username: process.env.RAZORPAYX_KEY_ID,
//           password: process.env.RAZORPAYX_KEY_SECRET,
//         },
//       }
//     );
//     process.env.ENV === 'dev' && if (process.env.NEXT_PUBLIC_ENV === "dev") {
//   console.log("enter4");
// }
//     if (!payout) {
//       return res.status(404).json({
//         success: false,
//         error: "Transaction failed",
//       });
//     }
//     res.status(200).json({ success: true, data: data });
//   } catch (error) {
//     console.error("❌ Payout Error Details:", {
//       error: error.message,
//       stack: error.stack,
//       errorCode: error.error?.code,
//       errorDescription: error.error?.description,
//       statusCode: error.statusCode,
//     });
//     res.status(500).json({
//       success: false,
//       error: "Failed to fetch payment details",
//     });
//   }
// };

// exports.payout = async (req, res) => {
//   try {
//     const { bookingId, propertyId, userId, hostId, amount, property } =
//       req.body;
//     if (!amount || amount < 100) {
//       return { success: false, error: "Amount too small" };
//     }
//     process.env.ENV === 'dev' && if (process.env.NEXT_PUBLIC_ENV === "dev") {
//   console.log("post1");
// }
//     const bank = await BankDetail.findOne({ hostId: hostId });
//     if (!bank) {
//       return res
//         .status(404)
//         .json({ success: false, error: "Bank details not found" });
//     }
//     const host = await HostPayout.findOne({ bookingId: bookingId });
//     if (!host) {
//       return res.status(404).json({
//         success: false,
//         error: "Host payout document details not found",
//       });
//     }
//     process.env.ENV === 'dev' && if (process.env.NEXT_PUBLIC_ENV === "dev") {
//   console.log("post2");
// }
//     const payout = await axios.post(
//       `${API_URL}/payouts`,
//       {
//         account_number: "2323230087607472",
//         fund_account_id: bank.fundId,
//         amount: 5000, // paise
//         currency: "INR",
//         mode: "IMPS",
//         purpose: "payout",
//         queue_if_low_balance: true,
//         reference_id: `payout_${bookingId}_${Date.now()}`,
//         narration: `Payout for booking ${bookingId}`,
//         notes: {
//           booking_id: bookingId,
//           user_id: userId,
//           host_id: hostId,
//           property_id: propertyId,
//         },
//       },
//       {
//         headers: {
//           "Content-Type": "application/json",
//           "X-Payout-Idempotency": string,
//           Authorization: `Basic ${auth}`,
//         },
//       }
//     );
//     process.env.ENV === 'dev' && if (process.env.NEXT_PUBLIC_ENV === "dev") {
//   console.log("Entered payout4");
// }
//     if (!payout) {
//       return res.status(404).json({ success: false, error: "Payout failed" });
//     }

//     return res.status(200).json({
//       success: true,
//       data: payout.data,
//       bookingId: bookingId,
//     });
//   } catch (error) {
//     console.error("❌ Payout Error:", error);
//   }
// };

async function initiatePayout(booking) {
  try {
    if (process.env.NEXT_PUBLIC_ENV === "dev") {
      console.log("Entered payout", booking);
    }
    if (!booking.price) {
      return { success: false, error: "Amount too small" };
    }
    const generateString = generateUniqueString();
    if (process.env.NEXT_PUBLIC_ENV === "dev") {
      console.log("Entered payout2");
    }
    const bank = await BankDetail.findOne({ hostId: booking.hostId });
    if (!bank) {
      await HostPayout.findOneAndUpdate(
        { bookingId: booking._id },
        { status: "failed" },
      );
      return { success: false, error: "Bank details not found" };
    }
    const host = await HostPayout.findOne({ bookingId: booking._id });
    if (!host) {
      return {
        success: false,
        error: "Host payout document details not found",
      };
    }

    if (process.env.NEXT_PUBLIC_ENV === "dev") {
      console.log("Entered payout3");
    }
    console.log("the actual amount", host.amount * 100);
    const payout = await axios.post(
      `https://api.razorpay.com/v1/payouts`,
      {
        account_number: ADMIN_ACCOUNT,
        fund_account_id: bank.fundId,
        amount: Math.round(host.amount * 100), // paise
        currency: "INR",
        mode: "IMPS",
        purpose: "payout",
        queue_if_low_balance: true,
        // reference_id: `payout_${booking._id}_${Date.now()}`,
        // narration: `Payout for booking ${booking._id}`,
        notes: {
          booking_id: booking._id,
          user_id: booking.userId,
          host_id: booking.hostId,
          property_id: booking.propertyId,
        },
      },
      {
        headers: {
          "Content-Type": "application/json",
          "X-Payout-Idempotency": generateString,
          Authorization: `Basic ${auth}`,
        },
      },
    );
    if (process.env.NEXT_PUBLIC_ENV === "dev") {
      console.log("Entered payout4");
    }
    if (!payout) {
      return { success: false, error: "Payout failed" };
    }
    const updatePayoutId = await HostPayout.findOneAndUpdate(
      { bookingId: booking._id },
      { paymentId: payout.data.id },
    );
    if (!updatePayoutId) {
      return { success: false, error: "Failed to save payout id" };
    }
    return {
      success: true,
      data: payout.data,
      bookingId: booking._id,
    };
  } catch (error) {
    console.error("❌ Payout Error Details for booking:", booking._id);

    if (error.response) {
      // Razorpay API returned an error
      console.error("Status:", error.response.status);
      console.error("Headers:", error.response.headers);
      console.error(
        "Response Data:",
        JSON.stringify(error.response.data, null, 2),
      );

      const razorpayError = error.response.data;
      const errorMessage =
        razorpayError.error?.description ||
        razorpayError.error?.code ||
        "Razorpay API error";

      console.error("Razorpay Error Message:", errorMessage);
      await HostPayout.findOneAndUpdate(
        { bookingId: booking._id },
        {
          status: "failed",
        },
      );
      return {
        success: false,
        error: errorMessage,
        details: razorpayError,
        bookingId: booking._id,
      };
    } else if (error.request) {
      // Network error
      console.error("No response received from Razorpay");
      console.error("Request:", error.request);

      return {
        success: false,
        error: "Network error - No response from Razorpay",
        bookingId: booking._id,
      };
    } else {
      // Setup error
      console.error("Setup Error:", error.message);

      return {
        success: false,
        error: error.message,
        bookingId: booking._id,
      };
    }
  }
}

async function createPayout(bookingId, propertyId, amount, hostId) {
  try {
    // const { bookingId, propertyId, amount, hostId } = req.body;

    if (process.env.NEXT_PUBLIC_ENV === "dev") {
      console.log("o", amount, bookingId, propertyId);
    }
    if (!bookingId || !propertyId || !amount) {
      // return res
      //   .status(400)
      //   .json({ success: false, error: "Missing parameter" });
      return { success: false, error: "Missing parameter" };
    }

    // const config = await Configure.findById("68e64844519bdcd9e0db952d");
    // if (!config) {
    //   return res
    //     .status(404)
    //     .json({ success: false, error: "No configuration found" });
    // }
    const hostData = await User.findById(hostId);
    if (!hostData) {
      // return res
      //   .status(404)
      //   .json({ success: false, message: "Host data could not be found" });
      return { success: false, error: "Host data could not be found" };
    }
    const kycDate = new Date(hostData.kyc.verifiedAt);
    const today = new Date();
    const diffTime = Math.abs(kycDate.getTime() - today.getTime());
    const diffDays = Math.floor(diffTime / (1000 * 60 * 60 * 24));

    if (process.env.NEXT_PUBLIC_ENV === "dev") {
      console.log("testing the stran", kycDate, diffDays);
    }
    let data;
    if (hostData.hostOffer == true && hostData.kyc && diffDays <= 90) {
      const newAmount = Number(amount);
      data = new HostPayout({
        bookingId,
        propertyId,
        amount: newAmount,
        status: "pending",
      });
      await data.save();
    } else {
      const newAmount =
        Number(amount) -
        (process.env.MAJESTIC_COMMISSION / 100) * Number(amount);
      data = new HostPayout({
        bookingId,
        propertyId,
        amount: newAmount,
        status: "pending",
      });
      await data.save();
    }

    // res.status(200).json({
    //   success: true,
    //   data: data,
    // });
    return { success: true, data: data };
  } catch (error) {
    // res.status(500).json({
    //   success: false,
    //   error: error.message || "Failed to create payout",
    // });
    return {
      success: false,
      error: error.message || "Failed to create payout",
    };
  }
}

// cron.schedule("42 11 * * *", async () => {
exports.schedulecron = async (req, res) => {
  try {
    if (process.env.NEXT_PUBLIC_ENV === "dev") {
      console.log("enter payout cron");
    }
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const todayEnd = new Date();
    todayEnd.setHours(23, 59, 59, 999);

    const twoDayAgo = new Date(todayStart);
    twoDayAgo.setDate(todayStart.getDate() - 2);

    if (process.env.NEXT_PUBLIC_ENV === "dev") {
      console.log("payout timing for", twoDayAgo, todayEnd);
    }
    const confirmedBookings = await Booking.find({
      status: "confirmed",
      checkIn: { $gte: twoDayAgo, $lte: todayEnd },
    });

    console.log(
      `📅 Found ${confirmedBookings.length} bookings for payout today`,
    );
    const bookingsToProcess = [];

    for (const booking of confirmedBookings) {
      const payoutRecord = await HostPayout.findOne({ bookingId: booking._id });

      // CASE A: No payout exists → process it
      if (!payoutRecord) {
        console.log(
          `🆕 No payout record found → processing booking ${booking._id}`,
        );
        await createPayout(
          booking._id,
          booking?.propertyId,
          booking?.subTotal,
          booking.hostId,
        );
        bookingsToProcess.push(booking);
        continue;
      }

      if (["failed", "reversed"].includes(payoutRecord.status)) {
        console.log(
          `🔁 Payout status "${payoutRecord.status}" → retry booking ${booking._id}`,
        );
        bookingsToProcess.push(booking);
        continue;
      }

      console.log(
        `⏭️ Skipping booking ${booking._id} (payout status: ${payoutRecord.status})`,
      );
    }

    const results = [];
    for (const booking of bookingsToProcess) {
      try {
        const result = await initiatePayout(booking);
        results.push(result);

        // Log each result
        if (result.success) {
          if (process.env.NEXT_PUBLIC_ENV === "dev") {
            console.log(`✅ Payout successful for booking: ${booking._id}`);
          }
        } else {
          console.log(
            `❌ Payout failed for booking: ${booking._id} - ${result.error}`,
          );
        }
      } catch (error) {
        console.error(`💥 Unexpected error for booking ${booking._id}:`, error);
        results.push({
          success: false,
          error: error.message,
          bookingId: booking._id,
        });
      }
    }
    const successful = results.filter((r) => r.success).length;
    const failed = results.filter((r) => !r.success).length;

    console.log(
      `📊 Cron job completed: ${successful} successful, ${failed} failed`,
    );

    return res.status(200).json({
      success: true,
      successful,
      failed,
      total: bookingsToProcess.length,
    });
  } catch (err) {
    console.error("❌ Cron job error:", err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
};
// );

exports.update = async (req, res) => {
  try {
    console.log("Entered the Payout update Function");
    const isDev = process.env.NEXT_PUBLIC_ENV === "dev";

    if (isDev) {
      console.log("Payment payout started");
      console.log("🟢 Webhook received at:", new Date().toISOString());
    }

    const secret = process.env.RAZORPAY_WEBHOOK_KEY;
    const signature = req.headers["x-razorpay-signature"];

    if (!secret || !signature) {
      return res.status(400).json({ error: "Missing signature headers" });
    }
    console.log("Secret present");
    // ===============================
    // 🔥 FIX 1: SAFE RAW BODY HANDLING
    // ===============================
    const rawBody = req.body.toString("utf8");

    if (isDev) {
      console.log("🔍 Raw body length:", rawBody.length);
    }

    // ===============================
    // 🔥 FIX 2: SIGNATURE VERIFICATION
    // ===============================
    const expectedSignature = crypto
      .createHmac("sha256", secret)
      .update(rawBody)
      .digest("hex");

    if (expectedSignature !== signature) {
      console.warn("❌ Invalid webhook signature");
      return res.status(400).json({ error: "Invalid signature" });
    }
    console.log("Signature match");
    if (isDev) {
      console.log("✅ Webhook verified!");
    }

    let payload;
    try {
      payload = JSON.parse(rawBody);
    } catch (e) {
      return res.status(400).json({ error: "Invalid JSON" });
    }

    if (isDev) {
      console.log("📦 Webhook Event:", payload.event);
    }
    console.log("Parsed");
    // ===============================
    // Respond immediately to Razorpay
    // ===============================
    res.status(200).json({ received: true });

    // ===============================
    // Background processing
    // ===============================
    setImmediate(() => {
      processWebhookEvent(payload).catch((err) => {
        console.error("❌ Background processing error:", err);
      });
    });
  } catch (error) {
    console.error("❌ Webhook error:", error);

    if (!res.headersSent) {
      res.status(500).json({ error: "Webhook failed" });
    }
  }
};
// Process webhook asynchronously
async function processWebhookEvent(payload) {
  try {
    console.log("Entered processing", payload);
    console.log("Entered processing", payload.payout);
    if (process.env.NEXT_PUBLIC_ENV === "dev") {
      console.log("🔄 Processing payout webhook event:", payload);
      console.log("Payload object", payload?.payload);
      console.log("Payload2 object", payload?.payload?.payout);
      console.log(
        "🔄 Processing payout webhook event:",
        payload?.payload?.payout?.entity,
      );
      console.log("Payload object", payload?.payout?.entity);
      console.log("Payload2 object", payload?.payment?.entity);
    }

    switch (payload.event) {
      // Pay-in events (Batch S): the same idempotent transition as the
      // client callback, so callback + webhook or a redelivered webhook can
      // never double-apply, and a payment the client never reported still
      // lands on the booking.
      case "payment.captured":
      case "payment.authorized": {
        const p = payload?.payload?.payment?.entity;
        if (p && p.order_id) {
          await applyPaymentSuccess({ orderId: p.order_id, razorpayPayment: p, paymentMethod: p.method, source: payload.event });
        }
        break;
      }
      case "order.paid": {
        const p = payload?.payload?.payment?.entity;
        const o = payload?.payload?.order?.entity;
        if (p && (p.order_id || o?.id)) {
          await applyPaymentSuccess({ orderId: p.order_id || o.id, razorpayPayment: p, paymentMethod: p.method, source: payload.event });
        }
        break;
      }
      case "payout.processed":
        await handlePayoutProcessed(payload?.payload?.payout?.entity);
        break;
      case "payout.initiated":
        await handlePayoutInitiated(payload?.payload?.payout?.entity);
        break;
      case "payout.reversed":
        await handlePayoutReversed(payload?.payload?.payout?.entity);
        break;
      case "payout.updated":
        await handlePayoutUpdated(payload?.payload?.payout?.entity);
        break;
      case "payout.pending":
        await handlePayoutPending(payload?.payload?.payout?.entity);
        break;
      case "payout.rejected":
        await handlePayoutRejected(payload?.payload?.payout?.entity);
        break;
      default:
        if (process.env.NEXT_PUBLIC_ENV === "dev") {
          console.log("⚪ Unhandled webhook event:", payload.event);
        }
    }

    if (process.env.NEXT_PUBLIC_ENV === "dev") {
      console.log("✅ Event processing completed:", payload.event);
    }
  } catch (error) {
    console.error(`❌ Error processing ${payload.event}:`, error);
  }
}

// Your handler functions remain the same...
// ========== PAYMENT HANDLERS ==========
async function handlePayoutProcessed(payment) {
  try {
    if (process.env.NEXT_PUBLIC_ENV === "dev") {
      console.log("💰Enterd Payout Processed:", payment);
    }
    if (!payment.id) {
      console.error("❌ Missing payout/payment id");
      return;
    }
    const paymentProcess = await HostPayout.findOneAndUpdate(
      {
        paymentId: payment.id,
      },
      { status: "paid" },
    );
    if (!paymentProcess) {
      console.error("❌ Payment processing failed");
      return;
    }
    // process.env.ENV === 'dev' && if (process.env.NEXT_PUBLIC_ENV === "dev") {
    //   console.log("Amount:", payment.amount / 100);
    // } // Convert paise to rupees
    // process.env.ENV === 'dev' && if (process.env.NEXT_PUBLIC_ENV === "dev") {
    //   console.log("Order ID:", payment.order_id);
    // }
    // process.env.ENV === 'dev' && if (process.env.NEXT_PUBLIC_ENV === "dev") {
    // console.log("Customer:", payment.email);
    // }

    // Update your booking status in database
    // await HostPayout.findOneAndUpdate(
    //   { razorpayOrderId: payment.order_id },
    //   {
    //     paymentStatus: 'captured',
    //     razorpayPaymentId: payment.id,
    //     paidAt: new Date()
    //   }
    // );

    //     if (process.env.NEXT_PUBLIC_ENV === "dev") {
    //   console.log("✅ Booking payment status updated");
    // }
  } catch (error) {
    console.error("❌ Error handling payment.captured:", error);
  }
}

async function handlePayoutInitiated(payment) {
  if (process.env.NEXT_PUBLIC_ENV === "dev") {
    console.log("💰 Entered Payout Initiated:", payment);
  }
  if (!payment.id) {
    console.error("❌ Missing payout/payment id");
    return;
  }
  const paymentInitiate = await HostPayout.findOneAndUpdate(
    {
      paymentId: payment.id,
    },
    { status: "initiated" },
  );
  if (!paymentInitiate) {
    console.error("❌ Payment initiation failed");
    return;
  }
  // process.env.ENV === 'dev' && if (process.env.NEXT_PUBLIC_ENV === "dev") {
  //   console.log("❌ Payment Failed:", payment.id, payment.error_description);
  // }
  // Update booking status to failed
}

async function handlePayoutUpdated(payment) {
  if (process.env.NEXT_PUBLIC_ENV === "dev") {
    console.log("🔐 Entered Payment Update:", payment);
  }
  // Payment is authorized but not captured yet
}

async function handlePayoutPending(payout) {
  if (process.env.NEXT_PUBLIC_ENV === "dev") {
    console.log("✅ Payout Processed:", payout);
  }
  // Your existing payout logic
}

async function handlePayoutRejected(payout) {
  if (process.env.NEXT_PUBLIC_ENV === "dev") {
    console.log("❌ Entered Payout Rejected:", payout);
  }
  if (!payout.id) {
    console.error("❌ Missing payout/payment id");
    return;
  }
  const payment = await HostPayout.findOneAndUpdate(
    {
      paymentId: payout.id,
    },
    { status: "rejected" },
  );
  if (!payment) {
    console.error("❌ Payment rejected");
    return;
  }

  // Your existing payout failure logic
}

async function handlePayoutReversed(payout) {
  if (process.env.NEXT_PUBLIC_ENV === "dev") {
    console.log("🔄 Entered ayout Reversed:", payout);
  }
  if (!payout.id) {
    console.error("❌ Missing payout/payment id");
    return;
  }
  const payment = await HostPayout.findOneAndUpdate(
    {
      paymentId: payout.id,
    },
    { status: "reversed" },
  );
  if (!payment) {
    console.error("❌ Payment reversed");
    return;
  }
}

// // controllers/paymentController.js
// const Razorpay = require("razorpay");
// const crypto = require("crypto");
// const Payment = require("../models/Payment");
// const User = require("../models/User");
// const Booking = require("../models/Booking");
// const { parseMDYToUTC } = require("../utils/convertDate");
// const BankDetail = require("../models/BankDetail");
// const axios = require("axios");
// const cron = require("node-cron");

// const { generateUniqueString } = require("../utils/generateString");
// const HostPayout = require("../models/HostPayout");
// const Configure = require("../models/Configure");
// const razorpay = new Razorpay({
//   key_id: "rzp_test_RRelkKgMDh3dun",
//   key_secret: "gYeQi2lZFvXMMBRs1lWjGANA",
// });


// const auth = Buffer.from(
//   `${razorpay.key_id.trim()}:${razorpay.key_secret.trim()}`
// ).toString("base64");
// const API_URL = process.env.RAZORPAY_API;
// // helper: parse "MM/DD/YYYY" or "M/D/YYYY"

// // Usage in your route:

// exports.fetch = async (req, res) => {
//   try {
//     const { paymentType, search, searchList, from, to } = req.query;
//     const date = parseMDYToUTC(from, to);

//     process.env.ENV === 'dev' && if (process.env.NEXT_PUBLIC_ENV === "dev") {
//   console.log(date.from, date.to);
// }

//     const filter = {};
//     if (paymentType && paymentType != "all") {
//       filter.paymentType = paymentType;
//     }

//     if (from && !to) {
//       // only from date given
//       filter.createdAt = { $gte: date.from };
//     } else if (from && to) {
//       // both from and to date given
//       filter.createdAt = {
//         $gte: date.from,
//         $lte: date.to,
//       };
//     }

//     let data;
//     if (!searchList) {
//       data = await Payment.find(filter).populate("propertyId");
//     }
//     if (searchList) {
//       if (searchList == "date-desc") {
//         data = await Payment.find(filter)
//           .populate("propertyId")
//           .sort({ createdAt: -1 });
//       } else if (searchList == "date-asc") {
//         data = await Payment.find(filter)
//           .populate("propertyId")
//           .sort({ createdAt: 1 });
//       } else if (searchList == "amount-desc") {
//         data = await Payment.find(filter)
//           .populate("propertyId")
//           .sort({ amount: -1 });
//       } else {
//         data = await Payment.find(filter)
//           .populate("propertyId")
//           .sort({ amount: 1 });
//       }
//     }

//     if (!data) {
//       return res.status(400).json({
//         success: false,
//         error: "Payment data not available",
//       });
//     }
//     if (search) {
//       data = data.filter(
//         (b) =>
//           b.propertyId.title.toLowerCase().includes(search.toLowerCase()) ||
//           b.paymentId.toLowerCase().includes(search.toLowerCase()) ||
//           b.customerDetails.name.toLowerCase().includes(search.toLowerCase())
//       );
//     }

//     res.json({
//       success: true,
//       data: data,
//     });
//   } catch (error) {
//     res.status(500).json({
//       success: false,
//       error: "Failed to create order",
//     });
//   }
// };
// // Create a new order

// exports.createOrder = async (req, res) => {
//   try {
//     const { bookingId, userId, currency, amount, propertyId } = req.body;

//     // Validate amount
//     if (!amount || amount < 100) {
//       return res.status(400).json({
//         success: false,
//         error: "Amount must be at least 100 paisa (₹1)",
//       });
//     }

//     //Find User Details
//     const user = await User.findById(userId);
//     const ObjectId = require("mongoose").Types.ObjectId;

//     process.env.ENV === 'dev' && if (process.env.NEXT_PUBLIC_ENV === "dev") {
//   console.log("not nic", bookingId);
// }

//     // Create order with Razorpay
//     const order = await razorpay.orders.create({
//       amount,
//       currency,
//       receipt: `receipt_${Date.now()}`,
//     });

//     // Save order details to database
//     const payment = new Payment({
//       orderId: order.id,
//       amount: order.amount,
//       currency: order.currency,
//       bookingId: bookingId,
//       propertyId: propertyId,
//       customerDetails: {
//         name: user.firstName + " " + user.lastName,
//         email: user.email,
//         contact: user.phoneNumber,
//       },
//       status: "created",
//     });
//     await payment.save();

//     res.json({
//       success: true,
//       data: order,
//     });
//   } catch (error) {
//     console.error("Create order error:", error);
//     res.status(500).json({
//       success: false,
//       error: "Failed to create order",
//     });
//   }
// };
// // Verify payment
// exports.verifyPayment = async (req, res) => {
//   try {
//     const {
//       razorpay_order_id,
//       razorpay_payment_id,
//       razorpay_signature,
//       paymentMethod,
//     } = req.body;

//     process.env.ENV === 'dev' && if (process.env.NEXT_PUBLIC_ENV === "dev") {
//   console.log("t0");
// }
//     // Verify signature
//     const body = razorpay_order_id + "|" + razorpay_payment_id;
//     const expectedSignature = crypto
//       .createHmac("sha256", razorpay.key_secret)
//       .update(body.toString())
//       .digest("hex");

//     process.env.ENV === 'dev' && if (process.env.NEXT_PUBLIC_ENV === "dev") {
//   console.log("t1");
// }
//     const isAuthentic = expectedSignature === razorpay_signature;
//     const payment = await razorpay.payments.fetch(razorpay_payment_id);
//     if (!payment) {
//       return res
//         .status(404)
//         .json({ success: false, error: "Payment method not found" });
//     }

//     process.env.ENV === 'dev' && if (process.env.NEXT_PUBLIC_ENV === "dev") {
//   console.log("t2");
// }
//     if (isAuthentic) {
//       // Update payment details in database
//       const data = await Payment.findOneAndUpdate(
//         { orderId: razorpay_order_id },
//         {
//           paymentId: razorpay_payment_id,
//           paymentMethod: payment?.method,
//           status: "paid",
//         }
//       );
//       if (!data) {
//         return res.status(404).json({ success: false, error: "Not found" });
//       }

//       res.status(200).json({
//         success: true,
//         data: data,
//         message: "Payment verified successfully",
//       });
//     } else {
//       // Update payment status to failed

//       process.env.ENV === 'dev' && if (process.env.NEXT_PUBLIC_ENV === "dev") {
//   console.log("t3");
// }
//       await Payment.findOneAndUpdate(
//         { orderId: razorpay_order_id },
//         { status: "failed" }
//       );

//       res.status(400).json({
//         success: false,
//         error: "Invalid signature",
//       });
//     }
//   } catch (error) {
//     console.error("Payment verification error:", error);
//     res.status(500).json({
//       success: false,
//       error: "Payment verification failed",
//     });
//   }
// };
// // Get payment details
// exports.getPayment = async (req, res) => {
//   try {
//     const payment = await Payment.findOne({
//       $or: [{ paymentId: req.params.id }, { orderId: req.params.id }],
//     });

//     if (!payment) {
//       return res.status(404).json({
//         success: false,
//         error: "Payment not found",
//       });
//     }

//     res.json({
//       success: true,
//       data: payment,
//     });
//   } catch (error) {
//     console.error("Get payment error:", error);
//     res.status(500).json({
//       success: false,
//       error: "Failed to fetch payment details",
//     });
//   }
// };

// exports.getPaymentByBooking = async (req, res) => {
//   try {
//     const payment = await Payment.findOne({
//       bookingId: req.query.id,
//     });

//     if (!payment) {
//       return res.status(404).json({
//         success: false,
//         error: "Payment not found",
//       });
//     }

//     res.json({
//       success: true,
//       data: payment,
//     });
//   } catch (error) {
//     console.error("Get payment error:", error);
//     res.status(500).json({
//       success: false,
//       error: "Failed to fetch payment details",
//     });
//   }
// };
// // exports.payout = async (req, res) => {
// //   try {
// //     const { hostId, bookingId, userId, amount, property, propertyId } =
// //       req.body;
// //     process.env.ENV === 'dev' && if (process.env.NEXT_PUBLIC_ENV === "dev") {
//   console.log("enter");
// }
// //     const bank = await BankDetail.find({ hostId: hostId });
// //     if (!bank) {
// //       return res.status(404).json({
// //         success: false,
// //         error: "Bank details not found",
// //       });
// //     }
// //     process.env.ENV === 'dev' && if (process.env.NEXT_PUBLIC_ENV === "dev") {
//   console.log("enter2");
// }
// //     if (!amount || amount < 100) {
// //       return res.status(400).json({
// //         success: false,
// //         error: "Amount too small. Minimum payout is ₹1",
// //       });
// //     }
// //     process.env.ENV === 'dev' && if (process.env.NEXT_PUBLIC_ENV === "dev") {
//   console.log("enter3");
// }
// //     const payout = await axios.post(
// //       "https://sandbox.razorpay.com/v1/payouts",
// //       {
// //         account_number: "123456789", //"your_razorpayx_account_number",
// //         fund_account_id: "fa_RQyP0KAFLr9kNp", //"host_bank_account_id",
// //         amount: 500000, // amount in paise (₹5000)
// //         currency: "INR",
// //         mode: "UPI", // or IMPS/NEFT/RTGS
// //         purpose: "payout", // or refund, cashback, etc.
// //         // scheduled_at: Math.floor(Date.now() / 1000) + 86400 * 3, 24 hours later
// //         queue_if_low_balance: true,
// //         reference_id: `payout_${bookingId}_${Date.now()}`, //`payout_${bookingId}_${Date.now()}`,
// //         narration: `Payout for booking ${bookingId}`,
// //         notes: {
// //           booking_id: bookingId,
// //           user_id: userId,
// //           host_id: hostId,
// //           property: property,
// //           property_id: propertyId,
// //         },
// //       },
// //       {
// //         auth: {
// //           username: process.env.RAZORPAYX_KEY_ID,
// //           password: process.env.RAZORPAYX_KEY_SECRET,
// //         },
// //       }
// //     );
// //     process.env.ENV === 'dev' && if (process.env.NEXT_PUBLIC_ENV === "dev") {
//   console.log("enter4");
// }
// //     if (!payout) {
// //       return res.status(404).json({
// //         success: false,
// //         error: "Transaction failed",
// //       });
// //     }
// //     res.status(200).json({ success: true, data: data });
// //   } catch (error) {
// //     console.error("❌ Payout Error Details:", {
// //       error: error.message,
// //       stack: error.stack,
// //       errorCode: error.error?.code,
// //       errorDescription: error.error?.description,
// //       statusCode: error.statusCode,
// //     });
// //     res.status(500).json({
// //       success: false,
// //       error: "Failed to fetch payment details",
// //     });
// //   }
// // };

// async function initiatePayout(booking) {
//   try {
//     process.env.ENV === 'dev' && if (process.env.NEXT_PUBLIC_ENV === "dev") {
//   console.log("Entered payout", booking);
// }
//     const generatestring = generateUniqueString();
//     if (!booking.price || booking.price < 100) {
//       return { success: false, error: "Amount too small" };
//     }
//     process.env.ENV === 'dev' && if (process.env.NEXT_PUBLIC_ENV === "dev") {
//   console.log("Entered payout2");
// }
//     const bank = await BankDetail.findOne({ hostId: booking.hostId });
//     if (!bank) {
//       return { success: false, error: "Bank details not found" };
//     }
//     const host = await HostPayout.findOne({ bookingId: booking._id });
//     if (!host) {
//       return {
//         success: false,
//         error: "Host payout document details not found",
//       };
//     }

//     process.env.ENV === 'dev' && if (process.env.NEXT_PUBLIC_ENV === "dev") {
//   console.log("Entered payout3");
// }
//     const payout = await axios.post(
//       `${API_URL}/payouts`,
//       {
//         account_number: "2323230087607472",
//         fund_account_id: bank.fundId,
//         amount: 5000, // paise
//         currency: "INR",
//         mode: "IMPS",
//         purpose: "payout",
//         queue_if_low_balance: true,
//         // reference_id: `payout_${booking._id}_${Date.now()}`,
//         // narration: `Payout for booking ${booking._id}`,
//         notes: {
//           booking_id: booking._id,
//           user_id: booking.userId,
//           host_id: booking.hostId,
//           property_id: booking.propertyId,
//         },
//       },
//       {
//         headers: {
//           "Content-Type": "application/json",
//           "X-Payout-Idempotency": generatestring,
//           Authorization: `Basic ${auth}`,
//         },
//       }
//     );
//     process.env.ENV === 'dev' && if (process.env.NEXT_PUBLIC_ENV === "dev") {
//   console.log("Entered payout4",payout.data);
// }
//     if (!payout) {
//       return { success: false, error: "Payout failed" };
//     }
//      const updatePayoutId = await HostPayout.findOneAndUpdate({ bookingId: booking._id },{paymentId:payout.data.id});
//   if (!updatePayoutId) {
//       return { success: false, error: "Failed to save payout id" };
//     }
//     return {
//       success: true,
//       data: payout.data,
//       bookingId: booking._id,
//     };
//   } catch (error) {
//     console.error("❌ Payout Error:", error);
//     return {
//       success: false,
//       error: error.message || "Failed to create payout",
//       bookingId: booking._id,
//     };
//   }
// }

// async function setcronjob(){
//   process.env.ENV === 'dev' && if (process.env.NEXT_PUBLIC_ENV === "dev") {
//   console.log("entered cron");
// }
//   try {
//     const todayStart = new Date();
//     todayStart.setHours(0, 0, 0, 0);
//     const todayEnd = new Date();
//     todayEnd.setHours(23, 59, 59, 999);

//     const confirmedBookings = await Booking.find({
//       status: "confirmed",
//       checkIn: { $gte: todayStart, $lte: todayEnd },
//     });

//     process.env.ENV === 'dev' && console.log(
//       `📅 Found ${confirmedBookings.length} bookings for payout today`
//     );

//     const results = [];
//     for (const booking of confirmedBookings) {
//       const result = await initiatePayout(booking);
//       results.push(result);

//       // Log each result
//       if (result.success) {
//         process.env.ENV === 'dev' && if (process.env.NEXT_PUBLIC_ENV === "dev") {
//   console.log(`✅ Payout successful for booking: ${booking._id}`);
// }
//       } else {
//         process.env.ENV === 'dev' && console.log(
//           `❌ Payout failed for booking: ${booking._id} - ${result.error}`
//         );
//       }
//     }
//     const successful = results.filter((r) => r.success).length;
//     const failed = results.filter((r) => !r.success).length;

//     process.env.ENV === 'dev' && console.log(
//       `📊 Cron job completed: ${successful} successful, ${failed} failed`
//     );
//   } catch (err) {
//     console.error("❌ Cron job error:", err.message);
//   }
// };

// exports.createPayout = async (req, res) => {
//   try {
//     const { bookingId, propertyId, amount } = req.body;
//     process.env.ENV === 'dev' && if (process.env.NEXT_PUBLIC_ENV === "dev") {
//   console.log("o", amount, bookingId, propertyId);
// }
//     if (!bookingId || !propertyId || !amount) {
//       return res
//         .status(400)
//         .json({ success: false, error: "Missing parameter" });
//     }

//     // const config = await Configure.findById("68e64844519bdcd9e0db952d");
//     // if (!config) {
//     //   return res
//     //     .status(404)
//     //     .json({ success: false, error: "No configuration found" });
//     // }

//     const newAmount = Number(amount) - (3 / 100) * Number(amount);

//     const data = new HostPayout({
//       bookingId,
//       propertyId,
//       amount: newAmount,
//       status: "pending",
//     });
//     await data.save();

//     const job = await setcronjob();

//     res.status(200).json({
//       success: true,
//       data: data,
//     });
//   } catch (error) {
//     res.status(500).json({
//       success: false,
//       error: error.message || "Failed to create payout",
//     });
//   }
// };

// exports.update = async (req, res) => {
//   // ✅ Return response IMMEDIATELY
//   // res.status(200).json({ received: true, timestamp: new Date().toISOString() });
//   process.env.ENV === 'dev' && if (process.env.NEXT_PUBLIC_ENV === "dev") {
//   console.log('Payment payout started');
// }
//   try {
//     const secret = "secret10142025";
//     process.env.ENV === 'dev' && if (process.env.NEXT_PUBLIC_ENV === "dev") {
//   console.log("🟢 Webhook received at:", new Date().toISOString());
// }

//     const signature = req.headers["x-razorpay-signature"];

//     // ✅ Manual raw body collection
//     let rawBody = '';

//     req.on('data', chunk => {
//       rawBody += chunk.toString();
//     });

//     req.on('end', async () => {
//       try {
//         process.env.ENV === 'dev' && if (process.env.NEXT_PUBLIC_ENV === "dev") {
//   console.log("🔍 Raw body length:", rawBody.length);
// }

//         // Verify signature
//         const expectedSignature = crypto
//           .createHmac('sha256', secret)
//           .update(rawBody)
//           .digest('hex');

//         process.env.ENV === 'dev' && console.log("🔍 Signature check:", {
//           expected: expectedSignature.substring(0, 20) + '...',
//           received: signature?.substring(0, 20) + '...',
//           match: expectedSignature === signature
//         });

//         if (expectedSignature !== signature) {
//           console.warn("❌ Invalid webhook signature");
//           return;
//         }

//         process.env.ENV === 'dev' && if (process.env.NEXT_PUBLIC_ENV === "dev") {
//   console.log("✅ Webhook verified!");
// }

//         // Parse payload
//         const payload = JSON.parse(rawBody);
//         process.env.ENV === 'dev' && if (process.env.NEXT_PUBLIC_ENV === "dev") {
//   console.log("📦 Webhook Event:", payload.event);
// }

//         // Process asynchronously
//         processWebhookEvent(payload).catch(console.error);

//       } catch (error) {
//         console.error("❌ Webhook processing error:", error);
//       }
//     });

//   } catch (error) {
//     console.error("❌ Webhook setup error:", error);
//   }
// };

// // Process webhook asynchronously
// async function processWebhookEvent(payload) {
//   try {
//     process.env.ENV === 'dev' && if (process.env.NEXT_PUBLIC_ENV === "dev") {
//   console.log("🔄 Processing webhook event:", payload);
// }

//     switch (payload.event) {
//       case "payment.captured":
//         process.env.ENV === 'dev' && if (process.env.NEXT_PUBLIC_ENV === "dev") {
//   console.log("payment captured");
// }
//         break;
//       case "payout.processed":
//         await handlePayoutProcessed(payload.payload.payout.entity);
//         break;
//       case "payout.initiated":
//         await handlePayoutInitiated(payload.payload.payout.entity);
//         break;
//       case "payout.reversed":
//         await handlePayoutReversed(payload.payload.payout.entity);
//         break;
//       case "payout.updated":
//         await handlePayoutUpdated(payload.payload.payout.entity);
//         break;
//       case "payout.pending":
//         await handlePayoutPending(payload.payload.payout.entity);
//         break;
//       case "payout.rejected":
//         await handlePayoutRejected(payload.payload.payout.entity);
//         break;
//       default:
//         process.env.ENV === 'dev' && if (process.env.NEXT_PUBLIC_ENV === "dev") {
//   console.log("⚪ Unhandled webhook event:", payload.event);
// }
// //     }

//     process.env.ENV === 'dev' && if (process.env.NEXT_PUBLIC_ENV === "dev") {
//   console.log("✅ Event processing completed:", payload.event);
// }
//   } catch (error) {
//     console.error(`❌ Error processing ${payload.event}:`, error);
//   }
// }

// // Your handler functions remain the same...
// // ========== PAYMENT HANDLERS ==========
// async function handlePayoutProcessed(payment) {
//   try {
//     process.env.ENV === 'dev' && if (process.env.NEXT_PUBLIC_ENV === "dev") {
//   console.log("💰 Payment Captured:", payment);
// }
//     // process.env.ENV === 'dev' && if (process.env.NEXT_PUBLIC_ENV === "dev") {
//   console.log("Amount:", payment.amount / 100);
// } // Convert paise to rupees
//     // process.env.ENV === 'dev' && if (process.env.NEXT_PUBLIC_ENV === "dev") {
//   console.log("Order ID:", payment.order_id);
// }
//     // process.env.ENV === 'dev' && if (process.env.NEXT_PUBLIC_ENV === "dev") {
//   console.log("Customer:", payment.email);
// }

//     // Update your booking status in database
//     // await HostPayout.findOneAndUpdate(
//     //   { razorpayOrderId: payment.order_id },
//     //   {
//     //     paymentStatus: 'captured',
//     //     razorpayPaymentId: payment.id,
//     //     paidAt: new Date()
//     //   }
//     // );

//     process.env.ENV === 'dev' && if (process.env.NEXT_PUBLIC_ENV === "dev") {
//   console.log("✅ Booking payment status updated");
// }
//   } catch (error) {
//     console.error("❌ Error handling payment.captured:", error);
//   }
// }

// async function handlePaymentInitiated(payment) {
//     process.env.ENV === 'dev' && if (process.env.NEXT_PUBLIC_ENV === "dev") {
//   console.log("💰 Payment Captured:", payment);
// }
//   // process.env.ENV === 'dev' && if (process.env.NEXT_PUBLIC_ENV === "dev") {
//   console.log("❌ Payment Failed:", payment.id, payment.error_description);
// }
//   // Update booking status to failed
// }

// async function handlePayoutUpdated(payment) {
//   process.env.ENV === 'dev' && if (process.env.NEXT_PUBLIC_ENV === "dev") {
//   console.log("🔐 Payment Authorized:", payment);
// }
//   // Payment is authorized but not captured yet
// }

// async function handlePayoutPending(payout) {
//   process.env.ENV === 'dev' && if (process.env.NEXT_PUBLIC_ENV === "dev") {
//   console.log("✅ Payout Processed:", payout);
// }
//   // Your existing payout logic
// }

// async function handlePayoutRejected(payout) {
//   process.env.ENV === 'dev' && if (process.env.NEXT_PUBLIC_ENV === "dev") {
//   console.log("❌ Payout Failed:", payout);
// }
//   // Your existing payout failure logic
// }

// async function handlePayoutReversed(payout) {
//   process.env.ENV === 'dev' && if (process.env.NEXT_PUBLIC_ENV === "dev") {
//   console.log("🔄 Payout Reversed:", payout);
// }
// }

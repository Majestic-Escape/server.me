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
const razorpay = new Razorpay({
  key_id: "rzp_test_RRelkKgMDh3dun",
  key_secret: "gYeQi2lZFvXMMBRs1lWjGANA",
});

// const YOUR_KEY = "rzp_test_RRelkKgMDh3dun";
// const YOUR_SECRET = "gYeQi2lZFvXMMBRs1lWjGANA";

const auth = Buffer.from(
  `${razorpay.key_id.trim()}:${razorpay.key_secret.trim()}`
).toString("base64");
const API_URL = process.env.RAZORPAY_API;
// helper: parse "MM/DD/YYYY" or "M/D/YYYY"

// Usage in your route:

exports.fetch = async (req, res) => {
  try {
    const { paymentType, search, searchList, from, to } = req.query;
    const date = parseMDYToUTC(from, to);

    console.log(date.from, date.to);

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
          b.customerDetails.name.toLowerCase().includes(search.toLowerCase())
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
// Create a new order

exports.createOrder = async (req, res) => {
  try {
    const { bookingId, userId, currency, amount, propertyId } = req.body;

    // Validate amount
    if (!amount || amount < 100) {
      return res.status(400).json({
        success: false,
        error: "Amount must be at least 100 paisa (₹1)",
      });
    }

    //Find User Details
    const user = await User.findById(userId);
    const ObjectId = require("mongoose").Types.ObjectId;

    console.log("not nic", bookingId);

    // Create order with Razorpay
    const order = await razorpay.orders.create({
      amount,
      currency,
      receipt: `receipt_${Date.now()}`,
    });

    // Save order details to database
    const payment = new Payment({
      orderId: order.id,
      amount: order.amount,
      currency: order.currency,
      bookingId: bookingId,
      propertyId: propertyId,
      customerDetails: {
        name: user.firstName + " " + user.lastName,
        email: user.email,
        contact: user.phoneNumber,
      },
      status: "created",
    });
    await payment.save();

    res.json({
      success: true,
      data: order,
    });
  } catch (error) {
    console.error("Create order error:", error);
    res.status(500).json({
      success: false,
      error: "Failed to create order",
    });
  }
};
// Verify payment
exports.verifyPayment = async (req, res) => {
  try {
    const {
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature,
      paymentMethod,
    } = req.body;

    console.log("t0");
    // Verify signature
    const body = razorpay_order_id + "|" + razorpay_payment_id;
    const expectedSignature = crypto
      .createHmac("sha256", razorpay.key_secret)
      .update(body.toString())
      .digest("hex");

    console.log("t1");
    const isAuthentic = expectedSignature === razorpay_signature;
    const payment = await razorpay.payments.fetch(razorpay_payment_id);
    if (!payment) {
      return res
        .status(404)
        .json({ success: false, error: "Payment method not found" });
    }

    console.log("t2");
    if (isAuthentic) {
      // Update payment details in database
      const data = await Payment.findOneAndUpdate(
        { orderId: razorpay_order_id },
        {
          paymentId: razorpay_payment_id,
          paymentMethod: payment?.method,
          status: "paid",
        }
      );
      if (!data) {
        return res.status(404).json({ success: false, error: "Not found" });
      }

      res.status(200).json({
        success: true,
        data: data,
        message: "Payment verified successfully",
      });
    } else {
      // Update payment status to failed

      console.log("t3");
      await Payment.findOneAndUpdate(
        { orderId: razorpay_order_id },
        { status: "failed" }
      );

      res.status(400).json({
        success: false,
        error: "Invalid signature",
      });
    }
  } catch (error) {
    console.error("Payment verification error:", error);
    res.status(500).json({
      success: false,
      error: "Payment verification failed",
    });
  }
};
// Get payment details
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
    const payment = await Payment.findOne({
      bookingId: req.query.id,
    });

    if (!payment) {
      return res.status(404).json({
        success: false,
        error: "Payment not found",
      });
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
//     console.log("enter");
//     const bank = await BankDetail.find({ hostId: hostId });
//     if (!bank) {
//       return res.status(404).json({
//         success: false,
//         error: "Bank details not found",
//       });
//     }
//     console.log("enter2");
//     if (!amount || amount < 100) {
//       return res.status(400).json({
//         success: false,
//         error: "Amount too small. Minimum payout is ₹1",
//       });
//     }
//     console.log("enter3");
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
//     console.log("enter4");
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
const string = generateUniqueString();
async function initiatePayout(booking) {
  try {
    console.log("Entered payout", booking);
    if (!booking.price || booking.price < 100) {
      return { success: false, error: "Amount too small" };
    }
    console.log("Entered payout2");
    const bank = await BankDetail.findOne({ hostId: booking.hostId });
    if (!bank) {
      return { success: false, error: "Bank details not found" };
    }
    const host = await HostPayout.findOne({ bookingId: booking._id });
    if (!host) {
      return {
        success: false,
        error: "Host payout document details not found",
      };
    }
    console.log("amount", host.payout);
    console.log("Entered payout3");
    const payout = await axios.post(
      `${API_URL}/payouts`,
      {
        account_number: "2323230087607472",
        fund_account_id: bank.fundId,
        amount: 5000, // paise
        currency: "INR",
        mode: "IMPS",
        purpose: "payout",
        queue_if_low_balance: true,
        reference_id: `payout_${booking._id}_${Date.now()}`,
        narration: `Payout for booking ${booking._id}`,
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
          "X-Payout-Idempotency": string,
          Authorization: `Basic ${auth}`,
        },
      }
    );
    console.log("Entered payout4");
    if (!payout) {
      return { success: false, error: "Payout failed" };
    }

    return {
      success: true,
      data: payout.data,
      bookingId: booking._id,
    };
  } catch (error) {
    console.error("❌ Payout Error:", error);
    return {
      success: false,
      error: error.message || "Failed to create payout",
      bookingId: booking._id,
    };
  }
}
exports.createPayout = async (req, res) => {
  try {
    const { bookingId, propertyId, amount } = req.body;
    console.log("o", amount, bookingId, propertyId);
    if (!bookingId || !propertyId || !amount) {
      return res
        .status(400)
        .json({ success: false, error: "Missing parameter" });
    }

    // const config = await Configure.findById("68e64844519bdcd9e0db952d");
    // if (!config) {
    //   return res
    //     .status(404)
    //     .json({ success: false, error: "No configuration found" });
    // }

    const newAmount = Number(amount) - (3 / 100) * Number(amount);
    console.log("o1", config.razorpay);
    const data = new HostPayout({
      bookingId,
      propertyId,
      amount: newAmount,
      status: "pending",
    });
    await data.save();

    res.status(200).json({
      success: true,
      data: data,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message || "Failed to create payout",
    });
  }
};

cron.schedule("* * * * *", async () => {
  try {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const todayEnd = new Date();
    todayEnd.setHours(23, 59, 59, 999);

    const confirmedBookings = await Booking.find({
      status: "confirmed",
      checkIn: { $gte: todayStart, $lte: todayEnd },
    });

    console.log(
      `📅 Found ${confirmedBookings.length} bookings for payout today`
    );

    const results = [];
    for (const booking of confirmedBookings) {
      const result = await initiatePayout(booking);
      results.push(result);

      // Log each result
      if (result.success) {
        console.log(`✅ Payout successful for booking: ${booking._id}`);
      } else {
        console.log(
          `❌ Payout failed for booking: ${booking._id} - ${result.error}`
        );
      }
    }
    const successful = results.filter((r) => r.success).length;
    const failed = results.filter((r) => !r.success).length;

    console.log(
      `📊 Cron job completed: ${successful} successful, ${failed} failed`
    );
  } catch (err) {
    console.error("❌ Cron job error:", err.message);
  }
});

exports.update = async (req, res) => {
  try {
    const secret = "secret10142025";
    console.log("enter webhook");

    const signature = req.headers["x-razorpay-signature"];

    const shasum = crypto.createHmac("sha256", secret);
    shasum.update(req.body);
    const digest = shasum.digest("hex");

    if (digest === signature) {
      console.log("✅ Webhook verified!");
      const payload = JSON.parse(req.body.toString());
      console.log("Webhook Data:", payload);

      if (payload.event === "payout.processed") {
        const payoutData = payload.payload.payout.entity;
        console.log("Payout completed for:", payoutData.id);
      }

      res.status(200).json({ status: "ok" });
    } else {
      console.warn("⚠️ Invalid signature — ignoring webhook");
      res.status(400).send("Invalid signature");
    }
  } catch (error) {
    console.error("❌ Webhook Error:", error);
    res.status(500).json({ success: false, error: error.message });
  }
};

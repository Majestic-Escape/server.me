const mongoose = require("mongoose");

const paymentSchema = new mongoose.Schema({
  orderId: {
    type: String,
    required: true,
    unique: true,
  },
  paymentId: {
    type: String,
    unique: true,
    sparse: true,
  },
  amount: {
    type: Number,
    required: true,
  },

  currency: {
    type: String,
    default: "INR",
  },

  status: {
    type: String,
    enum: ["created", "paid", "failed", "refund initiated", "refunded"],
    default: "created",
  },
  bookingId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Booking",
    required: true,
  },
  propertyId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "ListingProperty",
    required: true,
  },
  paymentType: {
    type: String,
    enum: ["pay-in", "pay-out", "refunded"],
    default: "pay-in",
  },
  paymentMethod: {
    type: String,
    default: "unknown",
  },
  customerDetails: {
    name: String,
    email: String,
    contact: String,
  },
  // --- Batch S ---
  // Razorpay-side facts recorded at verification (status as fetched).
  razorpayStatus: { type: String, default: null },
  paidAt: { type: Date, default: null },
  // Refund bookkeeping: one refund per payment, recorded with the Razorpay
  // refund id so a retry can never issue a second refund.
  refundId: { type: String, default: null },
  refundAmount: { type: Number, default: null },
  refundInitiatedAt: { type: Date, default: null },
  refundedAt: { type: Date, default: null },
  createdAt: {
    type: Date,
    default: Date.now,
  },
});

// At most one open (created) order per booking: the order-creation lock.
paymentSchema.index(
  { bookingId: 1 },
  { unique: true, partialFilterExpression: { status: "created" } },
);

module.exports = mongoose.model("Payment", paymentSchema);

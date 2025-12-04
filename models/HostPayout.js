const mongoose = require("mongoose");

const HostPayoutSchema = new mongoose.Schema(
  {
    orderId: {
      type: String,

      unique: true,
    },
    paymentId: {
      type: String,
      unique: true,
      sparse: true,
    },
    paymentType: {
      type: String,
      enum: ["pay-in", "pay-out", "refunded"],
      default: "pay-out",
    },
    paymentMethod: {
      type: String,
      default: "unknown",
    },
    currency: {
      type: String,
      default: "INR",
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
    status: {
      type: String,
      enum: ["pending", "paid", "failed", "reversed", "authorized", "captured"],
      default: "pending",
    },
    amount: {
      type: Number,
      required: true,
    },
  },
  { timestamps: true }
);

const HostPayout = mongoose.model("HostPayout", HostPayoutSchema);

module.exports = HostPayout;

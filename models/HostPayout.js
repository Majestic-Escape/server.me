const mongoose = require("mongoose");

const HostPayoutSchema = new mongoose.Schema(
  {
    // Never set by any flow; kept for the existing documents' shape. The
    // old `unique: true` here would have refused every second payout row
    // (all null) had the index ever been built — it is not in production.
    orderId: { type: String },
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
    // pending: created locally (sent to the gateway once `paymentId` is set)
    // initiated / paid / rejected / reversed: mirrored from payout webhooks
    // failed: the gateway refused the payout (retried by the next cycle)
    status: {
      type: String,
      enum: ["pending", "paid", "rejected", "reversed", "initiated", "failed"],
      default: "pending",
    },
    amount: {
      type: Number,
      required: true,
    },
    // Batch S.1 — one payout per booking, exactly once at the gateway:
    // `reference` is sent as the gateway reference_id so an ambiguous
    // attempt (timeout, 5xx) can be looked up instead of repeated;
    // `lockedAt` is the claim taken by the running cycle; `attempts`
    // numbers the idempotency key of each gateway call.
    reference: { type: String, default: undefined },
    attempts: { type: Number, default: 0 },
    lockedAt: { type: Date, default: null },
    lastError: { type: String, default: null },
    lastAttemptAt: { type: Date, default: null },
  },
  { timestamps: true },
);

HostPayoutSchema.index({ bookingId: 1 }, { unique: true });

const HostPayout = mongoose.model("HostPayout", HostPayoutSchema);

module.exports = HostPayout;

const mongoose = require("mongoose");
const bookingSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  source: { type: String, enum: ["local", "ical"], default: "local" }, // 'ical' = imported
  action: { type: String, enum: ["user", "host"], default: "user" },
  sourceId: { type: String, default: null }, // UID from VEVENT to dedupe imports
  propertyId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "ListingProperty",
    required: true,
  },
  payment: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Payment",
  },
  hostId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  checkIn: { type: Date, required: true },
  checkOut: { type: Date, required: true },
  price: { type: Number, required: true },
  subTotal: { type: Number, required: true },
  currency: { type: String, default: "USD" },
  status: {
    type: String,
    enum: ["pending", "confirmed", "rejected", "cancelled"],
    default: "pending",
  },
  paymentStatus: {
    type: String,
    enum: ["paid", "unpaid", "refunded"],
    default: "unpaid",
  },
  flag: {
    type: Boolean,
    default: false,
  },
  cancellationPolicy: {
    type: String,
    enum: ["strict", "moderate", "flexible"],
    default: "moderate",
  },

  guests: {
    type: Number,
    default: 1,
  },
  adults: {
    type: Number,
    default: 1,
  },
  children: {
    type: Number,
  },
  infants: {
    type: Number,
    max: 5,
  },
  nights: {
    type: Number,
  },
  guestData: {
    adults: [
      {
        name: { type: String, required: true },
        age: { type: Number, required: false }, // Optional for adults
      },
    ],
    children: [
      {
        name: { type: String, required: true },
        age: { type: Number, required: true }, // Usually required for kids
      },
    ],
  },

  reviewed: {
    type: Boolean,
    default: false,
  },
  hostReviewed: {
    type: Boolean,
    default: false,
  },
  refundAmount: Number,
  // --- Batch S: server-authoritative fields ---
  // The quote the customer confirmed, in integer paise. Razorpay orders are
  // created from a *fresh* quote which must equal this; otherwise the customer
  // is asked to reconfirm (PRICE_CHANGED). A booking is never silently
  // repriced.
  quote: {
    basePrice: Number,
    nights: Number,
    subTotalPaise: Number,
    serviceFeePaise: Number,
    gstPaise: Number,
    totalPaise: Number,
    currency: { type: String, default: "INR" },
  },
  // While unpaid, the reserved nights are a hold that expires at this time.
  holdExpiresAt: { type: Date, default: null },
  // Optional client-supplied Idempotency-Key (unique when present).
  idempotencyKey: { type: String, default: undefined },
  // Side effects that must happen exactly once.
  notifications: {
    paidAt: { type: Date, default: null },
    confirmedAt: { type: Date, default: null },
  },
  // Set when a paid booking could not keep its nights (the hold expired and
  // another booking took them before payment completed). Admin attention.
  needsAttention: { type: String, default: null },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

bookingSchema.index({ idempotencyKey: 1 }, { unique: true, sparse: true });
bookingSchema.index({ propertyId: 1, checkIn: 1, checkOut: 1 });

const Booking = mongoose.model("Booking", bookingSchema);

module.exports = Booking;

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
  // SyncGuard: when an admin last moved the stay's dates (echo evidence)
  datesChangedAt: { type: Date, default: undefined },
  // Side effects that must happen exactly once.
  notifications: {
    paidAt: { type: Date, default: null },
    confirmedAt: { type: Date, default: null },
    attentionAt: { type: Date, default: null },
    // "<flow>:<recipient>" of every e-mail already delivered, so a retried
    // step never mails the same person twice (services/bookingNotifications.js).
    sent: { type: [String], default: [] },
  },
  // Operational queue (services/attention.js): set when money was taken but
  // the booking cannot be honoured as-is — "inventory_conflict" (the hold was
  // lost before payment completed) or "amount_mismatch" (the captured amount
  // is not the server quote). Cleared by an admin resolution, never
  // automatically; nothing is refunded or rebooked without a human.
  needsAttention: { type: String, default: null },
  attentionDetails: { type: mongoose.Schema.Types.Mixed, default: null },
  attentionResolvedAt: { type: Date, default: null },
  attentionResolution: { type: String, default: null },
  // --- SyncGuard (docs/syncguard.md §2.2): provenance of an imported
  // (source: "ical") row. One row per (connection, external key); the
  // availability readers keep using status/paymentStatus exactly as before.
  external: {
    type: new mongoose.Schema(
      {
        connectionId: { type: mongoose.Schema.Types.ObjectId, ref: "ExternalCalendar" },
        channel: String,
        key: String, // UID, or UID#date for recurrences / split duplicates
        uid: String,
        // blocking: active | missing (absent, awaiting confirmation) |
        //           orphaned (its connection was disconnected; kept until the host releases it)
        // released: cancelled | removed | released
        state: String,
        kind: String, // reserved | blocked | unknown (provider hint)
        fingerprint: String,
        firstSeenAt: Date,
        lastChangedAt: Date,
        missingSince: Date,
        missingSyncs: Number,
        missingMass: Boolean,
        // kept blocking while absent until the host confirms (the link was
        // replaced without the host saying so — legacy endpoint)
        hostHold: Boolean,
        releasedAt: Date,
        releaseReason: String,
        // Possible echo (services/calendarSync/echo.js): still blocks and
        // still conflicts; only withheld from propagation.
        echo: {
          suspect: Boolean,
          since: Date,
          uncoveredSince: Date,
          promotedAt: Date,
        },
        conflict: {
          at: Date,
          kind: String, // paid_booking | external_overlap
          withBookingIds: [mongoose.Schema.Types.ObjectId],
          nights: [String],
          // a possible echo carrying a verified provider block marker
          // (Airbnb "Not available"): shown to the host, no alert e-mail
          likelyMirror: Boolean,
          notifiedAt: Date,
          // every paid booking it collides with is in the admin queue
          adminFlaggedAt: Date,
          // the paid bookings already in the admin queue for this conflict
          adminFlaggedFor: { type: [mongoose.Schema.Types.ObjectId], default: undefined },
        },
        rev: { type: Number, default: 0 },
      },
      { _id: false },
    ),
    default: undefined,
  },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

bookingSchema.index({ idempotencyKey: 1 }, { unique: true, sparse: true });
bookingSchema.index({ propertyId: 1, checkIn: 1, checkOut: 1 });
bookingSchema.index({ needsAttention: 1 }, { partialFilterExpression: { needsAttention: { $type: "string" } } });
// SyncGuard: one row per external event per connection (database invariant).
// Created by scripts/syncguard-migrate.js --create-indexes.
bookingSchema.index(
  { "external.connectionId": 1, "external.key": 1 },
  { unique: true, name: "external_connection_key", partialFilterExpression: { "external.connectionId": { $exists: true } } },
);

const Booking = mongoose.model("Booking", bookingSchema);

module.exports = Booking;

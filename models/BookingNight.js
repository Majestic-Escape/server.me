const mongoose = require("mongoose");

// One row per (property, night) that is taken. The unique index on
// (propertyId, date) is the whole double-booking defence: two concurrent
// reservations for the same night cannot both insert, whatever the timing.
//
// `expiresAt` is set while the owning booking is an unpaid hold and cleared
// (null) once the booking is paid / a host block / an iCal import. Expiry is
// decided by comparing `expiresAt` with the current time inside the
// reservation logic (services/inventory.js) — never by Mongo's asynchronous
// TTL deletion — so an expired hold is reusable the moment it expires.
const bookingNightSchema = new mongoose.Schema(
  {
    propertyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ListingProperty",
      required: true,
    },
    // UTC midnight of the night (the check-in day of that night).
    date: { type: Date, required: true },
    bookingId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Booking",
      required: true,
    },
    kind: {
      type: String,
      enum: ["booking", "block", "ical"],
      default: "booking",
    },
    expiresAt: { type: Date, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

bookingNightSchema.index({ propertyId: 1, date: 1 }, { unique: true });
bookingNightSchema.index({ bookingId: 1 });

module.exports = mongoose.model("BookingNight", bookingNightSchema);

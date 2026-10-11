// SyncGuard transitions log (docs/syncguard.md §2.3).
//
// Why a collection: hosts and the team need to answer "why was this date
// blocked?" days later, and Vercel keeps runtime logs for an hour. Only
// *transitions* are written (an event appeared / changed / went missing /
// was released, a conflict, an anomaly, a connection change) — never one
// row per poll — so volume follows booking activity, not the schedule.
// No guest data: external UIDs are stored as a short hash.
const mongoose = require("mongoose");

const calendarSyncLogSchema = new mongoose.Schema({
  at: { type: Date, default: Date.now },
  propertyId: { type: mongoose.Schema.Types.ObjectId, ref: "ListingProperty", required: true },
  connectionId: { type: mongoose.Schema.Types.ObjectId, ref: "ExternalCalendar" },
  bookingId: { type: mongoose.Schema.Types.ObjectId, ref: "Booking" },
  channel: String,
  type: { type: String, required: true },
  uidHash: String,
  startDay: String,
  endDay: String,
  actorId: { type: mongoose.Schema.Types.ObjectId },
  details: { type: mongoose.Schema.Types.Mixed },
});

// Explain queries (property + time) and the rate limit on connect attempts.
calendarSyncLogSchema.index({ propertyId: 1, at: -1 });
calendarSyncLogSchema.index({ actorId: 1, type: 1, at: -1 }, { partialFilterExpression: { actorId: { $exists: true } } });
// Retention: 90 days.
calendarSyncLogSchema.index({ at: 1 }, { expireAfterSeconds: 90 * 24 * 3600, name: "ttl_90d" });

module.exports = mongoose.model("CalendarSyncLog", calendarSyncLogSchema);

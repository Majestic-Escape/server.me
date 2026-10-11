// SyncGuard scheduler liveness (docs/syncguard.md §5). One document
// (_id "scheduler"), written once per sweep — never per connection. No
// trigger is authoritative: Vercel cron, the external clock, demand triggers
// and in-process tickers all record here, so a dead clock shows up as an
// ageing `lastSweepFinishedAt` and a growing overdue backlog instead of
// silently looking healthy.
const mongoose = require("mongoose");

const calendarSyncStateSchema = new mongoose.Schema(
  {
    _id: { type: String },
    lastTriggerAt: Date,
    lastTriggerSource: String,
    lastSweepStartedAt: Date,
    lastSweepFinishedAt: Date,
    lastSweepSummary: { type: mongoose.Schema.Types.Mixed },
    lastFullSweepAt: Date,
    sweeps: { type: Number, default: 0 },
    clockAlertAt: Date, // last "sync clock stopped" e-mail to ops (at most one a day)
  },
  { collection: "calendarsyncstate", versionKey: false },
);

module.exports = mongoose.model("CalendarSyncState", calendarSyncStateSchema);

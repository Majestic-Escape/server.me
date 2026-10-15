// SyncGuard facade (docs/syncguard.md). The booking core only ever calls
// ensureVerified / recordPrevented / nudgeProperty; it never knows whether
// a source event came from iCal or (later) an OTA API adapter.
const mongoose = require("mongoose");
const ExternalCalendar = require("../../models/ExternalCalendar");
const Booking = require("../../models/Booking");
const ListingProperty = require("../../models/ListingProperty");
const engine = require("./engine");
const prebook = require("./prebook");
const connections = require("./connections");
const exportFeed = require("./exportFeed");
const health = require("./health");
const { background } = require("./util");

const VIEW_STALE_MS = 5 * 60_000;

// A guest opened a stay's calendar: refresh its connections older than
// 5 min in the background. Bounded per connection by lastSuccessAt, the
// lease and failure backoff — never blocks the page.
function nudgeProperty(propertyId, reason = "calendar_view") {
  if (!mongoose.isValidObjectId(propertyId)) return;
  background(engine.refreshProperty(propertyId, { olderThanMs: VIEW_STALE_MS, reason }), `nudge ${reason}`);
}

// Metric: a direct booking was refused because an imported OTA booking
// already holds the nights.
function recordPrevented(propertyId) {
  background(ExternalCalendar.updateMany({ propertyId, kind: "import", status: { $ne: "disconnected" } }, { $inc: { "stats.prebookPrevented": 1 } }), "record prevented");
}

// Admin overview (GET /calendarSync/admin/overview, the admin "Calendar
// sync" page): scheduler liveness, health distribution computed exactly as
// hosts see it (conflicts and cross-site overlaps included), totals, and
// the connections that need a look — listing title, state, reason, counts.
// Never a calendar URL, a feed token or guest data.
const PROBLEM_ORDER = ["BROKEN", "NEEDS_ATTENTION", "STALE", "DEGRADED", "PARTIAL", "PENDING", "HEALTHY"];
const MAX_PROBLEMS = 200;
async function adminOverview(now = new Date()) {
  const conns = await ExternalCalendar.find({ kind: "import", status: { $ne: "disconnected" } }).select("propertyId channel name status sync stats lastFetched createdAt").lean();
  const today = new Date(Math.floor(now.getTime() / 86_400_000) * 86_400_000);
  const LIVE = ["active", "missing", "orphaned"];
  const flag = (cond) => ({ $sum: { $cond: [cond, 1, 0] } });
  const isMirror = { $eq: ["$external.conflict.likelyMirror", true] };
  const agg = conns.length
    ? await Booking.aggregate([
        { $match: { "external.connectionId": { $in: conns.map((c) => c._id) }, source: "ical", "external.state": { $in: LIVE }, checkOut: { $gt: today } } },
        {
          $group: {
            _id: "$external.connectionId",
            missing: flag({ $eq: ["$external.state", "missing"] }),
            conflicts: flag({ $and: [{ $eq: ["$external.conflict.kind", "paid_booking"] }, { $not: [isMirror] }] }),
            overlaps: flag({ $and: [{ $eq: ["$external.conflict.kind", "external_overlap"] }, { $not: [isMirror] }] }),
            possibleOverlaps: flag({ $and: [{ $eq: ["$external.conflict.kind", "external_overlap"] }, isMirror] }),
          },
        },
      ])
    : [];
  const countsById = new Map(agg.map((a) => [String(a._id), a]));
  const byHealth = {};
  const byChannel = {};
  const totals = {};
  const problems = [];
  for (const c of conns) {
    const n = countsById.get(String(c._id)) || { missing: 0, conflicts: 0, overlaps: 0, possibleOverlaps: 0 };
    const h = health.inbound(c, { conflicts: n.conflicts, overlaps: n.overlaps }, now);
    byHealth[h.state] = (byHealth[h.state] || 0) + 1;
    byChannel[c.channel || "UNKNOWN"] = (byChannel[c.channel || "UNKNOWN"] || 0) + 1;
    for (const [k, v] of Object.entries(c.stats || {})) if (typeof v === "number") totals[k] = (totals[k] || 0) + v;
    const s = c.sync || {};
    if (h.state !== "HEALTHY" || n.missing || n.possibleOverlaps) {
      problems.push({
        connectionId: String(c._id),
        propertyId: String(c.propertyId),
        channel: c.channel || "GENERIC_ICAL",
        name: c.name || null,
        state: h.state,
        reason: h.reason || null,
        lastSuccessAt: s.lastSuccessAt || null,
        lastErrorCode: s.lastErrorCode || null,
        consecutiveFailures: s.consecutiveFailures || 0,
        anomaly: s.anomaly || null,
        missing: n.missing,
        conflicts: n.conflicts,
        overlaps: n.overlaps,
        possibleOverlaps: n.possibleOverlaps,
      });
    }
  }
  problems.sort((a, b) => PROBLEM_ORDER.indexOf(a.state) - PROBLEM_ORDER.indexOf(b.state) || new Date(a.lastSuccessAt || 0) - new Date(b.lastSuccessAt || 0));
  const shown = problems.slice(0, MAX_PROBLEMS);
  const titles = new Map((await ListingProperty.find({ _id: { $in: [...new Set(shown.map((p) => p.propertyId))] } }).select("title").lean()).map((l) => [String(l._id), l.title || null]));
  for (const p of shown) p.listingTitle = titles.get(p.propertyId) || null;
  return { connections: conns.length, byHealth, byChannel, totals, scheduler: await engine.schedulerStatus(now), problems: shown, problemCount: problems.length };
}

// Called by the daily Vercel cron BEFORE its own sweep: if the frequent
// clock has not run (the scheduler is late or stopped) while calendars are
// connected, e-mail ops — at most once a day. Bookings stay safe without
// it (commitment checks), but cross-OTA propagation slows down.
async function alertIfClockStale(now = new Date()) {
  const status = await engine.schedulerStatus(now);
  if (status.state === "HEALTHY") return { alerted: false, state: status.state };
  if (!(await ExternalCalendar.exists(engine.ACTIVE_CONNECTION))) return { alerted: false, state: status.state };
  const CalendarSyncState = require("../../models/CalendarSyncState");
  const dayAgo = new Date(now.getTime() - 20 * 3600_000);
  const claimed = await CalendarSyncState.findOneAndUpdate(
    { _id: "scheduler", $or: [{ clockAlertAt: null }, { clockAlertAt: { $exists: false } }, { clockAlertAt: { $lte: dayAgo } }] },
    { $set: { clockAlertAt: now } },
  );
  if (!claimed) return { alerted: false, state: status.state };
  const { alertEmails } = require("../attention");
  const emailer = require("../../utils/sendEmail");
  const text = `Calendar sync clock is ${status.state === "STALE" ? "stopped" : "running late"}: last sweep ${status.lastSweepFinishedAt ? new Date(status.lastSweepFinishedAt).toISOString() : "never"}, ${status.overdueConnections} calendar(s) overdue. Bookings stay protected (they re-check calendars first), but bookings taken on one site reach the others slowly. Check the GitHub clock workflow (CALENDAR_SYNC_CRON_SECRET, SYNCGUARD_SWEEP_URL) and the admin Calendar sync page.`;
  try {
    const subject = `Action needed: calendar sync clock is ${status.state === "STALE" ? "stopped" : "running late"}`;
    await Promise.all(alertEmails().map((email) => emailer.sendHostNotification(email, "Admin", text, { subject, tag: "Action needed" })));
  } catch (err) {
    await CalendarSyncState.updateOne({ _id: "scheduler" }, { $set: { clockAlertAt: claimed.clockAlertAt || null } });
    throw err;
  }
  return { alerted: true, state: status.state };
}

module.exports = {
  alertIfClockStale,
  ensureVerified: prebook.ensureVerified,
  recordPrevented,
  nudgeProperty,
  adminOverview,
  runDue: engine.runDue,
  syncConnection: engine.syncConnection,
  schedulerStatus: engine.schedulerStatus,
  startTicker: engine.startTicker,
  connections,
  exportFeed,
};

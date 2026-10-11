// Echo handling — transitive loop prevention (docs/syncguard.md §4).
//
// Evidence levels:
//   REFLECTED      — the event's UID is in Majestic's UID namespace: it is
//                    provably ours coming back. Dropped (reconcile.js).
//   POSSIBLE ECHO  — every night of the event is covered by nights Majestic
//                    exports to that same connection, or exported to it
//                    after our previous successful read of that feed
//                    (minus the OTA's own export lag — see recentSince).
//                    That is NOT proof: an OTA can genuinely
//                    double-sell exactly those dates. So a possible echo
//                    still blocks Majestic inventory, still raises a
//                    conflict when it overlaps a paid Majestic booking, and
//                    is only withheld from *propagation* to other OTAs —
//                    which is what breaks Airbnb → Majestic → Agoda →
//                    Majestic → Airbnb cycles, whatever an OTA does to UIDs
//                    or adjacent ranges (subset test, not equality).
//   GENUINE        — everything else.
// A possible echo is promoted to genuine once its nights have been covered
// neither by our export to its connection nor by any other connection's
// live import for PROMOTE_AFTER (6 h ≥ 2 × the slowest documented OTA
// refresh, Airbnb's 3 h): a real reflection disappears within that time, a
// real booking does not. The "other connections" test stops two mutual
// reflections from being promoted at the same moment (which would recreate
// the cycle).
//
// Whether an OTA ever *fetched* our feed is deliberately not used: a feed
// GET can come from the host, a monitor, a proxy, anyone with the URL.
const mongoose = require("mongoose");
const Booking = require("../../models/Booking");
const ExternalCalendar = require("../../models/ExternalCalendar");
const { hasVerifiedBlockMarker } = require("./channels");
const { DAY_MS, dayNum, utcDayNumber } = require("./util");
const inventory = require("../inventory");

const RECENT_MAX_MS = 72 * 3600 * 1000;
const EXPORT_LAG_MS = 3600 * 1000;
const PROMOTE_AFTER_MS = 6 * 3600 * 1000;
const LIVE = ["active", "missing", "orphaned"];

function addRange(set, startDay, endDay, today) {
  for (let d = Math.max(startDay, today); d < endDay; d++) set.add(d);
}

// How far back an export that has since been removed still explains a NEW
// event of this connection. A new event was absent at our previous
// successful read of the feed, so if it is a reflection the OTA copied it
// from something we exported after about then (less the OTA's own export
// lag). Nights freed before that cannot explain it: a real booking taken on
// them is genuine and propagates at once — the whole point of the sync.
// Clamped to [1 h, 72 h] (first sync, long outages: more caution).
function recentSince(connection, now) {
  const t = now.getTime();
  const lastOk = connection.sync && connection.sync.lastSuccessAt ? new Date(connection.sync.lastSuccessAt).getTime() : 0;
  const from = lastOk ? lastOk - EXPORT_LAG_MS : t - RECENT_MAX_MS;
  return new Date(Math.min(t - EXPORT_LAG_MS, Math.max(t - RECENT_MAX_MS, from)));
}

// Nights of what this connection's feed carries now (`current`), carried
// since recentSince (`recent`), and what other connections import
// (`others`). null when nothing is ever exported to this connection.
async function coverageFor({ connection, now = new Date(), propagation = true }) {
  const pid = new mongoose.Types.ObjectId(String(connection.propertyId));
  const destination = !!connection.secret;
  const legacyRows = await ExternalCalendar.find({ propertyId: pid, kind: "export", secret: { $type: "string" }, status: { $ne: "disconnected" } }).select("export.lastServedAt").lean();
  if (!destination && !legacyRows.length) return null;
  // An OTA can only reflect what it has fetched. A booking counts as "sent to
  // this OTA" only if one of its links was requested AFTER the booking
  // existed: Majestic bookings travel in the destination feed and in the
  // legacy feed, other OTAs' bookings only in the destination feed. (A
  // request proves nothing on its own — anyone with the link can make one —
  // but no request proves no reflection.)
  const servedAt = (x) => (x && x.lastServedAt ? new Date(x.lastServedAt).getTime() : 0);
  const destServed = destination ? servedAt(connection.export) : 0;
  const nativeServed = Math.max(destServed, ...legacyRows.map((r) => servedAt(r.export)));
  const today = utcDayNumber(now);
  const since = recentSince(connection, now);
  const from = new Date(today * DAY_MS);
  const current = new Set();
  const recent = new Set();
  const others = new Set();
  const natives = await Booking.find({
    propertyId: pid,
    source: { $nin: ["ical", "ical_parked"] }, // Majestic-native only (parked imports are imports)
    checkOut: { $gt: from },
    $and: [
      { $or: [{ paymentStatus: "paid" }, { action: "host" }] },
      { $or: [{ status: { $nin: ["rejected", "cancelled"] } }, { updatedAt: { $gte: since } }] },
    ],
  })
    .select("checkIn checkOut status createdAt notifications.paidAt datesChangedAt")
    .lean();
  for (const b of natives) {
    const n = inventory.nightsBetween(b.checkIn, b.checkOut);
    if (!n.length) continue;
    // exported from the moment it was paid (or created, for a host block) and
    // again with new dates after an admin date move
    const visibleSince = Math.max(...[b.createdAt, b.notifications && b.notifications.paidAt, b.datesChangedAt].map((d) => (d ? new Date(d).getTime() : 0)));
    if (nativeServed < visibleSince) continue; // never fetched since it existed with these dates
    const target = ["rejected", "cancelled"].includes(b.status) ? recent : current;
    addRange(target, utcDayNumber(n[0]), utcDayNumber(n[n.length - 1]) + 1, today);
  }
  const imports = await Booking.find({
    propertyId: pid,
    source: "ical",
    "external.connectionId": { $exists: true, $ne: connection._id },
    checkOut: { $gt: from },
    $or: [{ "external.state": { $in: LIVE } }, { "external.releasedAt": { $gte: since } }],
  })
    .select("checkIn checkOut external.state external.echo external.firstSeenAt external.lastChangedAt")
    .lean();
  for (const b of imports) {
    const live = LIVE.includes(b.external.state);
    const s = utcDayNumber(b.checkIn);
    const e = utcDayNumber(b.checkOut);
    if (live) addRange(others, s, e, today);
    // Only genuine imports are exported, and only by destination feeds —
    // and only reflected if that feed was fetched after the import appeared.
    if (!destination || !propagation || (b.external.echo && b.external.echo.suspect)) continue;
    if (destServed < new Date(b.external.lastChangedAt || b.external.firstSeenAt || 0).getTime()) continue;
    addRange(live ? current : recent, s, e, today);
  }
  return { current, recent, others };
}

function eligible(channel, summaryKind) {
  if (summaryKind === "reserved") return false; // provider says it is a reservation
  if (hasVerifiedBlockMarker(channel) && summaryKind !== "blocked") return false;
  return true;
}

function covered(event, sets, today) {
  if (!sets || !sets.length) return false;
  const lo = Math.max(dayNum(event.startDay), today);
  const hi = dayNum(event.endDay);
  if (hi <= lo) return false;
  for (let d = lo; d < hi; d++) if (!sets.some((s) => s && s.has(d))) return false;
  return true;
}

// Classification of a new/changed event.
function classify(event, channel, cov, today) {
  if (!cov || !eligible(channel, event.summaryKind)) return { possible: false };
  return { possible: covered(event, [cov.current, cov.recent], today) };
}

// Next echo state of an unchanged possible echo:
//   { keep: true } | { set: {...} } | { promote: true }
function review(row, event, cov, today, now) {
  const echo = row.external.echo || {};
  const stillCovered = cov && covered(event, [cov.current, cov.others], today);
  if (stillCovered) return echo.uncoveredSince ? { set: { "external.echo.uncoveredSince": null } } : { keep: true };
  if (!echo.uncoveredSince) return { set: { "external.echo.uncoveredSince": now } };
  if (now.getTime() - new Date(echo.uncoveredSince).getTime() >= PROMOTE_AFTER_MS) return { promote: true };
  return { keep: true };
}

module.exports = { coverageFor, recentSince, eligible, covered, classify, review, RECENT_MAX_MS, EXPORT_LAG_MS, PROMOTE_AFTER_MS, LIVE };

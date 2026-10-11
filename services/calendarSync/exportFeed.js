// Majestic → OTA feeds (docs/syncguard.md §4).
//
//   legacy feed (kind "export", every URL issued before SyncGuard):
//     Majestic-native events only — its destination is unknown.
//   destination feed (the `secret` of an import connection K):
//     Majestic-native events + genuine imports of every OTHER connection.
//     Never K's own imports (no echo to the origin), never echoes, never
//     unpaid checkout holds (a 30-minute intention must not block an OTA
//     for hours).
//
// Privacy: each event is "Not available" + dates. UIDs are opaque HMACs in
// Majestic's UID namespace (no ObjectId, no OTA UID), no DESCRIPTION, no
// guest data. The body is deterministic for unchanged state, so the ETag is
// stable and well-behaved OTAs get 304s.
const mongoose = require("mongoose");
const icalGen = require("ical-generator");
const ExternalCalendar = require("../../models/ExternalCalendar");
const Booking = require("../../models/Booking");
const inventory = require("../inventory");
const flags = require("./flags");
const engine = require("./engine");
const { exportUid, sha256, utcDayNumber, DAY_MS, background } = require("./util");
const { OUTBOUND_QUIET_MS } = require("./health");

const ical = icalGen.default;
const HORIZON_DAYS = 731;
const PULL_STALE_MS = 15 * 60_000;
const SERVED_WRITE_EVERY_MS = 2 * 60_000;
const TOKEN_RE = /^[A-Za-z0-9_-]{20,100}$/;

function classifyAgent(ua) {
  const s = String(ua || "");
  if (/airbnb/i.test(s)) return "Airbnb";
  if (/booking\.?com/i.test(s)) return "Booking.com";
  if (/agoda/i.test(s)) return "Agoda";
  if (/vrbo|homeaway|expedia/i.test(s)) return "Vrbo";
  if (/makemytrip|goibibo|go-?mmt/i.test(s)) return "MakeMyTrip";
  if (/google/i.test(s)) return "Google Calendar";
  if (/calendar|ical|dav/i.test(s)) return "Calendar app";
  return "Other";
}

async function feedItems({ row, now, propagation }) {
  const today = utcDayNumber(now);
  const pid = new mongoose.Types.ObjectId(String(row.propertyId));
  const from = new Date(today * DAY_MS);
  const to = new Date((today + HORIZON_DAYS) * DAY_MS);
  const items = [];
  const natives = await Booking.find({
    propertyId: pid,
    source: { $nin: ["ical", "ical_parked"] }, // Majestic-native only (parked imports are imports)
    status: { $nin: ["rejected", "cancelled"] },
    $or: [{ paymentStatus: "paid" }, { action: "host" }],
    checkOut: { $gt: from },
    checkIn: { $lt: to },
  })
    .select("_id checkIn checkOut createdAt")
    .lean();
  for (const b of natives) {
    const nights = inventory.nightsBetween(b.checkIn, b.checkOut);
    if (!nights.length) continue;
    items.push({ uid: exportUid("b", b._id), start: nights[0], end: new Date(nights[nights.length - 1].getTime() + DAY_MS), stamp: b.createdAt || new Date(0) });
  }
  if (row.kind === "import" && propagation) {
    const imports = await Booking.find({
      propertyId: pid,
      source: "ical",
      status: "confirmed",
      "external.connectionId": { $exists: true, $ne: row._id },
      "external.state": { $in: ["active", "missing", "orphaned"] }, // every blocking state
      "external.echo.suspect": { $ne: true }, // possible echoes are never propagated
      checkOut: { $gt: from },
      checkIn: { $lt: to },
    })
      .select("_id checkIn checkOut external.firstSeenAt")
      .lean();
    for (const b of imports) {
      items.push({ uid: exportUid("x", b._id), start: new Date(utcDayNumber(b.checkIn) * DAY_MS), end: new Date(utcDayNumber(b.checkOut) * DAY_MS), stamp: (b.external && b.external.firstSeenAt) || new Date(0) });
    }
  }
  items.sort((a, b) => a.start - b.start || (a.uid < b.uid ? -1 : 1));
  return items;
}

function render(items) {
  const cal = ical({ name: "Majestic Escape", prodId: { company: "Majestic Escape", product: "SyncGuard", language: "EN" }, ttl: 3600 });
  for (const it of items) {
    cal.createEvent({ id: it.uid, start: it.start, end: it.end, allDay: true, summary: "Not available", stamp: it.stamp, transparency: "OPAQUE" });
  }
  return cal.toString();
}

// → { status: 404 } | { status: 304, etag } | { status: 200, body, etag, scope }
async function serve(secret, { userAgent, ifNoneMatch, now = new Date(), nudge = true } = {}) {
  if (typeof secret !== "string" || !TOKEN_RE.test(secret)) return { status: 404 };
  const row = await ExternalCalendar.findOne({ secret, kind: { $in: ["export", "import"] } }).lean();
  if (!row) return { status: 404 };
  // A disconnected import connection still serves its feed: the OTA keeps
  // receiving Majestic's bookings (only the inbound side was stopped).
  if (row.status === "disconnected" && row.kind !== "import") return { status: 404 };
  const scope = row.kind === "import" ? "destination" : "legacy";
  const propagation = !(await flags.propagationOff());
  // The feed is answered from Majestic's database, never from a live OTA
  // fetch: one public GET must not fan out into blocking outbound requests.
  // It only nudges, in the background, the property's other connections
  // that are older than 15 min — bounded per connection by lastSuccessAt,
  // the lease and failure backoff, however often the feed is requested.
  if (scope === "destination" && propagation && nudge) {
    // liveClock: each background sync reads the clock when it actually runs
    // (a delayed one must not stamp rows with this request's time)
    background(engine.refreshProperty(row.propertyId, { olderThanMs: PULL_STALE_MS, excludeId: row._id, reason: "export_nudge", now, liveClock: true }), "export nudge");
  }
  const body = render(await feedItems({ row, now, propagation }));
  const etag = `"${sha256(body).slice(0, 32)}"`;
  const ex = row.export || {};
  const agent = classifyAgent(userAgent);
  const since = ex.lastServedAt ? now.getTime() - new Date(ex.lastServedAt).getTime() : Infinity;
  // A chat preview or a browser never hides that a calendar service fetched
  // the link recently (it would turn "in use" into "opened"); a calendar
  // service is recorded at once even right after such a request. Otherwise
  // at most one write per 2 min.
  const knownRecent = ex.lastServedAgent && ex.lastServedAgent !== "Other" && since <= OUTBOUND_QUIET_MS;
  if (!(agent === "Other" && knownRecent) && (since > SERVED_WRITE_EVERY_MS || agent !== ex.lastServedAgent)) {
    background(
      ExternalCalendar.updateOne({ _id: row._id }, { $set: { "export.lastServedAt": now, "export.lastServedAgent": agent }, $inc: { "export.servedCount": 1 } }),
      "record feed fetch",
    );
  }
  if (ifNoneMatch && String(ifNoneMatch).split(",").map((s) => s.trim()).includes(etag)) return { status: 304, etag, scope };
  return { status: 200, body, etag, scope };
}

module.exports = { serve, feedItems, render, classifyAgent, TOKEN_RE };

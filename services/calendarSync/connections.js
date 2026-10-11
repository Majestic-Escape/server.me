// Host-facing connection management (docs/syncguard.md §2.1, §8).
// Authorisation happens in the controller (connection → listing → host);
// everything here assumes the caller may act on `listing`.
const mongoose = require("mongoose");
const ExternalCalendar = require("../../models/ExternalCalendar");
const Booking = require("../../models/Booking");
const BookingNight = require("../../models/BookingNight");
const CalendarSyncLog = require("../../models/CalendarSyncLog");
const channels = require("./channels");
const { safeFetch, normaliseUrl } = require("./safeFetch");
const { parseIcs } = require("./icsReader");
const engine = require("./engine");
const health = require("./health");
const journal = require("./journal");
const { hostRelease } = require("./reconcile");
const { newToken, sha256, maskUrl, waitAtMost, utcDayNumber, DAY_MS, dayStr } = require("./util");

const MAX_CONNECTIONS_PER_LISTING = 10;
const maxConnectionsPerHost = () => Number(process.env.SYNC_MAX_CONNECTIONS_PER_HOST) || 100;
const CONNECT_ATTEMPTS_PER_10_MIN = 20;
const MANUAL_SYNC_EVERY_MS = 60_000;
const INLINE_SYNC_WAIT_MS = 8_000;
// A link the site itself says no longer exists (404/410 — an OTA "reset
// link"), persistently: at least 3 failures in a row and nothing good for
// 6 h. 401/403 never count (bot walls and throttling answer 403 too).
const RESET_LINK_FAILURES = 3;
const RESET_LINK_MS = 6 * 3600_000;
function looksReset(c, now) {
  const s = c.sync || {};
  const lastGood = new Date(s.lastSuccessAt || c.createdAt || 0).getTime();
  return s.lastErrorCode === "NOT_FOUND" && (s.consecutiveFailures || 0) >= RESET_LINK_FAILURES && now.getTime() - lastGood >= RESET_LINK_MS;
}
const ACTIVE_ROWS = ["active", "missing"];
const BLOCKING_ROWS = ["active", "missing", "orphaned"];

class ConnError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

// The feed lives under /api/v1; PUBLIC_HOSTNAME is expected to include it,
// and is completed when it does not (a URL handed to an OTA must resolve).
function feedUrl(secret, req) {
  if (!secret) return null;
  let base = (process.env.PUBLIC_HOSTNAME || (req ? `${req.protocol}://${req.get("host")}` : "")).replace(/\/+$/, "");
  if (!/\/api\/v1$/.test(base)) base += "/api/v1";
  return `${base}/calendarSync/ics/${secret}.ics`;
}
function cleanName(v, fallback) {
  const s = typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f<>]/g, "").trim().slice(0, 60) : "";
  return s || fallback;
}
function urlHashOf(url) {
  return sha256(url);
}

async function activeConnections(propertyId) {
  return ExternalCalendar.find({ propertyId, kind: "import", status: { $ne: "disconnected" } }).lean();
}
// Legacy rows have no urlHash: compare on the normalised URL.
async function findSameUrl(propertyId, url) {
  const hash = urlHashOf(url);
  const rows = await activeConnections(propertyId);
  return rows.find((r) => {
    if (r.urlHash) return r.urlHash === hash;
    try {
      return urlHashOf(normaliseUrl(r.url)) === hash;
    } catch {
      return false;
    }
  });
}

// Downloads and parses without touching the database ("Test").
async function testUrl(url, channel, now) {
  const res = await safeFetch(url);
  const parsed = parseIcs(res.body, { now, channel });
  return { res, parsed };
}
function testSummary(parsed) {
  const blocking = parsed.events.filter((e) => e.status !== "cancelled" && !e.transparent);
  return {
    upcomingEvents: blocking.length,
    blockedNights: blocking.reduce((n, e) => n + Math.max(0, Math.round((Date.parse(e.endDay) - Date.parse(e.startDay)) / DAY_MS)), 0),
    warnings: ["unsupportedRule", "unknownTz", "invalid", "duplicateUid", "tooManyExceptions"].filter((k) => parsed.stats[k]),
  };
}
function fail(err) {
  if (err instanceof ConnError) throw err;
  if (err && typeof err.code === "string") throw new ConnError(422, err.code, health.message(err.code));
  throw err;
}

async function rateLimitConnect(actorId, now) {
  if (!actorId || !mongoose.isValidObjectId(actorId)) return;
  const recent = await CalendarSyncLog.countDocuments({ actorId, type: "connect_attempt", at: { $gte: new Date(now.getTime() - 10 * 60_000) } });
  if (recent >= CONNECT_ATTEMPTS_PER_10_MIN) throw new ConnError(429, "TOO_MANY_ATTEMPTS", "Too many connection attempts. Please wait a few minutes.");
}

async function connect({ listing, actorId, channel: wanted, name, url: rawUrl, now = new Date() }) {
  await rateLimitConnect(actorId, now);
  let url;
  const channel = channels.isChannel(wanted) ? wanted : channels.inferChannel(rawUrl);
  const logAttempt = (ok, code) => journal.record([{ type: "connect_attempt", propertyId: listing._id, actorId, channel, details: { ok, code } }]);
  try {
    url = normaliseUrl(rawUrl);
  } catch (err) {
    await logAttempt(false, err.code);
    fail(err);
  }
  if (await findSameUrl(listing._id, url)) throw new ConnError(409, "ALREADY_CONNECTED", "This calendar is already connected to this listing.");
  if ((await activeConnections(listing._id)).length >= MAX_CONNECTIONS_PER_LISTING) throw new ConnError(409, "TOO_MANY_CONNECTIONS", `A listing can have up to ${MAX_CONNECTIONS_PER_LISTING} calendar connections.`);
  // Bounds what one account can make Majestic fetch (listings are cheap to create).
  if (listing.host && (await ExternalCalendar.countDocuments({ hostId: listing.host, kind: "import", status: "active" })) >= maxConnectionsPerHost()) {
    throw new ConnError(409, "TOO_MANY_CONNECTIONS", `An account can have up to ${maxConnectionsPerHost()} calendar connections. Contact us if you need more.`);
  }
  let tested;
  try {
    tested = await testUrl(url, channel, now);
  } catch (err) {
    await logAttempt(false, err.code);
    fail(err);
  }
  await logAttempt(true);
  // Reconnecting a calendar this listing had disconnected revives that
  // connection, so the blocks it kept (orphaned) are synced again instead
  // of being duplicated.
  const previous = await ExternalCalendar.findOne({ propertyId: listing._id, kind: "import", status: "disconnected", urlHash: urlHashOf(url) }).sort({ disconnectedAt: -1 }).lean();
  if (previous) {
    // The OTA still has this connection's Majestic link saved (it kept
    // working while disconnected): keep it, unless the host stopped it. The
    // write is conditional on the link read here, so a "Stop link" landing
    // in between is never undone (re-read and retried).
    let prev = previous;
    for (let attempt = 0; ; attempt++) {
      if (!prev || prev.status !== "disconnected") throw new ConnError(409, "ALREADY_CONNECTED", "This calendar is already connected to this listing.");
      let res;
      try {
        res = await ExternalCalendar.updateOne(
          { _id: prev._id, status: "disconnected", secret: prev.secret ? prev.secret : { $exists: false } },
          {
            $set: { url, channel, name: cleanName(name, channels.label(channel)), status: "active", exportScope: "destination", secret: prev.secret || newToken(), sync: { nextSyncAt: now, firstAttemptAt: now }, updatedAt: now },
            $unset: { disconnectedAt: "", disconnectReason: "", disconnectMode: "", etag: "", lastModified: "", ...(prev.secret ? {} : { export: "" }) },
          },
        );
      } catch (err) {
        if (err && err.code === 11000) throw new ConnError(409, "ALREADY_CONNECTED", "This calendar is already connected to this listing.");
        throw err;
      }
      if (res.matchedCount) break;
      if (attempt >= 2) throw new ConnError(409, "CONFLICT", "This calendar changed while reconnecting. Please try again.");
      prev = await ExternalCalendar.findById(previous._id).lean();
    }
    await Booking.updateMany({ "external.connectionId": previous._id, "external.state": "orphaned" }, { $set: { "external.state": "active", updatedAt: now }, $inc: { "external.rev": 1 } });
    await journal.record([{ type: "connection_reconnected", propertyId: listing._id, connectionId: previous._id, channel, actorId }]);
    const resync = engine.syncConnection(previous._id, { force: true, prefetched: tested, reason: "reconnect", now });
    const state = await waitAtMost(resync, INLINE_SYNC_WAIT_MS, "reconnect sync");
    return { id: previous._id, test: testSummary(tested.parsed), syncState: state, reconnected: true };
  }
  let doc;
  try {
    doc = await ExternalCalendar.create({
      propertyId: listing._id,
      kind: "import",
      url,
      urlHash: urlHashOf(url),
      channel,
      name: cleanName(name, channels.label(channel)),
      hostId: listing.host,
      status: "active",
      exportScope: "destination",
      secret: newToken(),
      sync: { nextSyncAt: now, firstAttemptAt: now },
      stats: {},
      createdAt: now,
      updatedAt: now,
    });
  } catch (err) {
    if (err && err.code === 11000) throw new ConnError(409, "ALREADY_CONNECTED", "This calendar is already connected to this listing.");
    throw err;
  }
  await journal.record([{ type: "connection_created", propertyId: listing._id, connectionId: doc._id, channel, actorId }]);
  const sync = engine.syncConnection(doc._id, { force: true, prefetched: tested, reason: "connect", now });
  const state = await waitAtMost(sync, INLINE_SYNC_WAIT_MS, "connect sync");
  return { id: doc._id, test: testSummary(tested.parsed), syncState: state };
}

async function update({ conn, listing, actorId, name, channel, url: rawUrl, now = new Date(), prefetched = null }) {
  const set = { updatedAt: now };
  if (name !== undefined) set.name = cleanName(name, channels.label(conn.channel || "GENERIC_ICAL"));
  if (channel !== undefined) {
    if (!channels.isChannel(channel)) throw new ConnError(400, "VALIDATION", "Unknown calendar provider");
    set.channel = channel;
  }
  let tested = null;
  if (rawUrl !== undefined) {
    let url;
    try {
      url = normaliseUrl(rawUrl);
    } catch (err) {
      fail(err);
    }
    const same = await findSameUrl(listing._id, url);
    if (same && String(same._id) !== String(conn._id)) throw new ConnError(409, "ALREADY_CONNECTED", "This calendar is already connected to this listing.");
    if (!same) {
      try {
        tested = prefetched || (await testUrl(url, set.channel || conn.channel || channels.inferChannel(url), now));
      } catch (err) {
        fail(err);
      }
      // The lease is revoked too: a sync of the OLD calendar still in flight
      // must not stamp this connection "verified just now" (its finish is
      // conditional on its lease token, so it now writes nothing) — and the
      // new calendar is synced right below instead of being skipped as busy.
      Object.assign(set, { url, urlHash: urlHashOf(url), etag: null, lastModified: null, "sync.contentHash": null, "sync.nextSyncAt": now, "sync.consecutiveFailures": 0, "sync.lastErrorCode": null, "sync.alertedAt": null, "sync.leaseToken": null, "sync.leaseUntil": null });
    }
  }
  const res = await ExternalCalendar.updateOne({ _id: conn._id, status: { $ne: "disconnected" } }, { $set: set });
  if (!res.matchedCount) throw new ConnError(404, "NOT_FOUND", "Connection not found");
  if (tested) {
    await journal.record([{ type: "url_changed", propertyId: listing._id, connectionId: conn._id, channel: set.channel || conn.channel, actorId }]);
    // Events of the old calendar now go missing and are released only after
    // the usual confirmation — never in one step.
    await waitAtMost(engine.syncConnection(conn._id, { force: true, prefetched: tested, reason: "url_changed", now }), INLINE_SYNC_WAIT_MS, "url change sync");
  }
  return { ok: true, test: tested ? testSummary(tested.parsed) : null };
}

async function syncNow({ conn, now = new Date() }) {
  const ok = await ExternalCalendar.updateOne(
    { _id: conn._id, status: { $ne: "disconnected" }, $or: [{ "sync.manualAt": null }, { "sync.manualAt": { $exists: false } }, { "sync.manualAt": { $lte: new Date(now.getTime() - MANUAL_SYNC_EVERY_MS) } }] },
    { $set: { "sync.manualAt": now } },
  );
  if (!ok.modifiedCount) throw new ConnError(429, "SYNC_RATE_LIMITED", "This calendar was just synced. Try again in a minute.", { retryAfterSeconds: 60 });
  const p = engine.syncConnection(conn._id, { force: true, reason: "manual", now });
  let result = null;
  // Both outcomes handled: a rejection here would be an unhandled one and
  // take the process down (waitAtMost logs the failure itself).
  p.then(
    (r) => {
      result = r;
    },
    () => {},
  );
  const state = await waitAtMost(p, INLINE_SYNC_WAIT_MS, "manual sync");
  return { state, result };
}

async function rotate({ conn, listing, actorId, now = new Date() }) {
  const secret = newToken();
  const res = await ExternalCalendar.updateOne(
    { _id: conn._id, kind: conn.kind, status: { $ne: "disconnected" } },
    { $set: { secret, "export.rotatedAt": now, updatedAt: now }, $unset: { "export.hostConfirmedAt": "" } },
  );
  if (!res.matchedCount) throw new ConnError(404, "NOT_FOUND", "Connection not found");
  await journal.record([{ type: "token_rotated", propertyId: listing._id, connectionId: conn._id, channel: conn.channel, actorId }]);
  return { secret };
}

async function confirmExport({ conn, now = new Date() }) {
  await ExternalCalendar.updateOne({ _id: conn._id, status: { $ne: "disconnected" } }, { $set: { "export.hostConfirmedAt": now } });
}

async function futureBlocks(connectionId, states, now) {
  const today = new Date(utcDayNumber(now) * DAY_MS);
  const rows = await Booking.find({ "external.connectionId": connectionId, "external.state": { $in: states }, checkOut: { $gt: today } }).select("checkIn checkOut nights").lean();
  return { blocks: rows.length, nights: rows.reduce((n, r) => n + (r.nights || 0), 0) };
}

// Disconnecting a calendar does NOT make its dates safe to sell: the OTA may
// still be taking reservations Majestic can no longer see. So:
//   * the host must acknowledge exactly that (acknowledge: true);
//   * by default every imported block stays, as "orphaned" — still blocking
//     Majestic and still forwarded to the other channels — until the host
//     releases it explicitly (releaseOrphaned) or reconnects the calendar;
//   * releaseBlocks: true releases them now, for when the OTA listing is no
//     longer selling; that is a separate, explicit choice;
//   * the connection row and every event row are kept for the audit trail.
async function disconnect({ conn, listing, actorId, acknowledge, releaseBlocks = false, now = new Date() }) {
  if (acknowledge !== true) {
    const pending = await futureBlocks(conn._id, ACTIVE_ROWS, now);
    throw new ConnError(400, "ACK_REQUIRED", "Confirm that you understand bookings taken on this website will no longer reach Majestic.", pending);
  }
  const mode = releaseBlocks === true ? "release" : "keep";
  // Stop every future sync first (atomic). A sync already running re-checks
  // the status after reconciling and applies the same choice (engine.js).
  const res = await ExternalCalendar.updateOne(
    { _id: conn._id, status: { $ne: "disconnected" } },
    // The OUTBOUND link (secret) is kept: the OTA must keep seeing the
    // Majestic bookings, or it would sell those nights again. Only the
    // inbound side stops. The host can stop the link later (stopExport);
    // reconnecting the same calendar keeps it.
    { $set: { status: "disconnected", disconnectedAt: now, disconnectReason: "host", disconnectMode: mode, updatedAt: now }, $unset: { url: "", etag: "", lastModified: "" } },
  );
  if (!res.matchedCount) throw new ConnError(404, "NOT_FOUND", "Connection not found");
  let kept = 0;
  let released = 0;
  if (mode === "release") {
    released = (await hostRelease({ connectionId: conn._id, states: ["active", "missing", "orphaned"], reason: "host_released_on_disconnect", now })).released;
  } else {
    const r = await Booking.updateMany({ "external.connectionId": conn._id, "external.state": { $in: ACTIVE_ROWS } }, { $set: { "external.state": "orphaned", updatedAt: now }, $inc: { "external.rev": 1 } });
    kept = r.modifiedCount;
  }
  await journal.record([{ type: "disconnected", propertyId: listing._id, connectionId: conn._id, channel: conn.channel, actorId, details: { mode, kept, released } }]);
  return { mode, kept, released };
}

// Stops the Majestic link of a DISCONNECTED import (the token is a
// credential: it must stay revocable). The OTA then stops receiving
// Majestic's bookings — the host is warned in the panel first.
async function stopExport({ conn, listing, actorId, now = new Date() }) {
  const res = await ExternalCalendar.updateOne(
    { _id: conn._id, kind: "import", status: "disconnected", secret: { $type: "string" } },
    { $unset: { secret: "", "export.hostConfirmedAt": "" }, $set: { "export.stoppedAt": now, updatedAt: now } },
  );
  if (!res.matchedCount) {
    // already stopped (a double click, another tab): nothing left to do
    const already = await ExternalCalendar.exists({ _id: conn._id, kind: "import", status: "disconnected", secret: { $exists: false } });
    if (already) return { stopped: true };
    throw new ConnError(404, "NOT_FOUND", "Connection not found");
  }
  await journal.record([{ type: "export_stopped", propertyId: listing._id, connectionId: conn._id, channel: conn.channel, actorId }]);
  return { stopped: true };
}

// Host confirms that blocks Majestic can no longer verify were cancelled:
//   orphaned rows of a disconnected connection, or rows the live feed no
//   longer shows (missing — awaiting automatic confirmation).
async function releaseBlocks({ conn, listing, actorId, acknowledge, now = new Date() }) {
  const states = conn.status === "disconnected" ? ["orphaned"] : ["missing"];
  if (acknowledge !== true) {
    throw new ConnError(400, "ACK_REQUIRED", "Confirm that these bookings were cancelled on the other website.", await futureBlocks(conn._id, states, now));
  }
  const { released } = await hostRelease({ connectionId: conn._id, states, reason: conn.status === "disconnected" ? "host_released_orphaned" : "host_confirmed_cancelled", now });
  await journal.record([{ type: "host_released", propertyId: listing._id, connectionId: conn._id, channel: conn.channel, actorId, details: { states, released } }]);
  return { released };
}

// --- legacy POST /calendarSync/saveCalendar (web + mobile app) --------------
async function legacyExport({ listing, req, now = new Date() }) {
  let row = await ExternalCalendar.findOne({ propertyId: listing._id, kind: "export", canonical: true, status: { $ne: "disconnected" } }).lean();
  if (!row) {
    // Before SyncGuard several rows could exist; the oldest is the one the
    // host was most likely shown. Every legacy secret keeps working.
    row = await ExternalCalendar.findOne({ propertyId: listing._id, kind: "export", secret: { $type: "string" }, status: { $ne: "disconnected" } }).sort({ _id: 1 }).lean();
    if (row) {
      await ExternalCalendar.updateOne({ _id: row._id }, { $set: { canonical: true, exportScope: "legacy" } }).catch(() => {});
      return { existing: true, url: feedUrl(row.secret, req), secret: row.secret };
    }
    try {
      row = await ExternalCalendar.findOneAndUpdate(
        { propertyId: listing._id, kind: "export", canonical: true },
        { $setOnInsert: { secret: newToken(), exportScope: "legacy", createdAt: now } },
        { upsert: true, new: true },
      ).lean();
    } catch (err) {
      if (!(err && err.code === 11000)) throw err;
      row = await ExternalCalendar.findOne({ propertyId: listing._id, kind: "export", canonical: true }).lean();
    }
    return { existing: false, url: feedUrl(row.secret, req), secret: row.secret };
  }
  return { existing: true, url: feedUrl(row.secret, req), secret: row.secret };
}

async function legacyImport({ listing, actorId, url: rawUrl, now = new Date() }) {
  let url;
  try {
    url = normaliseUrl(rawUrl);
  } catch (err) {
    fail(err);
  }
  const same = await findSameUrl(listing._id, url);
  if (same) {
    // Re-saving the same link (the mobile app does it on every save) syncs at
    // most once a minute, under the same limit as "Sync now".
    const due = await ExternalCalendar.updateOne(
      { _id: same._id, status: { $ne: "disconnected" }, $or: [{ "sync.manualAt": null }, { "sync.manualAt": { $exists: false } }, { "sync.manualAt": { $lte: new Date(now.getTime() - MANUAL_SYNC_EVERY_MS) } }] },
      { $set: { "sync.manualAt": now } },
    );
    if (due.modifiedCount) await waitAtMost(engine.syncConnection(same._id, { force: true, reason: "legacy_resave", now }), INLINE_SYNC_WAIT_MS, "legacy resave sync");
    return { existing: true };
  }
  // The legacy clients (mobile app, old web page) can only ADD a link. A host
  // who copies a fresh link after the OTA reset the old one would otherwise
  // end up with two connections — the dead one refusing every booking — and
  // no way to remove it from the app. So a new link of the same site
  // REPLACES a connection of that site only when (1) the site has said for
  // hours that the old link does not exist (looksReset) and (2) the new link
  // is provably the same listing: it shows at least one event the old link
  // ever showed (any state, past stays included). No evidence — the old link
  // never showed anything, rate limits, 403s, outages, another listing — and
  // the new link is added beside it (the dead one keeps refusing bookings:
  // over-blocking, never a double booking).
  // The old link's bookings the new one does not show keep blocking until
  // the host confirms them (hostHold): the host never said "replace".
  const channel = channels.inferChannel(url);
  if (channel !== "GENERIC_ICAL") {
    const candidates = await ExternalCalendar.find({ propertyId: listing._id, kind: "import", status: { $ne: "disconnected" }, channel }).lean();
    const dead = candidates.find((c) => looksReset(c, now));
    if (dead) {
      await rateLimitConnect(actorId, now);
      const logAttempt = (ok, code) => journal.record([{ type: "connect_attempt", propertyId: listing._id, actorId, channel, details: { ok, code, replace: true } }]);
      let tested;
      try {
        tested = await testUrl(url, channel, now);
      } catch (err) {
        await logAttempt(false, err.code);
        fail(err);
      }
      await logAttempt(true);
      const newUids = new Set(tested.parsed.events.filter((e) => e.status !== "cancelled" && e.uid).map((e) => e.uid));
      // evidence: a stay still blocking, or one released in the last 90 days
      // (a UID seen long ago proves little)
      const seen = newUids.size
        ? await Booking.exists({
            "external.connectionId": dead._id,
            "external.uid": { $in: [...newUids] },
            $or: [{ "external.state": { $in: ACTIVE_ROWS } }, { "external.releasedAt": { $gte: new Date(now.getTime() - 90 * 86_400_000) } }],
          })
        : null;
      if (seen) {
        // Hold first, then switch the URL: if anything fails in between, the
        // worst left behind is a hold (over-blocking), never an unheld switch.
        // only rows not already held (an earlier replacement may hold some):
        // those are the ones to undo if the switch fails
        const toHold = (await Booking.find({ "external.connectionId": dead._id, "external.state": { $in: ACTIVE_ROWS }, "external.uid": { $nin: [...newUids] }, "external.hostHold": { $ne: true } }).select("_id").lean()).map((r) => r._id);
        if (toHold.length) await Booking.updateMany({ _id: { $in: toHold } }, { $set: { "external.hostHold": true, updatedAt: now }, $inc: { "external.rev": 1 } });
        try {
          await update({ conn: dead, listing, actorId, url, now, prefetched: tested });
        } catch (err) {
          if (toHold.length) await Booking.updateMany({ _id: { $in: toHold } }, { $set: { "external.hostHold": false, updatedAt: new Date() }, $inc: { "external.rev": 1 } }).catch(() => {});
          throw err;
        }
        return { existing: true, replaced: true };
      }
    }
  }
  await connect({ listing, actorId, url, now });
  return { existing: false };
}

// --- reads ---------------------------------------------------------------------
async function rowCounts(propertyId, now) {
  const today = new Date(utcDayNumber(now) * DAY_MS);
  const agg = await Booking.aggregate([
    { $match: { propertyId: new mongoose.Types.ObjectId(String(propertyId)), source: "ical", "external.connectionId": { $exists: true }, "external.state": { $in: BLOCKING_ROWS }, checkOut: { $gt: today } } },
    {
      $group: {
        _id: "$external.connectionId",
        active: { $sum: { $cond: [{ $eq: ["$external.state", "active"] }, 1, 0] } },
        missing: { $sum: { $cond: [{ $eq: ["$external.state", "missing"] }, 1, 0] } },
        orphaned: { $sum: { $cond: [{ $eq: ["$external.state", "orphaned"] }, 1, 0] } },
        mirrors: { $sum: { $cond: [{ $and: [{ $eq: ["$external.conflict.kind", "paid_booking"] }, { $eq: ["$external.conflict.likelyMirror", true] }] }, 1, 0] } },
        conflicts: { $sum: { $cond: [{ $and: [{ $eq: ["$external.conflict.kind", "paid_booking"] }, { $ne: ["$external.conflict.likelyMirror", true] }] }, 1, 0] } },
        overlaps: { $sum: { $cond: [{ $and: [{ $eq: ["$external.conflict.kind", "external_overlap"] }, { $ne: ["$external.conflict.likelyMirror", true] }] }, 1, 0] } },
        possibleOverlaps: { $sum: { $cond: [{ $and: [{ $eq: ["$external.conflict.kind", "external_overlap"] }, { $eq: ["$external.conflict.likelyMirror", true] }] }, 1, 0] } },
        echoes: { $sum: { $cond: [{ $eq: ["$external.echo.suspect", true] }, 1, 0] } },
        nights: { $sum: { $ifNull: ["$nights", 0] } },
      },
    },
  ]);
  return new Map(agg.map((a) => [String(a._id), a]));
}

// Overall protection of one connection — both directions, honestly:
//   ACTION_REQUIRED  inbound broken, a conflict, or a suspicious mass disappearance
//   DEGRADED         inbound stale/failing/pending, or Majestic → OTA not set up
//   HEALTHY          inbound verified recently AND the OTA has requested our feed
function protection(inbound, outbound) {
  if (["BROKEN", "NEEDS_ATTENTION"].includes(inbound.state)) return "ACTION_REQUIRED";
  if (["STALE", "DEGRADED", "PENDING", "PARTIAL"].includes(inbound.state)) return "DEGRADED";
  if (!["ACTIVE"].includes(outbound.state)) return "DEGRADED";
  return "HEALTHY";
}

function serialize(conn, counts, req, now) {
  const c = counts.get(String(conn._id)) || { active: 0, missing: 0, orphaned: 0, conflicts: 0, overlaps: 0, possibleOverlaps: 0, mirrors: 0, echoes: 0, nights: 0 };
  const s = conn.sync || {};
  const ex = conn.export || {};
  const channel = conn.channel || channels.inferChannel(conn.url);
  const inbound = health.inbound(conn, { conflicts: c.conflicts, overlaps: c.overlaps }, now);
  let outbound = health.outbound(conn, now);
  if (outbound.state === "ACTIVE" || outbound.state === "QUIET") {
    if (ex.rotatedAt && new Date(ex.lastServedAt) < new Date(ex.rotatedAt)) outbound = { state: ex.hostConfirmedAt ? "WAITING" : "NOT_CONFIRMED" };
  }
  return {
    id: String(conn._id),
    channel,
    channelLabel: channels.label(channel),
    name: conn.name || channels.label(channel),
    importUrl: conn.url ? maskUrl(conn.url) : null,
    legacy: !conn.urlHash,
    health: inbound,
    protection: protection(inbound, outbound),
    // Commitment policy (prebook.js): a calendar that cannot be re-verified
    // at booking time stops direct bookings of this listing.
    // Restricted as soon as the last check failed: a booking re-reads this
    // calendar first and is refused while it cannot be read.
    bookingRestricted: inbound.state === "BROKEN" || ((conn.sync && conn.sync.consecutiveFailures) || 0) > 0,
    sync: {
      lastAttemptAt: s.lastAttemptAt || conn.lastFetched || null,
      lastSuccessAt: s.lastSuccessAt || null,
      lastChangeAt: s.lastChangeAt || null,
      nextSyncAt: s.nextSyncAt || null,
      consecutiveFailures: s.consecutiveFailures || 0,
      lastError: s.lastErrorCode ? { code: s.lastErrorCode, message: health.message(s.lastErrorCode), at: s.lastErrorAt || null } : null,
      eventCount: s.eventCount ?? null,
      warnings: s.warnings || [],
    },
    counts: { active: c.active, missing: c.missing, conflicts: c.conflicts, overlaps: c.overlaps || 0, possibleOverlaps: c.possibleOverlaps || 0, likelyMirrors: c.mirrors, echoes: c.echoes, nights: c.nights },
    export: {
      url: feedUrl(conn.secret, req),
      state: outbound.state,
      lastServedAt: ex.lastServedAt || null,
      lastServedAgent: ex.lastServedAgent || null,
      hostConfirmedAt: ex.hostConfirmedAt || null,
      rotatedAt: ex.rotatedAt || null,
    },
    createdAt: conn.createdAt || (conn._id.getTimestamp ? conn._id.getTimestamp() : null),
  };
}

async function list({ listing, req, now = new Date() }) {
  const [conns, counts, legacyRow, gone] = await Promise.all([
    activeConnections(listing._id),
    rowCounts(listing._id, now),
    ExternalCalendar.findOne({ propertyId: listing._id, kind: "export", secret: { $type: "string" }, status: { $ne: "disconnected" } }).sort({ canonical: -1, _id: 1 }).lean(),
    ExternalCalendar.find({ propertyId: listing._id, kind: "import", status: "disconnected" }).select("channel name disconnectedAt secret export").lean(),
  ]);
  const connections = conns.sort((a, b) => String(a._id).localeCompare(String(b._id))).map((c) => serialize(c, counts, req, now));
  const rank = { HEALTHY: 0, DEGRADED: 1, ACTION_REQUIRED: 2 };
  const overall = connections.reduce((w, c) => (rank[c.protection] > rank[w] ? c.protection : w), "HEALTHY");
  return {
    overall: connections.length ? overall : "NONE",
    disconnected: gone
      .map((g) => ({
        id: String(g._id),
        channel: g.channel,
        channelLabel: channels.label(g.channel),
        name: g.name || channels.label(g.channel),
        disconnectedAt: g.disconnectedAt || null,
        orphanedBlocks: (counts.get(String(g._id)) || {}).orphaned || 0,
        // its Majestic link still serves (the OTA keeps seeing Majestic bookings)
        linkLive: typeof g.secret === "string",
        linkLastServedAt: (g.export && g.export.lastServedAt) || null,
      }))
      .filter((g) => g.orphanedBlocks > 0 || g.linkLive),
    providers: channels.publicProviders(),
    capability: {
      unitModel: "single_unit",
      note: "iCal shares only busy or free dates. Majestic treats every listing as one bookable unit, which matches how Airbnb, Booking.com, Agoda and Vrbo calendar sync work.",
    },
    connections,
    legacyFeed: legacyRow
      ? { url: feedUrl(legacyRow.secret, req), lastServedAt: (legacyRow.export && legacyRow.export.lastServedAt) || null, scope: "majestic_only" }
      : null,
  };
}

async function revokeLegacy({ listing, actorId, now = new Date() }) {
  const res = await ExternalCalendar.updateMany({ propertyId: listing._id, kind: "export", status: { $ne: "disconnected" } }, { $set: { status: "disconnected", disconnectedAt: now, disconnectReason: "host" }, $unset: { secret: "", canonical: "" } });
  await journal.record([{ type: "legacy_feed_revoked", propertyId: listing._id, actorId, details: { rows: res.modifiedCount } }]);
  return { revoked: res.modifiedCount };
}

// "Why is this date unavailable?" — current owner(s) + provenance + history.
async function explain({ listing, date, now = new Date() }) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || "")) || Number.isNaN(Date.parse(`${date}T00:00:00Z`))) throw new ConnError(400, "VALIDATION", "date must be YYYY-MM-DD");
  const day = new Date(`${date}T00:00:00.000Z`);
  const next = new Date(day.getTime() + DAY_MS);
  const pid = listing._id;
  const [night, overlapping, conns, history] = await Promise.all([
    BookingNight.findOne({ propertyId: pid, date: day }).lean(),
    Booking.find({ propertyId: pid, status: { $nin: ["rejected", "cancelled"] }, checkIn: { $lt: next }, checkOut: { $gt: day } })
      .select("source action status paymentStatus checkIn checkOut createdAt holdExpiresAt external")
      .lean(),
    ExternalCalendar.find({ propertyId: pid, kind: "import" }).select("channel name status sync").lean(),
    CalendarSyncLog.find({ propertyId: pid, startDay: { $lte: date }, endDay: { $gt: date }, at: { $gte: new Date(now.getTime() - 90 * DAY_MS) } })
      .sort({ at: -1 })
      .limit(50)
      .lean(),
  ]);
  const connById = new Map(conns.map((c) => [String(c._id), c]));
  const reasons = overlapping
    .filter((b) => b.source === "ical" || b.paymentStatus === "paid" || b.action === "host" || (b.holdExpiresAt && b.holdExpiresAt > now))
    .map((b) => {
      const owner = night && String(night.bookingId) === String(b._id);
      const range = { checkIn: dayStr(utcDayNumber(b.checkIn)), checkOut: dayStr(utcDayNumber(b.checkOut)) };
      if (b.source === "ical") {
        const ex = b.external || {};
        const c = ex.connectionId ? connById.get(String(ex.connectionId)) : null;
        return {
          type: "external",
          channel: ex.channel || (c && c.channel) || null,
          channelLabel: channels.label(ex.channel || (c && c.channel)),
          connectionName: c ? c.name || channels.label(c.channel) : null,
          kind: ex.kind || "unknown",
          state: ex.state || "active",
          echo: !!(ex.echo && ex.echo.suspect),
          conflict: ex.conflict && ex.conflict.at ? { kind: ex.conflict.kind, at: ex.conflict.at } : null,
          firstSeenAt: ex.firstSeenAt || b.createdAt || null,
          lastChangedAt: ex.lastChangedAt || null,
          missingSince: ex.missingSince || null,
          sourceLastSyncedAt: c && c.sync ? c.sync.lastSuccessAt || null : null,
          ownsNight: owner,
          ...range,
        };
      }
      if (b.action === "host") return { type: "host_block", ownsNight: owner, createdAt: b.createdAt, ...range };
      if (b.paymentStatus !== "paid") return { type: "checkout_hold", until: b.holdExpiresAt, ownsNight: owner, ...range };
      return { type: "majestic_booking", status: b.status, createdAt: b.createdAt, ownsNight: owner, ...range };
    });
  return {
    date,
    available: !night && reasons.length === 0,
    reasons,
    timeline: history.map((h) => ({ at: h.at, type: h.type, channel: h.channel || null, channelLabel: h.channel ? channels.label(h.channel) : null, startDay: h.startDay || null, endDay: h.endDay || null })),
  };
}

module.exports = { ConnError, connect, update, syncNow, rotate, confirmExport, disconnect, releaseBlocks, legacyExport, legacyImport, list, revokeLegacy, explain, feedUrl, MAX_CONNECTIONS_PER_LISTING, stopExport };

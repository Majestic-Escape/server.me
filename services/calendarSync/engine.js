// SyncGuard scheduler/engine (docs/syncguard.md §5).
//
// There is no process to keep a timer in (server.me is a Vercel function),
// so the schedule lives in the database: every import connection has
// `sync.nextSyncAt`. Any trigger — the daily Vercel cron, an external
// clock, a stay-calendar view, an OTA fetching our feed, a booking attempt,
// a host action — calls into this module; none is authoritative. Work is
// done only on connections that are due, one worker per connection (a
// 5-minute lease taken with one conditional update; an expired lease is
// reclaimable, so a crashed worker never locks a connection for good).
// Every sweep writes a heartbeat (models/CalendarSyncState.js) so a dead
// clock is visible as an ageing sweep and a growing overdue backlog.
const crypto = require("node:crypto");
const mongoose = require("mongoose");
const ExternalCalendar = require("../../models/ExternalCalendar");
const ListingProperty = require("../../models/ListingProperty");
const Booking = require("../../models/Booking");
const BookingNight = require("../../models/BookingNight");
const CalendarSyncState = require("../../models/CalendarSyncState");
const { safeFetch, isPermanent } = require("./safeFetch");
const { parseIcs } = require("./icsReader");
const { reconcile, hostRelease, LIVE } = require("./reconcile");
const flags = require("./flags");
const journal = require("./journal");
const notify = require("./notify");
const health = require("./health");
const { pool, platformDeadline } = require("./util");

const LEASE_MS = 5 * 60_000;
const intervalMs = () => (Number(process.env.SYNC_INTERVAL_MINUTES) || 15) * 60_000;
const BACKOFF_BASE_MS = 5 * 60_000;
const BACKOFF_MAX_MS = 6 * 3600_000;
const FULL_EVERY_MS = 20 * 3600_000;
const OVERDUE_GRACE_MS = 5 * 60_000;

function jittered(ms) {
  return Math.round(ms * (0.8 + Math.random() * 0.4)); // ±20 %: no thundering herd
}
function backoffMs(failures, retryAfter) {
  let ms = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, failures - 1));
  const ra = Number(retryAfter);
  if (Number.isFinite(ra) && ra > 0) ms = Math.max(ms, Math.min(BACKOFF_MAX_MS, ra * 1000));
  return jittered(ms);
}

const ACTIVE_CONNECTION = { kind: "import", status: { $ne: "disconnected" }, url: { $type: "string" } };
const leaseFree = (now) => ({ $or: [{ "sync.leaseUntil": null }, { "sync.leaseUntil": { $lte: now } }] });
const isDue = (now) => ({ $or: [{ "sync.nextSyncAt": null }, { "sync.nextSyncAt": { $lte: now } }] });

async function claim(connectionId, { force, now }) {
  const token = crypto.randomBytes(12).toString("hex");
  const and = [{ _id: connectionId }, ACTIVE_CONNECTION, leaseFree(now)];
  if (!force) and.push(isDue(now));
  const conn = await ExternalCalendar.findOneAndUpdate(
    { $and: and },
    { $set: { "sync.leaseUntil": new Date(now.getTime() + LEASE_MS), "sync.leaseToken": token, "sync.lastAttemptAt": now } },
    { new: true },
  ).lean();
  if (!conn) return null;
  if (!conn.sync.firstAttemptAt) await ExternalCalendar.updateOne({ _id: conn._id, "sync.firstAttemptAt": null }, { $set: { "sync.firstAttemptAt": now } });
  if (!conn.channel) conn.channel = require("./channels").inferChannel(conn.url);
  return { conn, token };
}

// Releases the lease — only if it is still ours (a worker whose lease
// expired and was re-taken must not overwrite the newer worker's state).
async function finish(conn, token, set, inc) {
  const res = await ExternalCalendar.updateOne(
    { _id: conn._id, "sync.leaseToken": token },
    { $set: { ...set, "sync.leaseUntil": null, "sync.leaseToken": null, updatedAt: new Date() }, ...(inc ? { $inc: inc } : {}) },
  );
  if (!res.matchedCount) journal.log("lease_lost", { connectionId: String(conn._id) }, "warn");
  return res.matchedCount > 0;
}
function incStats(obj) {
  const inc = {};
  for (const [k, v] of Object.entries(obj)) if (v) inc[`stats.${k}`] = v;
  return inc;
}

// The listing was deleted while a connection still existed: withdraw the
// imports exactly as the old sync did, and retire the connection.
async function retireForMissingListing(conn) {
  const rows = await Booking.find({ propertyId: conn.propertyId, source: "ical" }).select("_id").lean();
  for (const r of rows) {
    await BookingNight.deleteMany({ bookingId: r._id });
    await Booking.deleteOne({ _id: r._id });
  }
  await ExternalCalendar.updateOne({ _id: conn._id }, { $set: { status: "disconnected", disconnectedAt: new Date(), disconnectReason: "listing_deleted", "sync.leaseUntil": null, "sync.leaseToken": null } });
  journal.log("listing_gone", { connectionId: String(conn._id), propertyId: String(conn.propertyId), withdrawn: rows.length }, "warn");
}

// A host disconnected while this sync was reconciling: apply the host's
// choice to whatever the sync just added.
async function applyDisconnectAfterRace(connectionId, now) {
  const c = await ExternalCalendar.findById(connectionId).select("status disconnectMode").lean();
  if (!c || c.status !== "disconnected") return;
  if (c.disconnectMode === "release") await hostRelease({ connectionId, states: LIVE, reason: "host_released_on_disconnect", now });
  else await Booking.updateMany({ "external.connectionId": connectionId, "external.state": { $in: ["active", "missing"] } }, { $set: { "external.state": "orphaned", updatedAt: now }, $inc: { "external.rev": 1 } });
}

// Syncs one connection. Options:
//   force      — run even if not due (host actions, freshness checks); leases still apply
//   full       — unconditional fetch + night-ownership repair
//   prefetched — { res, parsed } from the connect test (no second download)
//   deadline   — absolute ms for the fetch
async function syncConnection(connectionId, { force = false, full = false, unconditional = false, prefetched = null, reason = "schedule", now = new Date(), deadline } = {}) {
  // Every caller passes a database id; anything else is refused, never thrown
  // (an unhandled rejection takes the whole server process down).
  if (!(connectionId instanceof mongoose.Types.ObjectId) && !/^[0-9a-fA-F]{24}$/.test(String(connectionId))) return { skipped: "invalid_id" };
  if (await flags.syncPaused()) return { skipped: "paused" };
  const claimed = await claim(new mongoose.Types.ObjectId(String(connectionId)), { force, now });
  if (!claimed) return { skipped: "not_due_or_busy" };
  const { conn, token } = claimed;
  const started = Date.now();
  const listing = await ListingProperty.findById(conn.propertyId).select("host hostEmail title").lean();
  if (!listing) {
    await retireForMissingListing(conn);
    return { ok: false, code: "LISTING_GONE" };
  }
  const s = conn.sync || {};
  try {
    let res = prefetched && prefetched.res;
    // Pending work (confirmations, echo reviews, owed admin flags) needs a
    // reconciliation, which a 304 would skip: fetch the whole calendar.
    const plain = full || unconditional || (s.pendingMissing || 0) > 0 || (s.pendingEchoes || 0) > 0 || (s.pendingFlags || 0) > 0;
    if (!res) {
      res = await safeFetch(conn.url, {
        etag: plain ? null : conn.etag,
        lastModified: plain ? null : conn.lastModified ? new Date(conn.lastModified).toUTCString() : null,
        deadline: deadline || undefined,
      });
    }
    const common = {
      "sync.lastSuccessAt": now,
      "sync.consecutiveFailures": 0,
      "sync.lastErrorCode": null,
      "sync.nextSyncAt": new Date(now.getTime() + jittered(intervalMs())),
      "sync.alertedAt": null,
      lastFetched: now,
    };
    // 304: nothing to read. Rows awaiting confirmation still need their
    // counters advanced, which only a 200 can do — so they force a full fetch
    // on the next run instead.
    if (res.status === 304) {
      const kept304 = await finish(conn, token, { ...common, "sync.lastHttpStatus": 304, "sync.lastDurationMs": Date.now() - started, ...((s.pendingMissing || s.pendingEchoes || s.pendingFlags) ? { etag: null, lastModified: null } : {}) }, incStats({ attempts: 1, successes: 1, notModified: 1 }));
      if (!kept304) return { ok: false, code: "LEASE_LOST", aborted: true };
      if (s.consecutiveFailures) journal.record([{ type: "sync_recovered", propertyId: conn.propertyId, connectionId: conn._id, channel: conn.channel }]);
      return { ok: true, notModified: true };
    }
    const parsed = (prefetched && prefetched.parsed) || parseIcs(res.body, { now, channel: conn.channel });
    const changed = parsed.contentHash !== s.contentHash;
    let result = { stats: {}, pendingMissing: s.pendingMissing || 0, pendingEchoes: s.pendingEchoes || 0, pendingFlags: s.pendingFlags || 0, anomaly: s.anomaly || null };
    // Reconcile unless nothing can have changed: same meaning, no row
    // awaiting confirmation, no possible echo awaiting review, not a full pass.
    const mustReconcile = full || changed || !s.contentHash || (s.pendingMissing || 0) > 0 || (s.pendingEchoes || 0) > 0 || (s.pendingFlags || 0) > 0;
    if (mustReconcile) {
      // Fencing: if this worker was frozen past its lease (a suspended
      // serverless instance) another worker may already have applied a
      // NEWER response. Renew the lease with our token or abort without
      // writing — an old response must never be reconciled over newer
      // state. (Without reconciliation the token-conditional release below
      // is already fenced, so unchanged polls pay no extra write.)
      const renewed = await ExternalCalendar.findOneAndUpdate(
        { _id: conn._id, "sync.leaseToken": token },
        { $set: { "sync.leaseUntil": new Date(Date.now() + LEASE_MS) } },
        { projection: { _id: 1 } },
      ).lean();
      if (!renewed) {
        journal.log("lease_lost_before_reconcile", { connectionId: String(conn._id), reason }, "warn");
        return { ok: false, code: "LEASE_LOST", aborted: true };
      }
      const propagation = !(await flags.propagationOff());
      result = await reconcile({ conn, listing, parsed, now, mode: full ? "full" : "incremental", propagation });
      await applyDisconnectAfterRace(conn._id, now);
    }
    const st = result.stats || {};
    // A row write lost a race (a host release, another worker): this feed
    // was not fully applied, so it must be reconciled again next time —
    // neither the hash nor the validators may let the next poll skip it.
    const raced = (st.raced || 0) > 0;
    const set = {
      ...common,
      "sync.lastHttpStatus": 200,
      "sync.contentHash": raced ? null : parsed.contentHash,
      "sync.eventCount": parsed.events.length,
      "sync.pendingMissing": result.pendingMissing,
      "sync.pendingEchoes": result.pendingEchoes,
      "sync.pendingFlags": result.pendingFlags || 0,
      "sync.anomaly": result.anomaly,
      "sync.anomalyAt": result.anomaly ? s.anomalyAt || now : null,
      "sync.warnings": ["unsupportedRule", "unknownTz", "invalid", "tooManyExceptions"].filter((k) => parsed.stats[k]),
      "sync.lastDurationMs": Date.now() - started,
    };
    if (changed) set["sync.lastChangeAt"] = now;
    if (full) set["sync.lastFullAt"] = now;
    if (raced) {
      // Not fully applied: commitment checks must not trust this pass, and
      // the next attempt comes soon.
      Object.assign(set, { etag: null, lastModified: null, "sync.nextSyncAt": new Date(now.getTime() + 60_000) });
      delete set["sync.lastSuccessAt"];
    }
    else {
      if (res.headers && res.headers.etag) set.etag = res.headers.etag;
      if (res.headers && res.headers.lastModified && !Number.isNaN(Date.parse(res.headers.lastModified))) set.lastModified = new Date(res.headers.lastModified);
    }
    const kept = await finish(conn, token, set, incStats({ attempts: 1, successes: 1, unchanged: mustReconcile ? 0 : 1, added: st.added, modified: st.modified, removed: st.removed, cancelled: st.cancelled, missingPending: st.missingNew, echoes: st.echoes, promoted: st.promoted, reflected: st.reflected, conflicts: st.conflicts, holdsDisplaced: st.holdsDisplaced, repaired: st.repaired, raced: st.raced }));
    // Another worker took the lease while we were frozen: nothing of ours
    // was written (the release is token-conditional) — say so honestly.
    if (!kept) return { ok: false, code: "LEASE_LOST", aborted: true };
    if (s.consecutiveFailures) journal.record([{ type: "sync_recovered", propertyId: conn.propertyId, connectionId: conn._id, channel: conn.channel }]);
    if (result.anomaly && !s.anomaly) journal.record([{ type: "anomaly", propertyId: conn.propertyId, connectionId: conn._id, channel: conn.channel, details: { anomaly: result.anomaly } }]);
    if (result.anomaly) {
      // Tell the host once per episode (claim, then send; released on failure).
      const claimedAnomaly = await ExternalCalendar.updateOne({ _id: conn._id, "sync.anomalyAlertedAt": null }, { $set: { "sync.anomalyAlertedAt": now } });
      if (claimedAnomaly.modifiedCount) {
        await notify.anomaly({ listing, channel: conn.channel }).catch(async (e) => {
          console.error("[syncguard] anomaly e-mail failed", e.message);
          await ExternalCalendar.updateOne({ _id: conn._id }, { $set: { "sync.anomalyAlertedAt": null } });
        });
      }
    } else if (s.anomalyAlertedAt) {
      await ExternalCalendar.updateOne({ _id: conn._id }, { $set: { "sync.anomalyAlertedAt": null } });
    }
    journal.log("sync_ok", { connectionId: String(conn._id), channel: conn.channel, reason, full, changed, events: parsed.events.length, ms: Date.now() - started, ...st });
    return { ok: true, raced: raced > 0, changed, reconciled: mustReconcile, stats: st, parsedStats: parsed.stats, anomaly: result.anomaly };
  } catch (err) {
    const code = err && typeof err.code === "string" && /^[A-Z_]+$/.test(err.code) ? err.code : "INTERNAL";
    const failures = (s.consecutiveFailures || 0) + 1;
    const set = {
      "sync.consecutiveFailures": failures,
      "sync.lastErrorCode": code,
      "sync.lastErrorAt": now,
      "sync.lastHttpStatus": err && err.httpStatus ? err.httpStatus : null,
      "sync.nextSyncAt": new Date(now.getTime() + backoffMs(failures, err && err.retryAfter)),
      "sync.lastDurationMs": Date.now() - started,
    };
    await finish(conn, token, set, incStats({ attempts: 1, failures: 1 }));
    if (code === "INTERNAL") console.error("[syncguard] internal sync error", { connectionId: String(conn._id), message: err && err.message });
    journal.log("sync_failed", { connectionId: String(conn._id), channel: conn.channel, reason, code, failures }, failures >= 3 ? "warn" : "info");
    if (failures === 1) journal.record([{ type: "sync_failed", propertyId: conn.propertyId, connectionId: conn._id, channel: conn.channel, details: { code } }]);
    // Tell the host once per broken episode.
    const state = health.inbound({ ...conn, sync: { ...s, consecutiveFailures: failures, lastErrorCode: code } }, {}, now).state;
    if (state === "BROKEN" && !s.alertedAt) {
      const claimedAlert = await ExternalCalendar.updateOne({ _id: conn._id, "sync.alertedAt": null }, { $set: { "sync.alertedAt": now } });
      if (claimedAlert.modifiedCount) {
        journal.record([{ type: "connection_broken", propertyId: conn.propertyId, connectionId: conn._id, channel: conn.channel, details: { code } }]);
        await notify.broken({ listing, channel: conn.channel, message: health.message(code) }).catch(async (e) => {
          console.error("[syncguard] broken-connection e-mail failed", e.message);
          await ExternalCalendar.updateOne({ _id: conn._id }, { $set: { "sync.alertedAt": null } });
        });
      }
    }
    return { ok: false, code, permanent: isPermanent(code), failures };
  }
}

async function heartbeat(update) {
  try {
    await CalendarSyncState.updateOne({ _id: "scheduler" }, update, { upsert: true });
  } catch (err) {
    console.error("[syncguard] heartbeat write failed", err.message);
  }
}

// Works through due connections, oldest `nextSyncAt` first (index
// {kind, status, sync.nextSyncAt}); every processed connection is pushed
// ~15 min into the future, so the next run continues where this one
// stopped and nothing is starved. Leftovers stay due. `full`: connections
// whose last full pass is older than 20 h get one (the daily cron).
async function runDue({ budgetMs = 50_000, concurrency = 4, full = false, reason = "sweep", source = reason, now = () => new Date(), limit = Infinity, reserveMs = 15_000 } = {}) {
  const startedAt = new Date();
  await heartbeat({ $set: { lastTriggerAt: startedAt, lastTriggerSource: source, lastSweepStartedAt: startedAt } });
  const deadline = platformDeadline(budgetMs);
  const summary = { processed: 0, ok: 0, failed: 0, skipped: 0, notModified: 0, changed: 0, paused: false, budgetExhausted: false };
  if (await flags.syncPaused()) {
    summary.paused = true;
  } else {
    const seen = new Set();
    for (;;) {
      // Room for one fetch (10 s) plus reconciliation before the deadline.
      if (deadline - Date.now() <= reserveMs || summary.processed >= limit) {
        summary.budgetExhausted = true;
        break;
      }
      const t = now();
      const filter = full
        ? { $and: [ACTIVE_CONNECTION, leaseFree(t), { $or: [{ "sync.lastFullAt": null }, { "sync.lastFullAt": { $lte: new Date(t.getTime() - FULL_EVERY_MS) } }] }] }
        : { $and: [ACTIVE_CONNECTION, leaseFree(t), isDue(t)] };
      const take = Math.min(concurrency * 2, limit - summary.processed);
      const batch = (await ExternalCalendar.find(filter).sort(full ? { "sync.lastFullAt": 1, _id: 1 } : { "sync.nextSyncAt": 1, _id: 1 }).limit(take).select("_id").lean()).filter((c) => !seen.has(String(c._id)));
      if (!batch.length) break;
      batch.forEach((c) => seen.add(String(c._id)));
      const results = await pool(batch, concurrency, (c) => syncConnection(c._id, { force: full, full, reason, deadline: Math.min(deadline, Date.now() + 10_000) }));
      for (const r of results) {
        summary.processed += 1;
        if (r && r.ok) {
          summary.ok += 1;
          if (r.notModified) summary.notModified += 1;
          if (r.changed) summary.changed += 1;
        } else if (r && r.skipped) summary.skipped += 1;
        else summary.failed += 1;
      }
    }
  }
  const finishedAt = new Date();
  await heartbeat({ $set: { lastSweepFinishedAt: finishedAt, lastSweepSummary: { ...summary, reason, full, ms: finishedAt - startedAt }, ...(full ? { lastFullSweepAt: finishedAt } : {}) }, $inc: { sweeps: 1 } });
  journal.log("sweep", { reason, source, full, ...summary });
  return summary;
}

// Scheduler liveness, derived at read time (docs §5): when did any trigger
// last run a sweep, how many connections are overdue and since when.
async function schedulerStatus(now = new Date()) {
  const [state, overdue, oldest] = await Promise.all([
    CalendarSyncState.findById("scheduler").lean(),
    ExternalCalendar.countDocuments({ ...ACTIVE_CONNECTION, "sync.nextSyncAt": { $lte: new Date(now.getTime() - OVERDUE_GRACE_MS) } }),
    ExternalCalendar.findOne({ ...ACTIVE_CONNECTION, "sync.nextSyncAt": { $lte: new Date(now.getTime() - OVERDUE_GRACE_MS) } }).sort({ "sync.nextSyncAt": 1 }).select("sync.nextSyncAt").lean(),
  ]);
  const interval = intervalMs();
  const lastRun = state && state.lastSweepFinishedAt ? new Date(state.lastSweepFinishedAt).getTime() : null;
  const sinceRun = lastRun === null ? Infinity : now.getTime() - lastRun;
  const oldestOverdueMs = oldest && oldest.sync && oldest.sync.nextSyncAt ? now.getTime() - new Date(oldest.sync.nextSyncAt).getTime() : 0;
  let stateName = "HEALTHY";
  if (sinceRun > 4 * 3600_000 || oldestOverdueMs > 4 * 3600_000) stateName = "STALE";
  else if (sinceRun > 2 * interval || oldestOverdueMs > 2 * interval) stateName = "DEGRADED";
  return {
    state: stateName,
    lastTriggerAt: (state && state.lastTriggerAt) || null,
    lastTriggerSource: (state && state.lastTriggerSource) || null,
    lastSweepFinishedAt: (state && state.lastSweepFinishedAt) || null,
    lastFullSweepAt: (state && state.lastFullSweepAt) || null,
    lastSweepSummary: (state && state.lastSweepSummary) || null,
    overdueConnections: overdue,
    oldestOverdueMinutes: Math.round(oldestOverdueMs / 60_000),
    expectedIntervalMinutes: Math.round(interval / 60_000),
  };
}

// Refreshes the connections of one property older than `olderThanMs`.
// Respects failure backoff unless `ignoreBackoff`.
async function refreshProperty(propertyId, { olderThanMs, excludeId = null, ignoreBackoff = false, reason = "demand", now = new Date(), deadline, liveClock = false } = {}) {
  if (!mongoose.isValidObjectId(propertyId)) return { connections: 0, refreshed: 0, results: [] };
  const conns = await ExternalCalendar.find({ propertyId, ...ACTIVE_CONNECTION }).select("_id sync").lean();
  const targets = conns.filter((c) => {
    if (excludeId && String(c._id) === String(excludeId)) return false;
    const s = c.sync || {};
    if (s.lastSuccessAt && now.getTime() - new Date(s.lastSuccessAt).getTime() <= olderThanMs) return false;
    if (!ignoreBackoff && (s.consecutiveFailures || 0) > 0 && s.nextSyncAt && new Date(s.nextSyncAt) > now) return false;
    return true;
  });
  const results = await pool(targets, 4, (c) => syncConnection(c._id, { force: true, reason, now: liveClock ? new Date() : now, deadline }));
  return { connections: conns.length, refreshed: results.filter((r) => r && r.ok).length, results };
}

// Long-running hosts only (local dev, a future always-on deployment):
// SYNC_INPROCESS_INTERVAL_MS starts ONE unref'd ticker per process. Leases
// make any number of processes/replicas safe. Never on Vercel.
let ticker = null;
function startTicker() {
  const every = Number(process.env.SYNC_INPROCESS_INTERVAL_MS);
  if (ticker || !Number.isFinite(every) || every < 30_000 || process.env.VERCEL) return false;
  ticker = setInterval(() => {
    runDue({ budgetMs: Math.min(every - 5_000, 120_000), reason: "inprocess", source: "inprocess" }).catch((err) => console.error("[syncguard] ticker run failed", err.message));
  }, every);
  if (ticker.unref) ticker.unref();
  return true;
}
function stopTicker() {
  if (ticker) clearInterval(ticker);
  ticker = null;
}

module.exports = { syncConnection, runDue, refreshProperty, schedulerStatus, startTicker, stopTicker, LEASE_MS, backoffMs, ACTIVE_CONNECTION, intervalMs };

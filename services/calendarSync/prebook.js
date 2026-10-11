// Verification at the moment inventory is committed (docs/syncguard.md §7).
//
// Called by POST /booking (before the hold is taken) and by
// POST /payment/create-order (before money moves). Page views never wait.
//
// Policy (every Majestic listing is a single unit, so a second sale of an
// already-sold night is never acceptable — conversion comes second):
//   * a connection verified recently enough is trusted as is — 2 min when
//     a guest takes a 30-minute hold (Confirm), 30 s where a guest is
//     committed for real (Pay, an admin date move);
//   * any older connection is re-fetched now (fetch deadline 8 s) and the
//     booking waits for the outcome;
//   * if that required refresh fails or does not finish, the booking is
//     refused with 409 AVAILABILITY_UNVERIFIED — for instant AND
//     request-to-book listings — whatever the age of the last success.
//     Nothing is held or charged; the guest can retry, and the host can
//     disconnect a dead calendar (with the explicit warning, §5).
// Why these windows: direct bookings are rare (tens a month), so
// re-verifying costs at most one OTA request per connection per Confirm/Pay,
// and the latency (≈0.3–2 s for an .ics) is paid only by a guest about to
// pay. A Confirm only holds nights (no money, released at Pay if an OTA
// booking appears), so 2 min is enough there. At Pay — where a booking an
// OTA published moments ago would otherwise become a paid double booking —
// the window is 30 s: in practice every Pay re-reads the calendars; 30 s
// only lets a sync already in flight (or a double-click) count. What no
// window can cover is an OTA that has sold a night but not yet published it
// in its feed (docs §10).
const ExternalCalendar = require("../../models/ExternalCalendar");
const engine = require("./engine");
const flags = require("./flags");
const journal = require("./journal");
const { pool, sleep } = require("./util");

const MONEY_CONTEXTS = new Set(["create_order", "admin_modify"]);
const seconds = (name, fallback) => (process.env[name] !== undefined ? Number(process.env[name]) : fallback);
const commitFreshMs = (context) => (MONEY_CONTEXTS.has(context) ? seconds("PREBOOK_PAY_FRESH_SECONDS", 30) : seconds("PREBOOK_FRESH_SECONDS", 120)) * 1000;
const refreshTimeoutMs = () => Number(process.env.PREBOOK_REFRESH_TIMEOUT_MS) || 8_000;
const RECENT_FAILURE_MS = 30_000; // a source that failed seconds ago is not hammered again

async function load(propertyId) {
  return ExternalCalendar.find({ propertyId, ...engine.ACTIVE_CONNECTION }).select("_id channel name createdAt sync").lean();
}
function fresh(conn, now, context) {
  const ok = conn.sync && conn.sync.lastSuccessAt ? new Date(conn.sync.lastSuccessAt).getTime() : 0;
  return now - ok <= commitFreshMs(context);
}

// Re-verifies one connection; resolves true only on a fresh success.
async function verifyOne(conn, { context, start, deadline }) {
  const s = conn.sync || {};
  const recentFailure = s.consecutiveFailures > 0 && s.lastAttemptAt && start - new Date(s.lastAttemptAt).getTime() < RECENT_FAILURE_MS && (!s.lastSuccessAt || new Date(s.lastAttemptAt) > new Date(s.lastSuccessAt));
  if (recentFailure) return false;
  // Unconditional: a commitment never trusts a 304 (a wrong one would count as "verified now").
  let r = await engine.syncConnection(conn._id, { force: true, unconditional: true, reason: context, now: new Date(start), deadline });
  // A pass that lost a write race did not apply everything it read: read
  // again once; a second race means "not verified" (never trusted).
  if (r && r.ok && r.raced && Date.now() < deadline) r = await engine.syncConnection(conn._id, { force: true, unconditional: true, reason: context, now: new Date(), deadline });
  if (r && r.ok) return !r.raced;
  if (!(r && r.skipped === "not_due_or_busy")) return false;
  // Another worker holds the lease right now: wait for its outcome. Its
  // success is stamped with the time *it* started (seconds before this
  // booking), so the test is the policy itself: verified within the window.
  while (Date.now() < deadline) {
    await sleep(200);
    const c = await ExternalCalendar.findById(conn._id).select("sync").lean();
    if (!c) return false;
    if (fresh(c, Date.now(), context)) return true;
    const leased = c.sync && c.sync.leaseUntil && new Date(c.sync.leaseUntil) > new Date();
    if (!leased) return false;
  }
  return false;
}

// → { ok: true, connections, refreshed } | { ok: false, code: "AVAILABILITY_UNVERIFIED", channels }
// Calendars are imported up to HORIZON_DAYS ahead (icsReader). A stay that
// ends later cannot be checked against them, so a listing with connected
// calendars does not commit it.
const HORIZON_DAYS = 730;
const DAY = 86_400_000;
async function ensureVerified(propertyId, { context = "prebook", now = new Date(), checkOut = null } = {}) {
  const conns = await load(propertyId);
  if (!conns.length) return { ok: true, connections: 0, refreshed: 0 };
  if (checkOut) {
    const lastNight = Math.floor(new Date(checkOut).getTime() / DAY) - 1;
    if (Number.isFinite(lastNight) && lastNight > Math.floor(now.getTime() / DAY) + HORIZON_DAYS - 1) return { ok: false, code: "BEYOND_SYNC_HORIZON", channels: [...new Set(conns.map((c) => c.channel))] };
  }
  const stale = conns.filter((c) => !fresh(c, now.getTime(), context));
  let failed = [];
  if (stale.length) {
    if (await flags.syncPaused()) {
      failed = stale; // sync is paused by ops: nothing can be verified
    } else {
      const start = Date.now();
      const deadline = start + refreshTimeoutMs();
      const results = await pool(stale, 4, (c) => verifyOne(c, { context, start, deadline }));
      failed = stale.filter((_, i) => results[i] !== true);
    }
  }
  if (failed.length) {
    await ExternalCalendar.updateMany({ _id: { $in: failed.map((c) => c._id) } }, { $inc: { "stats.prebookRefused": 1 } });
    journal.log("prebook_refused", { propertyId: String(propertyId), context, channels: failed.map((c) => c.channel) }, "warn");
    journal.record([{ type: "prebook_refused", propertyId, details: { context, connections: failed.map((c) => String(c._id)) } }]);
    return { ok: false, code: "AVAILABILITY_UNVERIFIED", channels: [...new Set(failed.map((c) => c.channel))] };
  }
  await ExternalCalendar.updateMany({ _id: { $in: conns.map((c) => c._id) } }, { $inc: { "stats.prebookChecks": 1 } });
  return { ok: true, connections: conns.length, refreshed: stale.length };
}

module.exports = { ensureVerified, commitFreshMs, HORIZON_DAYS };

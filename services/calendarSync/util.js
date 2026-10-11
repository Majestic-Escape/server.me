// Small shared helpers for SyncGuard.
const crypto = require("node:crypto");

const DAY_MS = 86_400_000;
// Every event Majestic exports carries a UID in this namespace, so an event
// of ours coming back through another calendar is recognisable (§4). Never
// change it: old exports would stop being recognised.
const UID_DOMAIN = "sync.majesticescape.in";

// HMAC key for exported UIDs: opaque (no ObjectId, no OTA UID) and stable.
// CALENDAR_UID_SECRET should be set once and never rotated; without it the
// key is derived from JWT_SECRET (stable in practice).
function uidKey() {
  return process.env.CALENDAR_UID_SECRET || crypto.createHash("sha256").update(`syncguard-uid:${process.env.JWT_SECRET || "dev"}`).digest("hex");
}
function exportUid(kind, id) {
  const h = crypto.createHmac("sha256", uidKey()).update(`${kind}:${String(id)}`).digest("base64url").slice(0, 26).toLowerCase().replace(/[^a-z0-9]/g, "x");
  return `me-${h}@${UID_DOMAIN}`;
}
function isMajesticUid(uid) {
  return typeof uid === "string" && uid.toLowerCase().endsWith(`@${UID_DOMAIN}`);
}

function newToken() {
  return crypto.randomBytes(32).toString("base64url"); // 256-bit, URL-safe, 43 chars
}
function sha256(s) {
  return crypto.createHash("sha256").update(String(s)).digest("hex");
}
function shortHash(s) {
  return sha256(s).slice(0, 12);
}

function utcDayNumber(date) {
  return Math.floor(new Date(date).getTime() / DAY_MS);
}
function dayStr(n) {
  return new Date(n * DAY_MS).toISOString().slice(0, 10);
}
function dayNum(str) {
  return Math.floor(Date.parse(`${str}T00:00:00Z`) / DAY_MS);
}
function dayDate(str) {
  return new Date(`${str}T00:00:00.000Z`);
}
// Night keys (UTC-midnight Dates) from startDay (incl.) to endDay (excl.),
// clipped to [today, today + horizon].
function nightsOf(startDay, endDay, { today, horizonDays = 731 } = {}) {
  const lo = Math.max(dayNum(startDay), today === undefined ? -Infinity : today);
  const hi = Math.min(dayNum(endDay), today === undefined ? Infinity : today + horizonDays);
  const out = [];
  for (let d = lo; d < hi; d++) out.push(new Date(d * DAY_MS));
  return out;
}

// Background work that must outlive the response on Vercel (same pattern
// as services/siteHero.js). Outside Vercel the promise simply runs on.
function background(promise, what) {
  const p = Promise.resolve(promise).catch((err) => console.error(`[syncguard] background ${what} failed`, err && (err.code || err.message)));
  try {
    require("@vercel/functions").waitUntil(p);
  } catch {
    /* not on Vercel */
  }
  return p;
}
// The platform's own deadline for this invocation, if any.
function platformDeadline(fallbackMs) {
  let end = Date.now() + fallbackMs;
  try {
    const d = require("@vercel/functions").getDeadline();
    if (d) end = Math.min(end, d.getTime() - 10_000);
  } catch {
    /* no platform deadline */
  }
  return end;
}
function sleep(ms) {
  return new Promise((r) => {
    const t = setTimeout(r, ms);
    if (t.unref) t.unref();
  });
}
// Waits for `promise` at most `ms`; the work keeps running (in background).
async function waitAtMost(promise, ms, what) {
  background(promise, what);
  return Promise.race([promise.then(() => "done", () => "failed"), sleep(ms).then(() => "pending")]);
}
// Runs async jobs with bounded concurrency.
async function pool(items, limit, fn) {
  const results = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      try {
        results[idx] = await fn(items[idx], idx);
      } catch (err) {
        results[idx] = { error: err };
      }
    }
  });
  await Promise.all(workers);
  return results;
}

// A calendar URL is a credential (Vrbo puts the secret in the path, Airbnb
// and Booking.com in the query). Hosts see the host name and the last four
// characters only — enough to tell two links apart, like a card number.
function maskUrl(url) {
  try {
    const u = new URL(url);
    const tail = `${u.pathname}${u.search}`.replace(/[^A-Za-z0-9]/g, "").slice(-4);
    return `${u.hostname}/…${tail}`;
  } catch {
    return "(hidden)";
  }
}

module.exports = { DAY_MS, UID_DOMAIN, exportUid, isMajesticUid, newToken, sha256, shortHash, utcDayNumber, dayStr, dayNum, dayDate, nightsOf, background, platformDeadline, sleep, waitAtMost, pool, maskUrl };

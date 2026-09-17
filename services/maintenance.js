// Booking-write maintenance gate (Batch S.1 cutover).
//
// While the flag `booking_writes_paused` is enabled, the endpoints that take
// inventory or open a payment (create booking / host block, create-order,
// admin modify) answer 503 MAINTENANCE. Everything else — browsing, reads,
// verify-payment and the payment webhook (which only record money already
// taken) — keeps working. The flag lives in the database so it can be
// flipped without a deploy (scripts/booking-gate.js) and takes effect within
// OPS_FLAG_CACHE_MS (10 s) on every instance.
//
// Fail-closed rules (a serverless instance starts cold on every scale-up):
//   * the gate is only ever *open* on the strength of a successful read;
//   * a read that fails or exceeds OPS_FLAG_READ_TIMEOUT_MS on an instance
//     that has never read the flag answers "paused" (503 MAINTENANCE_UNKNOWN)
//     — the write would need the same database anyway;
//   * an instance that has read the flag keeps its last known value across a
//     failed re-read, so a database blip mid-cutover cannot open the gate
//     and a blip in normal operation does not add a second outage;
//   * a failed read is retried after OPS_FLAG_CACHE_MS, so recovery is
//     automatic once the database answers again.
const OpsFlag = require("../models/OpsFlag");

const FLAG_ID = "booking_writes_paused";
const numberEnv = (name, fallback) =>
  process.env[name] !== undefined && Number.isFinite(Number(process.env[name])) ? Number(process.env[name]) : fallback;
const cacheMs = () => numberEnv("OPS_FLAG_CACHE_MS", 10_000);
const readTimeoutMs = () => numberEnv("OPS_FLAG_READ_TIMEOUT_MS", 2_500);

let cache = { value: false, at: 0, known: false };

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`flag read timed out after ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// Returns { paused, known }. `known` is false only when no read has ever
// succeeded on this instance and the current one failed too.
async function gateState(now = Date.now()) {
  if (now - cache.at < cacheMs()) return { paused: cache.known ? cache.value : true, known: cache.known };
  try {
    const flag = await withTimeout(OpsFlag.findById(FLAG_ID).maxTimeMS(readTimeoutMs()).lean(), readTimeoutMs());
    cache = { value: !!(flag && flag.enabled), at: now, known: true };
  } catch (err) {
    console.error(`[maintenance] flag read failed; ${cache.known ? "keeping last known value" : "no known value → treating as paused"}`, err.message);
    cache.at = now;
  }
  return { paused: cache.known ? cache.value : true, known: cache.known };
}

async function bookingWritesPaused(now = Date.now()) {
  return (await gateState(now)).paused;
}

function resetCache() {
  cache = { value: false, at: 0, known: false };
}

// Express middleware for inventory/payment-opening writes.
async function rejectWhilePaused(req, res, next) {
  const state = await gateState();
  if (state.paused) {
    return res.status(503).json({
      success: false,
      code: state.known ? "MAINTENANCE" : "MAINTENANCE_UNKNOWN",
      statusCode: 503,
      message: "Bookings are briefly paused for maintenance. Please try again in a few minutes.",
    });
  }
  return next();
}

module.exports = { FLAG_ID, bookingWritesPaused, gateState, rejectWhilePaused, resetCache };

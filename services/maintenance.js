// Booking-write maintenance gate (Batch S.1 cutover).
//
// While the flag `booking_writes_paused` is enabled, the endpoints that take
// inventory or open a payment (create booking / host block, create-order,
// admin modify) answer 503 MAINTENANCE. Everything else — browsing, reads,
// verify-payment and the payment webhook (which only record money already
// taken) — keeps working. The flag lives in the database so it can be
// flipped without a deploy (scripts/booking-gate.js) and takes effect within
// OPS_FLAG_CACHE_MS (10 s) on every instance.
const OpsFlag = require("../models/OpsFlag");

const FLAG_ID = "booking_writes_paused";
const cacheMs = () =>
  process.env.OPS_FLAG_CACHE_MS !== undefined && Number.isFinite(Number(process.env.OPS_FLAG_CACHE_MS))
    ? Number(process.env.OPS_FLAG_CACHE_MS)
    : 10_000;
let cache = { value: false, at: 0 };

async function bookingWritesPaused(now = Date.now()) {
  if (now - cache.at < cacheMs()) return cache.value;
  try {
    const flag = await OpsFlag.findById(FLAG_ID).lean();
    cache = { value: !!(flag && flag.enabled), at: now };
  } catch (err) {
    // A flag read failure must never open the gate silently during a
    // cutover, nor take bookings down outside one: keep the last value.
    console.error("[maintenance] flag read failed; keeping cached value", err.message);
    cache.at = now;
  }
  return cache.value;
}

function resetCache() {
  cache = { value: false, at: 0 };
}

// Express middleware for inventory/payment-opening writes.
async function rejectWhilePaused(req, res, next) {
  if (await bookingWritesPaused()) {
    return res.status(503).json({
      success: false,
      code: "MAINTENANCE",
      statusCode: 503,
      message: "Bookings are briefly paused for maintenance. Please try again in a few minutes.",
    });
  }
  return next();
}

module.exports = { FLAG_ID, bookingWritesPaused, rejectWhilePaused, resetCache };

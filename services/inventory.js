// Race-safe night inventory on top of models/BookingNight.
//
// Night keys: the UTC calendar day of every instant from checkIn (inclusive)
// to checkOut (exclusive), which is exactly how services/blockedDates.js and
// /booking/check-dates have always enumerated occupied dates (traveler
// bookings arrive as UTC-midnight instants, host blocks as 18:30Z instants —
// both map to the same days the calendar shows). Adjacent stays therefore
// never share a night.
//
// Invariants (enforced by the unique index on (propertyId, date)):
//  - one owner per property-night, whatever the request timing;
//  - an unpaid hold has `expiresAt`; it is reclaimable the moment
//    `expiresAt <= now` (decided here, never by Mongo TTL);
//  - a paid booking / host block / iCal import has `expiresAt: null`.
//
// A crash between "nights inserted" and "booking saved" leaves only
// expiring holds behind, never a permanent block.
const mongoose = require("mongoose");
const BookingNight = require("../models/BookingNight");

const DAY_MS = 86_400_000;
const HOLD_MINUTES = Number(process.env.BOOKING_HOLD_MINUTES) || 30;

function utcDay(value) {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

// Array of UTC-midnight Dates, one per night, or [] when the range is empty.
function nightsBetween(checkIn, checkOut) {
  const start = utcDay(checkIn);
  const end = utcDay(checkOut);
  if (!start || !end || end <= start) return [];
  const nights = [];
  for (let t = start.getTime(); t < end.getTime(); t += DAY_MS) {
    nights.push(new Date(t));
  }
  return nights;
}

function holdExpiry(now = new Date()) {
  return new Date(now.getTime() + HOLD_MINUTES * 60_000);
}

function isDuplicateKeyError(err) {
  return (
    err &&
    (err.code === 11000 ||
      (Array.isArray(err.writeErrors) &&
        err.writeErrors.some((w) => w.code === 11000)))
  );
}

// Tries to take every night in `nights` for `bookingId`.
//   kind: "booking" (hold, expires) | "block" | "ical" (permanent)
// Returns { ok: true } or { ok: false, conflicts: [BookingNight rows] }.
// On conflict nothing of ours is left behind.
async function reserveNights({ propertyId, nights, bookingId, kind = "booking", now = new Date() }) {
  if (!nights.length) return { ok: true };
  const pid = new mongoose.Types.ObjectId(propertyId);
  // 1. Expired holds on the wanted nights are dead weight: reclaim them.
  await BookingNight.deleteMany({
    propertyId: pid,
    date: { $in: nights },
    expiresAt: { $ne: null, $lte: now },
  });
  // 2. Insert our rows. `ordered: false` inserts every free night and reports
  //    the taken ones as duplicate-key errors.
  const docs = nights.map((date) => ({
    propertyId: pid,
    date,
    bookingId,
    kind,
    expiresAt: kind === "booking" ? holdExpiry(now) : null,
  }));
  try {
    await BookingNight.insertMany(docs, { ordered: false });
    return { ok: true };
  } catch (err) {
    if (!isDuplicateKeyError(err)) {
      await BookingNight.deleteMany({ bookingId });
      throw err;
    }
    // 3. Compensate: give back whatever we did manage to insert.
    await BookingNight.deleteMany({ bookingId });
    const conflicts = await BookingNight.find({
      propertyId: pid,
      date: { $in: nights },
    }).lean();
    return { ok: false, conflicts };
  }
}

// Rows for an iCal import may legitimately collide with local bookings (the
// external calendar mirrors them). Insert what is free, keep what exists.
async function ensureNightsBestEffort({ propertyId, nights, bookingId, kind }) {
  if (!nights.length) return;
  const pid = new mongoose.Types.ObjectId(propertyId);
  const docs = nights.map((date) => ({ propertyId: pid, date, bookingId, kind, expiresAt: null }));
  try {
    await BookingNight.insertMany(docs, { ordered: false });
  } catch (err) {
    if (!isDuplicateKeyError(err)) throw err;
  }
}

// Extends an unpaid hold if (and only if) we still own every night.
// Returns true when the hold is intact, false when any night was lost.
async function extendHold({ bookingId, nights, now = new Date() }) {
  if (!nights.length) return true;
  const owned = await BookingNight.countDocuments({ bookingId, date: { $in: nights } });
  if (owned !== nights.length) return false;
  await BookingNight.updateMany(
    { bookingId, expiresAt: { $ne: null } },
    { $set: { expiresAt: holdExpiry(now) } },
  );
  return true;
}

// Makes the nights permanent after payment. Returns the number of nights
// that were still ours; the caller treats < nights.length as a conflict.
async function finalizeNights({ bookingId, nights }) {
  if (!nights.length) return 0;
  await BookingNight.updateMany({ bookingId }, { $set: { expiresAt: null } });
  return BookingNight.countDocuments({ bookingId, date: { $in: nights } });
}

async function releaseNights(bookingId) {
  await BookingNight.deleteMany({ bookingId });
}

// Re-arms the unpaid hold of a booking that is about to be paid: extends it
// when every night is still ours, otherwise (the hold expired and was
// reclaimed, or the booking predates the night index) takes the nights
// again if they are free. A pending booking is therefore payable for as
// long as its dates are free — exactly the pre-S behaviour — and refused
// only when someone else actually holds them.
async function secureHold({ propertyId, bookingId, nights, now = new Date() }) {
  if (await extendHold({ bookingId, nights, now })) return { ok: true, extended: true };
  const reserved = await reserveNights({ propertyId, nights, bookingId, kind: "booking", now });
  return reserved.ok ? { ok: true, extended: false } : reserved;
}

// After a payment is confirmed: make our nights permanent, taking any we
// no longer hold if they are free. Returns { ok } or { ok: false, conflicts }.
async function securePermanent({ propertyId, bookingId, nights, now = new Date() }) {
  const kept = await finalizeNights({ bookingId, nights });
  if (kept === nights.length) return { ok: true };
  const reserved = await reserveNights({ propertyId, nights, bookingId, kind: "booking", now });
  if (!reserved.ok) return reserved;
  await finalizeNights({ bookingId, nights });
  return { ok: true, reclaimed: true };
}

module.exports = {
  DAY_MS,
  HOLD_MINUTES,
  utcDay,
  nightsBetween,
  holdExpiry,
  reserveNights,
  ensureNightsBestEffort,
  extendHold,
  finalizeNights,
  releaseNights,
  secureHold,
  securePermanent,
  isDuplicateKeyError,
};

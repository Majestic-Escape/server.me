// Night-ledger operations for imported events (docs/syncguard.md §3, §6).
//
// Same ledger as direct bookings (models/BookingNight.js, unique
// (propertyId, date)). Imports used to insert "best effort" and silently
// lose every night someone else owned (defect D10). Here every collision is
// classified:
//   expired hold              → reclaimed (dead weight, as in reserveNights)
//   live unpaid hold          → the external booking wins: the guest is
//                               refused at create-order (409) before paying,
//                               or lands in the existing inventory_conflict
//                               queue if the payment was already in flight
//   paid Majestic booking     → reported as a conflict (the caller decides
//                               how loudly — see reconcile.js)
//   host block / other import → shared (both block; nothing to resolve)
// Possible echoes are treated exactly like any other import here: an
// uncertain event protects inventory (false duplicate block > hidden booking).
const mongoose = require("mongoose");
const BookingNight = require("../../models/BookingNight");
const Booking = require("../../models/Booking");
const { isDuplicateKeyError } = require("../inventory");

function key(d) {
  return new Date(d).toISOString().slice(0, 10);
}

async function insertFree(pid, bookingId, nights) {
  if (!nights.length) return;
  try {
    await BookingNight.insertMany(
      nights.map((date) => ({ propertyId: pid, date, bookingId, kind: "ical", expiresAt: null })),
      { ordered: false },
    );
  } catch (err) {
    if (!isDuplicateKeyError(err)) throw err;
  }
}

function addTo(list, bookingId, date, kind, connectionId) {
  const id = String(bookingId);
  let entry = list.find((e) => e.bookingId === id);
  if (!entry) {
    entry = { bookingId: id, nights: [], ...(kind ? { kind } : {}), ...(connectionId ? { connectionId } : {}) };
    list.push(entry);
  }
  entry.nights.push(key(date));
}

// Claims `nights` for an import row. Returns
// { owned, displacedHolds: [{bookingId, nights}], paidConflicts: [...], shared: [{bookingId, nights, kind, connectionId?}] }
// (connectionId: the import connection of a shared import row).
async function claimNights({ propertyId, bookingId, nights, now = new Date() }) {
  const result = { owned: [], displacedHolds: [], paidConflicts: [], shared: [] };
  if (!nights.length) return result;
  const pid = new mongoose.Types.ObjectId(String(propertyId));
  await insertFree(pid, bookingId, nights);
  let owners = await BookingNight.find({ propertyId: pid, date: { $in: nights } }).lean();
  // A night row still carrying an expiry can belong to a booking that is
  // already PAID (an admin date move re-taking nights, a crash between
  // "paid" and "permanent"): that is a paid booking, never a hold to displace.
  const holdOwners = [...new Set(owners.filter((r) => r.expiresAt && String(r.bookingId) !== String(bookingId)).map((r) => String(r.bookingId)))];
  const paidHolders = new Set(
    holdOwners.length
      ? (await Booking.find({ _id: { $in: holdOwners }, paymentStatus: "paid", status: { $nin: ["cancelled", "rejected"] } }).select("_id").lean()).map((b) => String(b._id))
      : [],
  );
  const retry = [];
  for (const row of owners) {
    if (String(row.bookingId) === String(bookingId)) continue;
    if (paidHolders.has(String(row.bookingId))) continue;
    if (row.expiresAt && row.expiresAt <= now) {
      const del = await BookingNight.deleteOne({ _id: row._id, expiresAt: { $ne: null, $lte: now } });
      if (del.deletedCount) retry.push(row.date);
    } else if (row.expiresAt && row.expiresAt > now) {
      // A live checkout hold on a night an external calendar says is taken:
      // the external booking is a fact, the hold an intention. Take the
      // night only if it is still exactly that hold (conditional delete).
      const del = await BookingNight.deleteOne({ _id: row._id, bookingId: row.bookingId, expiresAt: row.expiresAt });
      if (del.deletedCount) {
        retry.push(row.date);
        addTo(result.displacedHolds, row.bookingId, row.date);
      }
    }
  }
  if (retry.length) await insertFree(pid, bookingId, retry);
  owners = await BookingNight.find({ propertyId: pid, date: { $in: nights } }).lean();
  const others = owners.filter((r) => String(r.bookingId) !== String(bookingId));
  result.owned = owners.filter((r) => String(r.bookingId) === String(bookingId)).map((r) => r.date);
  if (others.length) {
    const ids = [...new Set(others.map((r) => String(r.bookingId)))];
    const bookings = await Booking.find({ _id: { $in: ids } }).select("source action paymentStatus status external.connectionId").lean();
    const byId = new Map(bookings.map((b) => [String(b._id), b]));
    for (const r of others) {
      const b = byId.get(String(r.bookingId));
      if (b && b.source !== "ical" && b.action !== "host" && (!r.expiresAt || paidHolders.has(String(r.bookingId)))) addTo(result.paidConflicts, r.bookingId, r.date);
      else addTo(result.shared, r.bookingId, r.date, b ? (b.source === "ical" ? "import" : b.action === "host" ? "host_block" : "hold") : "unknown", b && b.external && b.external.connectionId ? String(b.external.connectionId) : null);
    }
  }
  return result;
}

// Drops this row's nights that are not in `keep` (a modification).
async function releaseOutside(bookingId, keep) {
  await BookingNight.deleteMany({ bookingId, date: { $nin: keep } });
}
async function releaseAll(bookingId) {
  await BookingNight.deleteMany({ bookingId });
}

module.exports = { claimNights, releaseOutside, releaseAll, key };

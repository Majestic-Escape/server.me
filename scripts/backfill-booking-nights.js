#!/usr/bin/env node
// Materialises BookingNight rows for every booking that blocks inventory
// today, so the unique (propertyId, date) index can be created without
// reopening occupied dates.
//
//   node scripts/backfill-booking-nights.js                 # dry run (default)
//   node scripts/backfill-booking-nights.js --apply         # insert missing rows
//   node scripts/backfill-booking-nights.js --apply --create-index
//   node scripts/backfill-booking-nights.js --rollback      # drop bookingnights
//
// Uses DB_URI from the environment (or --uri=...). Idempotent: rows are
// inserted only where (propertyId, date) is absent; reruns report 0 inserts.
// Conflicts (two live bookings claiming one night) are REPORTED, never
// resolved automatically — the index is refused while any remain.
require("dotenv").config();
const mongoose = require("mongoose");
const Booking = require("../models/Booking");
const BookingNight = require("../models/BookingNight");
const Payment = require("../models/Payment");
const { nightsBetween, utcDay } = require("../services/inventory");

const args = new Set(process.argv.slice(2));
const opt = (name) => {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`));
  return a ? a.slice(name.length + 3) : undefined;
};
const APPLY = args.has("--apply");
const CREATE_INDEX = args.has("--create-index");
const ROLLBACK = args.has("--rollback");
const URI = opt("uri") || process.env.DB_URI;

function kindOf(b) {
  if (b.source === "ical") return "ical";
  if (b.action === "host") return "block";
  return "booking";
}

async function main() {
  if (!URI) throw new Error("DB_URI (or --uri) is required");
  await mongoose.connect(URI);
  const db = mongoose.connection.db;
  const dbName = db.databaseName;
  console.log(`[backfill] database: ${dbName}  mode: ${ROLLBACK ? "ROLLBACK" : APPLY ? "APPLY" : "DRY-RUN"}`);

  if (ROLLBACK) {
    const exists = (await db.listCollections({ name: "bookingnights" }).toArray()).length > 0;
    if (exists) {
      await db.dropCollection("bookingnights");
      console.log("[backfill] dropped collection bookingnights (rollback complete; redeploy the previous backend)");
    } else {
      console.log("[backfill] nothing to roll back");
    }
    return;
  }

  // Phase 0 — stale open orders. The old create-order inserted a Payment
  // row per attempt, so a booking may hold several `created` rows; the new
  // partial unique index (one `created` per booking) cannot build over them.
  // Keep the newest open row per unpaid booking; retire the rest as failed.
  const openRows = await Payment.aggregate([
    { $match: { status: "created" } },
    { $sort: { createdAt: -1 } },
    { $group: { _id: "$bookingId", ids: { $push: "$_id" }, n: { $sum: 1 } } },
    { $match: { n: { $gt: 1 } } },
  ]);
  const staleIds = openRows.flatMap((g) => g.ids.slice(1));
  const paidBookingIds = await Payment.distinct("bookingId", { status: { $in: ["paid", "refund initiated", "refunded"] } });
  const openOnPaid = await Payment.find({ status: "created", bookingId: { $in: paidBookingIds } }).select("_id").lean();
  const retire = [...new Set([...staleIds.map(String), ...openOnPaid.map((r) => String(r._id))])];
  console.log(`[backfill] stale open Payment rows to retire as failed: ${retire.length} (${openRows.length} bookings with >1 open row, ${openOnPaid.length} open rows on already-paid bookings)`);
  if (APPLY && retire.length) {
    const r = await Payment.updateMany({ _id: { $in: retire.map((id) => new mongoose.Types.ObjectId(id)) }, status: "created" }, { $set: { status: "failed" } });
    console.log(`[backfill] retired: ${r.modifiedCount}`);
  }

  const today = utcDay(new Date());
  // Everything that blocks inventory for current/future nights.
  const live = await Booking.find({
    status: { $nin: ["rejected", "cancelled"] },
    checkOut: { $gt: today },
    $or: [{ paymentStatus: "paid" }, { action: "host" }, { source: "ical" }],
  })
    .select("_id propertyId checkIn checkOut status paymentStatus action source")
    .lean();
  console.log(`[backfill] live inventory-blocking bookings: ${live.length}`);

  // Build the desired rows and detect conflicts between live bookings.
  const wanted = new Map(); // key -> [{bookingId, kind}]
  let totalNights = 0;
  for (const b of live) {
    const nights = nightsBetween(b.checkIn, b.checkOut);
    totalNights += nights.length;
    for (const d of nights) {
      const key = `${b.propertyId}|${d.toISOString().slice(0, 10)}`;
      if (!wanted.has(key)) wanted.set(key, []);
      wanted.get(key).push({ bookingId: String(b._id), kind: kindOf(b), status: b.status, paymentStatus: b.paymentStatus });
    }
  }
  const conflicts = [...wanted.entries()].filter(([, owners]) => owners.length > 1);
  console.log(`[backfill] nights wanted: ${totalNights} (${wanted.size} distinct property-nights)`);
  console.log(`[backfill] conflicting property-nights: ${conflicts.length}`);
  for (const [key, owners] of conflicts.slice(0, 50)) {
    console.log(`  CONFLICT ${key}: ${owners.map((o) => `${o.bookingId}(${o.kind},${o.status}/${o.paymentStatus})`).join("  vs  ")}`);
  }
  if (conflicts.length > 50) console.log(`  … ${conflicts.length - 50} more`);

  // Existing rows (idempotency + rows owned by cancelled bookings).
  const existing = await BookingNight.find({}).select("propertyId date bookingId expiresAt").lean();
  const existingByKey = new Map(existing.map((r) => [`${r.propertyId}|${new Date(r.date).toISOString().slice(0, 10)}`, r]));
  let toInsert = [];
  let alreadyPresent = 0;
  let ownedByOther = 0;
  for (const [key, owners] of wanted) {
    if (owners.length > 1) continue; // conflicts are never auto-resolved
    const row = existingByKey.get(key);
    if (row) {
      if (String(row.bookingId) === owners[0].bookingId) alreadyPresent += 1;
      else ownedByOther += 1;
      continue;
    }
    const [propertyId, day] = key.split("|");
    toInsert.push({
      propertyId: new mongoose.Types.ObjectId(propertyId),
      date: new Date(`${day}T00:00:00.000Z`),
      bookingId: new mongoose.Types.ObjectId(owners[0].bookingId),
      kind: owners[0].kind,
      expiresAt: null,
    });
  }
  console.log(`[backfill] already present: ${alreadyPresent}, owned by another booking (skipped): ${ownedByOther}, to insert: ${toInsert.length}`);

  if (!APPLY) {
    console.log("[backfill] dry run — nothing written. Re-run with --apply to insert.");
    return;
  }
  let inserted = 0;
  for (let i = 0; i < toInsert.length; i += 500) {
    const chunk = toInsert.slice(i, i + 500);
    try {
      const r = await BookingNight.insertMany(chunk, { ordered: false });
      inserted += r.length;
    } catch (err) {
      if (err.code === 11000 || (err.writeErrors && err.writeErrors.length)) {
        inserted += chunk.length - (err.writeErrors ? err.writeErrors.length : 0);
      } else throw err;
    }
  }
  console.log(`[backfill] inserted: ${inserted}`);

  if (CREATE_INDEX) {
    if (conflicts.length) {
      console.log("[backfill] REFUSING to create the unique index while conflicts remain. Resolve them (cancel one side) and re-run.");
      process.exitCode = 2;
      return;
    }
    await BookingNight.collection.createIndex({ propertyId: 1, date: 1 }, { unique: true });
    await BookingNight.collection.createIndex({ bookingId: 1 });
    await Payment.collection.createIndex({ bookingId: 1 }, { unique: true, partialFilterExpression: { status: "created" } });
    await Booking.collection.createIndex({ idempotencyKey: 1 }, { unique: true, sparse: true });
    console.log("[backfill] indexes created: bookingnights (propertyId,date) unique, bookingId; payments one-open-order-per-booking; bookings idempotencyKey");
  }
}

main()
  .catch((err) => {
    console.error("[backfill] failed:", err.message);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());

#!/usr/bin/env node
// Read-only: explains why "Delete listing" answers 409 LISTING_HAS_DEPENDENTS
// for pending (status "processing") listings. For every pending listing it
// counts the rows the deletion treats as blockers, splitting bookings into
// guest bookings vs host calendar blocks vs iCal imports so the owner can see
// whether a refused listing is protected by real customer data or only by
// host-side rows.
//
//   node scripts/pending-listing-blockers.js --uri="<DB_URI>"   (or DB_URI)
//
// Prints ids, titles and counts only — no emails, no booking details.
require("dotenv").config();
const mongoose = require("mongoose");
const ListingProperty = require("../models/ListingProperty");
const Booking = require("../models/Booking");
const BookingNight = require("../models/BookingNight");
const Payment = require("../models/Payment");
const HostPayout = require("../models/HostPayout");
const Review = require("../models/Review");
const HostReview = require("../models/HostReview");

const args = process.argv.slice(2);
const opt = (name) => {
  const a = args.find((x) => x.startsWith(`--${name}=`));
  return a ? a.slice(name.length + 3) : undefined;
};

async function report({ log = console.log } = {}) {
  const pending = await ListingProperty.find({ status: "processing" }).select("_id title createdAt").sort({ createdAt: 1 }).lean();
  log(`[blockers] ${pending.length} pending listing(s)`);
  const rows = [];
  for (const l of pending) {
    const id = l._id;
    const [guest, hostBlocks, ical, nights, payments, payouts, reviews, hostReviews] = await Promise.all([
      Booking.countDocuments({ propertyId: id, action: { $ne: "host" }, source: { $ne: "ical" } }),
      Booking.countDocuments({ propertyId: id, action: "host" }),
      Booking.countDocuments({ propertyId: id, source: "ical" }),
      BookingNight.countDocuments({ propertyId: id }),
      Payment.countDocuments({ propertyId: id }),
      HostPayout.countDocuments({ propertyId: id }),
      Review.countDocuments({ property: id }),
      HostReview.countDocuments({ property: id }),
    ]);
    const blocked = guest + hostBlocks + ical + nights + payments + payouts + reviews + hostReviews > 0;
    rows.push({ id: String(id), title: (l.title || "(untitled)").slice(0, 40), created: l.createdAt ? l.createdAt.toISOString().slice(0, 10) : "", deletable: blocked ? "NO" : "yes", guestBookings: guest, hostBlocks, icalImports: ical, nights, payments, payouts, reviews, hostReviews });
  }
  if (rows.length) console.table(rows);
  const refused = rows.filter((r) => r.deletable === "NO");
  const hostOnly = refused.filter((r) => r.guestBookings + r.payments + r.payouts + r.reviews + r.hostReviews === 0);
  log(`[blockers] deletable now: ${rows.length - refused.length}; refused: ${refused.length} (of which ${hostOnly.length} only by host blocks / iCal rows / nights)`);
  return rows;
}

async function main() {
  const uri = opt("uri") || process.env.DB_URI;
  if (!uri) throw new Error("DB_URI (or --uri) is required");
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 20000 });
  console.log(`[blockers] database: ${mongoose.connection.db.databaseName}`);
  await report();
}

module.exports = { report };

if (require.main === module) {
  main()
    .catch((err) => {
      console.error("[blockers] failed:", err.message);
      process.exitCode = 1;
    })
    .finally(() => mongoose.disconnect());
}

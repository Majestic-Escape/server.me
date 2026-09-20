#!/usr/bin/env node
// Read-only audit of listing addresses after the host-wizard round-trip bug
// (the edit wizard loaded the public listing view and wrote it back: no street /
// registration number since 2026-01-27, and — between the contact lock-down
// release of 2026-09-20 14:36 UTC and the fix — an approximate point 150–350 m
// off the stored one, again on every save).
//
// Reports, for active / processing / inactive listings:
//   1. listings without a street (the host has to re-enter it in the wizard);
//   2. listings a host saved after --since (default: the release time) — their
//      point may have moved; the host should re-pin the location, or the
//      owner restores the address from a database snapshot taken before.
// Nothing is written.
//
//   node scripts/listing-address-audit.js --uri="<DB_URI>" [--since=2026-09-20T14:36:00Z]
const mongoose = require("mongoose");

const args = process.argv.slice(2);
const opt = (name) => {
  const a = args.find((x) => x.startsWith(`--${name}=`));
  return a ? a.slice(name.length + 3) : undefined;
};

async function main() {
  const uri = opt("uri") || process.env.DB_URI;
  if (!uri) throw new Error("--uri or DB_URI required");
  const since = new Date(opt("since") || "2026-09-20T14:36:00Z");
  if (Number.isNaN(since.getTime())) throw new Error("--since must be an ISO date");
  await mongoose.connect(uri);
  const ListingProperty = require("../models/ListingProperty");
  const rows = await ListingProperty.find({ status: { $in: ["active", "processing", "inactive"] } })
    .select("title status hostEmail address.street address.registrationNumber address.latitude address.longitude address.city createdAt updatedAt")
    .sort({ updatedAt: -1 })
    .lean();
  const noStreet = rows.filter((r) => !(r.address && String(r.address.street || "").trim()));
  const savedSince = rows.filter((r) => r.updatedAt && r.updatedAt >= since && r.createdAt < since);
  console.log(`listings (active/processing/inactive): ${rows.length}`);
  console.log(`\n1. without a street: ${noStreet.length}`);
  for (const r of noStreet) console.log(`   ${r._id} ${r.status.padEnd(10)} ${String(r.address && r.address.city || "").padEnd(18)} ${r.hostEmail || ""}  "${r.title}"`);
  console.log(`\n2. saved by a host after ${since.toISOString()} (point may have moved; ask the host to re-pin): ${savedSince.length}`);
  for (const r of savedSince) {
    const a = r.address || {};
    console.log(`   ${r._id} ${r.status.padEnd(10)} updated ${r.updatedAt.toISOString()} ${a.latitude},${a.longitude} street=${a.street ? "yes" : "no"} ${r.hostEmail || ""}  "${r.title}"`);
  }
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});

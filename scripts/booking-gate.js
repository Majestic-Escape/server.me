#!/usr/bin/env node
// Flips the booking-write maintenance gate (services/maintenance.js).
//
//   node scripts/booking-gate.js --status
//   node scripts/booking-gate.js --on  [--reason="Batch S cutover"]
//   node scripts/booking-gate.js --off
//
// Uses DB_URI (or --uri=...). Only the Batch S backend honours the flag; the
// pre-S backend ignores it, which is exactly why the cutover sequence turns
// it on *before* the Batch S deploy and off after the delta reconciliation.
require("dotenv").config();
const mongoose = require("mongoose");
const OpsFlag = require("../models/OpsFlag");
const { FLAG_ID } = require("../services/maintenance");

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const opt = (name) => {
  const a = args.find((x) => x.startsWith(`--${name}=`));
  return a ? a.slice(name.length + 3) : undefined;
};

async function main() {
  const uri = opt("uri") || process.env.DB_URI;
  if (!uri) throw new Error("DB_URI (or --uri) is required");
  await mongoose.connect(uri);
  const db = mongoose.connection.db.databaseName;
  if (has("--on") || has("--off")) {
    const enabled = has("--on");
    await OpsFlag.updateOne(
      { _id: FLAG_ID },
      { $set: { enabled, reason: opt("reason") || "", updatedAt: new Date() } },
      { upsert: true },
    );
  }
  const flag = await OpsFlag.findById(FLAG_ID).lean();
  console.log(`[gate] database: ${db}  booking writes paused: ${flag ? flag.enabled : false}${flag && flag.reason ? `  (${flag.reason})` : ""}`);
}

main()
  .catch((err) => {
    console.error("[gate] failed:", err.message);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());

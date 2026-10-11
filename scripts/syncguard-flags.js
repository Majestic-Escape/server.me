#!/usr/bin/env node
// SyncGuard runtime switches (services/calendarSync/flags.js) — no redeploy,
// effective on every instance within OPS_FLAG_CACHE_MS (10 s).
//
//   node scripts/syncguard-flags.js --status
//   node scripts/syncguard-flags.js --pause            stop all calendar fetches (imported blocks stay;
//                                                      bookings of connected listings are refused while
//                                                      their calendars cannot be re-verified)
//   node scripts/syncguard-flags.js --resume
//   node scripts/syncguard-flags.js --propagation-off  feeds carry Majestic-native events only
//   node scripts/syncguard-flags.js --propagation-on
//   [--reason="..."] [--confirm-db=<name>]
require("dotenv").config();
const mongoose = require("mongoose");
const OpsFlag = require("../models/OpsFlag");
const { SYNC_PAUSED, PROPAGATION_OFF } = require("../services/calendarSync/flags");

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const opt = (n) => {
  const a = args.find((x) => x.startsWith(`--${n}=`));
  return a ? a.slice(n.length + 3) : undefined;
};

async function set(id, enabled) {
  await OpsFlag.updateOne({ _id: id }, { $set: { enabled, reason: opt("reason") || "", updatedAt: new Date() } }, { upsert: true });
}

(async () => {
  const uri = opt("uri") || process.env.DB_URI;
  if (!uri) throw new Error("DB_URI (or --uri) is required");
  await mongoose.connect(uri);
  const db = mongoose.connection.db.databaseName;
  if (opt("confirm-db") && opt("confirm-db") !== db) throw new Error(`connected to "${db}", not "${opt("confirm-db")}"`);
  if (has("--pause")) await set(SYNC_PAUSED, true);
  if (has("--resume")) await set(SYNC_PAUSED, false);
  if (has("--propagation-off")) await set(PROPAGATION_OFF, true);
  if (has("--propagation-on")) await set(PROPAGATION_OFF, false);
  const flags = await OpsFlag.find({ _id: { $in: [SYNC_PAUSED, PROPAGATION_OFF] } }).lean();
  const v = (id) => (flags.find((f) => f._id === id) || { enabled: false }).enabled;
  console.log(`[syncguard] database: ${db}  sync paused: ${v(SYNC_PAUSED)}  propagation off: ${v(PROPAGATION_OFF)}`);
  await mongoose.disconnect();
})().catch(async (err) => {
  console.error("[syncguard] failed:", err.message);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});

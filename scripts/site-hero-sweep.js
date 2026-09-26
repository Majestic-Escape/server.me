#!/usr/bin/env node
// The homepage banner sweep by hand (services/siteHeroSweep.js; the daily
// cron runs the same thing). Dry run by default: lists what would be deleted.
//
//   node scripts/site-hero-sweep.js --uri="<DB_URI>"            (dry run)
//   node scripts/site-hero-sweep.js --uri="<DB_URI>" --apply    (delete)
//
// --apply ignores the once-a-day window (it is an explicit run) but keeps
// every safety rule: nothing referenced, nothing younger than 24 h.
require("dotenv").config();
const mongoose = require("mongoose");
const { sweep } = require("../services/siteHeroSweep");

const args = process.argv.slice(2);
const opt = (name) => {
  const a = args.find((x) => x.startsWith(`--${name}=`));
  return a ? a.slice(name.length + 3) : undefined;
};

async function main() {
  const uri = opt("uri") || process.env.DB_URI;
  if (!uri) throw new Error("DB_URI (or --uri) is required");
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 20000 });
  const apply = args.includes("--apply");
  console.log(`[site-hero sweep] database: ${mongoose.connection.db.databaseName}; ${apply ? "APPLY" : "dry run"}`);
  const summary = await sweep({ dryRun: !apply, force: apply });
  console.log(JSON.stringify(summary, null, 2));
}

if (require.main === module) {
  main()
    .catch((err) => {
      console.error("[site-hero sweep] failed:", err.message);
      process.exitCode = 1;
    })
    .finally(() => mongoose.disconnect());
}

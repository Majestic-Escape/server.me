#!/usr/bin/env node
// READ-ONLY audit of the listing visibility invariants
// (docs/listing-visibility.md). It writes nothing — every database call is a
// find / aggregate / count — and repairs nothing: a finding is for the owner
// to decide on, and any repair is a separate, separately authorised step.
//
// Hard violations (a listing the public can see but should not):
//   bannedHostLive        live listing whose host account is banned
//   deactivatedHostLive   live listing whose host account is deactivated
//   orphanHostLive        live listing whose host account does not exist
//   liveWithBanFlag       status "active" with ban:true (inconsistent row)
// Informational (no exposure; needs a decision before the host can relist):
//   inactiveNoProvenance  inactive with neither delist nor ban recorded —
//                         delisted before delist:"host" was recorded, or set
//                         inactive by an admin edit; the host cannot relist it
//                         without an admin approval
//   liveWithProvenance    live with a leftover delist value (re-approved before
//                         approval cleared it) — harmless, cleared on the next
//                         delist / approve
//
//   node scripts/audit-listing-invariants.js [--confirm-db=<name>] [--json]
//
// Prefer DB_URI from the environment over --uri= (keeps the credential out
// of the shell history). Exit code 0 = no hard violation, 2 = violations.
require("dotenv").config();
const mongoose = require("mongoose");

const args = process.argv.slice(2);
const opt = (name) => {
  const a = args.find((x) => x.startsWith(`--${name}=`));
  return a ? a.slice(name.length + 3) : undefined;
};

/** @param {import("mongoose").Connection} conn */
async function audit(conn) {
  const listings = conn.collection("listingproperties");
  const users = conn.collection("users");
  const live = await listings
    .find({ status: "active" }, { projection: { _id: 1, host: 1, ban: 1, delist: 1 } })
    .toArray();
  const hostIds = [...new Set(live.map((l) => l.host).filter(Boolean).map(String))].map((id) => new mongoose.Types.ObjectId(id));
  const hosts = await users
    .find({ _id: { $in: hostIds } }, { projection: { _id: 1, "status.active": 1, "status.banned": 1 } })
    .toArray();
  const byId = new Map(hosts.map((u) => [String(u._id), u]));
  const out = { bannedHostLive: [], deactivatedHostLive: [], orphanHostLive: [], liveWithBanFlag: [], inactiveNoProvenance: [], liveWithProvenance: [] };
  for (const l of live) {
    const id = String(l._id);
    if (l.ban === true) out.liveWithBanFlag.push(id);
    if (l.delist) out.liveWithProvenance.push(id);
    const u = l.host ? byId.get(String(l.host)) : null;
    if (!u) out.orphanHostLive.push(id);
    else if (u.status && u.status.banned === true) out.bannedHostLive.push(id);
    else if (u.status && u.status.active === false) out.deactivatedHostLive.push(id);
  }
  const ambiguous = await listings
    .find({ status: "inactive", delist: null, ban: { $ne: true } }, { projection: { _id: 1 } })
    .toArray();
  out.inactiveNoProvenance = ambiguous.map((l) => String(l._id));
  const hard = out.bannedHostLive.length + out.deactivatedHostLive.length + out.orphanHostLive.length + out.liveWithBanFlag.length;
  return { counts: Object.fromEntries(Object.entries(out).map(([k, v]) => [k, v.length])), ids: out, hardViolations: hard, liveListings: live.length };
}

async function main() {
  const uri = opt("uri") || process.env.DB_URI;
  if (!uri) {
    console.error("DB_URI (or --uri=) is required");
    process.exit(1);
  }
  await mongoose.connect(uri, { autoIndex: false });
  try {
    const want = opt("confirm-db");
    if (want && mongoose.connection.db.databaseName !== want) {
      console.error(`refusing: connected to "${mongoose.connection.db.databaseName}", expected "${want}"`);
      process.exit(1);
    }
    const result = await audit(mongoose.connection);
    if (args.includes("--json")) console.log(JSON.stringify(result, null, 2));
    else {
      console.log(`live listings: ${result.liveListings}`);
      for (const [k, n] of Object.entries(result.counts)) console.log(`${k.padEnd(22)} ${n}${n ? "  " + result.ids[k].join(", ") : ""}`);
      console.log(result.hardViolations ? `HARD VIOLATIONS: ${result.hardViolations}` : "no hard violation");
    }
    process.exitCode = result.hardViolations ? 2 : 0;
  } finally {
    await mongoose.disconnect();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error("audit failed:", err && err.message);
    process.exit(1);
  });
}

module.exports = { audit };

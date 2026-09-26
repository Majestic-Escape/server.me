#!/usr/bin/env node
// Read-only: lists every account that can act as an administrator, for the
// owner to review now that POST /admin/register is locked.
//
// Until that fix, anyone could call the endpoint, get a verified Admin record
// and a 7-day admin token back. Locking the route stops new ones; it does not
// remove accounts created before. Any account here the owner does not
// recognise must be banned: authz.resolveActor refuses a banned Admin on its
// very next request (its tokens stop working immediately).
//
//   node scripts/privileged-identities.js --uri="<DB_URI>" [--json]
//
// Shows what the owner needs to recognise an account (name, e-mail, dates,
// verified / banned) and whether an audited admin.create row names who added
// it (none will, for accounts made before the fix). Never writes; prints the
// exact command to ban an account instead.
require("dotenv").config();
const mongoose = require("mongoose");
const Admin = require("../models/Admin");
const User = require("../models/User");
const AdminAuditLog = require("../models/AdminAuditLog");

const args = process.argv.slice(2);
const opt = (name) => {
  const a = args.find((x) => x.startsWith(`--${name}=`));
  return a ? a.slice(name.length + 3) : undefined;
};
const flag = (name) => args.includes(`--${name}`);
const day = (d) => (d ? new Date(d).toISOString().slice(0, 10) : "");
const name = (d) => [d.firstName, d.lastName].filter(Boolean).join(" ");

async function report({ log = console.log, json = false } = {}) {
  const [admins, roleAdmins, created] = await Promise.all([
    Admin.find({}).select("firstName lastName email isVerified status createdAt").sort({ createdAt: 1 }).lean(),
    User.find({ role: "admin" }).select("firstName lastName email status createdAt").sort({ createdAt: 1 }).lean(),
    AdminAuditLog.find({ action: "admin.create" }).select("actorId targetId createdAt").lean(),
  ]);
  const addedBy = new Map(created.map((r) => [String(r.targetId), String(r.actorId)]));
  const rows = [
    ...admins.map((a) => ({
      kind: "Admin",
      id: String(a._id),
      name: name(a),
      email: a.email || "",
      created: day(a.createdAt),
      verified: a.isVerified ? "yes" : "no",
      banned: a.status && a.status.banned ? "BANNED" : "",
      addedBy: addedBy.get(String(a._id)) || "(no audit record)",
    })),
    ...roleAdmins.map((u) => ({
      kind: "User role=admin",
      id: String(u._id),
      name: name(u),
      email: u.email || "",
      created: day(u.createdAt),
      verified: "",
      banned: u.status && u.status.banned ? "BANNED" : "",
      addedBy: "(role set in the database)",
    })),
  ];
  if (json) {
    log(JSON.stringify(rows, null, 2));
    return rows;
  }
  log(`[privileged] ${admins.length} Admin record(s), ${roleAdmins.length} user(s) with role "admin"`);
  if (rows.length) console.table(rows);
  const active = rows.filter((r) => !r.banned);
  log(`[privileged] ${active.length} can act as admin right now. To ban one you do not recognise:`);
  log(`  Admin:  db.admins.updateOne({ _id: ObjectId("<id>") }, { $set: { "status.banned": true, "status.bannedReason": "unrecognised admin" } })`);
  log(`  User:   db.users.updateOne({ _id: ObjectId("<id>") }, { $set: { "status.banned": true } })`);
  return rows;
}

async function main() {
  const uri = opt("uri") || process.env.DB_URI;
  if (!uri) throw new Error("DB_URI (or --uri) is required");
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 20000 });
  if (!flag("json")) console.log(`[privileged] database: ${mongoose.connection.db.databaseName}`);
  await report({ json: flag("json") });
}

module.exports = { report };

if (require.main === module) {
  main()
    .catch((err) => {
      console.error("[privileged] failed:", err.message);
      process.exitCode = 1;
    })
    .finally(() => mongoose.disconnect());
}

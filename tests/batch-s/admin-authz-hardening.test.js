// Admin identities that were revoked, deactivated or duplicated keep no admin
// rights (the closure audit of the homepage-banner work: SEC-C, SEC-D,
// SEC-H). Checked on the admin-only fee settings (GET /admin/service); the
// banner routes have the same checks in site-hero-audit.test.js.
// Note: this file deliberately creates NO unique index on admins.email —
// the registration race must be safe without one (production has none).
const test = require("node:test");
const assert = require("node:assert/strict");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const h = require("./setup");

const Admin = () => require("../../models/Admin");
const User = () => require("../../models/User");
const AdminAuditLog = () => require("../../models/AdminAuditLog");
const Configure = () => require("../../models/Configure");

let ADMIN, AT;
const sign = (claims) => jwt.sign(claims, process.env.JWT_SECRET, { expiresIn: "1h" });
const fees = (token) => h.api("GET", "/admin/service", { token });

// Admin OTP mail goes to Brevo through axios: recorded, never sent.
const brevoCalls = [];
const axios = require("axios");
const realPost = axios.post;
axios.post = async (url, ...rest) => {
  if (String(url).includes("brevo.com")) {
    brevoCalls.push(url);
    return { data: { messageId: "test" } };
  }
  return realPost.call(axios, url, ...rest);
};

test.before(async () => {
  await h.start();
  ADMIN = await h.makeAdmin();
  AT = h.adminToken(ADMIN);
  await Configure().create({ gst: "18", service: "12", razorpay: 2 });
});
test.after(async () => h.stop());

test("revocation: an admin-role user's tokens of every shape stop working when its tokenVersion moves", async () => {
  const u = await h.makeUser({ role: "admin" });
  const tokens = {
    login: sign({ userId: String(u._id), firstName: "A", tokenVersion: 0, admin: 1 }),
    registration: sign({ userId: String(u._id), firstName: "A" }),
    userShaped: sign({ userId: String(u._id), firstName: "A", tokenVersion: 0, admin: 0 }),
  };
  for (const t of Object.values(tokens)) assert.equal((await fees(t)).status, 200);
  await User().updateOne({ _id: u._id }, { $inc: { tokenVersion: 1 } });
  for (const [name, t] of Object.entries(tokens)) assert.equal((await fees(t)).status, 401, `${name} after revocation`);
  assert.equal((await fees(sign({ userId: String(u._id), firstName: "A", tokenVersion: 1, admin: 1 }))).status, 200, "the current version works");
});

test("deactivated accounts and Admin records with a non-admin role have no admin rights; legacy records without a role keep theirs", async () => {
  const u = await h.makeUser({ role: "admin" });
  const ut = sign({ userId: String(u._id), firstName: "A", tokenVersion: 0, admin: 1 });
  assert.equal((await fees(ut)).status, 200);
  await User().updateOne({ _id: u._id }, { $set: { "status.active": false } });
  assert.equal((await fees(ut)).status, 403);
  const x = await h.makeAdmin();
  await Admin().updateOne({ _id: x._id }, { $set: { "status.active": false } });
  assert.equal((await fees(h.adminToken(x))).status, 403);
  const y = await h.makeAdmin();
  await Admin().updateOne({ _id: y._id }, { $set: { role: "host" } });
  assert.ok([401, 403].includes((await fees(h.adminToken(y))).status));
  const z = await h.makeAdmin();
  await Admin().collection.updateOne({ _id: z._id }, { $unset: { role: 1 } });
  assert.equal((await fees(h.adminToken(z))).status, 200, "legacy record, no role field");
});

test("registration: the same new e-mail five times at once → exactly one admin, one audit row; the others 409", async () => {
  const email = `race-${Date.now()}@authz.test`;
  const rs = await Promise.all(Array.from({ length: 5 }, (_, i) => h.api("POST", "/admin/register", { token: AT, body: { firstName: `R${i}`, email } })));
  assert.deepEqual(rs.map((r) => r.status).sort(), [201, 409, 409, 409, 409], JSON.stringify(rs.map((r) => r.body.code)));
  const made = await Admin().find({ email }).lean();
  assert.equal(made.length, 1);
  assert.equal(await AdminAuditLog().countDocuments({ action: "admin.create", targetId: made[0]._id }), 1);
  // the address in another spelling is the same admin
  const again = await h.api("POST", "/admin/register", { token: AT, body: { firstName: "Again", email: `  ${email.toUpperCase()} ` } });
  assert.equal(again.status, 409);
});

test("sign-in: an e-mail shared by two Admin records is refused (no code mailed) — a ban on one can't be walked around through the other", async () => {
  const dup = `dup-${Date.now()}@authz.test`;
  const mk = (banned) => ({ _id: new mongoose.Types.ObjectId(), firstName: "Dup", email: dup, isVerified: true, status: { active: !banned, banned }, otp: { value: "123456", expiry: new Date(Date.now() + 60000) } });
  await Admin().collection.insertMany([mk(false), mk(true)]);
  const before = brevoCalls.length;
  const req = await h.api("POST", "/admin/request-otp", { body: { email: dup } });
  assert.equal(req.status, 409, JSON.stringify(req.body));
  assert.equal(req.body.code, "ADMIN_AMBIGUOUS");
  assert.equal((await h.api("POST", "/admin/verify-otp", { body: { email: dup, otp: "123456" } })).status, 409);
  assert.equal(brevoCalls.length, before, "no code mailed");
  const lines = [];
  await require("../../scripts/privileged-identities").report({ log: (l) => lines.push(String(l)) });
  assert.ok(lines.some((l) => l.includes("DUPLICATE admin e-mail") && l.includes(dup)), lines.join("\n"));
  // a single-record e-mail still signs in normally
  const solo = await h.makeAdmin({ isVerified: true });
  assert.equal((await h.api("POST", "/admin/request-otp", { body: { email: solo.email } })).status, 200);
  assert.equal(brevoCalls.length, before + 1);
});

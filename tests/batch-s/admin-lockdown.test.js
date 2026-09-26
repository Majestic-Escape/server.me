// Phase 0a — POST /admin/register used to be open to anyone (verified Admin
// + a 7-day admin token) and /admin/service accepted any user token. Both are
// admin-only now; creating an admin is atomic with its audit row and returns
// no token. Also covers the read-only privileged-identities report.
const test = require("node:test");
const assert = require("node:assert/strict");
const jwt = require("jsonwebtoken");
const h = require("./setup");

const Admin = () => require("../../models/Admin");
const AdminAuditLog = () => require("../../models/AdminAuditLog");
const Configure = () => require("../../models/Configure");

let ADMIN, AT, G, GT, HOST, HT, BANNED, BT, RA, RAT;
let seq = 0;
const newAdmin = (extra = {}) => {
  seq += 1;
  return { firstName: `New${seq}`, lastName: "Admin", email: `new${seq}@lockdown.test`, ...extra };
};
const register = (body, token) => h.api("POST", "/admin/register", { token, body });
const counts = async () => ({ admins: await Admin().countDocuments(), audits: await AdminAuditLog().countDocuments({ action: "admin.create" }) });

test.before(async () => {
  await h.start();
  // The schema's unique e-mail index (admins' indexes are not managed by
  // ensure-indexes; the phone one is left out on purpose — see docs).
  await Admin().collection.createIndex({ email: 1 }, { unique: true });
  ADMIN = await h.makeAdmin();
  AT = h.adminToken(ADMIN);
  G = await h.makeUser();
  GT = h.userToken(G);
  HOST = await h.makeUser({ role: "host" });
  HT = h.userToken(HOST);
  BANNED = await h.makeAdmin({ status: { active: false, banned: true } });
  BT = h.adminToken(BANNED);
  RA = await h.makeUser({ role: "admin" });
  RAT = h.userToken(RA);
});
test.after(async () => h.stop());

test("register: anonymous, user, host, banned, deleted, forged and expired callers are refused and nothing is created", async () => {
  const before = await counts();
  const ghost = jwt.sign({ userId: "64b000000000000000000001", firstName: "Ghost" }, process.env.JWT_SECRET, { expiresIn: "1h" });
  const forged = jwt.sign({ userId: String(ADMIN._id), firstName: "Forged" }, "not-the-secret", { expiresIn: "1h" });
  const expired = jwt.sign({ userId: String(ADMIN._id), firstName: "Old", exp: Math.floor(Date.now() / 1000) - 60 }, process.env.JWT_SECRET);
  const cases = [
    ["anonymous", undefined, 401],
    ["guest", GT, 403],
    ["host", HT, 403],
    ["banned admin", BT, 401],
    ["deleted admin", ghost, 401],
    ["forged signature", forged, 403],
    ["expired admin token", expired, 401],
  ];
  for (const [label, token, status] of cases) {
    const r = await register(newAdmin(), token);
    assert.equal(r.status, status, `${label}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.token, undefined, `${label}: no token`);
  }
  assert.deepEqual(await counts(), before, "nothing created, nothing audited");
});

test("register: an admin creates an admin — 201, no token, verified, exactly one audit row in the same transaction", async () => {
  const before = await counts();
  const body = newAdmin({ phoneNumber: "7000000001" });
  const r = await register(body, AT);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.code, "ADMIN_CREATED");
  assert.equal(r.body.token, undefined, "the new account gets no token");
  const created = await Admin().findById(r.body.data.adminId).lean();
  assert.ok(created);
  assert.equal(created.email, body.email);
  assert.equal(created.isVerified, true);
  const rows = await AdminAuditLog().find({ action: "admin.create", targetId: created._id }).lean();
  assert.equal(rows.length, 1);
  assert.equal(String(rows[0].actorId), String(ADMIN._id));
  assert.equal(rows[0].targetType, "Admin");
  assert.deepEqual(rows[0].details || {}, {}, "ids only — no e-mail in the audit row");
  assert.deepEqual(await counts(), { admins: before.admins + 1, audits: before.audits + 1 });
});

test("register: a user whose role is admin is an admin (existing semantics)", async () => {
  const r = await register(newAdmin(), RAT);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const row = await AdminAuditLog().findOne({ action: "admin.create", targetId: r.body.data.adminId }).lean();
  assert.equal(String(row.actorId), String(RA._id));
});

test("register: validation, operator injection and duplicates are refused without side effects", async () => {
  const existing = newAdmin();
  assert.equal((await register(existing, AT)).status, 201);
  const before = await counts();

  const missing = await register({ lastName: "NoFirst", email: "x@lockdown.test" }, AT);
  assert.equal(missing.status, 400);
  assert.equal(missing.body.code, "MISSING_FIELDS");

  // an object would have reached Admin.findOne({ email }) as a query operator
  const injected = await register({ firstName: "Evil", email: { $gt: "" } }, AT);
  assert.equal(injected.status, 400);
  assert.equal((await register({ firstName: { $ne: null }, email: "y@lockdown.test" }, AT)).status, 400);

  const dupe = await register({ ...newAdmin(), email: existing.email }, AT);
  assert.equal(dupe.status, 409);
  assert.equal(dupe.body.code, "EMAIL_ALREADY_EXISTS");

  // the unique index catches a case variant the pre-check misses
  const upper = await register({ ...newAdmin(), email: existing.email.toUpperCase() }, AT);
  assert.equal(upper.status, 409, JSON.stringify(upper.body));

  assert.deepEqual(await counts(), before, "no admin and no audit row from refused requests");
});

test("register: when the audit row cannot be written nothing is saved (503)", async () => {
  const before = await counts();
  const Log = AdminAuditLog();
  const original = Log.create;
  Log.create = async () => {
    throw new Error("audit store unavailable");
  };
  try {
    const r = await register(newAdmin(), AT);
    assert.equal(r.status, 503, JSON.stringify(r.body));
    assert.equal(r.body.code, "AUDIT_UNAVAILABLE");
  } finally {
    Log.create = original;
  }
  assert.deepEqual(await counts(), before, "the admin insert rolled back with the audit failure");
});

test("service fees: admin-only for reading and writing", async () => {
  await Configure().deleteMany({});
  await Configure().create({ gst: "18", service: "12", razorpay: 2 });
  for (const [label, token, status] of [["anonymous", undefined, 401], ["guest", GT, 403], ["host", HT, 403]]) {
    assert.equal((await h.api("GET", "/admin/service", { token })).status, status, `GET ${label}`);
    const w = await h.api("POST", "/admin/service", { token, body: { gst: "0.01", service: "99" } });
    assert.equal(w.status, status, `POST ${label}`);
  }
  const unchanged = await Configure().findOne().lean();
  assert.equal(unchanged.service, "12", "refused writes changed nothing");

  const read = await h.api("GET", "/admin/service", { token: AT });
  assert.equal(read.status, 200);
  const write = await h.api("POST", "/admin/service", { token: AT, body: { gst: "18", service: "14" } });
  assert.equal(write.status, 200, JSON.stringify(write.body));
  assert.equal((await Configure().findOne().lean()).service, "14");
});

test("privileged-identities report lists every admin-capable account, audit provenance and bans; never writes", async () => {
  const { report } = require("../../scripts/privileged-identities");
  const before = await counts();
  const lines = [];
  const rows = await report({ log: (l) => lines.push(l), json: true });
  const byId = new Map(rows.map((r) => [r.id, r]));
  assert.equal(byId.get(String(ADMIN._id)).kind, "Admin");
  assert.equal(byId.get(String(ADMIN._id)).addedBy, "(no audit record)", "seeded directly — like any pre-fix account");
  assert.equal(byId.get(String(BANNED._id)).banned, "BANNED");
  assert.equal(byId.get(String(RA._id)).kind, "User role=admin");
  const audited = await AdminAuditLog().findOne({ action: "admin.create", actorId: ADMIN._id }).lean();
  assert.equal(byId.get(String(audited.targetId)).addedBy, String(ADMIN._id));
  assert.ok(!byId.has(String(G._id)), "ordinary users are not listed");
  assert.deepEqual(await counts(), before, "read-only");
  const table = [];
  await report({ log: (l) => table.push(l) });
  assert.ok(table.some((l) => /can act as admin right now/.test(l)));
});

test("login: operator objects are refused before any lookup (no code mailed, nobody's attempts used); a lock that ran out gives fresh attempts", async () => {
  const target = await h.makeAdmin({ isVerified: true });
  const mailed = h.sentEmails().length;
  for (const email of [{ $regex: "^" }, { $ne: null }, ["x"], 42, ""]) {
    const r = await h.api("POST", "/admin/request-otp", { body: { email } });
    assert.equal(r.status, 400, JSON.stringify(r.body));
    assert.equal(r.body.code, "INVALID_FIELDS");
  }
  assert.equal(h.sentEmails().length, mailed, "no code mailed to anyone");
  assert.equal((await h.api("POST", "/admin/verify-otp", { body: { email: { $regex: "^" }, otp: "000000" } })).status, 400);
  assert.equal((await h.api("POST", "/admin/verify-otp", { body: { email: target.email, otp: { $ne: "x" } } })).status, 400);
  assert.equal((await Admin().findById(target._id).lean()).otpRetries || 0, 0, "nobody's attempts were used");
  // a lock that has run out: a fresh set of attempts, not an instant re-lock
  await Admin().updateOne({ _id: target._id }, { $set: { otpRetries: 3, lockUntil: new Date(Date.now() - 1000), otp: { value: "123456", expiry: new Date(Date.now() + 60000) } } });
  const wrong = await h.api("POST", "/admin/verify-otp", { body: { email: target.email, otp: "654321" } });
  assert.equal(wrong.status, 400, JSON.stringify(wrong.body));
  assert.equal(wrong.body.code, "INVALID_OTP");
  assert.equal(wrong.body.otpAttempts.remainingAttempts, 2);
  const ok = await h.api("POST", "/admin/verify-otp", { body: { email: target.email, otp: "123456" } });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  // codes come from crypto: always six digits
  const { generateOTP } = require("../../utils/loginOtpUtils");
  for (let i = 0; i < 200; i += 1) assert.match(generateOTP(), /^[1-9]\d{5}$/);
});

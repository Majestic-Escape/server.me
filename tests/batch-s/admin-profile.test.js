// The signed-in admin's own profile: GET /admin/me and PATCH /admin/me/name.
// Self only (no id in the URL), same rename semantics as the admin rename of
// a user (validation, optimistic `expected`, audit row in the same
// transaction), for Admin-collection admins and role-admin users alike.
const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const h = require("./setup");

const Admin = () => require("../../models/Admin");
const User = () => require("../../models/User");
const AdminAuditLog = () => require("../../models/AdminAuditLog");

let G, GT, H, HT, ADMIN, AT, ADMIN2, AT2;

const me = (token) => h.api("GET", "/admin/me", { token });
const renameMe = (body, token = AT) => h.api("PATCH", "/admin/me/name", { token, body });
const audits = (targetId) => AdminAuditLog().countDocuments({ action: "admin.rename", targetId });
const nameOf = async (Model, id) => {
  const doc = await Model.findById(id).lean();
  return { firstName: doc.firstName, lastName: doc.lastName || "" };
};

test.before(async () => {
  await h.start();
  G = await h.makeUser({ firstName: "Guest", lastName: "One" });
  GT = h.userToken(G);
  H = await h.makeUser({ role: "host", firstName: "Host", lastName: "Person" });
  HT = h.userToken(H);
  await h.makeListing(H);
  ADMIN = await h.makeAdmin({ firstName: "Info", lastName: "Desk" });
  AT = h.adminToken(ADMIN);
  ADMIN2 = await h.makeAdmin({ firstName: "Other", lastName: "Admin" });
  AT2 = h.adminToken(ADMIN2);
});
test.after(async () => h.stop());

// ---------------------------------------------------------------------------
test("SM-PROF-01 authz: anon 401; guest, host, forged claim and deactivated admin 403; an admin sees only their own record", async () => {
  const DEACT = await h.makeAdmin({ firstName: "Gone", lastName: "Away", status: { active: false, banned: false } });
  const DT = h.adminToken(DEACT);
  const forged = h.userToken(G, { admin: 1 });
  const body = { firstName: "Hijack", lastName: "", expected: { firstName: "Info", lastName: "Desk" } };

  assert.equal((await me(null)).status, 401);
  assert.equal((await renameMe(body, null)).status, 401);
  for (const [label, token] of [["guest", GT], ["host", HT], ["forged admin claim", forged], ["deactivated admin", DT]]) {
    const g = await me(token);
    assert.equal(g.status, 403, `GET ${label}: ${JSON.stringify(g.body)}`);
    const p = await renameMe({ ...body, expected: { firstName: "Gone", lastName: "Away" } }, token);
    assert.equal(p.status, 403, `PATCH ${label}: ${JSON.stringify(p.body)}`);
  }
  assert.deepEqual(await nameOf(Admin(), DEACT._id), { firstName: "Gone", lastName: "Away" }, "a deactivated admin cannot rename itself");
  assert.deepEqual(await nameOf(User(), G._id), { firstName: "Guest", lastName: "One" });
  assert.equal(await AdminAuditLog().countDocuments({ action: "admin.rename" }), 0);

  const mine = await me(AT);
  assert.equal(mine.status, 200, JSON.stringify(mine.body));
  assert.deepEqual(mine.body, { success: true, data: { firstName: "Info", lastName: "Desk", email: ADMIN.email } });
  // no way to point it at someone else
  const other = await h.api("GET", `/admin/me?id=${ADMIN2._id}&userId=${ADMIN2._id}`, { token: AT });
  assert.equal(other.body.data.email, ADMIN.email);
  assert.equal((await me(AT2)).body.data.email, ADMIN2.email);
  const bare = await h.makeAdmin({ firstName: "Solo", lastName: undefined });
  const bareMe = await me(h.adminToken(bare));
  assert.deepEqual(bareMe.body.data, { firstName: "Solo", lastName: "", email: bare.email }, "a missing last name reads as empty");

  // a token whose admin record is gone signs nobody in
  const ghost = await h.makeAdmin();
  const ghostToken = h.adminToken(ghost);
  await Admin().deleteOne({ _id: ghost._id });
  assert.equal((await me(ghostToken)).status, 401);
  assert.equal((await renameMe({ firstName: "Ghost", lastName: "", expected: { firstName: ghost.firstName, lastName: "Test" } }, ghostToken)).status, 401);
});

test("SM-PROF-01 rename: valid, unchanged, invalid, missing/stale expected, extra fields ignored, 'Admin Support'", async () => {
  const A = await h.makeAdmin({ firstName: "Info", lastName: "Majestic" });
  const T = h.adminToken(A);
  const before = await Admin().findById(A._id).lean();

  // valid
  const ok = await renameMe({ firstName: "  Info   Team ", lastName: " Majestic ", expected: { firstName: "Info", lastName: "Majestic" } }, T);
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.deepEqual(ok.body, { success: true, changed: true, data: { firstName: "Info Team", lastName: "Majestic" } });
  assert.deepEqual(await nameOf(Admin(), A._id), { firstName: "Info Team", lastName: "Majestic" });
  assert.equal(await audits(A._id), 1);
  const row = await AdminAuditLog().findOne({ action: "admin.rename", targetId: A._id }).lean();
  assert.equal(String(row.actorId), String(A._id));
  assert.equal(row.actorKind, "admin");
  assert.equal(row.targetType, "Admin");
  assert.deepEqual(row.details, { before: { firstName: "Info", lastName: "Majestic" }, after: { firstName: "Info Team", lastName: "Majestic" } });
  assert.equal(JSON.stringify(row).includes("@"), false, "no e-mail in the audit row");

  // unchanged → no audit row
  const same = await renameMe({ firstName: "Info Team", lastName: "Majestic", expected: { firstName: "Info Team", lastName: "Majestic" } }, T);
  assert.equal(same.status, 200);
  assert.deepEqual(same.body, { success: true, changed: false, data: { firstName: "Info Team", lastName: "Majestic" } });
  assert.equal(await audits(A._id), 1, "no audit row for a no-op");

  // invalid
  const exp = { firstName: "Info Team", lastName: "Majestic" };
  for (const [first, last, field] of [
    ["Admin2", "Support", "firstName"],
    ["A".repeat(51), "", "firstName"],
    ["WhatsApp Rahul", "", "firstName"],
    ["", "Support", "firstName"],
    ["<b>Admin</b>", "", "firstName"],
    ["Admin", "Supp0rt", "lastName"],
    ["Admin", "B".repeat(51), "lastName"],
  ]) {
    const r = await renameMe({ firstName: first, lastName: last, expected: exp }, T);
    assert.equal(r.status, 400, `${JSON.stringify([first, last])} → ${r.status}`);
    assert.equal(r.body.code, "INVALID_NAME");
    assert.equal(r.body.field, field, JSON.stringify([first, last]));
  }
  const nonString = await renameMe({ firstName: { $ne: "" }, lastName: "", expected: exp }, T);
  assert.equal(nonString.status, 400);

  // expected is required
  for (const body of [{ firstName: "Admin", lastName: "Support" }, { firstName: "Admin", lastName: "Support", expected: "Info Team" }, { firstName: "Admin", lastName: "Support", expected: { lastName: "Majestic" } }]) {
    const r = await renameMe(body, T);
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.equal(r.body.code, "EXPECTED_REQUIRED");
  }
  assert.deepEqual(await nameOf(Admin(), A._id), exp, "nothing written by a refused request");

  // stale expected → 409 with the current names, nothing written
  const stale = await renameMe({ firstName: "Admin", lastName: "Support", expected: { firstName: "Info", lastName: "Majestic" } }, T);
  assert.equal(stale.status, 409);
  assert.equal(stale.body.code, "NAME_CHANGED");
  assert.deepEqual(stale.body.data, exp);
  const staleLast = await renameMe({ firstName: "Admin", lastName: "Support", expected: { firstName: "Info Team", lastName: "" } }, T);
  assert.equal(staleLast.status, 409, "an empty expected last name does not match a stored one");
  assert.deepEqual(await nameOf(Admin(), A._id), exp);
  assert.equal(await audits(A._id), 1, "no audit row for a stale write");

  // every other body field is ignored
  const extra = await renameMe({
    firstName: "Info",
    lastName: "Desk",
    expected: exp,
    email: "attacker@evil.test",
    role: "user",
    status: { active: false, banned: true },
    _id: String(new mongoose.Types.ObjectId()),
    otp: { value: "000000", expiry: new Date(Date.now() + 1e6).toISOString() },
    isVerified: false,
    phoneNumber: "9999999999",
  }, T);
  assert.equal(extra.status, 200, JSON.stringify(extra.body));
  const after = await Admin().findById(A._id).lean();
  assert.equal(after.firstName, "Info");
  assert.equal(after.lastName, "Desk");
  for (const key of ["email", "role", "isVerified", "phoneNumber"]) assert.deepEqual(after[key], before[key], key);
  assert.deepEqual(after.status, before.status);
  assert.deepEqual(after.otp, before.otp);
  assert.equal(await Admin().countDocuments({ email: "attacker@evil.test" }), 0);
  assert.equal(await audits(A._id), 2);

  // the owner's case: "Admin Support", no last name
  const support = await renameMe({ firstName: "Admin Support", lastName: "", expected: { firstName: "Info", lastName: "Desk" } }, T);
  assert.equal(support.status, 200, JSON.stringify(support.body));
  assert.deepEqual(support.body.data, { firstName: "Admin Support", lastName: "" });
  const stored = await Admin().findById(A._id).lean();
  assert.equal(`${stored.firstName} ${stored.lastName || ""}`.trim(), "Admin Support");
  const profile = await me(T);
  assert.deepEqual(profile.body.data, { firstName: "Admin Support", lastName: "", email: before.email });
  assert.equal(`${profile.body.data.firstName} ${profile.body.data.lastName}`.trim(), "Admin Support");
  // and from the empty last name, an empty expected value matches
  const back = await renameMe({ firstName: "Admin", lastName: "Support", expected: { firstName: "Admin Support", lastName: "" } }, T);
  assert.equal(back.status, 200);
  assert.equal(await audits(A._id), 4);
  // other admins untouched
  assert.deepEqual(await nameOf(Admin(), ADMIN2._id), { firstName: "Other", lastName: "Admin" });
});

test("SM-PROF-02 audit insert failure → 503 AUDIT_UNAVAILABLE and the name is unchanged", async () => {
  const A = await h.makeAdmin({ firstName: "Keep", lastName: "Me" });
  const original = AdminAuditLog().create;
  AdminAuditLog().create = async () => {
    throw new Error("mock: audit store down");
  };
  let r;
  try {
    r = await renameMe({ firstName: "Lost", lastName: "Me", expected: { firstName: "Keep", lastName: "Me" } }, h.adminToken(A));
  } finally {
    AdminAuditLog().create = original;
  }
  assert.equal(r.status, 503);
  assert.equal(r.body.code, "AUDIT_UNAVAILABLE");
  assert.deepEqual(await nameOf(Admin(), A._id), { firstName: "Keep", lastName: "Me" }, "rolled back with the audit");
  assert.equal(await audits(A._id), 0);
});

test("SM-PROF-03 a transient transaction error on the first attempt is retried: one audit row, name updated once", async () => {
  // The in-memory server refuses test commands (configureFailPoint), so the
  // first audit insert is made to succeed inside the transaction and then
  // fail with a driver error labelled TransientTransactionError — exactly
  // what a write conflict looks like to withTransaction. The driver aborts
  // (dropping that insert and the name update) and runs the callback again.
  const A = await h.makeAdmin({ firstName: "Retry", lastName: "Once" });
  const original = AdminAuditLog().create;
  let calls = 0;
  AdminAuditLog().create = async function (...args) {
    calls += 1;
    const rows = await original.apply(this, args);
    if (calls === 1) {
      const err = new mongoose.mongo.MongoServerError({ message: "mock: write conflict", code: 112, codeName: "WriteConflict" });
      err.addErrorLabel("TransientTransactionError");
      throw err;
    }
    return rows;
  };
  let r;
  try {
    r = await renameMe({ firstName: "Retried", lastName: "Once", expected: { firstName: "Retry", lastName: "Once" } }, h.adminToken(A));
  } finally {
    AdminAuditLog().create = original;
  }
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.changed, true);
  assert.equal(calls, 2, "the callback ran twice");
  assert.deepEqual(await nameOf(Admin(), A._id), { firstName: "Retried", lastName: "Once" });
  assert.equal(await audits(A._id), 1, "exactly one audit row survives the retry");
  const row = await AdminAuditLog().findOne({ action: "admin.rename", targetId: A._id }).lean();
  assert.deepEqual(row.details.before, { firstName: "Retry", lastName: "Once" }, "the retry re-read the original name");
});

test("SM-PROF-04 two concurrent renames with the same expected → one 200, one 409, one audit row", async () => {
  const A = await h.makeAdmin({ firstName: "Race", lastName: "Start" });
  const T = h.adminToken(A);
  const [a, b] = await Promise.all([
    renameMe({ firstName: "First", lastName: "Winner", expected: { firstName: "Race", lastName: "Start" } }, T),
    renameMe({ firstName: "Second", lastName: "Winner", expected: { firstName: "Race", lastName: "Start" } }, T),
  ]);
  assert.deepEqual([a.status, b.status].sort(), [200, 409], JSON.stringify([a.body, b.body]));
  const loser = a.status === 409 ? a : b;
  assert.equal(loser.body.code, "NAME_CHANGED");
  const winner = a.status === 200 ? "First" : "Second";
  assert.deepEqual(await nameOf(Admin(), A._id), { firstName: winner, lastName: "Winner" });
  assert.deepEqual(loser.body.data, { firstName: winner, lastName: "Winner" }, "the loser sees the winner's name");
  assert.equal(await audits(A._id), 1);
});

test("SM-PROF-05 a role-admin user renames their own users record; audit target User", async () => {
  const RA = await h.makeUser({ role: "admin", firstName: "Role", lastName: "Admin" });
  const RT = h.userToken(RA);
  const profile = await me(RT);
  assert.equal(profile.status, 200, JSON.stringify(profile.body));
  assert.deepEqual(profile.body.data, { firstName: "Role", lastName: "Admin", email: RA.email });

  const r = await renameMe({ firstName: "Admin Support", lastName: "", expected: { firstName: "Role", lastName: "Admin" }, role: "user", email: "x@evil.test" }, RT);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body, { success: true, changed: true, data: { firstName: "Admin Support", lastName: "" } });
  const stored = await User().findById(RA._id).lean();
  assert.equal(stored.firstName, "Admin Support");
  assert.equal(stored.lastName, "");
  assert.equal(stored.role, "admin");
  assert.equal(stored.email, RA.email);
  assert.equal(await Admin().exists({ _id: RA._id }), null, "no Admin record created or touched");
  const row = await AdminAuditLog().findOne({ action: "admin.rename", targetId: RA._id }).lean();
  assert.ok(row);
  assert.equal(row.targetType, "User");
  assert.equal(String(row.actorId), String(RA._id));
  assert.deepEqual(row.details, { before: { firstName: "Role", lastName: "Admin" }, after: { firstName: "Admin Support", lastName: "" } });

  // a token revoked by tokenVersion no longer reaches it
  await User().updateOne({ _id: RA._id }, { $inc: { tokenVersion: 1 } });
  assert.equal((await me(RT)).status, 401);
});

// Anonymous listing exposure closed next to search:
//   GET /prop-listing/ — drafts / in-review / delisted listings only for an
//     admin or the host listing their own; operator-shaped params refused;
//     searchTerm is literal, bounded text.
//   /property-registration-no — the number check is a literal match (".*"
//     used to "exist" and pass the Goa check); the full dump and the bulk
//     insert are admin-only.
const test = require("node:test");
const assert = require("node:assert/strict");
const h = require("./setup");

const PropertyRegistrationNo = () => require("../../models/PropertyRegistrationNo");

let HOST, HT, OTHER, OT, AT;

test.before(async () => {
  await h.start();
  HOST = await h.makeUser({ role: "host", firstName: "Owner", email: "owner@exposure.test" });
  HT = h.userToken(HOST);
  OTHER = await h.makeUser({ role: "host", firstName: "Other", email: "other@exposure.test" });
  OT = h.userToken(OTHER);
  AT = h.adminToken(await h.makeAdmin());
  for (const status of ["active", "incomplete", "processing", "inactive"]) {
    await h.makeListing(HOST, { title: `Exposure ${status}`, status, address: { city: "Panaji", state: "Goa" } });
  }
  await PropertyRegistrationNo().create({ registrationNo: "HOTN000123", propertyName: "Test Guest House", district: "North Goa", taluka: "Tiswadi", area: "Panaji", noOfRooms: 3 });
});
test.after(async () => h.stop());

const statuses = (body) => [...new Set((body.listings || []).map((l) => l.status))].sort();

test("prop-listing: non-public statuses only for the admin or the host's own list", async () => {
  // anonymous — with and without asking for a status
  for (const qs of ["", "?status=incomplete", "?status=processing", "?status=inactive", "?status=all"]) {
    const r = await h.api("GET", `/prop-listing/${qs}`);
    assert.equal(r.status, 200, qs);
    assert.deepEqual(statuses(r.body), ["active"], `anonymous ${qs || "(none)"}`);
  }
  // another signed-in user
  assert.deepEqual(statuses((await h.api("GET", "/prop-listing/?status=incomplete", { token: OT })).body), ["active"]);
  // the host's own list keeps working with any status
  const own = await h.api("GET", `/prop-listing/?hostEmail=${encodeURIComponent(HOST.email)}&status=processing`, { token: HT });
  assert.equal(own.status, 200);
  assert.deepEqual(statuses(own.body), ["processing"]);
  // someone else's hostEmail stays refused (unchanged)
  assert.equal((await h.api("GET", `/prop-listing/?hostEmail=${encodeURIComponent(HOST.email)}`, { token: OT })).status, 403);
  assert.equal((await h.api("GET", `/prop-listing/?hostEmail=${encodeURIComponent(HOST.email)}`)).status, 401);
  // the admin sees every status it asks for
  for (const s of ["incomplete", "processing", "inactive", "active"]) {
    assert.deepEqual(statuses((await h.api("GET", `/prop-listing/?status=${s}`, { token: AT })).body), [s], `admin ${s}`);
  }
  // a forged admin claim in the token is not an admin
  const forged = h.userToken(OTHER, { admin: 1, role: "admin" });
  assert.deepEqual(statuses((await h.api("GET", "/prop-listing/?status=incomplete", { token: forged })).body), ["active"]);
});

test("prop-listing: operator-shaped and unknown params refused; searchTerm is literal", async () => {
  for (const qs of ["status[$ne]=active", "status[]=incomplete", "searchTerm[$regex]=.*", "hostEmail[$ne]=x", "status=bogus", "page[$gt]=1"]) {
    const r = await h.api("GET", `/prop-listing/?${qs}`);
    assert.equal(r.status, 400, qs);
  }
  const any = await h.api("GET", "/prop-listing/?searchTerm=.*");
  assert.equal(any.status, 200);
  assert.equal(any.body.listings.length, 0, "'.*' is text, not match-everything");
  const t0 = Date.now();
  const redos = await h.api("GET", `/prop-listing/?searchTerm=${encodeURIComponent("(a+)+$" + "a".repeat(200))}`);
  assert.equal(redos.status, 200);
  assert.ok(Date.now() - t0 < 2000);
  assert.equal((await h.api("GET", "/prop-listing/?searchTerm=Exposure")).body.listings.length, 1, "plain search still works (active only)");
});

test("registration numbers: literal match; dump and insert are admin-only", async () => {
  assert.equal((await h.api("GET", "/property-registration-no/HOTN000123")).status, 200);
  assert.equal((await h.api("GET", "/property-registration-no/hotn000123")).status, 200, "case-insensitive as before");
  for (const probe of [".*", "HOTN.*", "^.*$", "HOTN000123|x", "(a+)+$", "x".repeat(65)]) {
    const r = await h.api("GET", `/property-registration-no/${encodeURIComponent(probe)}`);
    assert.equal(r.status, 404, probe);
    assert.equal(r.body.exists, false);
  }
  assert.equal((await h.api("GET", "/property-registration-no/")).status, 401);
  assert.equal((await h.api("GET", "/property-registration-no/", { token: HT })).status, 403);
  assert.equal((await h.api("GET", "/property-registration-no/", { token: AT })).status, 200);
  const fake = [{ registrationNo: "HOTN999999", propertyName: "Fake" }];
  assert.equal((await h.api("POST", "/property-registration-no/", { body: fake })).status, 401);
  assert.equal((await h.api("POST", "/property-registration-no/", { body: fake, token: HT })).status, 403);
  assert.equal(await PropertyRegistrationNo().countDocuments({ registrationNo: "HOTN999999" }), 0, "nobody but an admin can register a number");
});

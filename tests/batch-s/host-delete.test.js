// A host deletes its own draft ("incomplete") or withdraws its own pending
// submission ("processing") through DELETE /properties/host/:id — the same
// fail-safe service as the admin deletion. Admins may now delete drafts too.
const test = require("node:test");
const assert = require("node:assert/strict");
const h = require("./setup");

const ListingProperty = () => require("../../models/ListingProperty");
const Booking = () => require("../../models/Booking");
const AdminAuditLog = () => require("../../models/AdminAuditLog");

let HOST, HT, OTHER, OT, GUEST, GT, AT;

test.before(async () => {
  await h.start();
  HOST = await h.makeUser({ role: "host", firstName: "Owner", email: "owner@delete.test" });
  HT = h.userToken(HOST);
  OTHER = await h.makeUser({ role: "host", firstName: "Other", email: "other@delete.test" });
  OT = h.userToken(OTHER);
  GUEST = await h.makeUser({ firstName: "Guest", email: "guest@delete.test" });
  GT = h.userToken(GUEST);
  AT = h.adminToken(await h.makeAdmin());
});
test.after(async () => h.stop());

const del = (id, token) => h.api("DELETE", `/properties/host/${id}`, { token });

test("a host deletes its own draft: the row is gone, the audit row names the host", async () => {
  const draft = await h.makeListing(HOST, { title: "", status: "incomplete" });
  const r = await del(draft._id, HT);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.success, true);
  assert.equal(String(r.body.data._id), String(draft._id));
  assert.equal(await ListingProperty().findById(draft._id), null, "deleted");
  const audit = await AdminAuditLog().findOne({ targetId: draft._id, action: "listing.delete" }).lean();
  assert.ok(audit, "audit row written");
  assert.equal(audit.actorKind, "host");
  assert.equal(String(audit.actorId), String(HOST._id));
});

test("a host withdraws its own pending submission", async () => {
  const pending = await h.makeListing(HOST, { title: "Pending villa", status: "processing" });
  const r = await del(pending._id, HT);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(await ListingProperty().findById(pending._id), null);
});

test("live and delisted listings are refused (delist instead); nothing changes", async () => {
  const active = await h.makeListing(HOST, { title: "Live villa", status: "active" });
  const inactive = await h.makeListing(HOST, { title: "Paused villa", status: "inactive" });
  for (const l of [active, inactive]) {
    const r = await del(l._id, HT);
    assert.equal(r.status, 409, JSON.stringify(r.body));
    assert.equal(r.body.code, "LISTING_NOT_PENDING");
    assert.ok(await ListingProperty().findById(l._id), "still there");
  }
});

test("another host, a guest and an anonymous caller cannot delete it; a foreign listing answers 404 (no oracle)", async () => {
  const draft = await h.makeListing(HOST, { title: "", status: "incomplete" });
  const other = await del(draft._id, OT);
  assert.equal(other.status, 404, JSON.stringify(other.body));
  assert.equal(other.body.code, "LISTING_NOT_FOUND");
  const unknown = await del("000000000000000000000000", OT);
  assert.equal(unknown.status, 404);
  assert.equal(unknown.body.code, other.body.code, "a foreign listing and an unknown id answer the same way");
  const guest = await del(draft._id, GT);
  assert.equal(guest.status, 404, "a guest is a user without listings — same answer");
  const anon = await h.api("DELETE", `/properties/host/${draft._id}`, {});
  assert.equal(anon.status, 401);
  assert.ok(await ListingProperty().findById(draft._id), "still there");
  const bad = await del("not-an-id", HT);
  assert.equal(bad.status, 404);
});

test("a pending listing with a booking attached is refused with the blocker named", async () => {
  const pending = await h.makeListing(HOST, { title: "Booked pending", status: "processing" });
  await Booking().create({ userId: GUEST._id, hostId: HOST._id, propertyId: pending._id, checkIn: h.day(30), checkOut: h.day(32), price: 100, subTotal: 90, guests: 2, adults: 2, nights: 2, status: "pending", paymentStatus: "unpaid", source: "local", action: "user" });
  const r = await del(pending._id, HT);
  assert.equal(r.status, 409, JSON.stringify(r.body));
  assert.equal(r.body.code, "LISTING_HAS_DEPENDENTS");
  assert.deepEqual(r.body.blockers, ["bookings"]);
  assert.ok(await ListingProperty().findById(pending._id));
});

test("an admin can delete a draft as well as a pending listing; the admin list shows drafts on request", async () => {
  const draft = await h.makeListing(HOST, { title: "", status: "incomplete" });
  const listed = await h.api("GET", "/properties/admin/filtered-listings?status=incomplete&page=1&limit=100", { token: AT });
  assert.ok(listed.body.properties.some((l) => String(l._id) === String(draft._id)), "status=incomplete lists drafts");
  const hidden = await h.api("GET", "/properties/admin/filtered-listings?status=all&page=1&limit=100", { token: AT });
  assert.ok(!hidden.body.properties.some((l) => String(l._id) === String(draft._id)), "status=all keeps hiding drafts");
  const r = await h.api("DELETE", `/properties/admin/${draft._id}`, { token: AT });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(await ListingProperty().findById(draft._id), null);
  const audit = await AdminAuditLog().findOne({ targetId: draft._id }).lean();
  assert.equal(audit.actorKind, "admin");
});

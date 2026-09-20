// Host listing writes and the owner read. The edit wizard loads the listing
// through GET /prop-listing/:id and PUTs the whole object back through
// /properties/update-listing-property/:id — so the owner must read the stored
// truth (the public view, written back, moved the listing by its approximate
// offset and erased the street), and the PUT body must not be able to set
// what belongs to the server or the admin (status "active", kycStatus,
// bankDetails, ban, host, rating).
const test = require("node:test");
const assert = require("node:assert/strict");
const h = require("./setup");

const ListingProperty = () => require("../../models/ListingProperty");

const ADDRESS = {
  street: "House No 72, Holiday Street",
  district: "North Goa",
  city: "Panaji",
  state: "Goa",
  pincode: "403001",
  country: "India",
  latitude: 15.4909,
  longitude: 73.8278,
  registrationNumber: "GOA-REG-123",
};

let HOST, HT, OTHER, OT, GUEST, GT, AT;

test.before(async () => {
  await h.start();
  HOST = await h.makeUser({ role: "host", firstName: "Owner", email: "owner@guard.test" });
  HT = h.userToken(HOST);
  OTHER = await h.makeUser({ role: "host", firstName: "Other", email: "other@guard.test" });
  OT = h.userToken(OTHER);
  GUEST = await h.makeUser({ firstName: "Guest", email: "guest@guard.test" });
  GT = h.userToken(GUEST);
  AT = h.adminToken(await h.makeAdmin());
});
test.after(async () => h.stop());

const metres = (a, b) => {
  const dLat = (a.latitude - b.latitude) * 111320;
  const dLng = (a.longitude - b.longitude) * 111320 * Math.cos((a.latitude * Math.PI) / 180);
  return Math.sqrt(dLat * dLat + dLng * dLng);
};

test("GET /prop-listing/:id — the owner and an admin read the stored address; everyone else the public view", async () => {
  const l = await h.makeListing(HOST, { title: "Guarded villa", status: "active", address: ADDRESS, kycStatus: "completed" });
  const path = `/prop-listing/${l._id}?hostEmail=${encodeURIComponent(HOST.email)}`;

  const own = await h.api("GET", path, { token: HT });
  assert.equal(own.status, 200, JSON.stringify(own.body));
  assert.equal(own.body.address.street, ADDRESS.street, "owner sees the street");
  assert.equal(own.body.address.registrationNumber, ADDRESS.registrationNumber, "owner sees the registration number");
  assert.equal(own.body.address.latitude, ADDRESS.latitude, "owner sees the exact point");
  assert.equal(own.body.address.longitude, ADDRESS.longitude);
  assert.equal(own.body.hostEmail, HOST.email, "owner sees their own e-mail");
  assert.equal(own.body.kycStatus, "completed", "owner sees the KYC stage");
  assert.equal(own.body.embedding, undefined, "vectors never leave");

  const admin = await h.api("GET", path, { token: AT });
  assert.equal(admin.status, 200);
  assert.equal(admin.body.address.street, ADDRESS.street);
  assert.equal(admin.body.address.latitude, ADDRESS.latitude);

  for (const [who, token] of [["anonymous", undefined], ["another host", OT], ["a guest", GT]]) {
    const r = await h.api("GET", `/prop-listing/${l._id}`, { token });
    assert.equal(r.status, 200, who);
    assert.equal(r.body.address.street, undefined, `${who}: no street`);
    assert.equal(r.body.address.registrationNumber, undefined, `${who}: no registration number`);
    const d = metres(r.body.address, ADDRESS);
    assert.ok(d >= 140 && d <= 360, `${who}: approximate point ${d.toFixed(0)} m away`);
    assert.equal(r.body.hostEmail, undefined, `${who}: no hostEmail`);
    assert.equal(r.body.kycStatus, undefined, `${who}: no kycStatus`);
    assert.equal(r.body.ban, undefined, `${who}: no ban flag`);
    assert.equal(r.body.__v, undefined, `${who}: no __v`);
  }

  // a stale session is refused rather than silently served the public view
  const stale = await h.api("GET", path, { headers: { authorization: "Bearer not-a-token" } });
  assert.equal(stale.status, 403);
});

test("public GET /properties/:id carries no kycStatus / ban / __v; the admin document still does", async () => {
  const l = await h.makeListing(HOST, { title: "Public villa", status: "active", address: ADDRESS, kycStatus: "completed" });
  const pub = await h.api("GET", `/properties/${l._id}`);
  assert.equal(pub.status, 200);
  assert.equal(pub.body.data.kycStatus, undefined);
  assert.equal(pub.body.data.ban, undefined);
  assert.equal(pub.body.data.__v, undefined);
  assert.equal(pub.body.data.address.street, undefined);
  const admin = await h.api("GET", `/prop-listing/admin/${l._id}`, { token: AT });
  assert.equal(admin.status, 200, JSON.stringify(admin.body));
  assert.equal(admin.body.data.kycStatus, "completed");
  assert.equal(typeof admin.body.data.ban, "boolean");
});

test("the wizard round-trip keeps the stored address: owner GET → PUT the same object → nothing moved", async () => {
  const l = await h.makeListing(HOST, { title: "Round trip villa", status: "processing", address: ADDRESS });
  const own = await h.api("GET", `/prop-listing/${l._id}?hostEmail=${encodeURIComponent(HOST.email)}`, { token: HT });
  assert.equal(own.status, 200);
  const put = await h.api("PUT", `/properties/update-listing-property/${l._id}?submit=&status=`, { token: HT, body: { ...own.body, status: "processing" } });
  assert.equal(put.status, 200, JSON.stringify(put.body));
  const stored = await ListingProperty().findById(l._id).lean();
  assert.equal(stored.address.street, ADDRESS.street, "street kept");
  assert.equal(stored.address.registrationNumber, ADDRESS.registrationNumber, "registration number kept");
  assert.equal(stored.address.latitude, ADDRESS.latitude, "latitude kept");
  assert.equal(stored.address.longitude, ADDRESS.longitude, "longitude kept");
  assert.equal(String(stored.host), String(HOST._id), "host kept");
  assert.equal(stored.hostEmail, HOST.email, "hostEmail kept");
});

test("a host cannot activate, KYC-complete, bank-verify, unban, rate or hand over their listing through the PUT body", async () => {
  const l = await h.makeListing(HOST, { title: "Pending villa", status: "processing", address: ADDRESS, ban: false, kycStatus: "pending", bankDetails: false });

  const activate = await h.api("PUT", `/properties/update-listing-property/${l._id}`, { token: HT, body: { status: "active" } });
  assert.equal(activate.status, 403, JSON.stringify(activate.body));
  assert.equal(activate.body.code, "LISTING_STATUS_NOT_ALLOWED");
  assert.equal((await ListingProperty().findById(l._id).lean()).status, "processing", "still pending");

  const forged = await h.api("PUT", `/properties/update-listing-property/${l._id}`, {
    token: HT,
    body: { title: "Pending villa (edited)", kycStatus: "completed", bankDetails: true, validRegistrationNo: true, ban: true, averageRating: 5, reviewCount: 999, badge: "superhost", host: String(OTHER._id), hostEmail: OTHER.email, __v: 42 },
  });
  assert.equal(forged.status, 200, JSON.stringify(forged.body));
  const stored = await ListingProperty().findById(l._id).lean();
  assert.equal(stored.title, "Pending villa (edited)", "the ordinary field was written");
  assert.equal(stored.kycStatus, "pending");
  assert.equal(stored.bankDetails, false);
  assert.ok(!stored.validRegistrationNo);
  assert.equal(stored.ban, false);
  assert.equal(stored.averageRating ?? 0, 0);
  assert.equal(stored.reviewCount ?? 0, 0);
  assert.ok(!stored.badge);
  assert.equal(String(stored.host), String(HOST._id), "still the owner's");
  assert.equal(stored.hostEmail, HOST.email);

  // only immutable fields in the body: nothing to write, nothing breaks
  const noop = await h.api("PUT", `/properties/update-listing-property/${l._id}`, { token: HT, body: { kycStatus: "completed" } });
  assert.equal(noop.status, 200, JSON.stringify(noop.body));
  assert.equal((await ListingProperty().findById(l._id).lean()).kycStatus, "pending");

  // the wizard's own transitions still work: park the draft, resubmit, leave the status alone
  const active = await h.makeListing(HOST, { title: "Live villa", status: "active", address: ADDRESS });
  const same = await h.api("PUT", `/properties/update-listing-property/${active._id}`, { token: HT, body: { status: "active", title: "Live villa 2" } });
  assert.equal(same.status, 200, "unchanged status is fine");
  const resubmit = await h.api("PUT", `/properties/update-listing-property/${active._id}`, { token: HT, body: { status: "processing" } });
  assert.equal(resubmit.status, 200, "back to review is the host's call");
  const relive = await h.api("PUT", `/properties/update-listing-property/${active._id}`, { token: HT, body: { status: "active" } });
  assert.equal(relive.status, 403, "…but not back to live");
  const park = await h.api("PUT", `/properties/update-listing-property/${active._id}`, { token: HT, body: { status: "incomplete" } });
  assert.equal(park.status, 200);
  const delist = await h.api("PUT", `/properties/update-listing-property/${active._id}`, { token: HT, body: { status: "inactive" } });
  assert.equal(delist.status, 403, "delisting has its own route");

  // an admin keeps the full write
  const adminActivate = await h.api("PUT", `/properties/update-listing-property/${l._id}`, { token: AT, body: { status: "active", kycStatus: "completed" } });
  assert.equal(adminActivate.status, 200, JSON.stringify(adminActivate.body));
  assert.equal((await ListingProperty().findById(l._id).lean()).status, "active");
});

test("create-listing-property ignores the same fields from a host", async () => {
  const r = await h.api("POST", "/properties/create-listing-property", {
    token: HT,
    body: { hostEmail: HOST.email, title: "Fresh draft", status: "active", kycStatus: "completed", bankDetails: true, ban: true, averageRating: 5, host: String(OTHER._id) },
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const stored = await ListingProperty().findById(r.body._id).lean();
  assert.equal(stored.status, "incomplete");
  assert.notEqual(stored.kycStatus, "completed");
  assert.equal(stored.bankDetails ?? false, false);
  assert.equal(stored.ban ?? false, false);
  assert.equal(String(stored.host), String(HOST._id));
});

test("GET /prop-listing/?hostEmail= is the host's own (or an admin's) — no e-mail oracle", async () => {
  await h.makeListing(HOST, { title: "Oracle villa", status: "active", address: ADDRESS });
  const anon = await h.api("GET", `/prop-listing/?hostEmail=${encodeURIComponent(HOST.email)}`);
  assert.equal(anon.status, 401, JSON.stringify(anon.body));
  const other = await h.api("GET", `/prop-listing/?hostEmail=${encodeURIComponent(HOST.email)}`, { token: OT });
  assert.equal(other.status, 403);
  const own = await h.api("GET", `/prop-listing/?hostEmail=${encodeURIComponent(HOST.email)}`, { token: HT });
  assert.equal(own.status, 200);
  assert.ok(own.body.listings.every((x) => x.hostEmail === undefined), "the list view stays the public projection");
  assert.ok(own.body.listings.some((x) => x.title === "Oracle villa"));
  const admin = await h.api("GET", `/prop-listing/?hostEmail=${encodeURIComponent(HOST.email)}`, { token: AT });
  assert.equal(admin.status, 200);
  const open = await h.api("GET", "/prop-listing/?page=1");
  assert.equal(open.status, 200, "the catalogue read stays anonymous");
});

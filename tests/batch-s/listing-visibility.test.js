// Listing visibility (docs/listing-visibility.md) — who reads what of a
// listing that is not public, and the related exposure fixes:
//   GET /properties/:id and GET /prop-listing/:id — owner / active admin /
//     confirmed-paid guest / everyone else (stub) × every listing state
//   the booked guest never reads the host's current draft text (detail AND
//     booking routes); the booking records what they booked under
//   GET /properties/get-timings — host / admin only, three fields
//   GET /booking/check-dates, /booking/blocked-dates — hidden for non-public
//   GET /properties/id-and-name, /properties/admin/active — admin only
//   GET /properties/active/:hostId — another user gets cards only
//   card reads mask a title against the listing's own street (mask context)
//   the PII filter's error path drops cache headers
const test = require("node:test");
const assert = require("node:assert/strict");
const h = require("./setup");

const ListingProperty = () => require("../../models/ListingProperty");
const Booking = () => require("../../models/Booking");
const User = () => require("../../models/User");

let HOST, HT, OTHER, OT, ADMIN, AT, DEACT_AT, ROLE_ADMIN_T;
const L = {}; // listings by state
const STATES = {
  active: { status: "active" },
  activeBanned: { status: "active", ban: true },
  processing: { status: "processing" },
  incomplete: { status: "incomplete" },
  hostDelisted: { status: "inactive", delist: "host" },
  adminDelisted: { status: "inactive", delist: "admin" },
  banned: { status: "inactive", ban: true },
};
const STUB_KEYS = new Set(["_id", "title", "photos", "propertyType", "placeType", "basePrice", "address", "host", "averageRating", "reviewCount", "status"]);
const SECRET_TEXT = "Secret draft description about the hidden pool";

const addr = (n) => ({ street: `${n} Copper Lantern Road`, city: "Panaji", district: "North Goa", state: "Goa", pincode: "403001", latitude: 15.4909, longitude: 73.8278, registrationNumber: "HOTN-1" });

async function booking(guest, listing, overrides = {}) {
  return Booking().create({
    userId: guest._id,
    hostId: listing.host,
    propertyId: listing._id,
    checkIn: new Date("2026-01-10T00:00:00Z"),
    checkOut: new Date("2026-01-12T00:00:00Z"),
    price: 1000,
    subTotal: 1000,
    status: "confirmed",
    paymentStatus: "paid",
    ...overrides,
  });
}

test.before(async () => {
  await h.start();
  HOST = await h.makeUser({ role: "host", firstName: "Owner", email: "owner@visibility.test" });
  HT = h.userToken(HOST);
  OTHER = await h.makeUser({ firstName: "Other", email: "other@visibility.test" });
  OT = h.userToken(OTHER);
  ADMIN = await h.makeAdmin();
  AT = h.adminToken(ADMIN);
  DEACT_AT = h.adminToken(await h.makeAdmin({ status: { active: false, banned: false } }));
  ROLE_ADMIN_T = h.userToken(await h.makeUser({ role: "admin", firstName: "Roleadmin", email: "roleadmin@visibility.test" }));
  let n = 10;
  for (const [name, state] of Object.entries(STATES)) {
    L[name] = await h.makeListing(HOST, {
      title: `Visibility ${name}`,
      description: SECRET_TEXT,
      customRules: ["No loud music after 10"],
      selectedRules: ["No smoking"],
      amenities: ["pool"],
      photos: ["https://cdn.test/a.jpg", "https://cdn.test/b.jpg"],
      address: addr(n++),
      line1: "Flat 4B",
      ...state,
    });
  }
});
test.after(async () => h.stop());

function assertStub(data, label) {
  for (const k of Object.keys(data)) assert.ok(STUB_KEYS.has(k), `${label}: stub key "${k}" not allowed`);
  assert.equal(data.description, undefined, label);
  assert.equal(data.amenities, undefined, label);
  assert.equal(data.customRules, undefined, label);
  assert.ok(data.photos.length <= 1, `${label}: one photo at most`);
  assert.deepEqual(Object.keys(data.address).sort().filter((k) => !["city", "district", "state", "country"].includes(k)), [], `${label}: city-level address only`);
  const text = JSON.stringify(data);
  for (const leak of ["Copper Lantern", "HOTN-1", "Flat 4B", "latitude", "longitude", "hostEmail", SECRET_TEXT]) {
    assert.ok(!text.includes(leak), `${label}: leaked ${leak}`);
  }
  if (data.host && typeof data.host === "object") {
    assert.deepEqual(Object.keys(data.host).filter((k) => !["_id", "firstName", "profilePicture"].includes(k)), [], `${label}: host stub`);
  }
}

test("GET /properties/:id: a public listing reads exactly as before for every caller", async () => {
  const { sanitizeProperty, SAFE_HOST_SELECT } = require("../../utils/sanitizeResponse");
  const doc = await ListingProperty().findById(L.active._id).populate({ path: "host", model: "User", select: SAFE_HOST_SELECT });
  const expected = JSON.parse(JSON.stringify(sanitizeProperty(doc)));
  for (const token of [undefined, OT, HT, AT]) {
    const r = await h.api("GET", `/properties/${L.active._id}`, { token });
    assert.equal(r.status, 200);
    assert.equal(r.body.access, undefined, "no marker on a public listing");
    assert.equal(r.body.data.description, SECRET_TEXT, "public listings keep their text");
    if (token === undefined) assert.deepEqual(r.body.data, expected, "anonymous body unchanged");
  }
});

test("GET /properties/:id: non-public listings — stub for everyone but owner / active admin", async () => {
  for (const name of Object.keys(STATES).filter((s) => s !== "active")) {
    const id = L[name]._id;
    // anonymous, another user, a deactivated admin, a forged admin claim
    for (const [who, token] of [["anonymous", undefined], ["other user", OT], ["deactivated admin", DEACT_AT], ["forged admin", h.userToken(OTHER, { admin: 1, role: "admin" })]]) {
      const r = await h.api("GET", `/properties/${id}`, { token });
      assert.equal(r.status, 200, `${name} / ${who}`);
      assert.equal(r.body.access, "public", `${name} / ${who}`);
      assertStub(r.body.data, `${name} / ${who}`);
      assert.equal(r.body.data.status, STATES[name].status, "status stays (checkout says 'no longer available')");
    }
    // owner, admin, admin-role user: full public view (approximate point, text kept)
    for (const [who, token, access] of [["owner", HT, "owner"], ["admin", AT, "admin"], ["admin-role user", ROLE_ADMIN_T, "admin"]]) {
      const r = await h.api("GET", `/properties/${id}`, { token });
      assert.equal(r.status, 200, `${name} / ${who}`);
      assert.equal(r.body.access, access, `${name} / ${who}`);
      assert.equal(r.body.data.description, SECRET_TEXT, `${name} / ${who} keeps the text`);
      assert.ok(!JSON.stringify(r.body.data).includes("Copper Lantern"), `${name} / ${who}: still the public view (no street)`);
    }
  }
});

test("GET /properties/:id: a stale / invalid token is anonymous (never a 401 on a public page)", async () => {
  const stale = h.userToken(HOST, { tokenVersion: 99 });
  for (const token of [stale, "not-a-jwt", h.userToken(HOST, {}) + "x"]) {
    const pub = await h.api("GET", `/properties/${L.active._id}`, { token });
    assert.equal(pub.status, 200);
    const hidden = await h.api("GET", `/properties/${L.processing._id}`, { token });
    assert.equal(hidden.status, 200);
    assert.equal(hidden.body.access, "public", "a stale owner token gets the stub, not the owner view");
  }
  assert.equal((await h.api("GET", "/properties/0123456789abcdef01234567")).status, 404, "unknown id unchanged");
});

test("GET /prop-listing/:id: owner / admin unchanged (stored doc); others stub; ?hostEmail is no oracle", async () => {
  for (const name of Object.keys(STATES)) {
    const id = L[name]._id;
    const own = await h.api("GET", `/prop-listing/${id}`, { token: HT });
    assert.equal(own.status, 200);
    assert.match(own.body.address.street, /Copper Lantern Road$/, `${name}: owner keeps the stored street`);
    const adm = await h.api("GET", `/prop-listing/${id}`, { token: AT });
    assert.ok(adm.body.address.street, `${name}: admin keeps the stored street`);
    const anon = await h.api("GET", `/prop-listing/${id}`);
    assert.equal(anon.status, 200);
    if (name === "active") assert.equal(anon.body.description, SECRET_TEXT);
    else assertStub(anon.body, `prop-listing ${name}`);
  }
  // the old ?hostEmail= filter answered 404 / 200 by e-mail match — an oracle
  const guess = await h.api("GET", `/prop-listing/${L.active._id}?hostEmail=${encodeURIComponent("someone@else.test")}`);
  assert.equal(guess.status, 200, "ignored for a non-owner");
  const ownMismatch = await h.api("GET", `/prop-listing/${L.active._id}?hostEmail=${encodeURIComponent("someone@else.test")}`, { token: HT });
  assert.equal(ownMismatch.status, 404, "the owner's own narrowing still works");
  // /prop-listing keeps authMiddleware.optional's answers to a bad session
  assert.equal((await h.api("GET", `/prop-listing/${L.active._id}`, { token: h.userToken(HOST, { tokenVersion: 99 }) })).status, 401);
});

test("booked guest: confirmed + paid only, any time; operational view, never the current draft", async () => {
  const G = await h.makeUser({ firstName: "Guest", email: "guest@visibility.test" });
  const GT = h.userToken(G);
  const listing = L.hostDelisted;
  const snapshot = { checkinTime: "14", checkoutTime: "10", cancellationType: { flexible: true }, selectedRules: ["No pets (as booked)"], customRules: ["Quiet after 9 (as booked)"] };
  // every non-entitling booking first
  const variants = [
    { status: "confirmed", paymentStatus: "unpaid" },
    { status: "confirmed", paymentStatus: "refunded" },
    { status: "pending", paymentStatus: "paid" },
    { status: "cancelled", paymentStatus: "paid" },
    { status: "rejected", paymentStatus: "paid" },
    { status: "confirmed", paymentStatus: "paid", source: "ical" },
    { status: "confirmed", paymentStatus: "paid", action: "host" },
  ];
  for (const v of variants) {
    const b = await booking(G, listing, v);
    const r = await h.api("GET", `/properties/${listing._id}`, { token: GT });
    assert.equal(r.body.access, "public", JSON.stringify(v));
    assertStub(r.body.data, JSON.stringify(v));
    await Booking().deleteOne({ _id: b._id });
  }
  // another guest's paid booking entitles nobody else
  await booking(OTHER, listing, { status: "confirmed", paymentStatus: "paid" });
  assert.equal((await h.api("GET", `/properties/${listing._id}`, { token: GT })).body.access, "public");
  // a past confirmed + paid stay with a snapshot
  const past = await booking(G, listing, { listingSnapshot: snapshot });
  const r = await h.api("GET", `/properties/${listing._id}`, { token: GT });
  assert.equal(r.body.access, "bookedGuest");
  const d = r.body.data;
  assert.equal(d.description, undefined, "no current listing text");
  assert.equal(d.amenities, undefined);
  // the listing-level view carries no trip facts (a guest may hold several
  // bookings); those come with each booking (below)
  for (const k of ["customRules", "selectedRules", "checkinTime", "checkoutTime", "cancellationType"]) assert.equal(d[k], undefined, `detail route: no ${k}`);
  assert.ok(!JSON.stringify(d).includes("Copper Lantern"), "detail route: approximate location only");
  assert.ok(!JSON.stringify(d).includes(SECRET_TEXT));
  // the host edits the listing text + rules and resubmits it for review
  await ListingProperty().updateOne({ _id: listing._id }, { $set: { description: "NEW unpublished draft text", customRules: ["NEW draft rule"], status: "processing" } });
  const after = await h.api("GET", `/properties/${listing._id}`, { token: GT });
  assert.ok(!JSON.stringify(after.body).includes("NEW"), "detail route never shows the new draft");
  const viaBooking = await h.api("GET", `/booking/${past._id}`, { token: GT });
  assert.equal(viaBooking.status, 200);
  const bl = JSON.stringify(viaBooking.body.data.propertyId);
  assert.ok(!bl.includes("NEW"), "booking route never shows the new draft");
  assert.ok(bl.includes("Quiet after 9 (as booked)"), "booking route keeps the booked rules");
  assert.ok(bl.includes("Copper Lantern"), "booking route keeps the exact address of a confirmed, paid stay");
  assert.equal(viaBooking.body.data.propertyId.checkinTime, "14", "booking route: the hours of THIS booking");
  // a legacy booking without a snapshot: no rules at all (never rebuilt from the draft)
  await Booking().updateOne({ _id: past._id }, { $unset: { listingSnapshot: 1 } });
  const legacy = await h.api("GET", `/booking/${past._id}`, { token: GT });
  assert.equal(legacy.body.data.propertyId.customRules, undefined, "sparse fallback");
  assert.equal(legacy.body.data.propertyId.checkinTime, listing.checkinTime, "operational hours from the listing");
  assert.equal((await h.api("GET", `/properties/${listing._id}`, { token: GT })).body.access, "bookedGuest");
  // a public listing reads normally through the booking route
  await ListingProperty().updateOne({ _id: listing._id }, { $set: { status: "inactive", description: SECRET_TEXT, customRules: ["No loud music after 10"] } });
});

test("a new booking records the house facts it was made under", async () => {
  const G = await h.makeUser({ firstName: "Booker", email: "booker@visibility.test" });
  const r = await h.api("POST", "/booking", {
    token: h.userToken(G),
    body: { propertyId: String(L.active._id), checkIn: "2031-03-10", checkOut: "2031-03-12", adults: 1 },
  });
  assert.ok([200, 201].includes(r.status), JSON.stringify(r.body));
  const b = await Booking().findById(r.body.data._id).lean();
  assert.ok(b.listingSnapshot, "snapshot stored");
  assert.deepEqual(b.listingSnapshot.customRules, ["No loud music after 10"]);
  assert.deepEqual(b.listingSnapshot.selectedRules, ["No smoking"]);
  assert.equal(b.listingSnapshot.checkinTime, L.active.checkinTime);
});

test("GET /properties/get-timings: the listing's host or an admin, three fields only", async () => {
  const id = L.processing._id;
  assert.equal((await h.api("GET", `/properties/get-timings/${id}`)).status, 401);
  assert.equal((await h.api("GET", `/properties/get-timings/${id}`, { token: OT })).status, 403, "any signed-in user used to get the raw listing");
  for (const token of [HT, AT]) {
    const r = await h.api("GET", `/properties/get-timings/${id}`, { token });
    assert.equal(r.status, 200);
    assert.deepEqual(Object.keys(r.body.data).sort(), ["_id", "checkinTime", "checkoutTime"]);
  }
});

test("calendars: hidden for a non-public listing except to its host / admin / paid guest", async () => {
  // a user with no booking at all (OTHER holds a paid booking of one listing from the test above)
  const ST = h.userToken(await h.makeUser({ firstName: "Stranger", email: "stranger@visibility.test" }));
  for (const path of ["check-dates", "blocked-dates"]) {
    const pub = await h.api("GET", `/booking/${path}/${L.active._id}`);
    assert.equal(pub.status, 200, `${path} public`);
    assert.equal((await h.api("GET", `/booking/${path}/${L.active._id}`, { token: "garbage" })).status, 200, `${path}: stale token is anonymous`);
    for (const name of Object.keys(STATES).filter((s) => s !== "active")) {
      const id = L[name]._id;
      for (const token of [undefined, ST, DEACT_AT]) {
        const r = await h.api("GET", `/booking/${path}/${id}`, { token });
        assert.equal(r.status, 404, `${path} ${name}`);
        assert.equal(r.body.code, "LISTING_NOT_PUBLIC");
      }
      for (const token of [HT, AT]) assert.equal((await h.api("GET", `/booking/${path}/${id}`, { token })).status, 200, `${path} ${name} owner/admin`);
    }
    assert.equal((await h.api("GET", `/booking/${path}/0123456789abcdef01234567`)).status, 200, `${path}: unknown id keeps its old answer`);
  }
  const G = await h.makeUser({ firstName: "Calguest", email: "calguest@visibility.test" });
  await booking(G, L.banned);
  assert.equal((await h.api("GET", `/booking/check-dates/${L.banned._id}`, { token: h.userToken(G) })).status, 200, "paid guest");
});

test("id-and-name and admin/active are admin-only; active/:hostId gives others cards only", async () => {
  for (const path of [`/properties/id-and-name/${HOST._id}`, "/properties/admin/active"]) {
    assert.equal((await h.api("GET", path)).status, 401, path);
    assert.equal((await h.api("GET", path, { token: OT })).status, 403, path);
    assert.equal((await h.api("GET", path, { token: DEACT_AT })).status, 403, `${path}: deactivated admin`);
    assert.equal((await h.api("GET", path, { token: AT })).status, 200, path);
  }
  const cards = await h.api("GET", `/properties/id-and-name/${HOST._id}`, { token: AT });
  assert.deepEqual(cards.body.data.map((c) => c.title), ["Visibility active"], "live, not banned");
  assert.ok(!JSON.stringify(cards.body).includes("Copper Lantern"));
  // another user: cards of the host's public listings only
  const other = await h.api("GET", `/properties/active/${HOST._id}`, { token: OT });
  assert.equal(other.status, 200);
  assert.deepEqual(other.body.data.map((c) => c.title), ["Visibility active"]);
  const text = JSON.stringify(other.body);
  for (const leak of ["Copper Lantern", "hostEmail", "Flat 4B", "HOTN-1"]) assert.ok(!text.includes(leak), `active/:hostId leaked ${leak}`);
  // the host's own dashboard read is unchanged
  const own = await h.api("GET", `/properties/active/${HOST._id}`, { token: HT });
  assert.equal(own.status, 200);
  assert.ok(own.body.data.some((l) => l.address && l.address.street), "the host reads their own stored address");
  assert.equal((await h.api("GET", "/properties/active/not-an-id", { token: HT })).status, 404, "validateParam: invalid id (was a 500 cast error)");
});

test("card reads mask a title against the listing's own street (mask context)", async () => {
  // legacy row: the write policy refuses this today, old data may still hold it
  const legacy = await h.makeListing(HOST, { title: "Stay at 27 Copper Lantern Road", address: { street: "27 Copper Lantern Road", city: "Mapusa", state: "Goa", latitude: 15.59, longitude: 73.81 }, status: "active" });
  const reads = [
    `/properties/search-properties?location=Mapusa`,
    `/properties/dynamic`,
    `/properties/`,
    `/places/stays?q=Copper%20Lantern`,
  ];
  for (const path of reads) {
    const r = await h.api("GET", path);
    assert.equal(r.status, 200, path);
    const text = JSON.stringify(r.body);
    assert.ok(!text.includes("Copper Lantern"), `${path}: exact street leaked through a card title`);
    assert.ok(!/"street"|"line1"|"line2"/.test(text), `${path}: mask context must never be emitted`);
  }
  await ListingProperty().deleteOne({ _id: legacy._id });
});

test("PII filter: a response that fails the walk drops every cache header", async () => {
  const { piiResponseFilter } = require("../../middleware/piiResponseFilter");
  const headers = { "cache-control": "public, max-age=0", "cdn-cache-control": "public, s-maxage=300", "vercel-cache-tag": "listings", "surrogate-control": "x" };
  let sent;
  const res = {
    statusCode: 200,
    headersSent: false,
    status(c) { this.statusCode = c; return this; },
    set(k, v) { headers[k.toLowerCase()] = v; return this; },
    removeHeader(k) { delete headers[k.toLowerCase()]; },
    json(b) { sent = b; return this; },
  };
  piiResponseFilter({ actor: null, originalUrl: "/x", method: "GET" }, res, () => {});
  const cyclic = { a: {} };
  cyclic.a.self = cyclic;
  res.json(cyclic);
  assert.equal(res.statusCode, 500);
  assert.equal(sent.code, "RESPONSE_FILTER_ERROR");
  assert.equal(headers["cache-control"], "no-store");
  assert.equal(headers["cdn-cache-control"], undefined);
  assert.equal(headers["vercel-cache-tag"], undefined);
  assert.equal(headers["surrogate-control"], undefined);
});

test("deactivated admin: no admin rights anywhere (requireAdmin and object-level checks)", async () => {
  const r = await h.api("PATCH", `/properties/admin/approve/${L.processing._id}`, { token: DEACT_AT });
  assert.equal(r.status, 403);
  assert.equal((await ListingProperty().findById(L.processing._id).lean()).status, "processing");
  // a host-or-admin route used to let a deactivated admin through
  const edit = await h.api("PUT", `/properties/update-listing-property/${L.processing._id}`, { token: DEACT_AT, body: { title: "Hijacked" } });
  assert.equal(edit.status, 403);
});

test("every User / Booking field added here is classified (no public / self leak)", async () => {
  const { SECRET_USER_FIELDS, PUBLIC_USER_FIELDS, SELF_USER_FIELDS } = require("../../utils/sanitizeResponse");
  assert.ok(SECRET_USER_FIELDS.includes("listingFence"));
  assert.ok(!PUBLIC_USER_FIELDS.includes("listingFence") && !SELF_USER_FIELDS.includes("listingFence"));
  await User().updateOne({ _id: HOST._id }, { $set: { listingFence: 7 } });
  const me = await h.api("GET", `/hosts/single/${HOST._id}`, { token: HT });
  assert.ok(!JSON.stringify(me.body).includes("listingFence"), "not even in the self view");
});

test("an active row with a moderation ban is never bookable; the booked-guest view carries the price", async () => {
  const G = await h.makeUser({ firstName: "Bookban", email: "bookban@visibility.test" });
  const r = await h.api("POST", "/booking", {
    token: h.userToken(G),
    body: { propertyId: String(L.activeBanned._id), checkIn: "2031-05-10", checkOut: "2031-05-12", adults: 1 },
  });
  assert.equal(r.status, 409, JSON.stringify(r.body));
  assert.equal(r.body.code, "LISTING_INACTIVE");
  await booking(G, L.adminDelisted);
  const v = await h.api("GET", `/properties/${L.adminDelisted._id}`, { token: h.userToken(G) });
  assert.equal(v.body.access, "bookedGuest");
  assert.equal(v.body.data.basePrice, L.adminDelisted.basePrice, "apps format the price (no ₹NaN)");
});

test("delist provenance never reaches a public / guest reader", async () => {
  const legacyLive = await h.makeListing(HOST, { title: "Legacy live with provenance", status: "active", delist: "admin" });
  for (const path of [`/properties/${legacyLive._id}`, `/prop-listing/${legacyLive._id}`, `/properties/${L.adminDelisted._id}`]) {
    const r = await h.api("GET", path);
    assert.ok(!JSON.stringify(r.body).includes('"delist"'), `${path} leaked delist`);
  }
  // the owner's own editing read keeps it (sanitizePropertyForOwner)
  const own = await h.api("GET", `/prop-listing/${legacyLive._id}`, { token: HT });
  assert.equal(own.body.delist, "admin");
});

test("booking route: only a confirmed, paid guest gets the operational view of a hidden listing", async () => {
  const G = await h.makeUser({ firstName: "Unpaid", email: "unpaid@visibility.test" });
  const b = await booking(G, L.processing, { status: "pending", paymentStatus: "unpaid", listingSnapshot: { customRules: ["snapshot rule"] } });
  const r = await h.api("GET", `/booking/${b._id}`, { token: h.userToken(G) });
  assert.equal(r.status, 200);
  const p = r.body.data.propertyId;
  for (const k of Object.keys(p)) assert.ok(STUB_KEYS.has(k), `unpaid guest: key ${k} beyond the stub`);
  assert.equal(p.customRules, undefined);
  assert.ok(!JSON.stringify(p).includes(SECRET_TEXT));
});

test("soft auth is lazy: a public listing read with a session does no user lookup", async () => {
  const mongoose = require("mongoose");
  const seen = [];
  mongoose.set("debug", (coll, method) => seen.push(`${coll}.${method}`));
  try {
    const r = await h.api("GET", `/properties/${L.active._id}`, { token: HT });
    assert.equal(r.status, 200);
    // (users.find is the host populate of the listing itself; the session
    // lookup is a users.findOne by id)
    assert.ok(!seen.includes("users.findOne"), `unexpected session lookup: ${seen.join(", ")}`);
    seen.length = 0;
    const hidden = await h.api("GET", `/properties/${L.processing._id}`, { token: HT });
    assert.equal(hidden.body.access, "owner");
    assert.ok(seen.includes("users.findOne"), "the caller is resolved for a hidden listing");
  } finally {
    mongoose.set("debug", false);
  }
});

test("hostEmail follows the host account: never edited from a body, synced on reassignment", async () => {
  const A = await h.makeUser({ role: "host", firstName: "Hea", email: "hea@visibility.test" });
  const B = await h.makeUser({ role: "host", firstName: "Heb", email: "heb@visibility.test" });
  const l = await h.makeListing(A, { status: "processing" });
  // an admin edit echoing / forging hostEmail changes nothing
  await h.api("PUT", `/prop-listing/${l._id}`, { token: AT, body: { hostEmail: "someone@else.test", title: "Echo" } });
  assert.equal((await ListingProperty().findById(l._id).lean()).hostEmail, A.email);
  // reassignment with the host only: hostEmail follows
  assert.equal((await h.api("PUT", `/prop-listing/${l._id}`, { token: AT, body: { host: String(B._id) } })).status, 200);
  assert.equal((await ListingProperty().findById(l._id).lean()).hostEmail, B.email);
  // ...and a stale echo of the OLD e-mail after it does not undo that
  await h.api("PUT", `/properties/admin-update-property/${l._id}`, { token: AT, body: { hostEmail: A.email, host: String(B._id) } });
  assert.equal((await ListingProperty().findById(l._id).lean()).hostEmail, B.email);
  // admin create derives it from the host account
  const c = await h.api("POST", "/prop-listing", { token: AT, body: { title: "Derived", host: String(B._id), hostEmail: "forged@x.test", status: "processing" } });
  assert.equal(c.status, 201);
  assert.equal((await ListingProperty().findById(c.body._id).lean()).hostEmail, B.email);
  // an e-mail address never proves ownership: a host-less legacy row is not in
  // a user's own list (until an admin binds it); an admin lookup by e-mail finds it
  const legacy = await ListingProperty().create({ title: "Hostless legacy", hostEmail: A.email, status: "processing" });
  const own = await h.api("GET", `/properties/user-properties/${encodeURIComponent(A.email)}`, { token: h.userToken(A) });
  assert.ok(!own.body.listings.some((x) => String(x._id) === String(legacy._id)), "no e-mail-only private access");
  assert.ok(!own.body.listings.some((x) => String(x._id) === String(l._id)), "reassigned row left A's list");
  const adminView = await h.api("GET", `/properties/user-properties/${encodeURIComponent(A.email)}`, { token: AT });
  assert.ok(adminView.body.listings.some((x) => String(x._id) === String(legacy._id)), "admin lookup by e-mail still finds the legacy row");
  // an admin e-mail change of the host account updates the copies
  assert.equal((await h.api("PUT", `/hosts/${B._id}`, { token: AT, body: { email: "heb-new@visibility.test" } })).status, 200);
  assert.equal((await ListingProperty().findById(l._id).lean()).hostEmail, "heb-new@visibility.test");
  B.email = "heb-new@visibility.test";
  const stat = await h.api("GET", `/prop-listing/status?email=${encodeURIComponent(B.email)}`, { token: h.userToken(B) });
  assert.equal(stat.status, 200);
  assert.notEqual(stat.body.status, "noListings", "B's stage card sees the reassigned listing");
});

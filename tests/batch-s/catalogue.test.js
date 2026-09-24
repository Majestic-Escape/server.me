// Batch P — public catalogue: the chat widget's vector never leaves the API
// (and can never be written or nulled through it), list endpoints serve card
// projections with newest-first deterministic pages, date searches use the
// night ledger, only the pure-public reads carry edge-cache headers (with an
// authenticated fresh bypass), every public write notifies the caches with
// bounded tag batches, the gated routes are gated, the heavy modules load
// lazily, and each read stays within its operation ceiling.
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const mongoose = require("mongoose");
const h = require("./setup");

const ListingProperty = () => require("../../models/ListingProperty");
const BookingNight = () => require("../../models/BookingNight");
const Booking = () => require("../../models/Booking");
const changed = () => require("../../services/listingChanged");
const httpCache = () => require("../../utils/httpCache");

const FRESH = "test-fresh-secret"; // tests/batch-s/setup.js CATALOGUE_FRESH_SECRET
const VECTOR = Array.from({ length: 3072 }, (_, i) => (i % 97) / 100);

let ADMIN, AT, H, HT, G, GT, O, OT;
const ops = [];
function startCounting() {
  ops.length = 0;
  mongoose.set("debug", (collection, method) => ops.push(`${collection}.${method}`));
}
function stopCounting() {
  mongoose.set("debug", false);
  return ops.slice();
}
async function raw(path, { token, method = "GET", headers = {}, body } = {}) {
  const res = await fetch(`${h.baseUrl()}${path}`, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { "content-type": "application/json" } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: res.status, headers: Object.fromEntries(res.headers.entries()), text, json };
}
// Store the vector exactly like the widget: raw driver, no Mongoose.
async function embed(listingId) {
  await ListingProperty().collection.updateOne({ _id: listingId }, { $set: { embedding: VECTOR, embeddingUpdatedAt: new Date(), embeddingVersion: 2 } });
}
async function rawDoc(listingId) {
  return ListingProperty().collection.findOne({ _id: listingId });
}
function mockCalls() {
  return changed().__mockCalls();
}

test.before(async () => {
  await h.start();
  // expose the mock's call list for assertions
  const m = { calls: [] };
  changed().__setMock(m);
  changed().__mockCalls = () => m.calls;
  ADMIN = await h.makeAdmin();
  AT = h.adminToken(ADMIN);
  H = await h.makeUser({ role: "host", firstName: "Cat", lastName: "Host" });
  HT = h.userToken(H);
  O = await h.makeUser({ role: "host", firstName: "Other", lastName: "Host" });
  OT = h.userToken(O);
  G = await h.makeUser({ firstName: "Cat", lastName: "Guest" });
  GT = h.userToken(G);
});
test.after(async () => h.stop());

// ---------------------------------------------------------------------------
test("vector: present in Mongo, absent from every listing-bearing response, untouched by write bodies and the admin GET→PUT round trip", async () => {
  const L = await h.makeListing(H, { title: "Vector Villa", photos: ["https://example.com/a.jpg"], address: { city: "Panaji", state: "Goa" } });
  await embed(L._id);
  assert.equal((await rawDoc(L._id)).embedding.length, 3072, "stored like the widget stores it");

  // a booking whose responses populate the listing
  const B = await Booking().create({ userId: G._id, hostId: H._id, propertyId: L._id, checkIn: new Date(h.day(5)), checkOut: new Date(h.day(7)), price: 9000, subTotal: 18000, nights: 2, adults: 2, status: "confirmed", paymentStatus: "paid" });

  const reads = [
    ["front/dynamic", () => raw("/properties/front/dynamic")],
    ["dynamic", () => raw("/properties/dynamic")],
    ["search", () => raw("/properties/search-properties?location=Panaji")],
    ["detail", () => raw(`/properties/${L._id}`)],
    ["detail (auth'd)", () => raw(`/properties/${L._id}`, { token: GT })],
    ["prop-listing/:id", () => raw(`/prop-listing/${L._id}`)],
    ["prop-listing/admin/:id", () => raw(`/prop-listing/admin/${L._id}`, { token: AT })],
    ["prop-listing list", () => raw("/prop-listing/?page=1")],
    ["export", () => raw("/prop-listing/export", { token: AT })],
    ["host listings", () => raw(`/properties/user-properties/${encodeURIComponent(H.email)}?page=1&limit=10`, { token: HT })],
    ["bookings by user (populate)", () => raw(`/booking/user/${G._id}`, { token: GT })],
    ["admin filtered listings (aggregate)", () => raw("/properties/admin/filtered-listings?search=Vector&page=1&limit=10", { token: AT })],
    ["admin host profile (populate host)", () => raw(`/properties/active/filter/${H._id}?page=1&limit=10`, { token: AT })],
    ["admin-filter (lookups)", () => raw("/properties/admin-filter?search=Cat&page=1&limit=10", { token: AT })],
  ];
  for (const [name, call] of reads) {
    const r = await call();
    assert.equal(r.status, 200, `${name}: ${r.status} ${r.text.slice(0, 120)}`);
    assert.ok(!r.text.includes('"embedding'), `${name} leaks the vector`);
    assert.ok(!r.text.includes('"password"'), `${name} leaks a password hash`);
    assert.ok(!r.text.includes('"otp"'), `${name} leaks an OTP`);
    assert.ok(r.text.includes("Vector Villa") || name === "admin-filter (lookups)", `${name} should still carry the listing`);
  }
  assert.equal((await raw(`/booking/user/${G._id}`, { token: GT })).json.data[0].propertyId.title, "Vector Villa", "populated listing keeps its fields");
  void B;

  // admin edit form round trip: GET the raw doc, PUT it back (+ a hostile vector) — Mongo's vector survives
  const form = (await raw(`/prop-listing/admin/${L._id}`, { token: AT })).json.data;
  assert.equal(form.embedding, undefined);
  const put = await raw(`/properties/admin-update-property/${L._id}`, { token: AT, method: "PUT", body: { ...form, title: "Vector Villa Edited", embedding: [1, 2, 3], embeddingVersion: 99 } });
  assert.equal(put.status, 200, JSON.stringify(put.json).slice(0, 200));
  const after = await rawDoc(L._id);
  assert.equal(after.title, "Vector Villa Edited");
  assert.equal(after.embedding.length, 3072, "the widget's vector is untouched");
  assert.equal(after.embeddingVersion, 2);
  // host update body with the vector, and the admin prop-listing PUT
  assert.equal((await raw(`/properties/update-listing-property/${L._id}`, { token: HT, method: "PUT", body: { title: "Vector Villa Host", embedding: null } })).status, 200);
  assert.equal((await raw(`/prop-listing/${L._id}`, { token: AT, method: "PUT", body: { title: "Vector Villa Admin", embedding: [] } })).status, 200);
  const final = await rawDoc(L._id);
  assert.equal(final.embedding.length, 3072, "never nulled or emptied");
  assert.equal(final.title, "Vector Villa Admin");
  // a listing the widget has not embedded yet stays that way ($exists:false keeps working for its catch-up)
  const N = await h.makeListing(H, { title: "Not Yet Embedded" });
  await raw(`/properties/update-listing-property/${N._id}`, { token: HT, method: "PUT", body: { title: "Still Not Embedded", embedding: [0.1] } });
  assert.equal((await rawDoc(N._id)).embedding, undefined);
  // opt-in read still possible for a future server-side consumer
  const withVector = await ListingProperty().findById(L._id).select("+embedding").lean();
  assert.equal(withVector.embedding.length, 3072);
});

// ---------------------------------------------------------------------------
test("cards: envelopes unchanged, card fields present, sensitive fields absent, newest-first deterministic pages, page size capped", async () => {
  await ListingProperty().deleteMany({ host: { $in: [H._id, O._id] } });
  const made = [];
  for (let i = 0; i < 7; i++) {
    made.push(await h.makeListing(H, { title: `Card ${i}`, propertyType: "villa", createdAt: new Date(Date.UTC(2026, 0, 1 + i)), photos: [`https://example.com/${i}.jpg`], address: { city: "Panaji", state: "Goa", street: "1 Secret St", registrationNumber: "REG-1" }, description: "Pool and beach", amenities: ["pool"], bankDetails: true, kycStatus: "completed" }));
  }
  await h.makeListing(O, { title: "Draft", status: "processing" });

  const r = await raw("/properties/front/dynamic?limit=4");
  assert.equal(r.status, 200);
  assert.deepEqual(Object.keys(r.json).sort(), ["currentPage", "hasMore", "properties", "resultsPerPage", "totalPages", "totalProperties"]);
  assert.equal(r.json.properties.length, 4);
  assert.deepEqual(r.json.properties.map((p) => p.title), ["Card 6", "Card 5", "Card 4", "Card 3"], "newest first");
  const card = r.json.properties[0];
  for (const f of ["_id", "title", "propertyType", "basePrice", "photos", "address", "averageRating", "reviewCount", "bookingType", "description", "amenities", "guests", "status", "createdAt"]) {
    assert.ok(f in card, `card field ${f}`);
  }
  assert.equal(card.address.city, "Panaji");
  for (const f of ["hostEmail", "host", "bankDetails", "kycStatus", "embedding", "validRegistrationNo", "ban", "delist"]) {
    assert.ok(!(f in card), `card must not carry ${f}`);
  }
  assert.ok(!("street" in card.address) && !("registrationNumber" in card.address), "exact location stays private");
  const page2 = await raw("/properties/front/dynamic?limit=4&page=2");
  assert.deepEqual(page2.json.properties.map((p) => p.title), ["Card 2", "Card 1", "Card 0"]);
  assert.equal(page2.json.hasMore, false);
  assert.equal((await raw("/properties/dynamic?limit=4")).json.properties[0].title, "Card 6", "legacy twin behaves identically");

  const s = await raw("/properties/search-properties?location=Panaji&limit=4");
  // place search adds the (additive) `search` block: how the query was read
  assert.deepEqual(Object.keys(s.json).sort(), ["data", "pagination", "search"]);
  assert.deepEqual(Object.keys(s.json.pagination).sort(), ["totalCount", "totalPages"]);
  assert.deepEqual(s.json.data.map((p) => p.title), ["Card 6", "Card 5", "Card 4", "Card 3"]);
  const s2 = await raw("/properties/search-properties?location=Panaji&limit=4&page=2");
  assert.deepEqual(s2.json.data.map((p) => p.title), ["Card 2", "Card 1", "Card 0"], "stable second page");
  assert.equal(s.json.pagination.totalCount, 7);
  assert.equal((await raw("/properties/search-properties?location=Pan(aji")).status, 200, "regex input escaped");
  assert.equal((await raw("/properties/search-properties?propertyType=(villa")).status, 200);

  const big = await raw("/properties/front/dynamic?limit=999999");
  assert.equal(big.json.resultsPerPage, 50, "page size capped");
  assert.equal((await raw("/properties/search-properties?limit=999999")).json.pagination.totalPages, Math.ceil(7 / 50));

  const c = await raw("/properties/countstays?city=Panaji,Ujjain");
  assert.deepEqual(c.json, { success: true, data: [{ city: "panaji", count: 7 }, { city: "ujjain", count: 0 }] });
  assert.equal((await raw("/properties/countstays")).status, 400);
});

// ---------------------------------------------------------------------------
test("availability: the night ledger decides date searches — held nights hide, expired holds and cancelled bookings do not", async () => {
  await ListingProperty().deleteMany({ host: { $in: [H._id, O._id] } });
  const mk = (title) => h.makeListing(H, { title, address: { city: "Ledger", state: "Goa" } });
  const free = await mk("Free");
  const paid = await mk("Paid Night");
  const hold = await mk("Live Hold");
  const expired = await mk("Expired Hold");
  const block = await mk("Host Block");
  const ical = await mk("iCal Import");
  const cancelled = await mk("Cancelled Booking");
  const night = new Date(Date.UTC(2027, 2, 10));
  const fakeBooking = () => new mongoose.Types.ObjectId();
  await BookingNight().create([
    { propertyId: paid._id, date: night, bookingId: fakeBooking(), kind: "booking", expiresAt: null },
    { propertyId: hold._id, date: night, bookingId: fakeBooking(), kind: "booking", expiresAt: new Date(Date.now() + 10 * 60 * 1000) },
    { propertyId: expired._id, date: night, bookingId: fakeBooking(), kind: "booking", expiresAt: new Date(Date.now() - 60 * 1000) },
    { propertyId: block._id, date: night, bookingId: fakeBooking(), kind: "block", expiresAt: null },
    { propertyId: ical._id, date: night, bookingId: fakeBooking(), kind: "ical", expiresAt: null },
  ]);
  // an overlapping but cancelled booking with no nights (what the old Booking scan wrongly counted)
  await Booking().create({ userId: G._id, hostId: H._id, propertyId: cancelled._id, checkIn: new Date(Date.UTC(2027, 2, 9)), checkOut: new Date(Date.UTC(2027, 2, 12)), price: 1, subTotal: 1, nights: 3, adults: 1, status: "cancelled", paymentStatus: "unpaid" });

  const q = (from, to) => raw(`/properties/search-properties?location=Ledger&from=${from}&to=${to}`);
  const r = await q("2027-03-10", "2027-03-11");
  assert.equal(r.status, 200, r.text);
  const titles = r.json.data.map((p) => p.title).sort();
  assert.deepEqual(titles, ["Cancelled Booking", "Expired Hold", "Free"]);
  assert.equal(r.headers["cache-control"], "no-store, no-cache, must-revalidate, proxy-revalidate", "date searches keep the global no-store");
  assert.equal(r.headers["cdn-cache-control"], undefined);
  // a range that does not touch the held night frees everything
  const r2 = await q("2027-03-12", "2027-03-14");
  assert.equal(r2.json.data.length, 7);
  // invalid dates → 400 as before
  assert.equal((await q("nope", "2027-03-11")).status, 400);
});

// ---------------------------------------------------------------------------
test("cache headers: only the pure-public reads opt in, only on 200; fresh needs the secret; kill switch; everything else stays no-store", async () => {
  const L = await h.makeListing(H, { title: "Header Villa" });
  const cached = (r, name) => {
    assert.equal(r.status, 200, name);
    assert.equal(r.headers["cache-control"], "public, max-age=0, must-revalidate", `${name} browser directive`);
    assert.equal(r.headers["cdn-cache-control"], "public, s-maxage=300, stale-while-revalidate=120", `${name} cdn directive`);
    assert.equal(r.headers["vercel-cache-tag"], "listings", `${name} tag`);
    assert.equal(r.headers["vary"], "Origin", `${name} vary`);
    assert.equal(r.headers["pragma"], undefined, `${name} no legacy no-cache headers`);
    assert.ok(r.headers["etag"], `${name} etag for 304s`);
  };
  const uncached = (r, name) => {
    assert.equal(r.headers["cache-control"], "no-store, no-cache, must-revalidate, proxy-revalidate", `${name} stays no-store`);
    assert.equal(r.headers["cdn-cache-control"], undefined, name);
    assert.equal(r.headers["vercel-cache-tag"], undefined, name);
  };
  cached(await raw("/properties/front/dynamic"), "front/dynamic");
  cached(await raw("/properties/dynamic"), "dynamic");
  cached(await raw("/properties/search-properties?location=Header"), "search without dates");
  cached(await raw("/properties/countstays?city=Panaji"), "countstays");
  uncached(await raw("/properties/countstays"), "countstays 400");
  assert.equal((await raw("/properties/countstays")).status, 400);
  uncached(await raw(`/properties/${L._id}`), "detail");
  uncached(await raw(`/prop-listing/${L._id}`), "prop-listing detail");
  uncached(await raw("/prop-listing/?page=1"), "prop-listing list");
  uncached(await raw(`/properties/user-properties/${encodeURIComponent(H.email)}`, { token: HT }), "host listings");
  uncached(await raw("/properties/admin/filtered-listings?page=1&limit=5", { token: AT }), "admin list");

  // fresh: reserved for the site server
  const anon = await raw("/properties/front/dynamic?fresh=1");
  assert.equal(anon.status, 400);
  assert.equal(anon.json.code, "FRESH_NOT_ALLOWED");
  assert.equal(anon.headers["cdn-cache-control"], undefined);
  assert.equal((await raw("/properties/front/dynamic?fresh=1", { headers: { "x-catalogue-fresh": "wrong" } })).status, 400);
  assert.equal((await raw("/properties/front/dynamic?fresh=", { headers: { "x-catalogue-fresh": FRESH } })).status, 200, "any fresh value with the secret");
  const ok = await raw("/properties/front/dynamic?fresh=1", { headers: { "x-catalogue-fresh": FRESH } });
  assert.equal(ok.status, 200);
  assert.equal(ok.headers["cache-control"], "no-store");
  assert.equal(ok.headers["cdn-cache-control"], undefined);
  assert.equal(ok.json.properties.length > 0, true);
  const okCount = await raw("/properties/countstays?city=Panaji&fresh=1", { headers: { "x-catalogue-fresh": FRESH } });
  assert.equal(okCount.headers["cache-control"], "no-store");
  // 100 abusive fresh requests: all 400, none reach the list query
  startCounting();
  for (let i = 0; i < 100; i++) assert.equal((await raw(`/properties/front/dynamic?fresh=${i}`)).status, 400);
  assert.equal(stopCounting().filter((o) => o.startsWith("listingproperties")).length, 0, "no origin work for refused fresh requests");
  // the secret is compared in constant time: a prefix is still wrong
  assert.equal((await raw("/properties/front/dynamic?fresh=1", { headers: { "x-catalogue-fresh": FRESH.slice(0, -1) } })).status, 400);

  // kill switch
  process.env.CATALOGUE_CACHE_DISABLED = "1";
  try {
    uncached(await raw("/properties/front/dynamic"), "kill switch");
  } finally {
    delete process.env.CATALOGUE_CACHE_DISABLED;
  }
  cached(await raw("/properties/front/dynamic"), "after kill switch");

  // CORS block carries Vary: Origin for allowed origins too
  const cors = await raw("/properties/front/dynamic", { headers: { origin: "http://localhost:3000" } });
  assert.equal(cors.headers["access-control-allow-origin"], "http://localhost:3000");
  assert.match(cors.headers["vary"], /Origin/);
  assert.equal(httpCache().TAG, "listings");
});

// ---------------------------------------------------------------------------
test("notifications: every public-affecting write notifies with the right tags; drafts, KYC/bank flags and pending deletes do not; reactivate now persists", async () => {
  await ListingProperty().deleteMany({ host: { $in: [H._id, O._id] } });
  const calls = mockCalls();
  const since = () => calls.slice(mark);
  let mark = calls.length;
  const tagsOf = (id) => ["listings", `listing:${id}`];

  // approve (processing → active)
  const P = await h.makeListing(H, { title: "Pending Cabin", status: "processing" });
  mark = calls.length;
  assert.equal((await raw(`/properties/admin/approve/${P._id}`, { token: AT, method: "PATCH" })).status, 200);
  assert.deepEqual(since().map((c) => c.tags), [tagsOf(P._id)]);
  assert.equal(since()[0].reason, "approve");

  // host delist / admin delist
  mark = calls.length;
  assert.equal((await raw(`/properties/host/delist/${P._id}?hostSide=true`, { token: HT, method: "PATCH" })).status, 200);
  assert.deepEqual(since().map((c) => c.reason), ["delist"]);
  // reactivate: persisted now
  mark = calls.length;
  const re = await raw(`/properties/host/reactivate/${P._id}`, { token: HT, method: "PATCH" });
  assert.equal(re.status, 200, re.text);
  assert.equal((await ListingProperty().findById(P._id).select("status").lean()).status, "active", "reactivate used to be a no-op");
  assert.deepEqual(since().map((c) => c.reason), ["reactivate"]);
  mark = calls.length;
  assert.equal((await raw(`/properties/admin/delist/${P._id}`, { token: AT, method: "PATCH" })).status, 200);
  assert.deepEqual(since().map((c) => c.reason), ["admin-delist"]);
  assert.equal((await ListingProperty().findById(P._id).select("status delist").lean()).delist, "admin");

  // admin update of an inactive listing: no public change → no purge; making it active → purge
  mark = calls.length;
  assert.equal((await raw(`/properties/admin-update-property/${P._id}`, { token: AT, method: "PUT", body: { title: "Renamed While Inactive" } })).status, 200);
  assert.deepEqual(since(), []);
  mark = calls.length;
  assert.equal((await raw(`/properties/admin-update-property/${P._id}`, { token: AT, method: "PUT", body: { status: "active" } })).status, 200);
  assert.deepEqual(since().map((c) => c.reason), ["admin-update"]);

  // host wizard PUT on a draft: no purge; the same PUT on the active listing: purge; timings likewise
  const D = await h.makeListing(H, { title: "Draft Cabin", status: "incomplete" });
  mark = calls.length;
  assert.equal((await raw(`/properties/update-listing-property/${D._id}`, { token: HT, method: "PUT", body: { title: "Draft Cabin 2" } })).status, 200);
  assert.equal((await raw(`/properties/update-listing-property/${D._id}?submit=true&status=processing`, { token: HT, method: "PUT", body: { status: "processing" } })).status, 200);
  assert.equal((await raw("/properties/timings", { token: HT, method: "POST", body: { propertyId: String(D._id), checkinTime: "14", checkoutTime: "10" } })).status, 200);
  assert.deepEqual(since(), [], "draft wizard writes never purge");
  mark = calls.length;
  assert.equal((await raw(`/properties/update-listing-property/${P._id}`, { token: HT, method: "PUT", body: { basePrice: 12345 } })).status, 200);
  assert.equal((await raw("/properties/timings", { token: HT, method: "POST", body: { propertyId: String(P._id), checkinTime: "14", checkoutTime: "10" } })).status, 200);
  assert.deepEqual(since().map((c) => c.reason), ["host-update", "timing"]);

  // KYC / bank flag writes are not public changes
  mark = calls.length;
  assert.equal((await raw(`/properties/update-kyc-property/${H._id}`, { token: HT, method: "PATCH" })).status, 200);
  assert.deepEqual(since(), []);

  // ban / unban: exactly the flipped ids
  const A2 = await h.makeListing(H, { title: "Second Active" });
  mark = calls.length;
  assert.equal((await raw(`/guests/ban/${H._id}`, { token: AT, method: "PATCH", body: { active: true } })).status, 200);
  const banCall = since()[0];
  assert.equal(banCall.reason, "ban");
  assert.deepEqual(banCall.tags.slice(1).sort(), [`listing:${A2._id}`, `listing:${P._id}`].sort());
  mark = calls.length;
  assert.equal((await raw(`/guests/ban/${H._id}`, { token: AT, method: "PATCH", body: { active: false } })).status, 200);
  assert.equal(since()[0].reason, "unban");
  assert.equal(since()[0].tags.length, 3);
  // banning a host with no active listings notifies nothing
  mark = calls.length;
  assert.equal((await raw(`/guests/ban/${O._id}`, { token: AT, method: "PATCH", body: { active: true } })).status, 200);
  assert.deepEqual(since(), []);
  await raw(`/guests/ban/${O._id}`, { token: AT, method: "PATCH", body: { active: false } });
  HT = h.userToken(await require("../../models/User").findById(H._id)); // tokenVersion moved on ban

  // review on an active listing changes the card's rating → purge
  const B = await Booking().create({ userId: G._id, hostId: H._id, propertyId: A2._id, checkIn: new Date(h.day(-5)), checkOut: new Date(h.day(-3)), price: 1, subTotal: 1, nights: 2, adults: 1, status: "confirmed", paymentStatus: "paid" });
  mark = calls.length;
  const rev = await raw("/review/", { token: GT, method: "POST", body: { bookingId: String(B._id), rating: 5, content: "Lovely" } });
  assert.ok([200, 201].includes(rev.status), rev.text);
  assert.deepEqual(since().map((c) => c.reason), ["review"]);
  assert.equal((await ListingProperty().findById(A2._id).select("reviewCount").lean()).reviewCount, 1);

  // admin prop-listing create/update
  mark = calls.length;
  const created = await raw("/prop-listing/", { token: AT, method: "POST", body: { title: "Admin Created", host: String(H._id), hostEmail: H.email, status: "processing" } });
  assert.equal(created.status, 201);
  assert.deepEqual(since(), [], "created as processing → not public");
  mark = calls.length;
  assert.equal((await raw(`/prop-listing/${created.json._id}`, { token: AT, method: "PUT", body: { status: "active" } })).status, 200);
  assert.deepEqual(since().map((c) => c.reason), ["admin-prop-update"]);
  mark = calls.length;
  const createdLive = await raw("/prop-listing/", { token: AT, method: "POST", body: { title: "Admin Created Live", host: String(H._id), hostEmail: H.email, status: "active" } });
  assert.equal(createdLive.status, 201);
  assert.deepEqual(since().map((c) => c.reason), ["admin-create"]);

  // pending-listing delete is never a public change
  const PD = await h.makeListing(H, { title: "Pending Delete", status: "processing" });
  mark = calls.length;
  assert.equal((await raw(`/properties/admin/${PD._id}`, { token: AT, method: "DELETE" })).status, 200);
  assert.deepEqual(since(), []);
});

// ---------------------------------------------------------------------------
test("notifications: tag batching for 0/1/19/20/21/100 ids; the site call carries the secret, is awaited, and a hanging site cannot block a write", async () => {
  const { tagsFor, chunk, SITE_BATCH, CDN_BATCH, notifyListingChanged, __setMock } = changed();
  const ids = (n) => Array.from({ length: n }, () => new mongoose.Types.ObjectId());
  for (const [n, batches] of [[0, 1], [1, 1], [19, 1], [20, 2], [21, 2], [100, 6]]) {
    const tags = tagsFor(ids(n));
    assert.equal(tags.length, n + 1, `${n} ids → ${n + 1} tags`);
    assert.equal(new Set(tags).size, tags.length, "each tag once");
    const b = chunk(tags, SITE_BATCH);
    assert.equal(b.length, batches, `${n} ids → ${batches} site batches`);
    assert.ok(b.every((x) => x.length <= SITE_BATCH));
    assert.ok(chunk(tags, CDN_BATCH).every((x) => x.length <= CDN_BATCH));
    assert.deepEqual(b.flat(), tags, "batches cover every tag in order");
  }
  assert.deepEqual(tagsFor(["a", "a", null, "b"]), ["listings", "listing:a", "listing:b"]);

  // real HTTP against a stub site
  const received = [];
  let mode = "ok";
  const stub = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      received.push({ secret: req.headers["x-revalidate-secret"], body: JSON.parse(body), method: req.method });
      if (mode === "hang") return; // never answers
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"revalidated":true}');
    });
  });
  await new Promise((r) => stub.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${stub.address().port}/api/revalidate`;
  const saved = { url: process.env.SITE_REVALIDATE_URL, secret: process.env.REVALIDATE_SECRET };
  __setMock(null);
  process.env.SITE_REVALIDATE_URL = url;
  process.env.REVALIDATE_SECRET = "site-secret";
  try {
    const summary = await notifyListingChanged(ids(25), "test");
    assert.equal(received.length, 2, "25 ids → 2 site batches");
    assert.equal(received[0].secret, "site-secret");
    assert.equal(received[0].method, "POST");
    assert.equal(received[0].body.tags[0], "listings");
    assert.equal(received[0].body.tags.length, 20);
    assert.equal(received[1].body.tags.length, 6);
    assert.equal(summary.site.done, 26);
    assert.equal(summary.cdn.done, 26, "invalidateByTag is a no-op outside Vercel but still counted");

    // a hanging site: the write path is released within the deadline, nothing throws
    mode = "hang";
    const t0 = Date.now();
    const s2 = await notifyListingChanged(ids(1), "hang");
    assert.ok(Date.now() - t0 < 3000, `released in ${Date.now() - t0} ms`);
    assert.ok(s2.site.error, "timeout recorded, not thrown");
    // unconfigured → skipped, no request
    mode = "ok";
    delete process.env.SITE_REVALIDATE_URL;
    const before = received.length;
    const s3 = await notifyListingChanged(ids(1), "unconfigured");
    assert.equal(s3.site.skipped, "unconfigured");
    assert.equal(received.length, before);
  } finally {
    process.env.SITE_REVALIDATE_URL = saved.url;
    process.env.REVALIDATE_SECRET = saved.secret;
    __setMock({ calls: mockCalls() });
    stub.close();
  }
});

// ---------------------------------------------------------------------------
test("routes: status is the host's own stage (indexed, status-only); admin document, export, admin-filter and host-profile data are admin-only; ids validated", async () => {
  await ListingProperty().deleteMany({ host: { $in: [H._id, O._id] } });
  HT = h.userToken(await require("../../models/User").findById(H._id)); // tokenVersion moved with ban/unban
  OT = h.userToken(await require("../../models/User").findById(O._id));
  const S = (token, email = H.email) => raw(`/prop-listing/status?email=${encodeURIComponent(email)}`, { token });
  assert.equal((await S(null)).status, 401);
  assert.equal((await S(OT)).status, 403, "another host cannot read it");
  assert.equal((await S(HT)).json.status, "noListings");
  await h.makeListing(H, { status: "incomplete" });
  assert.equal((await S(HT)).json.status, "incompleteListings");
  await h.makeListing(H, { status: "processing" });
  assert.equal((await S(HT)).json.status, "mixedListings");
  await h.makeListing(O, { status: "active" });
  assert.equal((await S(OT, O.email)).json.status, "activeListings", "each host sees only their own stage");
  assert.equal((await S(AT, O.email)).json.status, "activeListings", "admin may ask for any host");
  // legacy documents keyed by hostEmail only are still found
  await ListingProperty().collection.updateMany({ host: O._id }, { $unset: { host: "" } });
  assert.equal((await S(OT, O.email)).json.status, "activeListings");
  startCounting();
  await S(HT);
  const statusOps = stopCounting();
  assert.ok(statusOps.filter((o) => o.startsWith("listingproperties")).length <= 1, statusOps.join(","));
  assert.ok(statusOps.length <= 3, `status issued ${statusOps.length}: ${statusOps.join(", ")}`);

  const L = await h.makeListing(H, { title: "Gate Villa" });
  assert.equal((await raw(`/prop-listing/admin/${L._id}`)).status, 401);
  assert.equal((await raw(`/prop-listing/admin/${L._id}`, { token: HT })).status, 403);
  assert.equal((await raw(`/prop-listing/admin/${L._id}`, { token: AT })).status, 200);
  assert.equal((await raw(`/prop-listing/admin/not-an-id`, { token: AT })).status, 404, "malformed path ids are 404 by convention");
  assert.equal((await raw(`/prop-listing/admin/${new mongoose.Types.ObjectId()}`, { token: AT })).status, 404);
  assert.equal((await raw(`/prop-listing/not-an-id`)).status, 404, "public detail validates the id (was a CastError 500)");
  assert.equal((await raw("/prop-listing/export")).status, 401);
  assert.equal((await raw("/prop-listing/export", { token: HT })).status, 403);
  assert.equal((await raw("/prop-listing/export", { token: AT })).status, 200);
  assert.equal((await raw("/properties/admin-filter?page=1")).status, 401);
  assert.equal((await raw("/properties/admin-filter?page=1", { token: AT })).status, 200);
  assert.equal((await raw(`/properties/active/filter/${H._id}`, { token: HT })).status, 403);
  assert.equal((await raw(`/properties/active/filter/${H._id}`, { token: AT })).status, 200);
  assert.equal((await raw(`/properties/active/filter/nope`, { token: AT })).status, 404);
});

// ---------------------------------------------------------------------------
test("cost: front/dynamic ≤ 2 ops, search ≤ 3, countstays ≤ 1, detail ≤ 2; payload for 16 cards is small; heavy modules load lazily and work on first use", async () => {
  await ListingProperty().deleteMany({ host: { $in: [H._id, O._id] } });
  for (let i = 0; i < 16; i++) {
    const L = await h.makeListing(H, { title: `Weight ${i}`, description: "x".repeat(400), photos: Array.from({ length: 6 }, (_, j) => `https://majestic-escape-host-properties.blr1.digitaloceanspaces.com/listings/${H._id}/${i}-${j}.jpg`), amenities: ["wifi", "pool", "ac"], address: { city: "Weigh", state: "Goa" } });
    await embed(L._id);
  }
  startCounting();
  const r = await raw("/properties/front/dynamic");
  const frontOps = stopCounting();
  assert.equal(r.json.properties.length, 16);
  console.log(`[cost] front/dynamic: ${frontOps.length} ops → ${frontOps.join(", ")}; ${r.text.length} bytes for 16 cards (each listing carries a ${JSON.stringify(VECTOR).length}-byte vector in Mongo)`);
  assert.ok(frontOps.length <= 2, frontOps.join(", "));
  assert.ok(r.text.length < 40 * 1024, `16 cards weigh ${r.text.length} bytes`);

  startCounting();
  await raw("/properties/search-properties?location=Weigh&from=2027-05-01&to=2027-05-03");
  const searchOps = stopCounting();
  console.log(`[cost] search with dates: ${searchOps.length} ops → ${searchOps.join(", ")}`);
  assert.ok(searchOps.length <= 3, searchOps.join(", "));

  startCounting();
  await raw("/properties/countstays?city=Weigh,Panaji");
  const countOps = stopCounting();
  assert.ok(countOps.length <= 1, countOps.join(", "));

  const id = (await ListingProperty().findOne({ title: "Weight 0" }).select("_id").lean())._id;
  startCounting();
  const d = await raw(`/properties/${id}`);
  const detailOps = stopCounting();
  assert.equal(d.status, 200);
  assert.ok(detailOps.length <= 2, detailOps.join(", "));
  assert.ok(d.text.length < 8 * 1024, `detail weighs ${d.text.length} bytes`);

  // lazy modules: not loaded by the booted app…
  const loaded = (name) => Object.keys(require.cache).some((k) => k.replace(/\\/g, "/").includes(`/node_modules/${name}/`));
  assert.equal(loaded("aws-sdk"), false, "aws-sdk must not load at boot");
  assert.equal(loaded("puppeteer-core"), false, "puppeteer-core must not load at boot");
  assert.equal(loaded("@sparticuz/chromium"), false, "chromium must not load at boot");
  // …and usable on first use: the invoice PDF module (stubbed renderer) and the real S3 client (offline URL signing)
  process.env.INVOICE_PDF_DISABLED = "1";
  try {
    const pdf = await require("../../utils/generateInvoicePDF")("<h1>x</h1>");
    assert.ok(Buffer.isBuffer(pdf) && pdf.length > 0);
  } finally {
    delete process.env.INVOICE_PDF_DISABLED;
  }
  assert.equal(loaded("puppeteer-core"), true, "first use loaded the module");
  const s3 = require("../../config/digitalOcean.config");
  const signed = await new Promise((resolve, reject) => s3.getSignedUrl("putObject", { Bucket: "test-bucket", Key: "listings/x.jpg", Expires: 60 }, (err, url) => (err ? reject(err) : resolve(url))));
  assert.match(signed, /^https:\/\/.*test-bucket.*listings\/x\.jpg\?/);
  assert.equal(loaded("aws-sdk"), true);
});

// ---------------------------------------------------------------------------
test("closure: reviews are the booking's guest / host only, moderation is admin-only; GET /properties/ (bare) is active-only cards", async () => {
  await ListingProperty().deleteMany({ host: { $in: [H._id, O._id] } });
  const User = require("../../models/User");
  HT = h.userToken(await User.findById(H._id));
  OT = h.userToken(await User.findById(O._id));
  const L = await h.makeListing(H, { title: "Review Villa" });
  const B = await Booking().create({ userId: G._id, hostId: H._id, propertyId: L._id, checkIn: new Date(h.day(-9)), checkOut: new Date(h.day(-7)), price: 1, subTotal: 1, nights: 2, adults: 1, status: "confirmed", paymentStatus: "paid" });
  const body = { bookingId: String(B._id), rating: 4, content: "Nice" };
  // guest review: anonymous / another user / the host / an admin → refused; the booking's guest → accepted once
  assert.equal((await raw("/review/", { method: "POST", body })).status, 401);
  assert.equal((await raw("/review/", { token: OT, method: "POST", body })).status, 403, "another user cannot review this booking");
  assert.equal((await raw("/review/", { token: HT, method: "POST", body })).status, 403, "the host cannot review as the guest");
  assert.equal((await raw("/review/", { token: AT, method: "POST", body })).status, 403, "reviews are personal, even for admins");
  assert.equal((await ListingProperty().findById(L._id).select("reviewCount").lean()).reviewCount, 0, "refused reviews change nothing");
  const ok = await raw("/review/", { token: GT, method: "POST", body });
  assert.ok([200, 201].includes(ok.status), ok.text);
  assert.equal((await ListingProperty().findById(L._id).select("reviewCount").lean()).reviewCount, 1);
  // host review of the guest: another host / the guest → refused; the booking's host → accepted
  const hb = { bookingId: String(B._id), rating: 5, content: "Great guest" };
  assert.equal((await raw("/review/guest", { method: "POST", body: hb })).status, 401);
  assert.equal((await raw("/review/guest", { token: OT, method: "POST", body: hb })).status, 403);
  assert.equal((await raw("/review/guest", { token: GT, method: "POST", body: hb })).status, 403);
  const hok = await raw("/review/guest", { token: HT, method: "POST", body: hb });
  assert.ok([200, 201].includes(hok.status), hok.text);
  // moderation: admin only, ids validated
  const upd = `/review/update?bookingId=${B._id}&status=accept&propertyId=${L._id}&rating=4`;
  assert.equal((await raw(upd, { method: "PATCH" })).status, 401);
  assert.equal((await raw(upd, { token: GT, method: "PATCH" })).status, 403);
  assert.equal((await raw(upd, { token: HT, method: "PATCH" })).status, 403);
  assert.equal((await raw(`/review/update?bookingId=nope&status=accept&propertyId=${L._id}&rating=4`, { token: AT, method: "PATCH" })).status, 400, "malformed id no longer a CastError");
  const mod = await raw(upd, { token: AT, method: "PATCH" });
  assert.equal(mod.status, 200, mod.text);
  assert.equal((await ListingProperty().findById(L._id).select("reviewCount").lean()).reviewCount, 0, "hidden review removed from the rating");

  // GET /properties/ (bare): only active listings, as cards, cacheable, envelope unchanged
  await h.makeListing(H, { title: "Bare Draft", status: "incomplete" });
  await h.makeListing(H, { title: "Bare Pending", status: "processing" });
  await h.makeListing(H, { title: "Bare Delisted", status: "inactive" });
  const bare = await raw("/properties/?limit=50");
  assert.equal(bare.status, 200);
  assert.deepEqual(Object.keys(bare.json).sort(), ["currentPage", "hasMore", "properties", "resultsPerPage", "totalPages", "totalProperties"]);
  const titles = bare.json.properties.map((p) => p.title);
  assert.ok(titles.includes("Review Villa"));
  for (const t of ["Bare Draft", "Bare Pending", "Bare Delisted"]) assert.ok(!titles.includes(t), `${t} must not be public`);
  assert.ok(!("hostEmail" in bare.json.properties[0]) && !("host" in bare.json.properties[0]) && !("embedding" in bare.json.properties[0]));
  assert.equal(bare.headers["vercel-cache-tag"], "listings");
  assert.equal(bare.json.resultsPerPage, 50);
  assert.equal((await raw("/properties/?limit=999999")).json.resultsPerPage, 50, "capped");
});

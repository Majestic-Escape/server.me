const test = require("node:test");
const assert = require("node:assert/strict");
const h = require("./setup");

let U, T; // guest user + token
let HOST, HT; // host + token
let ADMIN, AT;
let listing;

test.before(async () => {
  await h.start();
  U = await h.makeUser();
  T = h.userToken(U);
  HOST = await h.makeUser({ role: "host" });
  HT = h.userToken(HOST);
  ADMIN = await h.makeAdmin();
  AT = h.adminToken(ADMIN);
  listing = await h.makeListing(HOST);
});
test.after(async () => h.stop());

const Booking = () => require("../../models/Booking");
const BookingNight = () => require("../../models/BookingNight");

test("client-controlled money/status fields are ignored; server computes price, nights, status", async () => {
  const body = h.bookingBody(listing, { checkIn: h.day(40), checkOut: h.day(45) });
  // hostile extras
  Object.assign(body, { price: 1, subTotal: 1, nights: 1, status: "confirmed", paymentStatus: "paid", userId: String(HOST._id), hostId: String(U._id) });
  const r = await h.api("POST", "/booking/", { token: T, body });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const b = r.body.data;
  assert.equal(b.price, 58500);
  assert.equal(b.subTotal, 45000);
  assert.equal(b.nights, 5);
  assert.equal(b.status, "pending");
  assert.equal(b.paymentStatus, "unpaid");
  assert.equal(String(b.userId), String(U._id), "userId comes from the token");
  assert.equal(String(b.hostId), String(HOST._id), "hostId comes from the listing");
  assert.equal(b.quote.totalPaise, 5850000);
  assert.ok(b.holdExpiresAt);
  const nights = await BookingNight().countDocuments({ bookingId: b._id });
  assert.equal(nights, 5);
  // Same rule the old checkout applied on the client: first true flag in stored order.
  const stored = await require("../../models/ListingProperty").findById(listing._id).lean();
  const expectedPolicy = Object.entries(stored.cancellationType).find(([, v]) => v === true)[0];
  assert.equal(b.cancellationPolicy, expectedPolicy, "policy from the listing");
});

test("validation: dates, capacity, past, too long, malformed ids", async () => {
  const cases = [
    [{ checkIn: h.day(10), checkOut: h.day(10) }, 400, "INVALID_DATES"],
    [{ checkIn: h.day(12), checkOut: h.day(10) }, 400, "INVALID_DATES"],
    [{ checkIn: h.day(-2), checkOut: h.day(1) }, 400, "INVALID_DATES"],
    [{ checkIn: h.day(1500), checkOut: h.day(1867) }, 400, "INVALID_DATES"], // > one-year abuse ceiling (no product limit by default — S.1)
    [{ checkIn: h.day(10), checkOut: h.day(12), adults: 0 }, 400, "INVALID_GUESTS"],
    [{ checkIn: h.day(10), checkOut: h.day(12), children: -1 }, 400, "INVALID_GUESTS"],
    [{ checkIn: h.day(10), checkOut: h.day(12), adults: 3, children: 2 }, 400, "OVER_CAPACITY"],
    [{ checkIn: "2026-02-31T00:00:00.000Z", checkOut: "2026-03-05T00:00:00.000Z" }, 400, "INVALID_DATES"],
    [{ checkIn: "not-a-date", checkOut: h.day(12) }, 400, "INVALID_DATES"],
  ];
  for (const [over, status, code] of cases) {
    const r = await h.api("POST", "/booking/", { token: T, body: h.bookingBody(listing, over) });
    assert.equal(r.status, status, `${JSON.stringify(over)} → ${JSON.stringify(r.body)}`);
    assert.equal(r.body.code, code);
  }
  const bad = await h.api("POST", "/booking/", { token: T, body: { ...h.bookingBody(listing, { checkIn: h.day(10), checkOut: h.day(12) }), propertyId: "abc" } });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.code, "INVALID_ID");
  const missing = await h.api("POST", "/booking/", { token: T, body: { ...h.bookingBody(listing, { checkIn: h.day(10), checkOut: h.day(12) }), propertyId: "000000000000000000000000" } });
  assert.equal(missing.status, 404);
  // Feb 29 on a leap year is fine; leap-day of a non-leap year is not
  const leap = await h.api("POST", "/booking/", { token: T, body: h.bookingBody(listing, { checkIn: "2028-02-28T00:00:00.000Z", checkOut: "2028-03-01T00:00:00.000Z" }) });
  assert.equal(leap.status, leap.status === 400 && leap.body.code === "INVALID_DATES" ? 400 : 201);
});

test("inactive listing and listing without price are not bookable", async () => {
  const inactive = await h.makeListing(HOST, { status: "inactive" });
  let r = await h.api("POST", "/booking/", { token: T, body: h.bookingBody(inactive, { checkIn: h.day(10), checkOut: h.day(12) }) });
  assert.equal(r.status, 409);
  assert.equal(r.body.code, "LISTING_INACTIVE");
  const noPrice = await h.makeListing(HOST, { basePrice: undefined });
  r = await h.api("POST", "/booking/", { token: T, body: h.bookingBody(noPrice, { checkIn: h.day(10), checkOut: h.day(12) }) });
  assert.equal(r.status, 409);
  assert.equal(r.body.code, "PRICING_UNAVAILABLE");
});

test("anonymous and admin tokens cannot create guest bookings", async () => {
  let r = await h.api("POST", "/booking/", { body: h.bookingBody(listing, { checkIn: h.day(60), checkOut: h.day(62) }) });
  assert.equal(r.status, 401);
  r = await h.api("POST", "/booking/", { token: AT, body: h.bookingBody(listing, { checkIn: h.day(60), checkOut: h.day(62) }) });
  assert.equal(r.status, 403);
});

test("partial overlap and same nights conflict; adjacent stays succeed", async () => {
  const L = await h.makeListing(HOST);
  const a = await h.api("POST", "/booking/", { token: T, body: h.bookingBody(L, { checkIn: h.day(20), checkOut: h.day(22) }) });
  assert.equal(a.status, 201);
  const other = await h.makeUser();
  const OT = h.userToken(other);
  const overlap = await h.api("POST", "/booking/", { token: OT, body: h.bookingBody(L, { checkIn: h.day(21), checkOut: h.day(24) }) });
  assert.equal(overlap.status, 409);
  assert.equal(overlap.body.code, "DATES_UNAVAILABLE");
  const same = await h.api("POST", "/booking/", { token: OT, body: h.bookingBody(L, { checkIn: h.day(20), checkOut: h.day(22) }) });
  assert.equal(same.status, 409);
  const adjacent = await h.api("POST", "/booking/", { token: OT, body: h.bookingBody(L, { checkIn: h.day(22), checkOut: h.day(25) }) });
  assert.equal(adjacent.status, 201, JSON.stringify(adjacent.body));
  const before = await h.api("POST", "/booking/", { token: OT, body: h.bookingBody(L, { checkIn: h.day(18), checkOut: h.day(20) }) });
  assert.equal(before.status, 201);
  // no orphan nights from the failed attempts
  const owners = await BookingNight().distinct("bookingId", { propertyId: L._id });
  assert.equal(owners.length, 3);
});

test("same user re-submitting the same dates gets the same pending booking (idempotent), not a conflict", async () => {
  const L = await h.makeListing(HOST);
  const body = h.bookingBody(L, { checkIn: h.day(30), checkOut: h.day(33) });
  const first = await h.api("POST", "/booking/", { token: T, body });
  assert.equal(first.status, 201);
  const again = await h.api("POST", "/booking/", { token: T, body });
  assert.equal(again.status, 200);
  assert.equal(again.body.replayed, true);
  assert.equal(again.body.data._id, first.body.data._id);
  assert.equal(await Booking().countDocuments({ propertyId: L._id }), 1);
  // Idempotency-Key header replay
  const L2 = await h.makeListing(HOST);
  const b2 = h.bookingBody(L2, { checkIn: h.day(30), checkOut: h.day(33) });
  const k1 = await h.api("POST", "/booking/", { token: T, body: b2, headers: { "idempotency-key": "abc-123" } });
  const k2 = await h.api("POST", "/booking/", { token: T, body: b2, headers: { "idempotency-key": "abc-123" } });
  assert.equal(k1.status, 201);
  assert.equal(k2.status, 200);
  assert.equal(k2.body.data._id, k1.body.data._id);
});

test("an expired hold is reclaimable immediately (no TTL dependency)", async () => {
  const L = await h.makeListing(HOST);
  const first = await h.api("POST", "/booking/", { token: T, body: h.bookingBody(L, { checkIn: h.day(50), checkOut: h.day(52) }) });
  assert.equal(first.status, 201);
  // simulate expiry
  await BookingNight().updateMany({ bookingId: first.body.data._id }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
  await Booking().updateOne({ _id: first.body.data._id }, { $set: { holdExpiresAt: new Date(Date.now() - 1000) } });
  const other = await h.makeUser();
  const r = await h.api("POST", "/booking/", { token: h.userToken(other), body: h.bookingBody(L, { checkIn: h.day(50), checkOut: h.day(52) }) });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const owners = await BookingNight().distinct("bookingId", { propertyId: L._id });
  assert.deepEqual(owners.map(String), [r.body.data._id]);
  // and the expired booking can no longer be paid for
  const order = await h.api("POST", "/payment/create-order", { token: T, body: { bookingId: first.body.data._id, amount: 2340000, currency: "INR" } });
  assert.equal(order.status, 409);
  assert.equal(order.body.code, "DATES_UNAVAILABLE");
});

test("20 simultaneous attempts for the same nights: exactly one winner, clean 409s, no orphans", async () => {
  const L = await h.makeListing(HOST);
  const users = await Promise.all(Array.from({ length: 20 }, () => h.makeUser()));
  const results = await Promise.all(
    users.map((u) => h.api("POST", "/booking/", { token: h.userToken(u), body: h.bookingBody(L, { checkIn: h.day(70), checkOut: h.day(73) }) })),
  );
  const created = results.filter((r) => r.status === 201);
  const conflicts = results.filter((r) => r.status === 409);
  assert.equal(created.length, 1, `winners: ${created.length}, statuses: ${results.map((r) => r.status).join(",")}`);
  assert.equal(conflicts.length, 19);
  assert.ok(conflicts.every((r) => r.body.code === "DATES_UNAVAILABLE"));
  assert.equal(await Booking().countDocuments({ propertyId: L._id }), 1);
  const nights = await BookingNight().find({ propertyId: L._id }).lean();
  assert.equal(nights.length, 3);
  assert.ok(nights.every((n) => String(n.bookingId) === created[0].body.data._id));
});

test("20 simultaneous identical submissions from ONE user create one booking", async () => {
  const L = await h.makeListing(HOST);
  const body = h.bookingBody(L, { checkIn: h.day(80), checkOut: h.day(82) });
  const results = await Promise.all(Array.from({ length: 20 }, () => h.api("POST", "/booking/", { token: T, body })));
  const ids = new Set(results.filter((r) => r.status === 201 || r.status === 200).map((r) => r.body.data._id));
  assert.equal(ids.size, 1, JSON.stringify(results.map((r) => [r.status, r.body.code])));
  assert.equal(await Booking().countDocuments({ propertyId: L._id }), 1);
});

test("host calendar block: only the listing host, stored like before, occupies nights; unblock releases", async () => {
  const L = await h.makeListing(HOST);
  const blockBody = { userId: String(HOST._id), action: "host", guests: 1, adults: 1, children: 0, infants: 0, propertyId: String(L._id), hostId: String(HOST._id), status: "confirmed", paymentStatus: "paid", checkIn: `${h.day(90)}T18:30:00.000Z`, checkOut: `${h.day(92)}T18:30:00.000Z`, subTotal: 0, price: 0, currency: "INR", guestData: { adults: [{ name: "n", age: 1 }] } };
  const denied = await h.api("POST", "/booking/", { token: T, body: blockBody });
  assert.equal(denied.status, 403);
  const ok = await h.api("POST", "/booking/", { token: HT, body: blockBody });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  assert.equal(ok.body.data.action, "host");
  assert.equal(ok.body.data.status, "confirmed");
  assert.equal(ok.body.data.paymentStatus, "paid");
  assert.equal(ok.body.data.price, 0);
  const rows = await BookingNight().find({ bookingId: ok.body.data._id }).lean();
  assert.equal(rows.length, 2);
  assert.ok(rows.every((r) => r.kind === "block" && r.expiresAt === null));
  // guests cannot book a blocked night
  const g = await h.api("POST", "/booking/", { token: T, body: h.bookingBody(L, { checkIn: h.day(91), checkOut: h.day(93) }) });
  assert.equal(g.status, 409);
  // check-dates reader still sees the block exactly as before
  const cd = await h.api("GET", `/booking/check-dates/${L._id}`);
  assert.equal(cd.status, 200);
  assert.ok(cd.body.data.includes(h.day(90)) && cd.body.data.includes(h.day(91)));
  // unblock: stranger 403, host ok, nights released
  const s = await h.api("POST", `/booking/unblock-dates/${L._id}`, { token: T, body: { selectedDate: h.day(90) } });
  assert.equal(s.status, 403);
  const u = await h.api("POST", `/booking/unblock-dates/${L._id}`, { token: HT, body: { selectedDate: h.day(90) } });
  assert.equal(u.status, 200, JSON.stringify(u.body));
  assert.equal(await BookingNight().countDocuments({ bookingId: ok.body.data._id }), 0);
  const g2 = await h.api("POST", "/booking/", { token: T, body: h.bookingBody(L, { checkIn: h.day(91), checkOut: h.day(93) }) });
  assert.equal(g2.status, 201);
  // anonymous unblock is refused
  const anon = await h.api("POST", `/booking/unblock-dates/${L._id}`, { body: { selectedDate: h.day(90) } });
  assert.equal(anon.status, 401);
});

test("legacy paid booking without night rows still blocks (secondary check)", async () => {
  const L = await h.makeListing(HOST);
  await Booking().create({ userId: U._id, hostId: HOST._id, propertyId: L._id, checkIn: new Date(`${h.day(100)}T00:00:00.000Z`), checkOut: new Date(`${h.day(103)}T00:00:00.000Z`), price: 100, subTotal: 80, status: "confirmed", paymentStatus: "paid" });
  const r = await h.api("POST", "/booking/", { token: T, body: h.bookingBody(L, { checkIn: h.day(101), checkOut: h.day(102) }) });
  assert.equal(r.status, 409);
  assert.equal(await BookingNight().countDocuments({ propertyId: L._id }), 0, "no rows left behind");
});

test("malformed ids on booking routes are 400/404, never 500", async () => {
  for (const [m, p] of [["GET", "/booking/abc"], ["GET", "/booking/123456789012345678901234x"], ["PUT", "/booking/abc"], ["DELETE", "/booking/abc"], ["GET", "/booking/check-dates/abc"], ["GET", "/booking/blocked-dates/abc"]]) {
    const r = await h.api(m, p, { token: AT, body: m === "GET" ? undefined : {} });
    assert.ok([400, 404].includes(r.status), `${m} ${p} → ${r.status}`);
  }
  const r = await h.api("POST", "/booking/updateStatus", { token: T, body: { bookingId: "nope" } });
  assert.equal(r.status, 400);
  const p = await h.api("GET", "/properties/abc");
  assert.equal(p.status, 404);
});

const test = require("node:test");
const assert = require("node:assert/strict");
const jwt = require("jsonwebtoken");
const h = require("./setup");

let A, AT_, B, BT, HA, HAT, HB, HBT, ADMIN, AT;
let LA, LB; // listings of host A / host B
let bookA, bookB; // guest A on LA, guest B on LB
const Booking = () => require("../../models/Booking");

test.before(async () => {
  await h.start();
  A = await h.makeUser(); AT_ = h.userToken(A);
  B = await h.makeUser(); BT = h.userToken(B);
  HA = await h.makeUser({ role: "host" }); HAT = h.userToken(HA);
  HB = await h.makeUser({ role: "host" }); HBT = h.userToken(HB);
  ADMIN = await h.makeAdmin(); AT = h.adminToken(ADMIN);
  LA = await h.makeListing(HA);
  LB = await h.makeListing(HB);
  bookA = (await h.api("POST", "/booking/", { token: AT_, body: h.bookingBody(LA, { checkIn: h.day(200), checkOut: h.day(202) }) })).body.data;
  bookB = (await h.api("POST", "/booking/", { token: BT, body: h.bookingBody(LB, { checkIn: h.day(200), checkOut: h.day(202) }) })).body.data;
});
test.after(async () => h.stop());

test("matrix: guest/host/admin/anonymous × booking actions", async () => {
  const cases = [
    // [label, method, path, body, token, expected]
    ["guest A reads own booking", "GET", `/booking/${bookA._id}`, undefined, AT_, 200],
    ["guest A reads guest B booking", "GET", `/booking/${bookB._id}`, undefined, AT_, 403],
    ["host A reads booking on own listing", "GET", `/booking/${bookA._id}`, undefined, HAT, 200],
    ["host A reads booking on host B listing", "GET", `/booking/${bookB._id}`, undefined, HAT, 403],
    ["admin reads any booking", "GET", `/booking/${bookB._id}`, undefined, AT, 200],
    ["anonymous reads booking", "GET", `/booking/${bookA._id}`, undefined, undefined, 401],
    ["guest A confirms (host action)", "PATCH", "/booking/host/confirm", { bookingId: bookA._id }, AT_, 403],
    ["host B confirms host A booking", "PATCH", "/booking/host/confirm", { bookingId: bookA._id }, HBT, 403],
    ["guest B terminates guest A booking", "PATCH", "/booking/user/terminate", { bookingId: bookA._id }, BT, 403],
    ["host B terminates host A booking", "PATCH", "/booking/host/terminate", { bookingId: bookA._id }, HBT, 403],
    ["host B rejects host A booking", "PATCH", "/booking/host/cancel", { bookingId: bookA._id }, HBT, 403],
    ["guest calls admin cancel", "PATCH", "/booking/admin/cancel", { bookingId: bookA._id }, AT_, 403],
    ["host calls admin cancel", "PATCH", "/booking/admin/cancel", { bookingId: bookA._id }, HAT, 403],
    ["guest calls admin modify", "POST", "/booking/admin-modify?bookingId=x", {}, AT_, 403],
    ["host lists all bookings (admin)", "GET", "/booking/", undefined, HAT, 403],
    ["guest lists host emails (admin)", "GET", "/booking/hostEmails", undefined, AT_, 403],
    ["guest deletes booking", "DELETE", `/booking/${bookA._id}`, undefined, AT_, 403],
    ["host deletes booking", "DELETE", `/booking/${bookA._id}`, undefined, HAT, 403],
    ["guest A edits booking (PUT)", "PUT", `/booking/${bookA._id}`, { adults: 1 }, AT_, 403],
    ["guest B flags guest A booking", "PATCH", `/booking/update-flag?id=${bookA._id}`, {}, BT, 403],
    ["host B flags host A booking", "PATCH", `/booking/update-flag?id=${bookA._id}`, {}, HBT, 403],
    ["guest B closes guest A modal", "PATCH", "/booking/modal-close", { bookingId: bookA._id }, BT, 403],
    ["guest B pays guest A booking", "POST", "/payment/create-order", { bookingId: bookA._id, amount: bookA.quote.totalPaise }, BT, 403],
    ["anonymous pays", "POST", "/payment/create-order", { bookingId: bookA._id, amount: bookA.quote.totalPaise }, undefined, 401],
    ["anonymous verifies", "POST", "/payment/verify-payment", { razorpay_order_id: "x", razorpay_payment_id: "y", razorpay_signature: "z" }, undefined, 401],
    ["anonymous cron", "GET", "/payment/schedule-cron", undefined, undefined, 401],
    ["guest lists payments (admin)", "GET", "/payment/fetch", undefined, AT_, 403],
    ["guest B reads guest A bookings by user id", "GET", `/booking/user/${A._id}`, undefined, BT, 403],
    ["host B reads host A bookings by host id", "GET", `/booking/host/${HA._id}`, undefined, HBT, 403],
    ["guest B unblocks host A dates", "POST", `/booking/unblock-dates/${LA._id}`, { selectedDate: h.day(200) }, BT, 403],
    ["host B updates host A listing", "PUT", `/properties/update-listing-property/${LA._id}`, { basePrice: 1 }, HBT, 403],
    ["anonymous updates listing", "PUT", `/properties/update-listing-property/${LA._id}`, { basePrice: 1 }, undefined, 401],
    ["host B changes host A timings", "POST", "/properties/timings", { propertyId: String(LA._id), checkinTime: "1", checkoutTime: "2" }, HBT, 403],
    ["host B attaches an iCal to host A listing", "POST", "/calendarSync/saveCalendar", { propertyId: String(LA._id), url: "http://x/ics", kind: "import" }, HBT, 403],
    ["anonymous attaches an iCal", "POST", "/calendarSync/saveCalendar", { propertyId: String(LA._id), url: "http://x/ics", kind: "import" }, undefined, 401],
    ["host creates listing for another host email", "POST", "/properties/create-listing-property", { hostEmail: HB.email, title: "x" }, HAT, 403],
    ["host approves listing (admin)", "PATCH", `/properties/admin/approve/${LA._id}`, {}, HAT, 403],
    ["host B delists host A listing", "PATCH", `/properties/host/delist/${LA._id}?hostSide=true`, {}, HBT, 403],
    ["guest reads admin listings", "GET", "/properties/admin/filtered-listings?search=&status=all", undefined, AT_, 403],
    ["anonymous legacy PUT /properties/:id", "PUT", `/properties/${LA._id}`, { basePrice: 1 }, undefined, 401],
  ];
  const failures = [];
  for (const [label, method, path, body, token, expected] of cases) {
    const r = await h.api(method, path, { token, body: method === "GET" ? undefined : body });
    if (r.status !== expected) failures.push(`${label}: expected ${expected} got ${r.status} ${JSON.stringify(r.body).slice(0, 120)}`);
  }
  assert.deepEqual(failures, []);
  // nothing above changed state
  const a = await Booking().findById(bookA._id);
  assert.equal(a.status, "pending");
  assert.equal(a.paymentStatus, "unpaid");
  assert.equal((await require("../../models/ListingProperty").findById(LA._id)).basePrice, 9000);
});

test("admin identity must exist in the database: a bare admin-looking JWT is not an admin", async () => {
  const ghost = jwt.sign({ userId: "000000000000000000000001", firstName: "Ghost" }, process.env.JWT_SECRET, { expiresIn: "1h" });
  let r = await h.api("GET", "/booking/", { token: ghost });
  assert.equal(r.status, 401, JSON.stringify(r.body));
  // a user's token with a forged admin:1 claim is not an admin either
  const forged = jwt.sign({ userId: String(A._id), firstName: A.firstName, tokenVersion: 0, admin: 1 }, process.env.JWT_SECRET, { expiresIn: "1h" });
  r = await h.api("GET", "/booking/", { token: forged });
  assert.equal(r.status, 403);
  r = await h.api("PATCH", "/booking/admin/cancel", { token: forged, body: { bookingId: bookA._id } });
  assert.equal(r.status, 403);
  // banned admin
  const banned = await h.makeAdmin({ status: { banned: true } });
  r = await h.api("GET", "/booking/", { token: h.adminToken(banned) });
  assert.equal(r.status, 401);
  // revoked user token (tokenVersion bumped) is refused
  await require("../../models/User").updateOne({ _id: A._id }, { $inc: { tokenVersion: 1 } });
  r = await h.api("GET", `/booking/${bookA._id}`, { token: AT_ });
  assert.equal(r.status, 401);
  assert.equal(r.body.code, "TOKEN_INVALIDATED");
  await require("../../models/User").updateOne({ _id: A._id }, { $inc: { tokenVersion: -1 } });
});

test("list endpoints are scoped to the caller (no cross-host / cross-guest leakage)", async () => {
  // host A's active/analytics/revenue views never include host B's bookings
  let r = await h.api("GET", "/booking/analytics-filter?search=&status=all&from=null&to=null&limit=50&skip=0", { token: HAT });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const ids = (r.body.data || []).map((b) => String(b._id));
  assert.ok(!ids.includes(String(bookB._id)));
  r = await h.api("GET", `/booking/analytics-filter?search=&status=all&from=null&to=null&hostId=${HB._id}&limit=50&skip=0`, { token: HAT });
  assert.ok(!(r.body.data || []).some((b) => String(b._id) === String(bookB._id)), "hostId query param cannot widen the scope");
  r = await h.api("GET", "/booking/filter", { token: HAT });
  assert.ok(!(r.body.data || []).some((b) => String(b._id) === String(bookB._id)));
  r = await h.api("GET", "/booking/filter-active-bookings", { token: HAT });
  assert.equal(r.status, 200);
  assert.ok(!(r.body.data || []).some((b) => String(b.hostId?._id || b.hostId) === String(HB._id)));
  // guest B cannot list guest A's bookings through the query param
  r = await h.api("GET", `/booking/data?userId=${A._id}`, { token: BT });
  assert.equal(r.status, 200);
  assert.ok(!(r.body.data || []).some((b) => String(b._id) === String(bookA._id)));
  // admin sees everything
  r = await h.api("GET", "/booking/", { token: AT });
  assert.equal(r.status, 200);
  assert.ok(r.body.data.some((b) => String(b._id) === String(bookB._id)));
});

test("listing owners keep their own rights; admins keep theirs", async () => {
  let r = await h.api("POST", "/properties/timings", { token: HAT, body: { propertyId: String(LA._id), checkinTime: "14", checkoutTime: "10" } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  r = await h.api("POST", "/properties/timings", { token: AT, body: { propertyId: String(LA._id), checkinTime: "15", checkoutTime: "11" } });
  assert.equal(r.status, 200);
  r = await h.api("PATCH", `/properties/admin/approve/${LA._id}`, { token: AT, body: {} });
  assert.ok([200, 400, 404].includes(r.status), `admin approve → ${r.status}`); // handler semantics unchanged
  r = await h.api("GET", "/properties/admin/filtered-listings?search=&status=all", { token: AT });
  assert.equal(r.status, 200);
});

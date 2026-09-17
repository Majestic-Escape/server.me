// Final pre-release hardening pass: identity edge cases with side-effect
// accounting, malformed-input fuzzing, repeated high-contention rounds,
// boundary dates, simultaneous conflicting mutations, failure injection
// around secondary effects, and index/query-plan checks.
const test = require("node:test");
const assert = require("node:assert/strict");
const jwt = require("jsonwebtoken");
const h = require("./setup");

let U, T, B, BT, HOST, HT, HOST2, HT2, ADMIN, AT;
const Booking = () => require("../../models/Booking");
const Payment = () => require("../../models/Payment");
const BookingNight = () => require("../../models/BookingNight");
const User = () => require("../../models/User");
const Admin = () => require("../../models/Admin");

test.before(async () => {
  await h.start();
  U = await h.makeUser();
  T = h.userToken(U);
  B = await h.makeUser();
  BT = h.userToken(B);
  HOST = await h.makeUser({ role: "host" });
  HT = h.userToken(HOST);
  HOST2 = await h.makeUser({ role: "host" });
  HT2 = h.userToken(HOST2);
  ADMIN = await h.makeAdmin();
  AT = h.adminToken(ADMIN);
});
test.after(async () => h.stop());

// Everything that could be a side effect of a request.
async function footprint() {
  const g = h.razorpay().__mock.calls;
  return {
    bookings: await Booking().countDocuments(),
    nights: await BookingNight().countDocuments(),
    payments: await Payment().countDocuments(),
    gateway: g.ordersCreate + g.paymentsRefund,
    emails: h.sentEmails().length,
  };
}
let seq = 0;
async function paidBooking(L, token = T, dayBase) {
  const base = dayBase ?? 1200 + (seq += 3);
  const r = await h.api("POST", "/booking/", { token, body: h.bookingBody(L, { checkIn: h.day(base), checkOut: h.day(base + 2) }) });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const b = r.body.data;
  const o = (await h.api("POST", "/payment/create-order", { token, body: { bookingId: b._id, amount: b.quote.totalPaise } })).body.data;
  const p = h.razorpay().__registerPayment({ id: `pay_hd${seq}_${Date.now()}`, order_id: o.id, amount: o.amount, currency: "INR", status: "captured", method: "upi" });
  const v = await h.api("POST", "/payment/verify-payment", { token, body: { razorpay_order_id: o.id, razorpay_payment_id: p.id, razorpay_signature: h.signature(o.id, p.id) } });
  assert.equal(v.status, 200, JSON.stringify(v.body));
  return { booking: b, order: o, payment: p };
}

test("identity edge cases: banned user, expired / malformed / foreign-secret JWT, deleted admin, wrong cron secret — refused with no side effect", async () => {
  const L = await h.makeListing(HOST);
  const { booking, order } = await paidBooking(L);
  const banned = await h.makeUser({ status: { banned: true, active: true } });
  const bannedT = h.userToken(banned);
  const expired = jwt.sign({ userId: String(U._id), firstName: U.firstName, tokenVersion: 0, admin: 0 }, process.env.JWT_SECRET, { expiresIn: -10 });
  const foreign = jwt.sign({ userId: String(U._id), firstName: U.firstName, tokenVersion: 0, admin: 0 }, "not-the-secret", { expiresIn: "1h" });
  const ghostAdmin = await h.makeAdmin();
  const ghostAT = h.adminToken(ghostAdmin);
  await Admin().deleteOne({ _id: ghostAdmin._id });
  const before = await footprint();
  const body = h.bookingBody(L, { checkIn: h.day(1500), checkOut: h.day(1502) });
  const cases = [
    ["banned creates booking", "POST", "/booking/", body, bannedT, 403, "USER_BANNED"],
    ["banned opens order", "POST", "/payment/create-order", { bookingId: booking._id, amount: 1 }, bannedT, 403, "USER_BANNED"],
    ["banned verifies", "POST", "/payment/verify-payment", { razorpay_order_id: order.id, razorpay_payment_id: "x", razorpay_signature: "y" }, bannedT, 403, "USER_BANNED"],
    ["expired token creates booking", "POST", "/booking/", body, expired, 401, "AUTH_TOKEN_EXPIRED"],
    ["foreign-secret token creates booking", "POST", "/booking/", body, foreign, 403, "AUTH_TOKEN_INVALID"],
    ["garbage token", "POST", "/booking/", body, "not.a.jwt", 403, "AUTH_TOKEN_INVALID"],
    ["deleted admin cancels", "PATCH", "/booking/admin/cancel", { bookingId: booking._id }, ghostAT, 401, "AUTH_REQUIRED"],
    ["deleted admin lists attention", "GET", "/booking/admin/attention", undefined, ghostAT, 401, "AUTH_REQUIRED"],
    ["guest B reads guest A payment by booking", "GET", `/payment/booking?id=${booking._id}`, undefined, BT, 403, undefined],
    ["host B updates host A KYC record", "PATCH", `/properties/update-kyc-property/${HOST._id}`, {}, HT2, 403, "FORBIDDEN"],
    ["guest resolves attention", "PATCH", "/booking/admin/attention/resolve", { bookingId: booking._id, resolution: "keep" }, T, 403, "FORBIDDEN"],
    ["host B unblocks host A dates", "POST", `/booking/unblock-dates/${L._id}`, { selectedDate: h.day(1200) }, HT2, 403, "FORBIDDEN"],
  ];
  for (const [name, method, path, data, token, status, code] of cases) {
    const r = await h.api(method, path, { token, body: data });
    assert.equal(r.status, status, `${name}: ${JSON.stringify(r.body)}`);
    if (code) assert.equal(r.body.code, code, name);
  }
  // wrong cron secret / admin JWT as cron secret
  for (const auth of ["Bearer wrong", `Bearer ${AT}`, "Basic abc"]) {
    const r = await h.api("GET", "/payment/schedule-cron", { headers: { authorization: auth } });
    assert.equal(r.status, 401, auth);
  }
  const after = await footprint();
  assert.deepEqual(after, before, "unauthorized attempts left no booking, night, payment, gateway call or e-mail behind");
});

test("fuzz: malformed ids, shapes, dates and guest counts answer 400/404, never a CastError 500", async () => {
  const L = await h.makeListing(HOST);
  const ok = h.bookingBody(L, { checkIn: h.day(1600), checkOut: h.day(1602) });
  const before = await footprint();
  const ids = ["", "abc", "123", "zzzzzzzzzzzzzzzzzzzzzzzz", "000000000000000000000000", ["6aab5c6eb3f5aa882e92cd95"], { $ne: null }, 12345, null];
  const expectFor = (id) => (id === "000000000000000000000000" ? 404 : 400);
  for (const id of ids) {
    const r = await h.api("POST", "/booking/", { token: T, body: { ...ok, propertyId: id } });
    assert.ok([400, 404].includes(r.status) && r.status === expectFor(id), `create propertyId=${JSON.stringify(id)} → ${r.status} ${JSON.stringify(r.body)}`);
    const o = await h.api("POST", "/payment/create-order", { token: T, body: { bookingId: id, amount: 1 } });
    assert.equal(o.status, expectFor(id), `create-order bookingId=${JSON.stringify(id)} → ${o.status}`);
    for (const path of ["/booking/host/confirm", "/booking/user/terminate", "/booking/admin/attention/resolve"]) {
      const r2 = await h.api("PATCH", path, { token: path.includes("admin") ? AT : T, body: { bookingId: id, resolution: "keep" } });
      assert.ok([400, 404].includes(r2.status), `${path} bookingId=${JSON.stringify(id)} → ${r2.status}`);
    }
  }
  for (const id of ["abc", "123", "zzzzzzzzzzzzzzzzzzzzzzzz", "%20", "null"]) {
    for (const path of [`/booking/${id}`, `/booking/check-dates/${id}`, `/booking/blocked-dates/${id}`, `/properties/${id}`, `/booking/user/${id}`]) {
      const r = await h.api("GET", path, { token: path.startsWith("/booking/user") ? AT : T });
      assert.ok([400, 404].includes(r.status), `GET ${path} → ${r.status} ${JSON.stringify(r.body).slice(0, 100)}`);
    }
    const m = await h.api("POST", "/booking/admin-modify", { token: AT, body: { bookingId: id, checkIn: ok.checkIn, checkOut: ok.checkOut, adults: 1, children: 0, guest: 1 } });
    assert.ok([400, 404].includes(m.status), `admin-modify ${id} → ${m.status}`);
  }
  // shapes and values
  const bad = [
    [{ checkIn: { $gt: "" } }, 400], [{ checkIn: ["2027-01-01"] }, 400], [{ checkIn: "2027-02-30T00:00:00.000Z" }, 400], [{ checkIn: "2027-13-01" }, 400],
    [{ checkOut: 12345 }, 400], [{ adults: -1 }, 400], [{ adults: "two" }, 400], [{ adults: 1e9 }, 400], [{ children: 1.5 }, 400], [{ infants: -3 }, 400],
    [{ adults: { $gt: 0 } }, 400], [{ guestData: "x" }, 201], [{ guestData: { adults: Array.from({ length: 5000 }, (_, i) => ({ name: `G${i}`, age: 30 })) } }, 201],
    [{ price: -1, subTotal: 0, status: "confirmed", paymentStatus: "paid", nights: 99 }, 201],
  ];
  let day = 1700;
  for (const [over, status] of bad) {
    day += 5;
    const body = { ...h.bookingBody(L, { checkIn: h.day(day), checkOut: h.day(day + 2) }), ...over };
    const r = await h.api("POST", "/booking/", { token: T, body });
    assert.equal(r.status, status, `${JSON.stringify(over).slice(0, 80)} → ${r.status} ${JSON.stringify(r.body).slice(0, 120)}`);
    if (status === 201) {
      const bk = await Booking().findById(r.body.data._id).lean();
      assert.equal(bk.status, "pending");
      assert.equal(bk.paymentStatus, "unpaid");
      assert.equal(bk.nights, 2);
      assert.equal(bk.price, 23400, "client price ignored");
      assert.ok(bk.guestData.adults.length <= 50, "guest rows capped");
    }
  }
  // verify-payment with non-string ids
  for (const v of [{ razorpay_order_id: ["a"], razorpay_payment_id: "b", razorpay_signature: "c" }, { razorpay_order_id: { a: 1 }, razorpay_payment_id: "b", razorpay_signature: "c" }, {}]) {
    const r = await h.api("POST", "/payment/verify-payment", { token: T, body: v });
    assert.equal(r.status, 400, JSON.stringify(r.body));
  }
  const after = await footprint();
  assert.equal(after.payments, before.payments);
  assert.equal(after.gateway, before.gateway);
  assert.equal(after.emails, before.emails);
});

test("contention: 3 rounds × 20 simultaneous same-night bookings, each with one winner and zero orphans", async () => {
  for (let round = 0; round < 3; round++) {
    const L = await h.makeListing(HOST);
    const users = await Promise.all(Array.from({ length: 20 }, () => h.makeUser()));
    const from = h.day(1800 + round * 10), to = h.day(1803 + round * 10);
    const before = await footprint();
    const results = await Promise.all(users.map((u) => h.api("POST", "/booking/", { token: h.userToken(u), body: h.bookingBody(L, { checkIn: from, checkOut: to }) })));
    const codes = results.map((r) => r.status);
    assert.equal(codes.filter((c) => c === 201).length, 1, `round ${round}: ${JSON.stringify(codes)}`);
    assert.equal(codes.filter((c) => c === 409).length, 19, `round ${round}`);
    const rows = await Booking().find({ propertyId: L._id }).lean();
    assert.equal(rows.length, 1, "no orphan booking");
    const nights = await BookingNight().find({ propertyId: L._id }).lean();
    assert.equal(nights.length, 3, "no orphan night");
    assert.ok(nights.every((n) => String(n.bookingId) === String(rows[0]._id)));
    assert.equal(await Payment().countDocuments({ propertyId: L._id }), 0);
    const after = await footprint();
    assert.equal(after.gateway, before.gateway);
    // the 19 losers can all book elsewhere: nothing about them is stuck
    const other = await h.api("POST", "/booking/", { token: h.userToken(users[19]), body: h.bookingBody(L, { checkIn: to, checkOut: h.day(1805 + round * 10) }) });
    assert.equal(other.status, 201, "adjacent stay (check-in on the winner's check-out) is fine");
  }
});

test("overlap geometry and boundary dates: partial, identical, adjacent, leap day, year boundary", async () => {
  const L = await h.makeListing(HOST);
  const book = (token, from, to) => h.api("POST", "/booking/", { token, body: h.bookingBody(L, { checkIn: from, checkOut: to }) });
  const nextLeap = (() => { let y = new Date().getUTCFullYear() + 1; while (!((y % 4 === 0 && y % 100 !== 0) || y % 400 === 0)) y++; return y; })();
  // leap day stay
  let r = await book(T, `${nextLeap}-02-28`, `${nextLeap}-03-01`);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.data.nights, 2, "Feb 28 and Feb 29");
  const leapNights = await BookingNight().find({ bookingId: r.body.data._id }).sort({ date: 1 }).lean();
  assert.deepEqual(leapNights.map((n) => n.date.toISOString().slice(0, 10)), [`${nextLeap}-02-28`, `${nextLeap}-02-29`]);
  // partial overlap (one shared night) from another guest
  r = await book(BT, `${nextLeap}-02-29`, `${nextLeap}-03-02`);
  assert.equal(r.status, 409);
  // adjacent (check-in on the check-out day) is allowed
  r = await book(BT, `${nextLeap}-03-01`, `${nextLeap}-03-03`);
  assert.equal(r.status, 201);
  // identical overlap by a third guest
  const C = await h.makeUser();
  r = await book(h.userToken(C), `${nextLeap}-02-28`, `${nextLeap}-03-01`);
  assert.equal(r.status, 409);
  // year boundary
  const y = new Date().getUTCFullYear() + 1;
  r = await book(T, `${y}-12-30`, `${y + 1}-01-02`);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.data.nights, 3);
  const yb = await BookingNight().find({ bookingId: r.body.data._id }).sort({ date: 1 }).lean();
  assert.deepEqual(yb.map((n) => n.date.toISOString().slice(0, 10)), [`${y}-12-30`, `${y}-12-31`, `${y + 1}-01-01`]);
  r = await book(BT, `${y + 1}-01-01`, `${y + 1}-01-03`);
  assert.equal(r.status, 409, "Jan 1 is taken");
  r = await book(BT, `${y + 1}-01-02`, `${y + 1}-01-04`);
  assert.equal(r.status, 201, "Jan 2 onwards is free");
  // month boundary, 18:30Z host-block instants (the calendar's format) vs a UTC-midnight guest booking
  const blk = await h.api("POST", "/booking/", { token: HT, body: h.bookingBody(L, { checkIn: `${y}-03-31`, checkOut: `${y}-04-01`, action: "host", adults: 1 }) });
  assert.equal(blk.status, 201);
  const blkRows = await BookingNight().find({ bookingId: blk.body.data._id }).lean();
  assert.deepEqual(blkRows.map((n) => n.date.toISOString().slice(0, 10)), [`${y}-03-31`]);
  r = await book(T, `${y}-03-31`, `${y}-04-02`);
  assert.equal(r.status, 409, "the host block is honoured across the month boundary");
  r = await book(T, `${y}-04-01`, `${y}-04-02`);
  assert.equal(r.status, 201);
});

test("simultaneous conflicting mutations: host terminate + admin cancel + guest cancel on one paid booking → one refund, one terminal state", async () => {
  const L = await h.makeListing(HOST);
  const { booking } = await paidBooking(L);
  const refundsBefore = h.razorpay().__mock.calls.paymentsRefund;
  const rs = await Promise.all([
    h.api("PATCH", "/booking/host/terminate", { token: HT, body: { bookingId: booking._id } }),
    h.api("PATCH", "/booking/admin/cancel", { token: AT, body: { bookingId: booking._id } }),
    h.api("PATCH", "/booking/user/terminate", { token: T, body: { bookingId: booking._id } }),
    h.api("PATCH", "/booking/host/cancel", { token: HT, body: { bookingId: booking._id } }),
  ]);
  const statuses = rs.map((r) => r.status).sort();
  assert.ok(statuses.filter((s) => s === 200).length >= 1, JSON.stringify(rs.map((r) => r.body)));
  assert.equal(h.razorpay().__mock.calls.paymentsRefund, refundsBefore + 1, "exactly one gateway refund");
  const bk = await Booking().findById(booking._id).lean();
  assert.ok(["cancelled", "rejected"].includes(bk.status));
  assert.equal(bk.paymentStatus, "refunded");
  assert.equal(await BookingNight().countDocuments({ bookingId: booking._id }), 0);
  const pays = await Payment().find({ bookingId: booking._id }).lean();
  assert.equal(pays.filter((p) => p.status === "refunded").length, 1);
  // a later retry of any of them is a clean 409
  for (const [path, token] of [["/booking/host/terminate", HT], ["/booking/admin/cancel", AT], ["/booking/user/terminate", T]]) {
    const r = await h.api("PATCH", path, { token, body: { bookingId: booking._id } });
    assert.equal(r.status, 409, path);
  }
  assert.equal(h.razorpay().__mock.calls.paymentsRefund, refundsBefore + 1);
});

test("two tabs: create-order from two sessions of the same guest and a 5× rapid verify replay → one order, one payment, one e-mail set", async () => {
  const L = await h.makeListing(HOST);
  const r = await h.api("POST", "/booking/", { token: T, body: h.bookingBody(L, { checkIn: h.day(1900), checkOut: h.day(1902) }) });
  const b = r.body.data;
  const T2 = h.userToken(U); // second tab, second token
  const ordersBefore = h.razorpay().__mock.calls.ordersCreate;
  const orders = await Promise.all([T, T2, T, T2, T].map((tok) => h.api("POST", "/payment/create-order", { token: tok, body: { bookingId: b._id, amount: b.quote.totalPaise } })));
  const ids = new Set(orders.filter((o) => o.status === 200).map((o) => o.body.data.id));
  assert.equal(ids.size, 1, JSON.stringify(orders.map((o) => [o.status, o.body.code])));
  assert.equal(h.razorpay().__mock.calls.ordersCreate, ordersBefore + 1);
  const order = orders.find((o) => o.status === 200).body.data;
  const p = h.razorpay().__registerPayment({ id: `pay_tabs_${Date.now()}`, order_id: order.id, amount: order.amount, currency: "INR", status: "captured", method: "upi" });
  h.resetEmails();
  const vs = await Promise.all([T, T2, T, T2, T].map((tok) => h.api("POST", "/payment/verify-payment", { token: tok, body: { razorpay_order_id: order.id, razorpay_payment_id: p.id, razorpay_signature: h.signature(order.id, p.id) } })));
  assert.ok(vs.every((v) => v.status === 200));
  assert.equal(vs.filter((v) => v.body.alreadyProcessed === false).length, 1);
  assert.equal(await Payment().countDocuments({ bookingId: b._id }), 1);
  const us = await Promise.all([T, T2].map((tok) => h.api("POST", "/booking/updateStatus", { token: tok, body: { bookingId: b._id } })));
  assert.ok(us.every((u) => u.status === 200));
  assert.equal(h.sentEmails().length, 4, "34/35/36/36 once");
});

test("failure injection: booking write fails after the nights were taken → nights released; invoice/e-mail failure never repeats a financial step", async () => {
  const L = await h.makeListing(HOST);
  const origSave = Booking().prototype.save;
  Booking().prototype.save = function () { return Promise.reject(new Error("mock: booking write failed")); };
  let r;
  try {
    r = await h.api("POST", "/booking/", { token: T, body: h.bookingBody(L, { checkIn: h.day(2000), checkOut: h.day(2002) }) });
  } finally {
    Booking().prototype.save = origSave;
  }
  assert.equal(r.status, 500);
  assert.equal(await BookingNight().countDocuments({ propertyId: L._id }), 0, "no permanent or held nights left behind");
  r = await h.api("POST", "/booking/", { token: BT, body: h.bookingBody(L, { checkIn: h.day(2000), checkOut: h.day(2002) }) });
  assert.equal(r.status, 201, "the dates are immediately bookable");

  // invoice generation failure after payment: payment untouched, no gateway/refund calls, notifications retryable
  const { booking } = await paidBooking(L);
  const pdf = require("../../utils/generateInvoicePDF");
  const savedFlag = process.env.INVOICE_PDF_DISABLED;
  delete process.env.INVOICE_PDF_DISABLED;
  const origPdf = pdf.generateInvoicePDF;
  const gwBefore = h.razorpay().__mock.calls.ordersCreate + h.razorpay().__mock.calls.paymentsRefund;
  let u;
  try {
    r = await h.api("POST", "/booking/updateStatus", { token: T, body: { bookingId: booking._id } });
  } finally {
    process.env.INVOICE_PDF_DISABLED = savedFlag;
  }
  assert.equal(r.status, 502, JSON.stringify(r.body));
  assert.equal(r.body.code, "NOTIFY_FAILED");
  const bk = await Booking().findById(booking._id).lean();
  assert.equal(bk.paymentStatus, "paid");
  assert.equal(bk.status, "confirmed");
  assert.equal(bk.notifications.paidAt, null, "claim released for retry");
  assert.equal(h.razorpay().__mock.calls.ordersCreate + h.razorpay().__mock.calls.paymentsRefund, gwBefore, "no financial side effect");
  h.resetEmails();
  u = await h.api("POST", "/booking/updateStatus", { token: T, body: { bookingId: booking._id } });
  assert.equal(u.status, 200);
  assert.equal(h.sentEmails().length, 4);
  u = await h.api("POST", "/booking/updateStatus", { token: T, body: { bookingId: booking._id } });
  assert.equal(u.body.alreadyNotified, true);
  assert.equal(h.sentEmails().length, 4);
  void origPdf;
});

test("mongo read failure on the listing during create → 500 with nothing written; recovers on the next request", async () => {
  const ListingProperty = require("../../models/ListingProperty");
  const L = await h.makeListing(HOST);
  const orig = ListingProperty.findById;
  ListingProperty.findById = () => ({ lean: () => Promise.reject(new Error("mock: mongo read failed")), select: () => ({ lean: () => Promise.reject(new Error("mock")) }) });
  let r;
  try {
    r = await h.api("POST", "/booking/", { token: T, body: h.bookingBody(L, { checkIn: h.day(2100), checkOut: h.day(2102) }) });
  } finally {
    ListingProperty.findById = orig;
  }
  assert.equal(r.status, 500);
  assert.equal(r.body.code, "SERVER_ERROR");
  assert.ok(!/mock: mongo/.test(JSON.stringify(r.body)), "internal error text is not echoed");
  assert.equal(await Booking().countDocuments({ propertyId: L._id }), 0);
  assert.equal(await BookingNight().countDocuments({ propertyId: L._id }), 0);
  r = await h.api("POST", "/booking/", { token: T, body: h.bookingBody(L, { checkIn: h.day(2100), checkOut: h.day(2102) }) });
  assert.equal(r.status, 201);
});

test("query plans: the hot lookups use indexes (no collection scan)", async () => {
  const mongoose = require("mongoose");
  const db = mongoose.connection.db;
  const L = await h.makeListing(HOST);
  await paidBooking(L);
  const plan = async (coll, filter) => {
    const e = await db.collection(coll).find(filter).explain("queryPlanner");
    const stages = JSON.stringify(e.queryPlanner.winningPlan);
    return { ixscan: /IXSCAN/.test(stages), collscan: /COLLSCAN/.test(stages), stages };
  };
  const pid = L._id;
  const checks = [
    ["bookingnights", { propertyId: pid, date: { $in: [new Date()] } }],
    ["bookingnights", { bookingId: new mongoose.Types.ObjectId() }],
    ["bookingnights", { propertyId: pid, expiresAt: { $gt: new Date() }, date: { $gte: new Date() } }],
    ["bookings", { propertyId: pid, status: { $nin: ["rejected", "cancelled"] }, paymentStatus: "paid", checkIn: { $lt: new Date() }, checkOut: { $gt: new Date() } }],
    ["bookings", { idempotencyKey: "x:y" }],
    ["bookings", { needsAttention: { $type: "string" } }],
    ["payments", { bookingId: new mongoose.Types.ObjectId(), status: "created" }],
    ["payments", { orderId: "order_x" }],
    ["hostpayouts", { bookingId: new mongoose.Types.ObjectId() }],
  ];
  for (const [coll, filter] of checks) {
    const p = await plan(coll, filter);
    assert.ok(p.ixscan && !p.collscan, `${coll} ${JSON.stringify(filter).slice(0, 80)} → ${p.stages.slice(0, 200)}`);
  }
});

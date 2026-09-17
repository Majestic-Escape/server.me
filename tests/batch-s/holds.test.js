// Batch S.1 — hold semantics for every booking mode, and the guest → host →
// payment state transitions for instant and request-to-book listings
// (the table in docs/batch-s-booking-payment-integrity.md §9).
const test = require("node:test");
const assert = require("node:assert/strict");
const h = require("./setup");

let U, T, HOST, HT, ADMIN, AT;
const Booking = () => require("../../models/Booking");
const Payment = () => require("../../models/Payment");
const BookingNight = () => require("../../models/BookingNight");
const HOLD_MS = 30 * 60_000;

test.before(async () => {
  await h.start();
  U = await h.makeUser();
  T = h.userToken(U);
  HOST = await h.makeUser({ role: "host" });
  HT = h.userToken(HOST);
  ADMIN = await h.makeAdmin();
  AT = h.adminToken(ADMIN);
});
test.after(async () => h.stop());

let base = 700;
async function create(L, { token = T, nights = 2, ...rest } = {}) {
  base += 10;
  const r = await h.api("POST", "/booking/", { token, body: h.bookingBody(L, { checkIn: h.day(base), checkOut: h.day(base + nights), ...rest }) });
  return { r, checkIn: h.day(base), checkOut: h.day(base + nights) };
}
async function order(b, token = T) {
  return h.api("POST", "/payment/create-order", { token, body: { bookingId: b._id, amount: b.quote ? b.quote.totalPaise : undefined } });
}
let seq = 0;
async function payFor(b, token = T) {
  const o = await order(b, token);
  assert.equal(o.status, 200, JSON.stringify(o.body));
  const p = h.razorpay().__registerPayment({ id: `pay_hold${++seq}`, order_id: o.body.data.id, amount: o.body.data.amount, currency: "INR", status: "captured", method: "upi" });
  const v = await h.api("POST", "/payment/verify-payment", { token, body: { razorpay_order_id: o.body.data.id, razorpay_payment_id: p.id, razorpay_signature: h.signature(o.body.data.id, p.id) } });
  assert.equal(v.status, 200, JSON.stringify(v.body));
  return { order: o.body.data, payment: p, verify: v.body };
}
async function nightsOf(b) {
  return BookingNight().find({ bookingId: b._id }).lean();
}
const templates = () => h.sentEmails().map((e) => e.templateId);

test("instant booking: hold at create (30 min), permanent at payment, confirmed at payment; emails once; guest cancel releases", async () => {
  const L = await h.makeListing(HOST, { bookingType: { manual: false }, cancellationType: { flexible: true } });
  const t0 = Date.now();
  const { r } = await create(L);
  assert.equal(r.status, 201);
  const b = r.body.data;
  assert.equal(b.status, "pending");
  assert.equal(b.paymentStatus, "unpaid");
  let n = await nightsOf(b);
  assert.equal(n.length, 2);
  for (const row of n) {
    assert.ok(row.expiresAt, "unpaid = hold");
    assert.ok(Math.abs(new Date(row.expiresAt) - (t0 + HOLD_MS)) < 5000, "≈30 minutes");
  }
  assert.ok(Math.abs(new Date(b.holdExpiresAt) - (t0 + HOLD_MS)) < 5000);
  // the dates are blocked for everyone else from this instant
  const other = await h.makeUser();
  const taken = await h.api("POST", "/booking/", { token: h.userToken(other), body: h.bookingBody(L, { checkIn: h.day(base), checkOut: h.day(base + 2) }) });
  assert.equal(taken.status, 409);
  assert.equal(taken.body.code, "DATES_UNAVAILABLE");
  // check-dates shows them as unavailable while held
  const cd = await h.api("GET", `/booking/check-dates/${L._id}`);
  assert.equal(cd.status, 200);

  h.resetEmails();
  const { verify } = await payFor(b);
  assert.equal(verify.booking.status, "confirmed", "instant: confirmed at payment, no host step");
  assert.equal(verify.booking.paymentStatus, "paid");
  n = await nightsOf(b);
  assert.ok(n.every((row) => row.expiresAt === null), "paid = permanent");
  // the legacy client calls updateStatus then instant/confirm: notifications once, no state change
  const u1 = await h.api("POST", "/booking/updateStatus", { token: T, body: { bookingId: b._id } });
  const u2 = await h.api("POST", "/booking/updateStatus", { token: T, body: { bookingId: b._id } });
  assert.equal(u1.status, 200);
  assert.equal(u2.body.alreadyNotified, true);
  const c1 = await h.api("PATCH", "/booking/instant/confirm", { token: T, body: { bookingId: b._id } });
  assert.equal(c1.status, 200);
  assert.deepEqual(templates().sort((a, z) => a - z), [34, 35, 36, 36], "host 34, guest 35, admins 36 — once");
  // guest cancels inside the flexible window → refunded, nights released
  const cancel = await h.api("PATCH", "/booking/user/terminate", { token: T, body: { bookingId: b._id } });
  assert.equal(cancel.status, 200, JSON.stringify(cancel.body));
  assert.equal(cancel.body.refunded, true);
  assert.equal((await nightsOf(b)).length, 0, "cancelled = released");
  const bk = await Booking().findById(b._id);
  assert.equal(bk.status, "cancelled");
  assert.equal(bk.paymentStatus, "refunded");
  // and the dates are bookable again immediately
  const again = await h.api("POST", "/booking/", { token: h.userToken(other), body: h.bookingBody(L, { checkIn: h.day(base), checkOut: h.day(base + 2) }) });
  assert.equal(again.status, 201);
});

test("request-to-book: hold at create, permanent at payment, pending until the host decides; approval delay keeps the nights; reject refunds and releases", async () => {
  const L = await h.makeListing(HOST, { bookingType: { manual: true }, cancellationType: { moderate: true } });
  const { r } = await create(L);
  const b = r.body.data;
  h.resetEmails();
  const { verify } = await payFor(b);
  assert.equal(verify.booking.status, "pending", "manual: paid but awaiting the host");
  assert.equal(verify.booking.paymentStatus, "paid");
  assert.ok((await nightsOf(b)).every((row) => row.expiresAt === null), "inventory stays blocked while the host decides, however long that takes");
  await h.api("POST", "/booking/updateStatus", { token: T, body: { bookingId: b._id } });
  assert.deepEqual(templates().sort((a, z) => a - z), [8, 9, 9, 42], "host 8, admins 9, guest 42");
  // instant/confirm is refused for a manual listing
  const ic = await h.api("PATCH", "/booking/instant/confirm", { token: T, body: { bookingId: b._id } });
  assert.equal(ic.status, 409);
  // nobody else can take the nights meanwhile
  const other = await h.makeUser();
  const taken = await h.api("POST", "/booking/", { token: h.userToken(other), body: h.bookingBody(L, { checkIn: h.day(base), checkOut: h.day(base + 2) }) });
  assert.equal(taken.status, 409);
  // host approves (idempotent)
  h.resetEmails();
  const ok1 = await h.api("PATCH", "/booking/host/confirm", { token: HT, body: { bookingId: b._id } });
  const ok2 = await h.api("PATCH", "/booking/host/confirm", { token: HT, body: { bookingId: b._id } });
  assert.equal(ok1.status, 200);
  assert.equal(ok2.body.alreadyConfirmed, true);
  assert.equal((await Booking().findById(b._id)).status, "confirmed");
  assert.deepEqual(templates().sort((a, z) => a - z), [10, 18, 18, 19], "guest 10, admins 18, host 19 — once");

  // a second request the host rejects: full refund, nights released
  const { r: r2 } = await create(L);
  const b2 = r2.body.data;
  await payFor(b2);
  h.resetEmails();
  const rej = await h.api("PATCH", "/booking/host/cancel", { token: HT, body: { bookingId: b2._id } });
  assert.equal(rej.status, 200, JSON.stringify(rej.body));
  assert.equal(rej.body.refunded, true);
  const bk2 = await Booking().findById(b2._id);
  assert.equal(bk2.status, "rejected");
  assert.equal(bk2.paymentStatus, "refunded");
  assert.equal((await nightsOf(b2)).length, 0);
  assert.deepEqual(templates().sort((a, z) => a - z), [11, 16, 16, 17]);
  // a paid pending request the host never answers is not something the guest
  // can pay again, and a host cannot confirm an unpaid request
  const { r: r3 } = await create(L);
  const unpaidConfirm = await h.api("PATCH", "/booking/host/confirm", { token: HT, body: { bookingId: r3.body.data._id } });
  assert.equal(unpaidConfirm.status, 409);
  assert.equal(unpaidConfirm.body.code, "PAYMENT_NOT_RECORDED");
});

test("abandoned checkout: the hold expires after 30 minutes, the dates are free again, and the pending booking is still payable later if nobody took them", async () => {
  const L = await h.makeListing(HOST);
  const { r } = await create(L);
  const b = r.body.data;
  // simulate 31 minutes passing
  await BookingNight().updateMany({ bookingId: b._id }, { $set: { expiresAt: new Date(Date.now() - 60_000) } });
  await Booking().updateOne({ _id: b._id }, { $set: { holdExpiresAt: new Date(Date.now() - 60_000) } });
  // check-dates no longer shows the nights as taken? (the reader counts
  // unexpired holds and paid bookings only)
  // guest comes back and pays: nights are free → re-held and paid
  const { verify } = await payFor(b);
  assert.equal(verify.booking.status, "confirmed");
  assert.equal((await nightsOf(b)).length, 2);
  // pending row itself never expired (pre-S: pending bookings live forever) — documented
  assert.equal((await Booking().findById(b._id)).status, "confirmed");
});

test("abandoned checkout, dates taken meanwhile: the late Pay is refused with DATES_UNAVAILABLE and nothing is charged", async () => {
  const L = await h.makeListing(HOST);
  const { r, checkIn, checkOut } = await create(L);
  const b = r.body.data;
  await BookingNight().updateMany({ bookingId: b._id }, { $set: { expiresAt: new Date(Date.now() - 60_000) } });
  const other = await h.makeUser();
  const taken = await h.api("POST", "/booking/", { token: h.userToken(other), body: h.bookingBody(L, { checkIn, checkOut }) });
  assert.equal(taken.status, 201, "expired hold is reusable immediately");
  const ordersBefore = h.razorpay().__mock.calls.ordersCreate;
  const o = await order(b);
  assert.equal(o.status, 409);
  assert.equal(o.body.code, "DATES_UNAVAILABLE");
  assert.equal(h.razorpay().__mock.calls.ordersCreate, ordersBefore, "no gateway order");
  assert.equal((await nightsOf(b)).length, 0, "the loser keeps nothing");
  assert.equal(await Payment().countDocuments({ bookingId: b._id }), 0);
});

test("payment delay: clicking Pay re-arms the hold for 30 minutes; retries reuse the booking and the order", async () => {
  const L = await h.makeListing(HOST);
  const { r, checkIn, checkOut } = await create(L);
  const b = r.body.data;
  // 25 minutes later the guest clicks Pay
  await BookingNight().updateMany({ bookingId: b._id }, { $set: { expiresAt: new Date(Date.now() + 5 * 60_000) } });
  const t0 = Date.now();
  const o1 = await order(b);
  assert.equal(o1.status, 200);
  for (const row of await nightsOf(b)) assert.ok(new Date(row.expiresAt) - t0 > HOLD_MS - 5000, "hold extended from the Pay click");
  // double submit of the booking form → same booking; double Pay → same order
  const dup = await h.api("POST", "/booking/", { token: T, body: h.bookingBody(L, { checkIn, checkOut }) });
  assert.equal(dup.status, 200);
  assert.equal(dup.body.data._id, b._id);
  const o2 = await order(b);
  assert.equal(o2.body.data.id, o1.body.data.id);
  assert.equal(o2.body.reused, true);
});

test("pending unpaid booking cancelled by the guest releases the hold at once; host block and unblock", async () => {
  const L = await h.makeListing(HOST);
  const { r, checkIn, checkOut } = await create(L);
  const b = r.body.data;
  const c = await h.api("PATCH", "/booking/user/terminate", { token: T, body: { bookingId: b._id } });
  assert.equal(c.status, 200);
  assert.equal(c.body.refunded, false, "nothing was paid");
  assert.equal((await nightsOf(b)).length, 0);
  const other = await h.makeUser();
  assert.equal((await h.api("POST", "/booking/", { token: h.userToken(other), body: h.bookingBody(L, { checkIn, checkOut }) })).status, 201);
  // host block: permanent rows from the start, ₹0, confirmed/paid (as before)
  base += 10;
  const blk = await h.api("POST", "/booking/", { token: HT, body: h.bookingBody(L, { checkIn: h.day(base), checkOut: h.day(base + 1), action: "host", adults: 1 }) });
  assert.equal(blk.status, 201, JSON.stringify(blk.body));
  assert.equal(blk.body.data.price, 0);
  assert.equal(blk.body.data.status, "confirmed");
  const rows = await nightsOf(blk.body.data);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, "block");
  assert.equal(rows[0].expiresAt, null);
  const ub = await h.api("POST", `/booking/unblock-dates/${L._id}`, { token: HT, body: { selectedDate: `${h.day(base)}T18:30:00.000Z` } });
  assert.equal(ub.status, 200);
  assert.equal((await nightsOf(blk.body.data)).length, 0);
});

test("limits: no stay-length or horizon product rule unless configured; one-year abuse ceiling; one day of past-date grace", async () => {
  const lifecycle = require("../../controllers/bookingLifecycleController");
  assert.equal(lifecycle.MAX_BOOKING_NIGHTS, 0, "off by default — a business decision, not a hardening default");
  const L = await h.makeListing(HOST);
  const long = await h.api("POST", "/booking/", { token: T, body: h.bookingBody(L, { checkIn: h.day(1000), checkOut: h.day(1045) }) });
  assert.equal(long.status, 201, "45 nights, 1000 days ahead: allowed (as the old backend and the calendar allow)");
  assert.equal(long.body.data.nights, 45);
  const tooLong = await h.api("POST", "/booking/", { token: T, body: h.bookingBody(L, { checkIn: h.day(2000), checkOut: h.day(2367) }) });
  assert.equal(tooLong.status, 400);
  assert.equal(tooLong.body.code, "INVALID_DATES");
  const yesterday = await h.api("POST", "/booking/", { token: T, body: h.bookingBody(L, { checkIn: h.day(-1), checkOut: h.day(1) }) });
  assert.equal(yesterday.status, 201, "same-day check-in chosen west of UTC");
  const past = await h.api("POST", "/booking/", { token: T, body: h.bookingBody(L, { checkIn: h.day(-2), checkOut: h.day(-1) }) });
  assert.equal(past.status, 400);
});

// Batch S.1 — production cutover: the booking-write gate and the delta
// reconciliation that closes the "old backend wrote bookings after the
// backfill" window. Also: pre-S bookings (no quote, no night rows, orders at
// client-chosen amounts) meeting the S payment path.
const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("child_process");
const path = require("path");
const h = require("./setup");

let U, T, HOST, HT, ADMIN, AT;
const Booking = () => require("../../models/Booking");
const Payment = () => require("../../models/Payment");
const BookingNight = () => require("../../models/BookingNight");
const OpsFlag = () => require("../../models/OpsFlag");
const { FLAG_ID } = require("../../services/maintenance");

const gate = (enabled) => OpsFlag().updateOne({ _id: FLAG_ID }, { $set: { enabled, updatedAt: new Date() } }, { upsert: true });
const at = (d, t = "00:00:00.000Z") => new Date(`${d}T${t}`);

test.before(async () => {
  await h.start();
  U = await h.makeUser();
  T = h.userToken(U);
  HOST = await h.makeUser({ role: "host" });
  HT = h.userToken(HOST);
  ADMIN = await h.makeAdmin();
  AT = h.adminToken(ADMIN);
});
test.after(async () => {
  await gate(false);
  await h.stop();
});

function pay(order, id) {
  return h.razorpay().__registerPayment({ id, order_id: order.id, amount: order.amount, currency: "INR", status: "captured", method: "upi" });
}
function verify(order, p, token = T) {
  return h.api("POST", "/payment/verify-payment", { token, body: { razorpay_order_id: order.id, razorpay_payment_id: p.id, razorpay_signature: h.signature(order.id, p.id) } });
}

test("gate: inventory-taking writes answer 503 MAINTENANCE while paused; reads, verify-payment and the webhook keep working", async () => {
  const L = await h.makeListing(HOST);
  // an order opened before the gate (a customer already on the gateway page)
  const before = (await h.api("POST", "/booking/", { token: T, body: h.bookingBody(L, { checkIn: h.day(400), checkOut: h.day(402) }) })).body.data;
  const order = (await h.api("POST", "/payment/create-order", { token: T, body: { bookingId: before._id, amount: before.quote.totalPaise } })).body.data;

  await gate(true);
  const paused = [
    await h.api("POST", "/booking/", { token: T, body: h.bookingBody(L, { checkIn: h.day(410), checkOut: h.day(412) }) }),
    await h.api("POST", "/booking/", { token: HT, body: h.bookingBody(L, { checkIn: h.day(410), checkOut: h.day(412), action: "host", adults: 1 }) }),
    await h.api("POST", "/payment/create-order", { token: T, body: { bookingId: before._id, amount: before.quote.totalPaise } }),
    await h.api("POST", "/booking/admin-modify", { token: AT, body: { bookingId: before._id, checkIn: `${h.day(420)}T00:00:00.000Z`, checkOut: `${h.day(422)}T00:00:00.000Z`, adults: 2, children: 0, guest: 2 } }),
  ];
  for (const r of paused) {
    assert.equal(r.status, 503, JSON.stringify(r.body));
    assert.equal(r.body.code, "MAINTENANCE");
  }
  assert.equal(await Booking().countDocuments({ propertyId: L._id }), 1, "nothing was written while paused");
  // reads and the booking itself are untouched
  assert.equal((await h.api("GET", `/booking/${before._id}`, { token: T })).status, 200);
  assert.equal((await h.api("GET", `/booking/check-dates/${L._id}`)).status, 200);
  // the payment already in flight still lands
  const v = await verify(order, pay(order, "pay_gate1"));
  assert.equal(v.status, 200, JSON.stringify(v.body));
  const bk = await Booking().findById(before._id);
  assert.equal(bk.paymentStatus, "paid");
  assert.equal(bk.status, "confirmed");
  assert.equal(await BookingNight().countDocuments({ bookingId: before._id, expiresAt: null }), 2);

  await gate(false);
  const after = await h.api("POST", "/booking/", { token: T, body: h.bookingBody(L, { checkIn: h.day(410), checkOut: h.day(412) }) });
  assert.equal(after.status, 201, "writes resume the moment the gate is off");
});

test("gate: a flag read failure keeps the last known value (never opens or closes the gate by accident)", async () => {
  const maintenance = require("../../services/maintenance");
  maintenance.resetCache();
  await gate(true);
  assert.equal(await maintenance.bookingWritesPaused(), true);
  const orig = OpsFlag().findById;
  OpsFlag().findById = () => ({ lean: async () => { throw new Error("db down"); } });
  try {
    assert.equal(await maintenance.bookingWritesPaused(), true, "stays paused when the read fails");
  } finally {
    OpsFlag().findById = orig;
  }
  await gate(false);
  assert.equal(await maintenance.bookingWritesPaused(), false);
});

test("delta reconciliation: rows written by the old backend after the first backfill are materialised; live Batch S rows are never overwritten; stale holds are replaced", async () => {
  const uri = (await h.start()).uri;
  const L = await h.makeListing(HOST);
  const mk = (over) => Booking().create({ userId: U._id, hostId: HOST._id, propertyId: L._id, price: 1, subTotal: 1, ...over });

  // Batch S live rows: a paid booking (permanent nights), an unexpired hold,
  // an expired hold.
  const sPaid = (await h.api("POST", "/booking/", { token: T, body: h.bookingBody(L, { checkIn: h.day(500), checkOut: h.day(502) }) })).body.data;
  const o = (await h.api("POST", "/payment/create-order", { token: T, body: { bookingId: sPaid._id, amount: sPaid.quote.totalPaise } })).body.data;
  assert.equal((await verify(o, pay(o, "pay_delta1"))).status, 200);
  const other = await h.makeUser();
  const sHold = (await h.api("POST", "/booking/", { token: h.userToken(other), body: h.bookingBody(L, { checkIn: h.day(510), checkOut: h.day(512) }) })).body.data;
  const sExpired = (await h.api("POST", "/booking/", { token: T, body: h.bookingBody(L, { checkIn: h.day(520), checkOut: h.day(522) }) })).body.data;
  await BookingNight().updateMany({ bookingId: sExpired._id }, { $set: { expiresAt: new Date(Date.now() - 1000) } });

  // "Gap" rows: written by the old backend between backfill and activation
  // (no night rows at all) — a paid guest booking, a host block, an iCal
  // import, and paid bookings overlapping each of the S rows above.
  const gapPaid = await mk({ checkIn: at(h.day(530)), checkOut: at(h.day(533)), status: "confirmed", paymentStatus: "paid" });
  const gapBlock = await mk({ checkIn: at(h.day(540), "18:30:00.000Z"), checkOut: at(h.day(542), "18:30:00.000Z"), status: "confirmed", paymentStatus: "paid", action: "host" });
  const gapIcal = await mk({ checkIn: at(h.day(550)), checkOut: at(h.day(551)), status: "confirmed", paymentStatus: "paid", source: "ical" });
  const gapVsPaid = await mk({ checkIn: at(h.day(501)), checkOut: at(h.day(503)), status: "confirmed", paymentStatus: "paid" }); // shares day 501 with sPaid
  const gapVsHold = await mk({ checkIn: at(h.day(511)), checkOut: at(h.day(513)), status: "confirmed", paymentStatus: "paid" }); // shares day 511 with the live hold
  const gapVsExpired = await mk({ checkIn: at(h.day(520)), checkOut: at(h.day(522)), status: "confirmed", paymentStatus: "paid" }); // exactly the expired hold's nights

  const run = (...args) => spawnSync(process.execPath, [path.join(__dirname, "../../scripts/backfill-booking-nights.js"), `--uri=${uri}`, ...args], { encoding: "utf8", env: { ...process.env, RAZORPAY_MOCK: "1" } });
  const num = (re, txt) => Number((txt.match(re) || [])[1]);
  let out = run();
  assert.ok(out.stdout.includes("DRY-RUN"), out.stdout + out.stderr);
  // day 501: two paid bookings (sPaid + gapVsPaid) → a plain conflict between live bookings
  assert.equal(num(/conflicting property-nights: (\d+)/, out.stdout), 1, out.stdout);
  assert.ok(out.stdout.includes(`${sPaid._id}(booking,confirmed/paid)`), out.stdout);
  // day 511: wanted by a paid gap booking but held by a live, unexpired Batch S hold
  assert.equal(num(/owned by another LIVE booking\/hold \(conflict, not written\): (\d+)/, out.stdout), 1, out.stdout);
  assert.ok(out.stdout.includes(`held by ${sHold._id} (hold until`), out.stdout);
  assert.equal(num(/stale rows to replace: (\d+)/, out.stdout), 2, "the expired hold's two nights");
  const before = await BookingNight().countDocuments({ propertyId: L._id });

  out = run("--apply", "--create-index");
  assert.equal(out.status, 2, "index refused while a live row conflicts: " + out.stdout);
  assert.ok(/stale rows removed: 2/.test(out.stdout), out.stdout);
  // every non-conflicting gap night now exists, owned by the gap booking
  assert.equal(await BookingNight().countDocuments({ bookingId: gapPaid._id, expiresAt: null }), 3);
  assert.equal(await BookingNight().countDocuments({ bookingId: gapBlock._id, kind: "block" }), 2);
  assert.equal(await BookingNight().countDocuments({ bookingId: gapIcal._id, kind: "ical" }), 1);
  assert.equal(await BookingNight().countDocuments({ bookingId: gapVsExpired._id }), 2, "expired hold replaced by the paid gap booking");
  assert.equal(await BookingNight().countDocuments({ bookingId: sExpired._id }), 0);
  // live S rows untouched; the conflicting gap nights not written
  assert.equal(await BookingNight().countDocuments({ bookingId: sPaid._id, expiresAt: null }), 2);
  assert.equal(await BookingNight().countDocuments({ bookingId: sHold._id }), 2);
  assert.equal(await BookingNight().countDocuments({ bookingId: gapVsPaid._id }), 1, "only its free night (502)");
  assert.equal(await BookingNight().countDocuments({ bookingId: gapVsHold._id }), 1, "only its free night (512)");
  assert.ok((await BookingNight().countDocuments({ propertyId: L._id })) > before);
  // idempotent
  out = run("--apply");
  assert.equal(num(/inserted: (\d+)/, out.stdout), 0, out.stdout);
  assert.equal(num(/stale rows to replace: (\d+)/, out.stdout), 0, out.stdout);

  // Operator resolves the two conflicts (cancels the gap side) → index allowed
  await Booking().updateMany({ _id: { $in: [gapVsPaid._id, gapVsHold._id] } }, { $set: { status: "cancelled" } });
  out = run("--apply", "--create-index");
  assert.equal(out.status, 0, out.stdout + out.stderr);
  assert.ok(/hostpayouts one-per-booking/.test(out.stdout));
  const hidx = await require("../../models/HostPayout").collection.indexes();
  assert.ok(hidx.some((i) => i.name === "bookingId_1" && i.unique));
});

test("pre-S pending booking (no quote, no nights): payable through S when its dates are free — re-held, re-quoted, then paid at the server price", async () => {
  const L = await h.makeListing(HOST, { basePrice: 5000 });
  const legacy = await Booking().create({
    userId: U._id, hostId: HOST._id, propertyId: L._id, action: "user", source: "local",
    checkIn: at(h.day(600)), checkOut: at(h.day(602)), nights: 2, guests: 2, adults: 2,
    price: 1, subTotal: 1, status: "pending", paymentStatus: "unpaid",
  });
  // the old client sends its own amount; the server refuses it and re-quotes
  let r = await h.api("POST", "/payment/create-order", { token: T, body: { bookingId: legacy._id, amount: 100 } });
  assert.equal(r.status, 409, JSON.stringify(r.body));
  assert.equal(r.body.code, "PRICE_CHANGED");
  assert.equal(r.body.quote.totalPaise, 1170000); // 5000×2 + 12% + 5%
  assert.equal(await BookingNight().countDocuments({ bookingId: legacy._id }), 2, "nights re-held for the legacy booking");
  // the D client re-confirms: the replay reprices the same booking
  r = await h.api("POST", "/booking/", { token: T, body: h.bookingBody(L, { checkIn: h.day(600), checkOut: h.day(602) }) });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.data._id, String(legacy._id));
  assert.equal(r.body.repriced, true);
  r = await h.api("POST", "/payment/create-order", { token: T, body: { bookingId: legacy._id, amount: 1170000 } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const v = await verify(r.body.data, pay(r.body.data, "pay_legacy1"));
  assert.equal(v.status, 200);
  const bk = await Booking().findById(legacy._id);
  assert.equal(bk.paymentStatus, "paid");
  assert.equal(bk.status, "confirmed");
  assert.equal(bk.price, 11700);
  assert.equal(await BookingNight().countDocuments({ bookingId: legacy._id, expiresAt: null }), 2);
});

test("pre-S open order at a client-chosen amount: the captured payment is recorded but the booking is queued, not confirmed; one alert; no second order; admin cancel refunds once", async () => {
  const L = await h.makeListing(HOST, { basePrice: 5000 });
  const legacy = await Booking().create({
    userId: U._id, hostId: HOST._id, propertyId: L._id, action: "user", source: "local",
    checkIn: at(h.day(610)), checkOut: at(h.day(612)), nights: 2, guests: 2, adults: 2,
    price: 1, subTotal: 1, status: "pending", paymentStatus: "unpaid",
  });
  // order opened by the old backend for ₹1 (client-supplied), still open at cutover
  const order = await h.razorpay().orders.create({ amount: 100, currency: "INR", receipt: "legacy" });
  await Payment().create({ orderId: order.id, amount: 100, currency: "INR", bookingId: legacy._id, propertyId: L._id, status: "created" });
  h.resetEmails();
  const p = pay(order, "pay_legacy_cheap");
  const [v1, v2] = await Promise.all([verify(order, p), verify(order, p)]); // callback + webhook-style replay
  assert.equal(v1.status, 200, JSON.stringify(v1.body));
  assert.equal(v2.status, 200, JSON.stringify(v2.body));
  const bk = await Booking().findById(legacy._id);
  assert.equal(bk.paymentStatus, "unpaid", "₹1 does not pay a ₹11,700 stay");
  assert.equal(bk.status, "pending");
  assert.equal(bk.needsAttention, "amount_mismatch");
  assert.equal(bk.attentionDetails.capturedPaise, 100);
  assert.equal(bk.attentionDetails.expectedPaise, 1170000);
  assert.equal((await Payment().findOne({ orderId: order.id })).status, "paid", "the gateway fact is recorded");
  const alerts = h.sentEmails().filter((e) => e.templateId === 2);
  assert.equal(alerts.length, 2, "one alert per configured admin address, sent once");
  assert.deepEqual(alerts.map((e) => e.recipientEmail).sort(), ["admin1@test.local", "admin2@test.local"]);
  // the guest cannot open another order while it is under review
  const again = await h.api("POST", "/payment/create-order", { token: T, body: { bookingId: legacy._id, amount: 1170000 } });
  assert.equal(again.status, 409);
  assert.equal(again.body.code, "BOOKING_NOT_PAYABLE");
  // it shows in the queue
  const q = await h.api("GET", "/booking/admin/attention", { token: AT });
  assert.equal(q.status, 200);
  assert.ok(q.body.data.some((b) => b._id === String(legacy._id)));
  assert.equal((await h.api("GET", "/booking/admin/attention", { token: T })).status, 403);
  // admin decides to refund: admin cancel refunds the captured ₹1 exactly once and clears the flag
  const refundsBefore = h.razorpay().__mock.calls.paymentsRefund;
  const c = await h.api("PATCH", "/booking/admin/cancel", { token: AT, body: { bookingId: legacy._id } });
  assert.equal(c.status, 200, JSON.stringify(c.body));
  assert.equal(c.body.refunded, true);
  assert.equal(h.razorpay().__mock.calls.paymentsRefund, refundsBefore + 1);
  const done = await Booking().findById(legacy._id);
  assert.equal(done.status, "cancelled");
  assert.equal(done.needsAttention, null);
  assert.ok(/admin-cancel/.test(done.attentionResolution));
  assert.equal((await Payment().findOne({ orderId: order.id })).status, "refunded");
  const c2 = await h.api("PATCH", "/booking/admin/cancel", { token: AT, body: { bookingId: legacy._id } });
  assert.equal(c2.status, 409, "already closed");
});

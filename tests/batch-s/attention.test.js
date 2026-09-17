// Batch S.1 — the operational attention queue: a paid booking that lost its
// nights is flagged once, alerted once (whatever the number of callback /
// webhook deliveries), visible to admins, and resolved by a human.
const test = require("node:test");
const assert = require("node:assert/strict");
const h = require("./setup");

let U, T, HOST, HT, ADMIN, AT;
const Booking = () => require("../../models/Booking");
const BookingNight = () => require("../../models/BookingNight");

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

let base = 800;
let seq = 0;
// A booking whose hold expired and whose nights another guest took before
// its payment completed. Returns everything needed to deliver the payment.
async function conflictSetup(listingOverrides = {}) {
  const L = await h.makeListing(HOST, listingOverrides);
  base += 10;
  const body = h.bookingBody(L, { checkIn: h.day(base), checkOut: h.day(base + 2) });
  const b = (await h.api("POST", "/booking/", { token: T, body })).body.data;
  const order = (await h.api("POST", "/payment/create-order", { token: T, body: { bookingId: b._id, amount: b.quote.totalPaise } })).body.data;
  await BookingNight().updateMany({ bookingId: b._id }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
  const other = await h.makeUser();
  const o = await h.api("POST", "/booking/", { token: h.userToken(other), body });
  assert.equal(o.status, 201);
  const p = h.razorpay().__registerPayment({ id: `pay_att${++seq}`, order_id: order.id, amount: order.amount, currency: "INR", status: "captured", method: "upi" });
  return { L, b, order, p, other: o.body.data };
}
const webhook = (order, p) =>
  h.api("POST", "/paymentforpayout/payout/update", {
    headers: { "x-razorpay-signature": require("crypto").createHmac("sha256", process.env.RAZORPAY_WEBHOOK_KEY).update(JSON.stringify({ event: "payment.captured", payload: { payment: { entity: p } } })).digest("hex") },
    body: { event: "payment.captured", payload: { payment: { entity: p } } },
  });
const verify = (order, p) =>
  h.api("POST", "/payment/verify-payment", { token: T, body: { razorpay_order_id: order.id, razorpay_payment_id: p.id, razorpay_signature: h.signature(order.id, p.id) } });
const alerts = () => h.sentEmails().filter((e) => e.templateId === 2);

test("payment success + inventory conflict: callback ×2 and webhook ×2 racing → one flag, one alert per admin, queue entry visible to admins only", async () => {
  const { b, order, p } = await conflictSetup();
  h.resetEmails();
  const results = await Promise.all([verify(order, p), webhook(order, p), verify(order, p), webhook(order, p)]);
  for (const r of results) assert.equal(r.status, 200, JSON.stringify(r.body));
  const bk = await Booking().findById(b._id);
  assert.equal(bk.paymentStatus, "paid");
  assert.equal(bk.status, "pending");
  assert.equal(bk.needsAttention, "inventory_conflict");
  assert.ok(bk.notifications.attentionAt);
  assert.equal(alerts().length, 2, "one alert per configured admin address, once");
  // whichever delivery won tells its caller; a loser that read the booking a
  // moment earlier may not — the client also learns it from updateStatus (409 UNDER_REVIEW)
  const again = await verify(order, p); // the client's retry / the summary page reload
  assert.equal(again.body.alreadyProcessed, true);
  assert.equal(again.body.booking.needsAttention, "inventory_conflict", "the client is told the booking is under review");
  const q = await h.api("GET", "/booking/admin/attention", { token: AT });
  assert.equal(q.status, 200);
  const item = q.body.data.find((x) => x._id === String(b._id));
  assert.ok(item, "queued");
  assert.equal(item.attentionDetails.takenBy.length, 1);
  assert.equal((await h.api("GET", "/booking/admin/attention", { token: T })).status, 403);
  assert.equal((await h.api("GET", "/booking/admin/attention", { token: HT })).status, 403);
  // a later redelivery after the flag is set does not alert again
  await webhook(order, p);
  assert.equal(alerts().length, 2);
  // the post-payment client calls must not notify or confirm as if all were well
  const u = await h.api("POST", "/booking/updateStatus", { token: T, body: { bookingId: b._id } });
  assert.equal(u.status, 409);
  assert.equal(u.body.code, "UNDER_REVIEW");
  assert.equal(h.sentEmails().length, 2, "no paid-notifications either");
  const ic = await h.api("PATCH", "/booking/instant/confirm", { token: T, body: { bookingId: b._id } });
  assert.equal(ic.status, 409);
  assert.equal(ic.body.code, "UNDER_REVIEW");
  // the host cannot approve it either
  const hc = await h.api("PATCH", "/booking/host/confirm", { token: HT, body: { bookingId: b._id } });
  assert.equal(hc.status, 409);
  assert.equal(hc.body.code, "UNDER_REVIEW");
  const bk2 = await Booking().findById(b._id);
  assert.equal(bk2.status, "pending");
  assert.equal(bk2.needsAttention, "inventory_conflict");
});

test("alert e-mail failure keeps the queue entry and retries the alert on the next delivery, still exactly once overall", async () => {
  const { b, order, p } = await conflictSetup();
  h.resetEmails();
  const emailMod = require("../../utils/sendEmail");
  const orig = emailMod.sendHostNotification;
  let calls = 0;
  emailMod.sendHostNotification = async () => { calls += 1; throw new Error("brevo down"); };
  try {
    assert.equal((await verify(order, p)).status, 200);
  } finally {
    emailMod.sendHostNotification = orig;
  }
  assert.ok(calls >= 1);
  let bk = await Booking().findById(b._id);
  assert.equal(bk.needsAttention, "inventory_conflict", "queued even though the mail failed");
  assert.equal(bk.notifications.attentionAt, null, "claim released for a retry");
  // the webhook redelivery retries the alert once
  await webhook(order, p);
  assert.equal(alerts().length, 2);
  bk = await Booking().findById(b._id);
  assert.ok(bk.notifications.attentionAt);
  await webhook(order, p);
  assert.equal(alerts().length, 2, "no duplicates after success");
});

test("resolution: keep is refused while the nights are taken, succeeds once they are free (re-secured, confirmed); dismiss only clears; guest cannot resolve", async () => {
  const { b, order, p, other } = await conflictSetup();
  assert.equal((await verify(order, p)).status, 200);
  const keep = () => h.api("PATCH", "/booking/admin/attention/resolve", { token: AT, body: { bookingId: b._id, resolution: "keep" } });
  let r = await keep();
  assert.equal(r.status, 409, JSON.stringify(r.body));
  assert.equal(r.body.code, "DATES_UNAVAILABLE");
  assert.equal((await Booking().findById(b._id)).needsAttention, "inventory_conflict", "still queued");
  // admin frees the other side (its guest cancels) and keeps ours
  const otherUser = await require("../../models/User").findById(other.userId);
  const cancelOther = await h.api("PATCH", "/booking/user/terminate", { token: h.userToken(otherUser), body: { bookingId: other._id } });
  assert.equal(cancelOther.status, 200);
  h.resetEmails();
  r = await keep();
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const bk = await Booking().findById(b._id);
  assert.equal(bk.needsAttention, null);
  assert.equal(bk.status, "confirmed");
  assert.equal(bk.paymentStatus, "paid");
  assert.equal(await BookingNight().countDocuments({ bookingId: b._id, expiresAt: null }), 2);
  assert.ok(/keep by/.test(bk.attentionResolution));
  assert.deepEqual(h.sentEmails().map((e) => e.templateId).sort((x, y) => x - y), [34, 35, 36, 36], "the post-payment e-mails go out now, once");
  assert.equal((await h.api("POST", "/booking/updateStatus", { token: T, body: { bookingId: b._id } })).body.alreadyNotified, true);
  // a second resolve is a no-op
  r = await keep();
  assert.equal(r.status, 200);
  assert.equal(r.body.alreadyClear, true);
  // validation and authorization
  const bad = await h.api("PATCH", "/booking/admin/attention/resolve", { token: AT, body: { bookingId: b._id, resolution: "refund" } });
  assert.equal(bad.status, 400);
  assert.equal((await h.api("PATCH", "/booking/admin/attention/resolve", { token: T, body: { bookingId: b._id, resolution: "dismiss" } })).status, 403);

  // dismiss path on a fresh conflict
  const s2 = await conflictSetup();
  await verify(s2.order, s2.p);
  const d = await h.api("PATCH", "/booking/admin/attention/resolve", { token: AT, body: { bookingId: s2.b._id, resolution: "dismiss" } });
  assert.equal(d.status, 200);
  const bk2 = await Booking().findById(s2.b._id);
  assert.equal(bk2.needsAttention, null);
  assert.equal(bk2.status, "pending", "dismiss changes nothing else");
  assert.equal(await BookingNight().countDocuments({ bookingId: s2.b._id }), 0);
});

test("no automatic refund or rebooking: a flagged booking's money stays captured until an admin acts; admin cancel then refunds once", async () => {
  const { b, order, p } = await conflictSetup();
  const refundsBefore = h.razorpay().__mock.calls.paymentsRefund;
  await verify(order, p);
  await webhook(order, p);
  assert.equal(h.razorpay().__mock.calls.paymentsRefund, refundsBefore, "nothing refunded automatically");
  const c = await h.api("PATCH", "/booking/admin/cancel", { token: AT, body: { bookingId: b._id } });
  assert.equal(c.status, 200);
  assert.equal(c.body.refunded, true);
  assert.equal(h.razorpay().__mock.calls.paymentsRefund, refundsBefore + 1);
  const bk = await Booking().findById(b._id);
  assert.equal(bk.status, "cancelled");
  assert.equal(bk.paymentStatus, "refunded");
  assert.equal(bk.needsAttention, null);
});

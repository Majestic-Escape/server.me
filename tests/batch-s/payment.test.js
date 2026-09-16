const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const h = require("./setup");

let U, T, HOST, HT, ADMIN, AT;
const Booking = () => require("../../models/Booking");
const Payment = () => require("../../models/Payment");
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

let dayBase = 100;
async function freshBooking({ listingOverrides = {}, nights = 2, token = T } = {}) {
  const L = await h.makeListing(HOST, listingOverrides);
  dayBase += 10;
  const r = await h.api("POST", "/booking/", { token, body: h.bookingBody(L, { checkIn: h.day(dayBase), checkOut: h.day(dayBase + nights) }) });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return { listing: L, booking: r.body.data };
}
async function createOrder(booking, { token = T, amount = booking.quote.totalPaise, currency = "INR" } = {}) {
  return h.api("POST", "/payment/create-order", { token, body: { bookingId: booking._id, userId: String(U._id), currency, amount, propertyId: booking.propertyId } });
}
let paySeq = 0;
function fakePayment(order, over = {}) {
  paySeq += 1;
  return h.razorpay().__registerPayment({ id: `pay_mock${paySeq}`, order_id: order.id, amount: order.amount, currency: "INR", status: "captured", method: "upi", ...over });
}
async function verify(order, payment, { token = T, signature } = {}) {
  return h.api("POST", "/payment/verify-payment", {
    token,
    body: { razorpay_order_id: order.id, razorpay_payment_id: payment.id, razorpay_signature: signature ?? h.signature(order.id, payment.id), paymentMethod: "upi" },
  });
}

test("order amount is the server quote; client amount tampering is refused; ₹1 cannot pay", async () => {
  const { booking } = await freshBooking();
  assert.equal(booking.quote.totalPaise, 2340000); // 9000×2 = 18000 + 2160 + 3240
  for (const amount of [100, 1, 2339999, "1"]) {
    const r = await createOrder(booking, { amount });
    assert.equal(r.status, 409, JSON.stringify(r.body));
    assert.equal(r.body.code, "AMOUNT_MISMATCH");
    assert.equal(r.body.expectedAmount, 2340000);
  }
  const wrongCur = await createOrder(booking, { currency: "USD" });
  assert.equal(wrongCur.status, 400);
  const ok = await createOrder(booking);
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.data.amount, 2340000);
  assert.equal(ok.body.data.currency, "INR");
  assert.equal(h.razorpay().__mock.orders.get(ok.body.data.id).amount, 2340000, "Razorpay was asked for exactly the quote");
  // no amount at all (a client that trusts the server) also works
  const noAmt = await h.api("POST", "/payment/create-order", { token: T, body: { bookingId: booking._id } });
  assert.equal(noAmt.status, 200);
  assert.equal(noAmt.body.data.id, ok.body.data.id, "same open order reused");
});

test("one open order per booking: retries and 10 concurrent create-order calls yield one Razorpay order", async () => {
  const { booking } = await freshBooking();
  const before = h.razorpay().__mock.calls.ordersCreate;
  const results = await Promise.all(Array.from({ length: 10 }, () => createOrder(booking)));
  const ids = new Set(results.filter((r) => r.status === 200).map((r) => r.body.data.id));
  assert.equal(results.filter((r) => r.status === 200).length, 10, JSON.stringify(results.map((r) => [r.status, r.body.code])));
  assert.equal(ids.size, 1);
  assert.equal(h.razorpay().__mock.calls.ordersCreate - before, 1, "exactly one gateway order created");
  assert.equal(await Payment().countDocuments({ bookingId: booking._id }), 1);
});

test("verify: signature, order/payment relationship, amount, currency and status are all checked; fail closed", async () => {
  const { booking } = await freshBooking();
  const order = (await createOrder(booking)).body.data;
  const good = fakePayment(order);
  // wrong signature
  let r = await verify(order, good, { signature: "deadbeef" });
  assert.equal(r.status, 400);
  assert.equal(r.body.code, "INVALID_SIGNATURE");
  // signature computed with another secret
  r = await verify(order, good, { signature: h.signature(order.id, good.id, "other") });
  assert.equal(r.status, 400);
  // valid signature but the gateway says the payment is for another order
  const otherOrder = { id: "order_mockOTHER", amount: order.amount };
  const p2 = fakePayment(otherOrder);
  r = await verify(order, p2);
  assert.equal(r.status, 400, JSON.stringify(r.body));
  assert.equal(r.body.code, "PAYMENT_MISMATCH");
  // right order, wrong amount at the gateway (₹1 paid)
  const p3 = fakePayment(order, { amount: 100 });
  r = await verify(order, p3);
  assert.equal(r.status, 400);
  assert.equal(r.body.code, "PAYMENT_MISMATCH");
  // wrong currency
  const p4 = fakePayment(order, { currency: "USD" });
  r = await verify(order, p4);
  assert.equal(r.status, 400);
  // failed / unknown status
  const p5 = fakePayment(order, { status: "failed" });
  r = await verify(order, p5);
  assert.equal(r.status, 400);
  // unknown payment id
  r = await h.api("POST", "/payment/verify-payment", { token: T, body: { razorpay_order_id: order.id, razorpay_payment_id: "pay_nope", razorpay_signature: h.signature(order.id, "pay_nope") } });
  assert.ok([400, 404, 500].includes(r.status));
  // nothing changed
  const b = await Booking().findById(booking._id);
  assert.equal(b.paymentStatus, "unpaid");
  assert.equal(b.status, "pending");
  const pay = await Payment().findOne({ orderId: order.id });
  assert.equal(pay.status, "created", "a bad signature must not flip the order state");
  // the genuine payment still works afterwards
  r = await verify(order, good);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const paid = await Booking().findById(booking._id);
  assert.equal(paid.paymentStatus, "paid");
  assert.equal(paid.status, "confirmed", "instant-book listing confirms at payment");
  const nights = await BookingNight().find({ bookingId: booking._id }).lean();
  assert.ok(nights.every((n) => n.expiresAt === null), "nights are permanent after payment");
});

test("verification is idempotent: replay, concurrent replay, and callback+webhook race apply once", async () => {
  const { booking } = await freshBooking();
  const order = (await createOrder(booking)).body.data;
  const payment = fakePayment(order);
  const webhookBody = JSON.stringify({ event: "payment.captured", payload: { payment: { entity: payment } } });
  const sig = crypto.createHmac("sha256", process.env.RAZORPAY_WEBHOOK_KEY).update(webhookBody).digest("hex");
  const base = (await h.start()).baseUrl;
  const sendWebhook = () => fetch(`${base}/paymentforpayout/payout/update`, { method: "POST", headers: { "content-type": "application/json", "x-razorpay-signature": sig }, body: webhookBody });
  const results = await Promise.all([verify(order, payment), verify(order, payment), sendWebhook(), verify(order, payment), sendWebhook()]);
  assert.ok(results.slice(0, 2).every((r) => r.status === 200), JSON.stringify(results.slice(0, 2).map((r) => r.body)));
  await h.sleep(500);
  const pay = await Payment().findOne({ orderId: order.id });
  assert.equal(pay.status, "paid");
  assert.equal(pay.paymentId, payment.id);
  assert.equal(await Payment().countDocuments({ bookingId: booking._id }), 1);
  const b = await Booking().findById(booking._id);
  assert.equal(b.paymentStatus, "paid");
  // a *different* payment for the same (already paid) order is refused
  const p2 = fakePayment(order);
  const r = await verify(order, p2);
  assert.equal(r.status, 409);
  assert.equal(r.body.code, "PAYMENT_STATE");
  // the legacy post-payment notification call sends emails exactly once
  h.resetEmails();
  const n1 = await h.api("POST", "/booking/updateStatus", { token: T, body: { bookingId: booking._id, userId: String(U._id), manual: false, payment: pay._id } });
  const n2 = await h.api("POST", "/booking/updateStatus", { token: T, body: { bookingId: booking._id, userId: String(U._id), manual: false, payment: pay._id } });
  assert.equal(n1.status, 200, JSON.stringify(n1.body));
  assert.equal(n2.status, 200);
  assert.equal(n2.body.alreadyNotified, true);
  const sent = h.sentEmails();
  assert.equal(sent.length, 4, JSON.stringify(sent)); // host 34, user 35, 2 admins 36
  assert.deepEqual(sent.map((e) => e.templateId).sort(), [34, 35, 36, 36]);
  // forged webhook signature is rejected and changes nothing
  const forged = await fetch(`${base}/paymentforpayout/payout/update`, { method: "POST", headers: { "content-type": "application/json", "x-razorpay-signature": "bad" }, body: webhookBody });
  assert.equal(forged.status, 400);
});

test("webhook alone (client never called verify) records the payment; manual listing stays pending", async () => {
  const { booking } = await freshBooking({ listingOverrides: { bookingType: { manual: true } } });
  const order = (await createOrder(booking)).body.data;
  const payment = fakePayment(order);
  const body = JSON.stringify({ event: "order.paid", payload: { payment: { entity: payment }, order: { entity: { id: order.id } } } });
  const sig = crypto.createHmac("sha256", process.env.RAZORPAY_WEBHOOK_KEY).update(body).digest("hex");
  const base = (await h.start()).baseUrl;
  const res = await fetch(`${base}/paymentforpayout/payout/update`, { method: "POST", headers: { "content-type": "application/json", "x-razorpay-signature": sig }, body });
  assert.equal(res.status, 200);
  await h.sleep(600);
  const b = await Booking().findById(booking._id);
  assert.equal(b.paymentStatus, "paid");
  assert.equal(b.status, "pending", "manual listings wait for host approval");
  // client cannot self-confirm a manual booking via the legacy instant route
  const ic = await h.api("PATCH", "/booking/instant/confirm", { token: T, body: { bookingId: booking._id, propertyTitle: "x" } });
  assert.equal(ic.status, 409);
  // host confirms → confirmed; stranger host cannot; second confirm is a no-op
  const stranger = await h.makeUser({ role: "host" });
  const s = await h.api("PATCH", "/booking/host/confirm", { token: h.userToken(stranger), body: { bookingId: booking._id } });
  assert.equal(s.status, 403);
  const c = await h.api("PATCH", "/booking/host/confirm", { token: HT, body: { bookingId: booking._id } });
  assert.equal(c.status, 200, JSON.stringify(c.body));
  const c2 = await h.api("PATCH", "/booking/host/confirm", { token: HT, body: { bookingId: booking._id } });
  assert.equal(c2.status, 200);
  assert.equal(c2.body.alreadyConfirmed, true);
  assert.equal((await Booking().findById(booking._id)).status, "confirmed");
});

test("unpaid bookings cannot be confirmed or marked paid by the client", async () => {
  const { booking } = await freshBooking();
  let r = await h.api("POST", "/booking/updateStatus", { token: T, body: { bookingId: booking._id, userId: String(U._id), manual: false, payment: "000000000000000000000000" } });
  assert.equal(r.status, 409);
  assert.equal(r.body.code, "PAYMENT_NOT_RECORDED");
  r = await h.api("PATCH", "/booking/instant/confirm", { token: T, body: { bookingId: booking._id } });
  assert.equal(r.status, 409);
  r = await h.api("PATCH", "/booking/host/confirm", { token: HT, body: { bookingId: booking._id } });
  assert.equal(r.status, 409);
  r = await h.api("PUT", `/booking/${booking._id}`, { token: T, body: { paymentStatus: "paid", status: "confirmed", price: 1 } });
  assert.equal(r.status, 403);
  r = await h.api("PUT", `/booking/${booking._id}`, { token: AT, body: { paymentStatus: "paid", status: "confirmed", price: 1, adults: 3 } });
  assert.equal(r.status, 200);
  const b = await Booking().findById(booking._id);
  assert.equal(b.paymentStatus, "unpaid");
  assert.equal(b.status, "pending");
  assert.equal(b.price, 23400);
  assert.equal(b.adults, 3, "whitelisted field applied");
});

test("price change between booking and Pay → PRICE_CHANGED with the fresh quote; inactive listing → refused", async () => {
  const { listing, booking } = await freshBooking();
  await require("../../models/ListingProperty").updateOne({ _id: listing._id }, { $set: { basePrice: 10000 } });
  let r = await createOrder(booking);
  assert.equal(r.status, 409, JSON.stringify(r.body));
  assert.equal(r.body.code, "PRICE_CHANGED");
  assert.equal(r.body.quote.totalPaise, 2600000); // 10000×2 = 20000 + 2400 + 3600
  assert.equal(r.body.confirmedTotalPaise, 2340000);
  assert.equal(await Payment().countDocuments({ bookingId: booking._id }), 0, "no order created");
  // customer reconfirms by creating a fresh booking (client re-quotes); the old one is never repriced
  assert.equal((await Booking().findById(booking._id)).quote.totalPaise, 2340000);
  await require("../../models/ListingProperty").updateOne({ _id: listing._id }, { $set: { basePrice: 9000, status: "inactive" } });
  r = await createOrder(booking);
  assert.equal(r.status, 409);
  assert.equal(r.body.code, "LISTING_INACTIVE");
});

test("only the booking's guest can create/verify; banned users are blocked; anonymous refused", async () => {
  const { booking } = await freshBooking();
  const other = await h.makeUser();
  let r = await createOrder(booking, { token: h.userToken(other) });
  assert.equal(r.status, 403);
  r = await createOrder(booking, { token: HT });
  assert.equal(r.status, 403);
  r = await createOrder(booking, { token: AT });
  assert.equal(r.status, 403);
  r = await h.api("POST", "/payment/create-order", { body: { bookingId: booking._id, amount: 2340000 } });
  assert.equal(r.status, 401);
  const order = (await createOrder(booking)).body.data;
  const payment = fakePayment(order);
  r = await verify(order, payment, { token: h.userToken(other) });
  assert.equal(r.status, 403);
  // banned
  await require("../../models/User").updateOne({ _id: other._id }, { $set: { "status.banned": true } });
  r = await createOrder(booking, { token: h.userToken(other) });
  assert.equal(r.status, 403);
  assert.equal(r.body.code, "USER_BANNED");
  // expired / malformed tokens
  const expired = require("jsonwebtoken").sign({ userId: String(U._id), admin: 0, tokenVersion: 0 }, process.env.JWT_SECRET, { expiresIn: -10 });
  r = await createOrder(booking, { token: expired });
  assert.equal(r.status, 401);
  r = await createOrder(booking, { token: "not.a.jwt" });
  assert.equal(r.status, 403);
});

test("gateway failure on order creation leaves no open order; a retry succeeds", async () => {
  const { booking } = await freshBooking();
  h.razorpay().__mock.fail.ordersCreate = true;
  let r = await createOrder(booking);
  assert.equal(r.status, 502);
  assert.equal(await Payment().countDocuments({ bookingId: booking._id }), 0);
  h.razorpay().__mock.fail.ordersCreate = false;
  r = await createOrder(booking);
  assert.equal(r.status, 200);
});

test("refund: authorized, once, and never marked refunded when the gateway fails", async () => {
  const { booking } = await freshBooking({ listingOverrides: { cancellationType: { flexible: true, moderate: false } } });
  const order = (await createOrder(booking)).body.data;
  await verify(order, fakePayment(order));
  // guest of another booking / a stranger host / anonymous cannot refund
  const stranger = await h.makeUser({ role: "host" });
  for (const [tok, path] of [[h.userToken(stranger), "/booking/host/cancel"], [h.userToken(stranger), "/booking/host/terminate"], [h.userToken(await h.makeUser()), "/booking/user/terminate"], [T, "/booking/admin/cancel"], [HT, "/booking/admin/cancel"]]) {
    const r = await h.api("PATCH", path, { token: tok, body: { bookingId: booking._id, userEmail: "attacker@x", hostEmail: "attacker@x" } });
    assert.equal(r.status, 403, `${path} → ${r.status}`);
  }
  assert.equal(h.razorpay().__mock.calls.paymentsRefund, 0);
  // gateway failure: nothing refunded, payment stays paid, booking untouched
  h.razorpay().__mock.fail.paymentsRefund = true;
  let r = await h.api("PATCH", "/booking/host/terminate", { token: HT, body: { bookingId: booking._id } });
  assert.equal(r.status, 502);
  assert.equal(r.body.code, "REFUND_FAILED");
  assert.equal((await Payment().findOne({ orderId: order.id })).status, "paid");
  assert.equal((await Booking().findById(booking._id)).status, "confirmed");
  h.razorpay().__mock.fail.paymentsRefund = false;
  const refundsBefore = h.razorpay().__mock.calls.paymentsRefund; // (the failed call above counted)
  // two concurrent refund attempts (host terminate + admin cancel) → one gateway refund
  h.resetEmails();
  const [a, b] = await Promise.all([
    h.api("PATCH", "/booking/host/terminate", { token: HT, body: { bookingId: booking._id } }),
    h.api("PATCH", "/booking/admin/cancel", { token: AT, body: { bookingId: booking._id } }),
  ]);
  const statuses = [a.status, b.status].sort();
  assert.ok(statuses.includes(200), JSON.stringify([a.body, b.body]));
  assert.equal(h.razorpay().__mock.calls.paymentsRefund - refundsBefore, 1, "exactly one refund at the gateway");
  const pay = await Payment().findOne({ orderId: order.id });
  assert.equal(pay.status, "refunded");
  assert.ok(pay.refundId);
  assert.equal(pay.refundAmount, 2340000);
  const bk = await Booking().findById(booking._id);
  assert.equal(bk.paymentStatus, "refunded");
  assert.ok(["cancelled", "rejected"].includes(bk.status));
  assert.equal(await BookingNight().countDocuments({ bookingId: booking._id }), 0, "nights released");
  // replaying the refund is harmless
  const again = await h.api("PATCH", "/booking/host/terminate", { token: HT, body: { bookingId: booking._id } });
  assert.equal(again.status, 409);
  assert.equal(h.razorpay().__mock.calls.paymentsRefund - refundsBefore, 1);
  // emails: recipients are the booking parties, not the attacker-supplied addresses
  assert.ok(h.sentEmails().every((e) => !e.recipientEmail.includes("attacker")));
});

test("guest cancellation outside the policy window cancels without refund; inside refunds", async () => {
  // flexible = FLEXIBLE_POLICY_DAYS hours (24h) before check-in
  const { booking } = await freshBooking({ listingOverrides: { cancellationType: { flexible: true, moderate: false } } });
  const order = (await createOrder(booking)).body.data;
  await verify(order, fakePayment(order));
  const before = h.razorpay().__mock.calls.paymentsRefund;
  let r = await h.api("PATCH", "/booking/user/terminate", { token: T, body: { bookingId: booking._id } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.refunded, true);
  assert.equal(h.razorpay().__mock.calls.paymentsRefund, before + 1);
  // strict policy: no refund, but cancellation still recorded and nights released
  const { booking: b2 } = await freshBooking({ listingOverrides: { cancellationType: { strict: true, moderate: false } } });
  const o2 = (await createOrder(b2)).body.data;
  await verify(o2, fakePayment(o2));
  r = await h.api("PATCH", "/booking/user/terminate", { token: T, body: { bookingId: b2._id } });
  assert.equal(r.status, 200);
  assert.equal(r.body.refunded, false);
  assert.equal(h.razorpay().__mock.calls.paymentsRefund, before + 1);
  assert.equal((await Booking().findById(b2._id)).status, "cancelled");
  assert.equal((await Payment().findOne({ orderId: o2.id })).status, "paid");
  assert.equal(await BookingNight().countDocuments({ bookingId: b2._id }), 0);
});

test("payment reads and the transactions list are protected", async () => {
  const { booking } = await freshBooking();
  const order = (await createOrder(booking)).body.data;
  let r = await h.api("GET", "/payment/fetch?paymentType=all");
  assert.equal(r.status, 401);
  r = await h.api("GET", "/payment/fetch?paymentType=all", { token: T });
  assert.equal(r.status, 403);
  r = await h.api("GET", "/payment/fetch?paymentType=all", { token: AT });
  assert.equal(r.status, 200);
  r = await h.api("GET", `/payment/booking?id=${booking._id}`, { token: h.userToken(await h.makeUser()) });
  assert.equal(r.status, 403);
  r = await h.api("GET", `/payment/booking?id=${booking._id}`, { token: T });
  assert.equal(r.status, 200);
  r = await h.api("GET", `/payment/booking?id=${booking._id}`, { token: HT });
  assert.equal(r.status, 200);
  r = await h.api("GET", `/payment/booking?id=abc`, { token: T });
  assert.equal(r.status, 400);
  r = await h.api("GET", `/payment/payment/${order.id}`, { token: h.userToken(await h.makeUser()) });
  assert.equal(r.status, 403);
});

test("cron requires the secret", async () => {
  let r = await h.api("GET", "/payment/schedule-cron");
  assert.equal(r.status, 401);
  r = await h.api("GET", "/payment/schedule-cron", { token: "wrong" });
  assert.equal(r.status, 401);
  r = await h.api("GET", "/payment/schedule-cron", { token: process.env.CRON_SECRET });
  assert.equal(r.status, 200, JSON.stringify(r.body));
});

test("price change → second Confirm replays the pending booking at the fresh quote and can be paid", async () => {
  const { listing, booking } = await freshBooking();
  await require("../../models/ListingProperty").updateOne({ _id: listing._id }, { $set: { basePrice: 10000 } });
  let r = await createOrder(booking);
  assert.equal(r.body.code, "PRICE_CHANGED");
  // the client re-submits the same stay (same user, same dates) after showing the new total
  const again = await h.api("POST", "/booking/", { token: T, body: h.bookingBody(listing, { checkIn: booking.checkIn.slice(0, 10), checkOut: booking.checkOut.slice(0, 10) }) });
  assert.equal(again.status, 200, JSON.stringify(again.body));
  assert.equal(again.body.data._id, booking._id, "same booking, not a second one");
  assert.equal(again.body.repriced, true);
  assert.equal(again.body.data.quote.totalPaise, 2600000);
  assert.equal(again.body.data.price, 26000);
  // paying the old figure is still refused; the fresh figure works
  r = await createOrder(again.body.data, { amount: 2340000 });
  assert.equal(r.body.code, "AMOUNT_MISMATCH");
  r = await createOrder(again.body.data, { amount: 2600000 });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.data.amount, 2600000);
});

// Batch S.1 — host payout cycle: authorization, amount source, recipient,
// exactly-once at the gateway under concurrent / repeated cycles, gateway
// rejection, ambiguous outcomes, DB failure after the payout, no payout for
// refunded / unpaid / block / iCal bookings, and the payout webhooks.
const test = require("node:test");
const assert = require("node:assert/strict");
const h = require("./setup");

let U, HOST, ADMIN, AT, BANK;
const Booking = () => require("../../models/Booking");
const HostPayout = () => require("../../models/HostPayout");
const BankDetail = () => require("../../models/BankDetail");
const { runPayoutCycle, windowFor } = require("../../services/payouts");

test.before(async () => {
  await h.start();
  U = await h.makeUser();
  HOST = await h.makeUser({ role: "host" });
  ADMIN = await h.makeAdmin();
  AT = h.adminToken(ADMIN);
  BANK = await BankDetail().create({ hostId: HOST._id, contactId: "cont_mock", fundId: "fa_mockhost", accountNumber: "123456789012", ifsc: "HDFC0000001", name: "Hosty", bankName: "HDFC" });
});
test.after(async () => h.stop());

const gw = () => h.payoutGateway();
let seq = 0;
// A confirmed, paid, local guest booking checking in today (payout window).
async function payable(over = {}) {
  const L = await h.makeListing(HOST);
  const today = new Date();
  today.setHours(12, 0, 0, 0);
  seq += 1;
  return Booking().create({
    userId: U._id, hostId: HOST._id, propertyId: L._id, action: "user", source: "local",
    checkIn: today, checkOut: new Date(today.getTime() + 2 * 86_400_000), nights: 2, guests: 2, adults: 2,
    price: 11700 + seq, subTotal: 10000, status: "confirmed", paymentStatus: "paid",
    ...over,
  });
}
const rowFor = (b) => HostPayout().findOne({ bookingId: b._id }).lean();

test("cron endpoint: refused without the secret; with it runs one cycle and reports", async () => {
  assert.equal((await h.api("GET", "/payment/schedule-cron")).status, 401);
  assert.equal((await h.api("GET", "/payment/schedule-cron", { token: AT })).status, 401, "admin JWT is not the cron secret");
  const r = await h.api("GET", "/payment/schedule-cron", { headers: { authorization: `Bearer ${process.env.CRON_SECRET}` } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.success, true);
  assert.ok("successful" in r.body && "failed" in r.body && "skipped" in r.body);
});

test("amount = subTotal minus MAJESTIC_COMMISSION %, recipient = the host's fund account, reference = bookingId, exactly one gateway call across 5 concurrent cycles and later reruns", async () => {
  const b = await payable();
  gw().__mock.calls.create = 0;
  const runs = await Promise.all([1, 2, 3, 4, 5].map(() => runPayoutCycle()));
  assert.equal(gw().__mock.calls.create, 1, "one payout created at the gateway");
  assert.equal(runs.reduce((n, r) => n + r.successful, 0), 1);
  const row = await rowFor(b);
  assert.equal(row.amount, 8800, "10000 − 12 %");
  assert.ok(row.paymentId.startsWith("pout_mock"));
  assert.equal(row.status, "pending", "awaits the payout webhooks, as before");
  assert.equal(row.lockedAt, null);
  assert.equal(row.reference, String(b._id));
  const gp = gw().__mock.payouts.get(row.paymentId);
  assert.equal(gp.amount, 880000, "integer paise");
  assert.equal(gp.fund_account_id, "fa_mockhost");
  assert.equal(gp.reference_id, String(b._id));
  assert.equal(await HostPayout().countDocuments({ bookingId: b._id }), 1);
  // the next two daily runs (still inside the window) do nothing
  for (const offset of [1, 2]) {
    const r = await runPayoutCycle({ now: new Date(Date.now() + offset * 86_400_000) });
    assert.equal(r.total, 0);
  }
  assert.equal(gw().__mock.calls.create, 1);
  // payout webhooks advance the row (unchanged handlers)
  const crypto = require("crypto");
  const event = (name) => {
    const body = { event: name, payload: { payout: { entity: { id: row.paymentId, amount: 880000 } } } };
    return h.api("POST", "/paymentforpayout/payout/update", {
      headers: { "x-razorpay-signature": crypto.createHmac("sha256", process.env.RAZORPAY_WEBHOOK_KEY).update(JSON.stringify(body)).digest("hex") },
      body,
    });
  };
  assert.equal((await event("payout.initiated")).status, 200);
  assert.equal((await rowFor(b)).status, "initiated");
  assert.equal((await event("payout.processed")).status, 200);
  assert.equal((await rowFor(b)).status, "paid");
  assert.equal((await runPayoutCycle()).total, 0, "a paid row is never touched again");
});

test("selection: refunded, unpaid, pending-approval, host-block, iCal and out-of-window bookings are never paid out", async () => {
  const rows = [
    await payable({ paymentStatus: "refunded" }), // guest refunded but status still confirmed (legacy rows exist in prod)
    await payable({ paymentStatus: "unpaid" }),
    await payable({ status: "pending" }), // request-to-book awaiting the host
    await payable({ action: "host", price: 0, subTotal: 0 }),
    await payable({ source: "ical", price: 0, subTotal: 0 }),
    await payable({ status: "cancelled" }),
    await payable({ checkIn: new Date(Date.now() + 5 * 86_400_000), checkOut: new Date(Date.now() + 7 * 86_400_000) }),
  ];
  gw().__mock.calls.create = 0;
  await runPayoutCycle();
  assert.equal(gw().__mock.calls.create, 0);
  for (const b of rows) assert.equal(await rowFor(b), null, `no payout row for ${b.action}/${b.source}/${b.status}/${b.paymentStatus}`);
  // window: two days ago is in, three days ago is out
  const { from, to } = windowFor(new Date());
  assert.ok((to - from) / 86_400_000 > 2.9 && (to - from) / 86_400_000 < 3.1);
});

test("gateway rejects (4xx): recorded as failed, retried by the next cycle exactly once (after a reference lookup), never twice", async () => {
  const b = await payable();
  gw().__mock.calls.create = 0;
  gw().__mock.fail.create = "rejected";
  let r = await runPayoutCycle();
  assert.equal(r.failed, 1);
  let row = await rowFor(b);
  assert.equal(row.status, "failed");
  assert.equal(row.paymentId, undefined);
  assert.ok(/insufficient balance/.test(row.lastError));
  gw().__mock.fail.create = null;
  r = await runPayoutCycle({ now: new Date(Date.now() + 86_400_000) });
  assert.equal(r.successful, 1);
  row = await rowFor(b);
  assert.equal(row.status, "pending");
  assert.ok(row.paymentId);
  assert.equal(gw().__mock.calls.create, 2, "one refused, one accepted");
  assert.equal([...gw().__mock.payouts.values()].filter((p) => p.reference_id === String(b._id)).length, 1);
  await runPayoutCycle({ now: new Date(Date.now() + 2 * 86_400_000) });
  assert.equal(gw().__mock.calls.create, 2);
});

test("ambiguous outcome (payout created, response lost): never marked failed; the next cycle adopts the existing payout instead of creating another", async () => {
  const b = await payable();
  gw().__mock.calls.create = 0;
  gw().__mock.fail.create = "ambiguous-created";
  let r = await runPayoutCycle();
  assert.equal(r.failed, 1);
  assert.equal(r.results[0].ambiguous, true);
  let row = await rowFor(b);
  assert.equal(row.status, "pending", "not failed — we do not know");
  assert.equal(row.paymentId, undefined);
  assert.ok(/ambiguous/.test(row.lastError));
  gw().__mock.fail.create = null;
  r = await runPayoutCycle({ now: new Date(Date.now() + 86_400_000) });
  assert.equal(r.successful, 1);
  assert.equal(r.results[0].adopted, true);
  row = await rowFor(b);
  assert.ok(row.paymentId);
  assert.equal(gw().__mock.calls.create, 1, "the lost-response payout was adopted, not repeated");
  assert.equal([...gw().__mock.payouts.values()].filter((p) => p.reference_id === String(b._id)).length, 1);
});

test("ambiguous outcome (timeout, nothing created): the next cycle finds nothing at the gateway and creates the payout once", async () => {
  const b = await payable();
  gw().__mock.calls.create = 0;
  gw().__mock.fail.create = "ambiguous";
  await runPayoutCycle();
  assert.equal((await rowFor(b)).status, "pending");
  gw().__mock.fail.create = null;
  const r = await runPayoutCycle({ now: new Date(Date.now() + 86_400_000) });
  assert.equal(r.successful, 1);
  assert.equal(r.results[0].adopted, undefined);
  assert.equal(gw().__mock.calls.create, 2);
  assert.equal([...gw().__mock.payouts.values()].filter((p) => p.reference_id === String(b._id)).length, 1);
});

test("DB failure right after the gateway accepted the payout: the id is written on retry with a CRITICAL log; no second payout", async () => {
  const b = await payable();
  gw().__mock.calls.create = 0;
  const orig = HostPayout().updateOne;
  let failed = 0;
  HostPayout().updateOne = function (filter, update, ...rest) {
    if (failed === 0 && update && update.$set && update.$set.paymentId) {
      failed += 1;
      return Promise.reject(new Error("mock: db write failed"));
    }
    return orig.call(this, filter, update, ...rest);
  };
  try {
    const r = await runPayoutCycle();
    assert.equal(r.successful, 1);
  } finally {
    HostPayout().updateOne = orig;
  }
  assert.equal(failed, 1);
  const row = await rowFor(b);
  assert.ok(row.paymentId, "recorded on the retry");
  assert.equal(gw().__mock.calls.create, 1);
  await runPayoutCycle({ now: new Date(Date.now() + 86_400_000) });
  assert.equal(gw().__mock.calls.create, 1);
});

test("no bank details / unknown host / missing commission: no gateway call, no money moves", async () => {
  const other = await h.makeUser({ role: "host" });
  const L = await h.makeListing(other);
  const today = new Date();
  today.setHours(12, 0, 0, 0);
  const b = await Booking().create({
    userId: U._id, hostId: other._id, propertyId: L._id, action: "user", source: "local",
    checkIn: today, checkOut: new Date(today.getTime() + 86_400_000), nights: 1, guests: 1, adults: 1,
    price: 5850, subTotal: 5000, status: "confirmed", paymentStatus: "paid",
  });
  gw().__mock.calls.create = 0;
  let r = await runPayoutCycle();
  assert.equal(gw().__mock.calls.create, 0);
  let row = await rowFor(b);
  assert.equal(row.status, "failed");
  assert.equal(row.lastError, "Bank details not found");
  // the host adds bank details → the next cycle pays once
  await BankDetail().create({ hostId: other._id, contactId: "cont_other", fundId: "fa_other", accountNumber: "987654321098", ifsc: "HDFC0000002", name: "Other", bankName: "HDFC" });
  r = await runPayoutCycle({ now: new Date(Date.now() + 86_400_000) });
  assert.equal(r.successful, 1);
  assert.equal(gw().__mock.calls.create, 1);
  // commission unset → refused before any row is created
  const saved = process.env.MAJESTIC_COMMISSION;
  delete process.env.MAJESTIC_COMMISSION;
  try {
    const b2 = await payable();
    r = await runPayoutCycle();
    assert.equal(r.results.find((x) => String(x.bookingId) === String(b2._id)).error, "MAJESTIC_COMMISSION is not configured");
    assert.equal(await rowFor(b2), null);
  } finally {
    process.env.MAJESTIC_COMMISSION = saved;
  }
  assert.equal(gw().__mock.calls.create, 1);
});

test("a stale lock (crashed cycle) is reclaimed after 10 minutes; a fresh lock is respected", async () => {
  const b = await payable();
  await HostPayout().create({ bookingId: b._id, propertyId: b.propertyId, amount: 8800, status: "pending", reference: String(b._id), lockedAt: new Date() });
  const mine = () => [...gw().__mock.payouts.values()].filter((p) => p.reference_id === String(b._id)).length;
  let r = await runPayoutCycle();
  assert.ok(r.skipped >= 1, "another runner holds the lock");
  assert.equal(mine(), 0);
  await HostPayout().updateOne({ bookingId: b._id }, { $set: { lockedAt: new Date(Date.now() - 11 * 60_000) } });
  r = await runPayoutCycle();
  assert.equal(mine(), 1);
  assert.ok((await rowFor(b)).paymentId);
  await runPayoutCycle();
  assert.equal(mine(), 1);
});

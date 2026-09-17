// End-to-end simulation of the production runbook (docs §7) on the safe
// environment. "Old backend" writes are reproduced exactly as
// origin/dev's handlers left them (client-priced booking rows, one Payment
// row per create-order at the client amount, unconditional paid flag,
// no night rows). Batch S is the live app under test.
const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("child_process");
const path = require("path");
const h = require("./setup");

let U, T, B, BT, HOST, HT, uri;
const Booking = () => require("../../models/Booking");
const BookingNight = () => require("../../models/BookingNight");
const Payment = () => require("../../models/Payment");
const OpsFlag = () => require("../../models/OpsFlag");
const SCRIPT = path.join(__dirname, "../../scripts/backfill-booking-nights.js");
const GATE = path.join(__dirname, "../../scripts/booking-gate.js");
const backfill = (...args) => spawnSync(process.execPath, [SCRIPT, `--uri=${uri}`, ...args], { encoding: "utf8", env: { ...process.env, RAZORPAY_MOCK: "1" } });
const gate = (...args) => spawnSync(process.execPath, [GATE, `--uri=${uri}`, ...args], { encoding: "utf8", env: { ...process.env } });
const num = (re, txt) => Number((txt.match(re) || [])[1]);
const at = (d) => new Date(`${d}T00:00:00.000Z`);

// --- the pre-S backend, as it behaved -------------------------------------
async function oldCreateBooking({ user, listing, checkIn, checkOut, price, status = "pending", paymentStatus = "unpaid" }) {
  const overlapping = await Booking().findOne({ propertyId: listing._id, status: { $nin: ["rejected", "cancelled"] }, paymentStatus: "paid", checkIn: { $lt: at(checkOut) }, checkOut: { $gt: at(checkIn) } });
  if (overlapping) return { status: 409 };
  const b = await Booking().create({ userId: user._id, hostId: listing.host, propertyId: listing._id, action: "user", source: "local", checkIn: at(checkIn), checkOut: at(checkOut), nights: 1, guests: 2, adults: 2, price, subTotal: price, status, paymentStatus });
  return { status: 201, booking: b };
}
async function oldCreateOrder(booking, amount) {
  const order = await h.razorpay().orders.create({ amount, currency: "INR", receipt: "old" });
  await Payment().create({ orderId: order.id, amount, currency: "INR", bookingId: booking._id, propertyId: booking.propertyId, status: "created" });
  return order;
}
async function oldVerifyAndMarkPaid(booking, order) {
  const p = h.razorpay().__registerPayment({ id: `pay_old_${order.id}`, order_id: order.id, amount: order.amount, currency: "INR", status: "captured", method: "upi" });
  await Payment().findOneAndUpdate({ orderId: order.id }, { paymentId: p.id, status: "paid" });
  await Booking().findByIdAndUpdate(booking._id, { paymentStatus: "paid", status: "confirmed" });
  return p;
}

test.before(async () => {
  uri = (await h.start()).uri;
  U = await h.makeUser();
  T = h.userToken(U);
  B = await h.makeUser();
  BT = h.userToken(B);
  HOST = await h.makeUser({ role: "host" });
  HT = h.userToken(HOST);
});
test.after(async () => {
  await OpsFlag().deleteMany({});
  await h.stop();
});

test("runbook steps 3→9 with traffic in every phase", async () => {
  const L = await h.makeListing(HOST, { basePrice: 9000 });
  const sNew = (token, from, to) => h.api("POST", "/booking/", { token, body: h.bookingBody(L, { checkIn: h.day(from), checkOut: h.day(to) }) });

  // ---- production state before anything: paid legacy bookings, pending legacy rows, stale open orders
  const legacyPaid = (await oldCreateBooking({ user: U, listing: L, checkIn: h.day(5000), checkOut: h.day(5002), price: 23400, status: "confirmed", paymentStatus: "paid" })).booking;
  const legacyPending = (await oldCreateBooking({ user: B, listing: L, checkIn: h.day(5010), checkOut: h.day(5012), price: 100 })).booking; // client-priced ₹100 (!)
  // the one-open-order index does not exist in production yet
  await Payment().collection.dropIndex("bookingId_1").catch(() => {});
  const staleOrder1 = await oldCreateOrder(legacyPending, 100);
  await oldCreateOrder(legacyPending, 100); // second click, second open order (old behaviour)

  // ---- step 3: dry-run → apply (old backend live)
  let out = backfill();
  assert.equal(out.status, 0, out.stdout + out.stderr);
  assert.equal(num(/conflicting property-nights: (\d+)/, out.stdout), 0);
  out = backfill("--apply");
  assert.equal(out.status, 0, out.stdout + out.stderr);
  assert.equal(await BookingNight().countDocuments({ bookingId: legacyPaid._id }), 2);
  assert.equal(await Payment().countDocuments({ bookingId: legacyPending._id, status: "created" }), 1, "stale duplicate open order retired");

  // ---- the gap: the old backend keeps writing after the apply
  const gapPaid = (await oldCreateBooking({ user: U, listing: L, checkIn: h.day(5020), checkOut: h.day(5022), price: 23400 })).booking;
  const gapOrder = await oldCreateOrder(gapPaid, 2340000);
  await oldVerifyAndMarkPaid(gapPaid, gapOrder);
  const gapPending = (await oldCreateBooking({ user: B, listing: L, checkIn: h.day(5030), checkOut: h.day(5032), price: 23400 })).booking;
  const gapPendingOrder = await oldCreateOrder(gapPending, 2340000); // customer on the gateway page at cutover

  // ---- step 4: gate on
  out = gate("--on", "--reason=Batch S cutover");
  assert.ok(/paused: true/.test(out.stdout), out.stdout + out.stderr);
  require("../../services/maintenance").resetCache(); // = the Batch S process starting fresh (step 5)

  // ---- step 5: Batch S is live, old backend gone. Traffic during the pause:
  let r = await sNew(T, 5040, 5042);
  assert.equal(r.status, 503, "new booking refused");
  assert.equal(r.body.code, "MAINTENANCE");
  r = await h.api("POST", "/payment/create-order", { token: BT, body: { bookingId: gapPending._id, amount: 2340000 } });
  assert.equal(r.status, 503, "opening an order refused");
  assert.equal((await h.api("GET", `/booking/check-dates/${L._id}`)).status, 200, "reads fine");
  assert.equal((await h.api("GET", `/booking/${gapPaid._id}`, { token: T })).status, 200);
  // the customer who was already on the gateway page completes: their pre-S order lands through Batch S
  const p = h.razorpay().__registerPayment({ id: "pay_gap_pending", order_id: gapPendingOrder.id, amount: gapPendingOrder.amount, currency: "INR", status: "captured", method: "upi" });
  r = await h.api("POST", "/payment/verify-payment", { token: BT, body: { razorpay_order_id: gapPendingOrder.id, razorpay_payment_id: p.id, razorpay_signature: h.signature(gapPendingOrder.id, p.id) } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  let gp = await Booking().findById(gapPending._id).lean();
  assert.equal(gp.paymentStatus, "paid");
  assert.equal(gp.status, "confirmed", "amount matched the fresh quote → honoured");
  assert.equal(await BookingNight().countDocuments({ bookingId: gapPending._id, expiresAt: null }), 2, "nights secured by verify itself");

  // ---- step 6/7: drain, then delta reconciliation + indexes
  out = backfill("--apply", "--create-index");
  assert.equal(out.status, 0, out.stdout + out.stderr);
  assert.equal(await BookingNight().countDocuments({ bookingId: gapPaid._id, expiresAt: null }), 2, "the gap booking got its nights");
  assert.equal(num(/stale rows to replace: (\d+)/, out.stdout), 0);
  assert.ok(/indexes created/.test(out.stdout));

  // ---- step 8: startup check
  const { verifyRequiredIndexes } = require("../../services/startupChecks");
  assert.deepEqual(await verifyRequiredIndexes(), []);

  // ---- step 9: gate off; normal traffic resumes
  out = gate("--off");
  assert.ok(/paused: false/.test(out.stdout));
  require("../../services/maintenance").resetCache();
  r = await sNew(T, 5040, 5042);
  assert.equal(r.status, 201);
  r = await sNew(BT, 5020, 5022);
  assert.equal(r.status, 409, "gap booking's nights are protected");
  r = await sNew(BT, 5000, 5002);
  assert.equal(r.status, 409, "legacy paid booking's nights are protected");
  // the client-priced legacy pending row cannot be paid at ₹1: its stale order is refused and a re-quote is demanded
  r = await h.api("POST", "/payment/create-order", { token: BT, body: { bookingId: legacyPending._id, amount: 100 } });
  assert.equal(r.status, 409);
  assert.equal(r.body.code, "PRICE_CHANGED");
  assert.equal(r.body.quote.totalPaise, 2340000);
  // …and if the old ₹1 order is paid anyway (attacker kept the checkout open), it is queued, not honoured
  const cheap = h.razorpay().__registerPayment({ id: "pay_cheap_legacy", order_id: staleOrder1.id, amount: 100, currency: "INR", status: "captured", method: "upi" });
  r = await h.api("POST", "/payment/verify-payment", { token: BT, body: { razorpay_order_id: staleOrder1.id, razorpay_payment_id: cheap.id, razorpay_signature: h.signature(staleOrder1.id, cheap.id) } });
  // the retired duplicate may be the one still open; whichever row is open behaves the same
  if (r.status === 200) {
    const lp = await Booking().findById(legacyPending._id).lean();
    assert.equal(lp.paymentStatus, "unpaid");
    assert.equal(lp.needsAttention, "amount_mismatch");
  } else {
    assert.equal(r.body.code, "PAYMENT_STATE", JSON.stringify(r.body));
  }
});

test("gate cache window: a Batch S instance honours a flip within OPS_FLAG_CACHE_MS; a restarted instance reads the flag immediately", async () => {
  const maintenance = require("../../services/maintenance");
  const L = await h.makeListing(HOST);
  // emulate the production 10 s cache on this instance
  process.env.OPS_FLAG_CACHE_MS = "400";
  maintenance.resetCache();
  await OpsFlag().updateOne({ _id: maintenance.FLAG_ID }, { $set: { enabled: false } }, { upsert: true });
  let r = await h.api("POST", "/booking/", { token: T, body: h.bookingBody(L, { checkIn: h.day(5100), checkOut: h.day(5102) }) });
  assert.equal(r.status, 201);
  await OpsFlag().updateOne({ _id: maintenance.FLAG_ID }, { $set: { enabled: true } });
  r = await h.api("POST", "/booking/", { token: T, body: h.bookingBody(L, { checkIn: h.day(5110), checkOut: h.day(5112) }) });
  assert.equal(r.status, 201, "still cached open: this is the documented window the drain step covers");
  await h.sleep(450);
  r = await h.api("POST", "/booking/", { token: T, body: h.bookingBody(L, { checkIn: h.day(5120), checkOut: h.day(5122) }) });
  assert.equal(r.status, 503, "closed once the cache expired");
  maintenance.resetCache(); // process restart
  r = await h.api("POST", "/booking/", { token: T, body: h.bookingBody(L, { checkIn: h.day(5130), checkOut: h.day(5132) }) });
  assert.equal(r.status, 503, "a fresh process reads the flag before its first write");
  // every write the cache let through carries night rows, so the reconciliation sees it
  const late = await Booking().findOne({ propertyId: L._id, checkIn: at(h.day(5110)) }).lean();
  assert.equal(await BookingNight().countDocuments({ bookingId: late._id }), 2);
  await OpsFlag().updateOne({ _id: maintenance.FLAG_ID }, { $set: { enabled: false } });
  process.env.OPS_FLAG_CACHE_MS = "0";
  maintenance.resetCache();
});

test("gate cold start fails closed: an instance with no cached state and a failing/hanging flag read refuses booking writes, keeps reads and payment completion working, and recovers when the database answers", async () => {
  const maintenance = require("../../services/maintenance");
  const L = await h.makeListing(HOST);
  // a booking + order opened before the incident (customer on the gateway page)
  const before = (await h.api("POST", "/booking/", { token: T, body: h.bookingBody(L, { checkIn: h.day(5200), checkOut: h.day(5202) }) })).body.data;
  const order = (await h.api("POST", "/payment/create-order", { token: T, body: { bookingId: before._id, amount: before.quote.totalPaise } })).body.data;
  const writes = async () => ({
    create: (await h.api("POST", "/booking/", { token: T, body: h.bookingBody(L, { checkIn: h.day(5210), checkOut: h.day(5212) }) })),
    order: (await h.api("POST", "/payment/create-order", { token: BT, body: { bookingId: before._id, amount: 1 } })),
    modify: (await h.api("POST", "/booking/admin-modify", { token: h.adminToken(await h.makeAdmin()), body: { bookingId: before._id, checkIn: `${h.day(5220)}T00:00:00.000Z`, checkOut: `${h.day(5222)}T00:00:00.000Z`, adults: 2, children: 0, guest: 2 } })),
  });
  const orig = OpsFlag().findById;
  const failing = () => ({ maxTimeMS: () => ({ lean: async () => { throw new Error("mock: db unreachable"); } }) });
  const hanging = () => ({ maxTimeMS: () => ({ lean: () => new Promise(() => {}) }) });
  process.env.OPS_FLAG_READ_TIMEOUT_MS = "300";
  try {
    for (const flagInDb of [true, false]) {
      await OpsFlag().updateOne({ _id: maintenance.FLAG_ID }, { $set: { enabled: flagInDb } }, { upsert: true });
      // 1. cold instance, read throws
      maintenance.resetCache();
      OpsFlag().findById = failing;
      let r = await writes();
      for (const [k, v] of Object.entries(r)) { assert.equal(v.status, 503, `${k} (flag=${flagInDb}, read throws) ${JSON.stringify(v.body)}`); assert.equal(v.body.code, "MAINTENANCE_UNKNOWN"); }
      // 2. cold instance, read hangs → answered within the read timeout, still closed
      maintenance.resetCache();
      OpsFlag().findById = hanging;
      const t0 = Date.now();
      r = await writes();
      assert.ok(Date.now() - t0 < 3 * 300 + 1500, "hanging read is bounded by the timeout");
      for (const v of Object.values(r)) assert.equal(v.status, 503);
      // reads and payment completion are unaffected while unknown
      assert.equal((await h.api("GET", `/booking/check-dates/${L._id}`)).status, 200);
      assert.equal((await h.api("GET", `/booking/${before._id}`, { token: T })).status, 200);
      assert.equal(await Booking().countDocuments({ propertyId: L._id }), 1, "nothing written");
    }
    // 3. recovery: database answers again — gate ON is honoured (known), then OFF opens
    OpsFlag().findById = orig;
    await OpsFlag().updateOne({ _id: maintenance.FLAG_ID }, { $set: { enabled: true } });
    let r = await writes();
    for (const v of Object.values(r)) { assert.equal(v.status, 503); assert.equal(v.body.code, "MAINTENANCE"); }
    // a known-ON instance losing the database stays closed
    OpsFlag().findById = failing;
    maintenance.resetCache(); await OpsFlag().updateOne({ _id: maintenance.FLAG_ID }, { $set: { enabled: true } });
    OpsFlag().findById = orig; await maintenance.bookingWritesPaused(); OpsFlag().findById = failing;
    r = await writes();
    for (const v of Object.values(r)) assert.equal(v.status, 503);
    OpsFlag().findById = orig;
    await OpsFlag().updateOne({ _id: maintenance.FLAG_ID }, { $set: { enabled: false } });
    r = await writes();
    assert.equal(r.create.status, 201, JSON.stringify(r.create.body));
    assert.equal(r.order.status, 403, "create-order reaches the controller again (guest B is not the owner → 403, not 503)");
    // the in-flight payment completes at any point
    const p = h.razorpay().__registerPayment({ id: "pay_coldstart", order_id: order.id, amount: order.amount, currency: "INR", status: "captured", method: "upi" });
    const v = await h.api("POST", "/payment/verify-payment", { token: T, body: { razorpay_order_id: order.id, razorpay_payment_id: p.id, razorpay_signature: h.signature(order.id, p.id) } });
    assert.equal(v.status, 200);
  } finally {
    OpsFlag().findById = orig;
    delete process.env.OPS_FLAG_READ_TIMEOUT_MS;
    await OpsFlag().updateOne({ _id: maintenance.FLAG_ID }, { $set: { enabled: false } });
    maintenance.resetCache();
  }
});

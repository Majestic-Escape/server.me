const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const path = require("node:path");
const h = require("./setup");

let U, T, HOST, HT, AT;
const Booking = () => require("../../models/Booking");
const Payment = () => require("../../models/Payment");
const BookingNight = () => require("../../models/BookingNight");

test.before(async () => {
  await h.start();
  U = await h.makeUser(); T = h.userToken(U);
  HOST = await h.makeUser({ role: "host" }); HT = h.userToken(HOST);
  AT = h.adminToken(await h.makeAdmin());
});
test.after(async () => h.stop());

let dayBase = 200;
async function paidBooking(over = {}) {
  const L = await h.makeListing(HOST, over);
  dayBase += 10;
  const b = (await h.api("POST", "/booking/", { token: T, body: h.bookingBody(L, { checkIn: h.day(dayBase), checkOut: h.day(dayBase + 2) }) })).body.data;
  const order = (await h.api("POST", "/payment/create-order", { token: T, body: { bookingId: b._id, amount: b.quote.totalPaise } })).body.data;
  const p = h.razorpay().__registerPayment({ id: `pay_rec${dayBase}`, order_id: order.id, amount: order.amount, currency: "INR", status: "captured", method: "upi" });
  const v = await h.api("POST", "/payment/verify-payment", { token: T, body: { razorpay_order_id: order.id, razorpay_payment_id: p.id, razorpay_signature: h.signature(order.id, p.id) } });
  assert.equal(v.status, 200, JSON.stringify(v.body));
  return { listing: L, booking: b, order, payment: p };
}

test("Razorpay refund succeeded but the first DB write fails → retried, recorded once, no second refund", async () => {
  const { booking, order } = await paidBooking();
  const P = Payment();
  const original = P.updateOne.bind(P);
  let failures = 0;
  P.updateOne = function (filter, update, ...rest) {
    if (update && update.$set && update.$set.status === "refunded" && failures === 0) {
      failures += 1;
      return Promise.reject(new Error("simulated DB outage"));
    }
    return original(filter, update, ...rest);
  };
  const before = h.razorpay().__mock.calls.paymentsRefund;
  try {
    const r = await h.api("PATCH", "/booking/host/terminate", { token: HT, body: { bookingId: booking._id } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
  } finally {
    P.updateOne = original;
  }
  assert.equal(failures, 1);
  assert.equal(h.razorpay().__mock.calls.paymentsRefund - before, 1);
  const pay = await P.findOne({ orderId: order.id });
  assert.equal(pay.status, "refunded");
  assert.ok(pay.refundId);
});

test("post-payment notification failure never touches the payment and is retried, not duplicated", async () => {
  const { booking, payment } = await paidBooking();
  process.env.INVOICE_PDF_DISABLED = "0"; // Chromium is not available here → PDF generation throws
  h.resetEmails();
  let r = await h.api("POST", "/booking/updateStatus", { token: T, body: { bookingId: booking._id, manual: false } });
  assert.equal(r.status, 502);
  assert.equal(r.body.code, "NOTIFY_FAILED");
  process.env.INVOICE_PDF_DISABLED = "1";
  const b = await Booking().findById(booking._id);
  assert.equal(b.paymentStatus, "paid");
  assert.equal(b.notifications.paidAt, null, "claim released so it can be retried");
  assert.equal((await Payment().findOne({ paymentId: payment.id })).status, "paid");
  r = await h.api("POST", "/booking/updateStatus", { token: T, body: { bookingId: booking._id, manual: false } });
  assert.equal(r.status, 200);
  assert.equal(h.sentEmails().length, 4);
  r = await h.api("POST", "/booking/updateStatus", { token: T, body: { bookingId: booking._id, manual: false } });
  assert.equal(r.body.alreadyNotified, true);
  assert.equal(h.sentEmails().length, 4, "no duplicate emails");
});

test("hold expired and nights taken before payment completes → payment recorded, booking flagged, never silently confirmed", async () => {
  const L = await h.makeListing(HOST);
  const b = (await h.api("POST", "/booking/", { token: T, body: h.bookingBody(L, { checkIn: h.day(250), checkOut: h.day(252) }) })).body.data;
  const order = (await h.api("POST", "/payment/create-order", { token: T, body: { bookingId: b._id, amount: b.quote.totalPaise } })).body.data;
  // customer sits on the gateway page past the hold; another guest takes the nights
  await BookingNight().updateMany({ bookingId: b._id }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
  const other = await h.makeUser();
  const o = await h.api("POST", "/booking/", { token: h.userToken(other), body: h.bookingBody(L, { checkIn: h.day(250), checkOut: h.day(252) }) });
  assert.equal(o.status, 201);
  const p = h.razorpay().__registerPayment({ id: "pay_late", order_id: order.id, amount: order.amount, currency: "INR", status: "captured", method: "upi" });
  const v = await h.api("POST", "/payment/verify-payment", { token: T, body: { razorpay_order_id: order.id, razorpay_payment_id: p.id, razorpay_signature: h.signature(order.id, p.id) } });
  assert.equal(v.status, 200);
  const bk = await Booking().findById(b._id);
  assert.equal(bk.paymentStatus, "paid", "the money was taken; that fact is recorded");
  assert.equal(bk.status, "pending", "not confirmed");
  assert.equal(bk.needsAttention, "inventory_conflict");
  // the other guest keeps the nights
  const owners = await BookingNight().distinct("bookingId", { propertyId: L._id });
  assert.deepEqual(owners.map(String), [o.body.data._id]);
});

test("iCal import materialises nights, tolerates overlap with local bookings, releases on removal", async () => {
  const inventory = require("../../services/inventory");
  const L = await h.makeListing(HOST);
  const local = (await h.api("POST", "/booking/", { token: T, body: h.bookingBody(L, { checkIn: h.day(260), checkOut: h.day(262) }) })).body.data;
  const imported = await Booking().create({ userId: HOST._id, hostId: HOST._id, propertyId: L._id, checkIn: new Date(`${h.day(261)}T00:00:00.000Z`), checkOut: new Date(`${h.day(264)}T00:00:00.000Z`), price: 0, subTotal: 0, status: "confirmed", paymentStatus: "paid", source: "ical", sourceId: "uid-1", guests: 0 });
  await inventory.ensureNightsBestEffort({ propertyId: L._id, nights: inventory.nightsBetween(imported.checkIn, imported.checkOut), bookingId: imported._id, kind: "ical" });
  const rows = await BookingNight().find({ propertyId: L._id }).lean();
  // 601 belongs to the local hold; 602 and 603 to the import
  const byDay = Object.fromEntries(rows.map((r) => [r.date.toISOString().slice(0, 10), String(r.bookingId)]));
  assert.equal(byDay[h.day(260)], local._id);
  assert.equal(byDay[h.day(261)], local._id);
  assert.equal(byDay[h.day(262)], String(imported._id));
  assert.equal(byDay[h.day(263)], String(imported._id));
  const g = await h.api("POST", "/booking/", { token: h.userToken(await h.makeUser()), body: h.bookingBody(L, { checkIn: h.day(263), checkOut: h.day(265) }) });
  assert.equal(g.status, 409, "imported nights block guests");
  // removal from the feed = the sync controller cancels the booking and releases its nights
  await Booking().updateOne({ _id: imported._id }, { $set: { status: "cancelled" } });
  await inventory.releaseNights(imported._id);
  const g2 = await h.api("POST", "/booking/", { token: h.userToken(await h.makeUser()), body: h.bookingBody(L, { checkIn: h.day(263), checkOut: h.day(265) }) });
  assert.equal(g2.status, 201);
});

test("backfill script: dry-run reports, apply is idempotent, conflicts block the index, rollback drops", async () => {
  const uri = (await h.start()).uri;
  const L1 = await h.makeListing(HOST);
  const L2 = await h.makeListing(HOST);
  const mk = (over) => Booking().create({ userId: U._id, hostId: HOST._id, propertyId: L1._id, price: 1, subTotal: 1, ...over });
  // legacy rows without night entries
  const paid = await mk({ checkIn: new Date(`${h.day(270)}T00:00:00.000Z`), checkOut: new Date(`${h.day(273)}T00:00:00.000Z`), status: "confirmed", paymentStatus: "paid" });
  const block = await mk({ checkIn: new Date(`${h.day(280)}T18:30:00.000Z`), checkOut: new Date(`${h.day(282)}T18:30:00.000Z`), status: "confirmed", paymentStatus: "paid", action: "host" });
  await mk({ checkIn: new Date(`${h.day(290)}T00:00:00.000Z`), checkOut: new Date(`${h.day(292)}T00:00:00.000Z`), status: "cancelled", paymentStatus: "refunded" }); // ignored
  await mk({ checkIn: new Date(`${h.day(-10)}T00:00:00.000Z`), checkOut: new Date(`${h.day(-8)}T00:00:00.000Z`), status: "confirmed", paymentStatus: "paid" }); // past, ignored
  await mk({ checkIn: new Date(`${h.day(300)}T00:00:00.000Z`), checkOut: new Date(`${h.day(302)}T00:00:00.000Z`), status: "pending", paymentStatus: "unpaid" }); // unpaid, ignored
  // a genuine legacy conflict on L2 (two paid bookings, one night in common)
  const c1 = await mk({ propertyId: L2._id, checkIn: new Date(`${h.day(310)}T00:00:00.000Z`), checkOut: new Date(`${h.day(312)}T00:00:00.000Z`), status: "confirmed", paymentStatus: "paid" });
  await mk({ propertyId: L2._id, checkIn: new Date(`${h.day(311)}T00:00:00.000Z`), checkOut: new Date(`${h.day(313)}T00:00:00.000Z`), status: "confirmed", paymentStatus: "paid" });
  // stale duplicate open orders on one booking (as the old create-order left
  // them). The partial unique index must not exist yet for this to be
  // possible — exactly the production situation the script has to handle.
  await Payment().collection.dropIndex("bookingId_1");
  await Payment().create({ orderId: "order_stale1", amount: 100, bookingId: paid._id, propertyId: L1._id, status: "created", createdAt: new Date(Date.now() - 60000) });
  await Payment().create({ orderId: "order_stale2", amount: 100, bookingId: paid._id, propertyId: L1._id, status: "created" });
  const run = (...args) => spawnSync(process.execPath, [path.join(__dirname, "../../scripts/backfill-booking-nights.js"), `--uri=${uri}`, ...args], { encoding: "utf8", env: { ...process.env, RAZORPAY_MOCK: "1" } });
  let out = run();
  assert.ok(out.stdout.includes("mode: DRY-RUN"), out.stdout + out.stderr);
  const num = (re, txt) => Number((txt.match(re) || [])[1]);
  assert.equal(num(/conflicting property-nights: (\d+)/, out.stdout), 1, out.stdout);
  assert.equal(num(/retire as failed: (\d+)/, out.stdout), 1, out.stdout);
  const wanted = num(/to insert: (\d+)/, out.stdout);
  assert.ok(wanted >= 7, out.stdout); // 3 (paid) + 2 (block) + 2 non-conflicting nights of the pair (+ rows other suites left)
  assert.equal(await BookingNight().countDocuments({ propertyId: { $in: [L1._id, L2._id] } }), 0, "dry run writes nothing");
  assert.equal(await Payment().countDocuments({ bookingId: paid._id, status: "created" }), 2, "dry run retires nothing");
  out = run("--apply");
  assert.equal(num(/retired: (\d+)/, out.stdout), 1, out.stdout);
  assert.equal(num(/inserted: (\d+)/, out.stdout), wanted, out.stdout);
  assert.equal(await Payment().countDocuments({ bookingId: paid._id, status: "created" }), 1, "newest open order kept");
  assert.equal(await BookingNight().countDocuments({ bookingId: paid._id }), 3);
  assert.equal(await BookingNight().countDocuments({ bookingId: block._id }), 2);
  out = run("--apply");
  assert.equal(num(/to insert: (\d+)/, out.stdout), 0, "idempotent rerun: " + out.stdout);
  assert.equal(num(/inserted: (\d+)/, out.stdout), 0, out.stdout);
  out = run("--apply", "--create-index");
  assert.equal(out.status, 2, "index refused while a conflict exists");
  // resolve the conflict (cancel one side) → index allowed. The flagged
  // booking from the hold-expiry test above is a live conflict too (paid,
  // wants nights another guest holds): the operator closes it as well.
  await Booking().updateOne({ _id: c1._id }, { $set: { status: "cancelled" } });
  await Booking().updateMany({ needsAttention: "inventory_conflict" }, { $set: { status: "cancelled", needsAttention: null } });
  out = run("--apply", "--create-index");
  assert.equal(out.status, 0, out.stdout + out.stderr);
  assert.ok(/indexes created/.test(out.stdout));
  const idx = await BookingNight().collection.indexes();
  assert.ok(idx.some((i) => i.name === "propertyId_1_date_1" && i.unique));
  const pidx = await Payment().collection.indexes();
  assert.ok(pidx.some((i) => i.name === "bookingId_1" && i.unique && i.partialFilterExpression), "one-open-order index rebuilt");
  // rollback removes the collection (and only that)
  out = run("--rollback");
  assert.ok(/dropped collection bookingnights/.test(out.stdout));
  assert.equal(await Booking().countDocuments({ propertyId: L1._id }), 5, "bookings untouched");
  // NOTE: dropping the collection also drops the unique index — the invariant
  // is gone until the previous backend is redeployed (or indexes are rebuilt).
  await BookingNight().syncIndexes();
  const rebuilt = await BookingNight().collection.indexes();
  assert.ok(rebuilt.some((i) => i.name === "propertyId_1_date_1" && i.unique));
});

test("admin modify: moving a paid booking onto taken nights is refused and keeps its nights; onto free nights moves them", async () => {
  const { listing, booking } = await paidBooking();
  const mdy = (offset) => { const d = new Date(); d.setUTCDate(d.getUTCDate() + offset); return `${d.getUTCMonth() + 1}/${d.getUTCDate()}/${d.getUTCFullYear()}`; };
  // another paid booking occupies a later window
  const other = await h.makeUser();
  const obr = await h.api("POST", "/booking/", { token: h.userToken(other), body: h.bookingBody(listing, { checkIn: h.day(dayBase + 20), checkOut: h.day(dayBase + 22) }) });
  assert.equal(obr.status, 201, JSON.stringify(obr.body));
  const ob = obr.body.data;
  assert.equal(await BookingNight().countDocuments({ bookingId: ob._id }), 2);
  const before = await BookingNight().find({ bookingId: booking._id }).lean();
  assert.equal(before.length, 2);
  // 1. move onto the other booking's nights → 409, original nights intact
  let r = await h.api("POST", `/booking/admin-modify?bookingId=${booking._id}&guest=2&adults=2&from=${mdy(dayBase + 20)}&to=${mdy(dayBase + 22)}&property=all`, { token: AT, body: {} });
  assert.equal(r.status, 409, JSON.stringify(r.body));
  const after = await BookingNight().find({ bookingId: booking._id }).lean();
  assert.deepEqual(after.map((n) => +n.date).sort(), before.map((n) => +n.date).sort());
  assert.ok(after.every((n) => n.expiresAt === null));
  // 2. move onto free nights → moved, old nights released
  r = await h.api("POST", `/booking/admin-modify?bookingId=${booking._id}&guest=2&adults=2&from=${mdy(dayBase + 30)}&to=${mdy(dayBase + 33)}&property=all`, { token: AT, body: {} });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const moved = await BookingNight().find({ bookingId: booking._id }).lean();
  assert.equal(moved.length, 3);
  assert.equal((await Booking().findById(booking._id)).nights, 3);
  const free = await h.api("POST", "/booking/", { token: h.userToken(await h.makeUser()), body: h.bookingBody(listing, { checkIn: h.day(dayBase), checkOut: h.day(dayBase + 2) }) });
  assert.equal(free.status, 201, "the vacated nights are bookable again");
  // non-admins cannot modify
  r = await h.api("POST", `/booking/admin-modify?bookingId=${booking._id}&guest=2&adults=2&from=${mdy(dayBase + 30)}&to=${mdy(dayBase + 33)}`, { token: HT, body: {} });
  assert.equal(r.status, 403);
  void ob;
});

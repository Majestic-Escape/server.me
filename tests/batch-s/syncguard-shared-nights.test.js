// SyncGuard: an imported OTA booking blocks its nights even when it does not
// OWN them in the night ledger — a night it shares with a host block or a
// booking that is later released. Every path that claims nights through
// services/inventory.js#reserveNights must respect that, not only POST /booking
// (which also has a row-level overlap check).
const { test, before, after } = require("node:test");
const assert = require("node:assert");
const S = require("./syncguard-helpers");
const H = require("./setup");

const ota = new S.FakeOta();
const record = S.evidence("shared-nights");
let Booking;
let BookingNight;
let engine;

before(async () => {
  await H.start();
  await ota.start();
  Booking = require("../../models/Booking");
  BookingNight = require("../../models/BookingNight");
  engine = require("../../services/calendarSync/engine");
});
after(async () => {
  await ota.stop();
  await H.stop();
});

let seq = 0;
// Builds: guest P holds night N (unpaid) → P's hold expires → host blocks N →
// an OTA booking on N arrives (shares N with the block: no night row) → the
// host unblocks N. N is now free in the ledger but blocked by the OTA booking.
async function sharedNightScenario(offset) {
  const host = await H.makeUser();
  const listing = await H.makeListing(host);
  const hostToken = H.userToken(host);
  const p = `/shared${++seq}.ics`;
  ota.events(p, []);
  const conn = await H.api("POST", `/calendarSync/properties/${listing._id}/connections`, { token: hostToken, body: { channel: "AIRBNB", url: ota.url(p) } });
  assert.strictEqual(conn.status, 201, JSON.stringify(conn.body));
  const guest = await H.makeUser();
  const gToken = H.userToken(guest);
  const pending = await H.api("POST", "/booking", { token: gToken, body: H.bookingBody(listing, { checkIn: S.day(offset), checkOut: S.day(offset + 1) }) });
  assert.strictEqual(pending.status, 201, JSON.stringify(pending.body));
  await BookingNight.updateMany({ bookingId: pending.body.data._id }, { $set: { expiresAt: new Date(Date.now() - 60_000) } }); // hold expired
  const block = await H.api("POST", "/booking", { token: hostToken, body: { ...H.bookingBody(listing, { checkIn: S.day(offset), checkOut: S.day(offset + 1) }), action: "host" } });
  assert.strictEqual(block.status, 201, JSON.stringify(block.body));
  ota.events(p, [{ uid: `SHARED-${seq}@airbnb.com`, start: S.day(offset), end: S.day(offset + 1), summary: "Reserved" }]);
  await engine.syncConnection(conn.body.id, { force: true });
  const imp = await Booking.findOne({ propertyId: listing._id, source: "ical" }).lean();
  assert.ok(imp && imp.status === "confirmed", "the OTA booking is imported and blocking");
  assert.strictEqual(await BookingNight.countDocuments({ bookingId: imp._id }), 0, "it shares the night with the host block (no night row of its own)");
  const un = await H.api("POST", `/booking/unblock-dates/${listing._id}`, { token: hostToken, body: { selectedDate: S.day(offset) } });
  assert.strictEqual(un.status, 200, JSON.stringify(un.body));
  assert.strictEqual(await BookingNight.countDocuments({ propertyId: listing._id }), 0, "the ledger now shows the night free");
  return { listing, guest, gToken, pending: pending.body.data, imp, connId: conn.body.id };
}

test("Pay on an old pending booking cannot take a night an OTA booking covers (secureHold → reserveNights)", async () => {
  const x = await sharedNightScenario(100);
  const before = H.razorpay().__mock.calls.ordersCreate;
  const o = await H.api("POST", "/payment/create-order", { token: x.gToken, body: { bookingId: x.pending._id, amount: x.pending.quote.totalPaise, currency: "INR" } });
  assert.strictEqual(o.status, 409, JSON.stringify(o.body));
  assert.strictEqual(o.body.code, "DATES_UNAVAILABLE");
  assert.strictEqual(H.razorpay().__mock.calls.ordersCreate - before, 0, "no money can move");
  assert.strictEqual(await BookingNight.countDocuments({ bookingId: x.pending._id }), 0, "nothing claimed");
  record("pay-after-shared-release", { http: { status: o.status, code: o.body.code }, db: await S.snapshot(x.listing._id) });
});

test("a direct booking of that night is refused too (and the ledger is not left holding it)", async () => {
  const x = await sharedNightScenario(110);
  const g2 = await H.makeUser();
  const r = await H.api("POST", "/booking", { token: H.userToken(g2), body: H.bookingBody(x.listing, { checkIn: S.day(110), checkOut: S.day(111) }) });
  assert.strictEqual(r.status, 409);
  assert.strictEqual(await BookingNight.countDocuments({ propertyId: x.listing._id }), 0);
});

test("admin 'keep' and admin date moves cannot claim it either", async () => {
  const x = await sharedNightScenario(120);
  const inventory = require("../../services/inventory");
  const direct = await inventory.reserveNights({ propertyId: x.listing._id, nights: inventory.nightsBetween(new Date(`${S.day(120)}T00:00:00Z`), new Date(`${S.day(121)}T00:00:00Z`)), bookingId: x.pending._id, kind: "booking" });
  assert.strictEqual(direct.ok, false, "the shared primitive refuses");
  assert.ok(direct.conflicts.some((c) => c.kind === "ical"), "and names the imported booking as the owner");
  // Adjacent nights stay bookable: the check is per night, not per stay window.
  const ok = await inventory.reserveNights({ propertyId: x.listing._id, nights: inventory.nightsBetween(new Date(`${S.day(121)}T00:00:00Z`), new Date(`${S.day(123)}T00:00:00Z`)), bookingId: new (require("mongoose").Types.ObjectId)(), kind: "booking" });
  assert.strictEqual(ok.ok, true, "the night after the OTA booking (its checkout day) is free");
});

// The displacement race: an OTA booking arrives while the guest's hold is
// being extended, so it ends up SHARING the night with a live hold.
async function holdSharedWithImport(offset) {
  const host = await H.makeUser();
  const listing = await H.makeListing(host);
  const guest = await H.makeUser();
  const gToken = H.userToken(guest);
  const b = await H.api("POST", "/booking", { token: gToken, body: H.bookingBody(listing, { checkIn: S.day(offset), checkOut: S.day(offset + 2) }) });
  assert.strictEqual(b.status, 201, JSON.stringify(b.body));
  const imp = await Booking.create({ userId: host._id, hostId: host._id, propertyId: listing._id, source: "ical", sourceId: `RACE-${offset}@airbnb.com`, action: "user", checkIn: new Date(`${S.day(offset + 1)}T00:00:00Z`), checkOut: new Date(`${S.day(offset + 2)}T00:00:00Z`), price: 0, subTotal: 0, status: "confirmed", paymentStatus: "paid" });
  return { listing, gToken, booking: b.body.data, imp };
}

test("race: a hold that shares a night with an OTA booking is given up at Pay (no order)", async () => {
  const x = await holdSharedWithImport(140);
  const before = H.razorpay().__mock.calls.ordersCreate;
  const o = await H.api("POST", "/payment/create-order", { token: x.gToken, body: { bookingId: x.booking._id, amount: x.booking.quote.totalPaise, currency: "INR" } });
  assert.strictEqual(o.status, 409, JSON.stringify(o.body));
  assert.strictEqual(H.razorpay().__mock.calls.ordersCreate - before, 0);
  assert.strictEqual(await BookingNight.countDocuments({ bookingId: x.booking._id }), 0, "the hold was released");
});

test("race: payment landing on nights an OTA booking now covers is flagged, never confirmed; admin 'keep' is refused", async () => {
  const host = await H.makeUser();
  const listing = await H.makeListing(host);
  const guest = await H.makeUser();
  const gToken = H.userToken(guest);
  const b = await H.api("POST", "/booking", { token: gToken, body: H.bookingBody(listing, { checkIn: S.day(150), checkOut: S.day(152) }) });
  const o = await H.api("POST", "/payment/create-order", { token: gToken, body: { bookingId: b.body.data._id, amount: b.body.data.quote.totalPaise, currency: "INR" } });
  assert.strictEqual(o.status, 200, JSON.stringify(o.body));
  // the OTA booking lands while the guest is on the gateway page (sharing the night)
  await Booking.create({ userId: host._id, hostId: host._id, propertyId: listing._id, source: "ical", sourceId: "RACE-PAY@airbnb.com", action: "user", checkIn: new Date(`${S.day(151)}T00:00:00Z`), checkOut: new Date(`${S.day(152)}T00:00:00Z`), price: 0, subTotal: 0, status: "confirmed", paymentStatus: "paid" });
  const pay = H.razorpay().__registerPayment({ id: "pay_race_shared", order_id: o.body.data.id, amount: o.body.data.amount, currency: "INR", status: "captured", method: "upi" });
  const v = await H.api("POST", "/payment/verify-payment", { token: gToken, body: { razorpay_order_id: o.body.data.id, razorpay_payment_id: pay.id, razorpay_signature: H.signature(o.body.data.id, pay.id) } });
  assert.strictEqual(v.status, 200, JSON.stringify(v.body));
  const after = await Booking.findById(b.body.data._id).lean();
  assert.deepStrictEqual([after.paymentStatus, after.status, after.needsAttention], ["paid", "pending", "inventory_conflict"]);
  const admin = H.adminToken(await H.makeAdmin());
  const keep = await H.api("PATCH", "/booking/admin/attention/resolve", { token: admin, body: { bookingId: String(after._id), resolution: "keep" } });
  assert.strictEqual(keep.status, 409, JSON.stringify(keep.body));
  assert.strictEqual((await Booking.findById(after._id).lean()).status, "pending", "still not confirmed");
  record("payment-race-shared", { booking: { status: after.status, needsAttention: after.needsAttention }, keep: keep.status });
});

test("a later full pass gives the OTA booking its night back in the ledger", async () => {
  const x = await sharedNightScenario(130);
  await engine.syncConnection(x.connId, { force: true, full: true });
  assert.strictEqual(await BookingNight.countDocuments({ bookingId: x.imp._id }), 1);
});

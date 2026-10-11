// SyncGuard × direct booking & payment (docs/syncguard.md §7).
// The commitment policy: a connection older than 2 min must be re-verified
// at Confirm/Pay; if that fails the booking is refused — whatever the age.
process.env.PREBOOK_REFRESH_TIMEOUT_MS = "700";
const { test, before, after } = require("node:test");
const assert = require("node:assert");
const S = require("./syncguard-helpers");
const H = require("./setup");

const ota = new S.FakeOta();
const record = S.evidence("booking");
let Booking;
let BookingNight;
let ExternalCalendar;
let Payment;

before(async () => {
  await H.start();
  await ota.start();
  Booking = require("../../models/Booking");
  BookingNight = require("../../models/BookingNight");
  ExternalCalendar = require("../../models/ExternalCalendar");
  Payment = require("../../models/Payment");
  await Promise.all([ExternalCalendar.syncIndexes(), require("../../models/CalendarSyncLog").syncIndexes()]);
});
after(async () => {
  await ota.stop();
  await H.stop();
});

let seq = 0;
async function connected(events = [], channel = "AIRBNB") {
  const host = await H.makeUser();
  const listing = await H.makeListing(host);
  const p = `/bk${++seq}.ics`;
  ota.events(p, events);
  const r = await H.api("POST", `/calendarSync/properties/${listing._id}/connections`, { token: H.userToken(host), body: { channel, url: ota.url(p) } });
  assert.strictEqual(r.status, 201, JSON.stringify(r.body));
  const guest = await H.makeUser();
  return { host, listing, path: p, id: r.body.id, guest, gToken: H.userToken(guest) };
}
async function ageConnection(id, minutes) {
  await ExternalCalendar.updateOne({ _id: id }, { $set: { "sync.lastSuccessAt": new Date(Date.now() - minutes * 60_000), "sync.lastAttemptAt": new Date(Date.now() - minutes * 60_000), "sync.consecutiveFailures": 0 } });
}
const book = (x, from, to) => H.api("POST", "/booking", { token: x.gToken, body: H.bookingBody(x.listing, { checkIn: S.day(from), checkOut: S.day(to) }) });
async function dbState(x) {
  return { bookings: await Booking.countDocuments({ propertyId: x.listing._id, source: "local" }), nights: await BookingNight.countDocuments({ propertyId: x.listing._id }), refused: ((await ExternalCalendar.findById(x.id).lean()).stats || {}).prebookRefused || 0 };
}

for (const minutes of [11, 60, 12 * 60, 23 * 60]) {
  test(`${minutes} min stale + refresh times out → AVAILABILITY_UNVERIFIED, nothing held`, async () => {
    const x = await connected([]);
    await ageConnection(x.id, minutes);
    ota.set(x.path, { hang: true });
    ota.resetHits();
    const t = Date.now();
    const r = await book(x, 30, 32);
    assert.strictEqual(r.status, 409, JSON.stringify(r.body));
    assert.strictEqual(r.body.code, "AVAILABILITY_UNVERIFIED");
    assert.ok(Date.now() - t < 5000, "bounded wait");
    assert.strictEqual(ota.count(x.path), 1, "exactly one live refresh attempted");
    const db = await dbState(x);
    assert.deepStrictEqual([db.bookings, db.nights, db.refused], [0, 0, 1]);
    // A retry seconds later does not hammer the failing source.
    const again = await book(x, 30, 32);
    assert.strictEqual(again.body.code, "AVAILABILITY_UNVERIFIED");
    record(`stale-${minutes}m-timeout`, { http: { status: r.status, code: r.body.code }, db, sourceHits: ota.count(x.path) });
  });
}

test("fresh (1 min) connection: the known state is used, no live fetch, booking proceeds", async () => {
  const x = await connected([]);
  await ageConnection(x.id, 1);
  ota.set(x.path, { hang: true });
  ota.resetHits();
  const r = await book(x, 30, 32);
  assert.strictEqual(r.status, 201, JSON.stringify(r.body));
  assert.strictEqual(ota.count(x.path), 0);
});

test("stale source recovers during booking: refresh succeeds → booking proceeds", async () => {
  const x = await connected([]);
  await ageConnection(x.id, 300);
  await ExternalCalendar.updateOne({ _id: x.id }, { $set: { "sync.consecutiveFailures": 4, "sync.lastErrorCode": "TIMEOUT", "sync.nextSyncAt": new Date(Date.now() + 3600_000) } });
  ota.events(x.path, []); // back up
  const r = await book(x, 30, 32);
  assert.strictEqual(r.status, 201, JSON.stringify(r.body));
  const c = await ExternalCalendar.findById(x.id).lean();
  assert.strictEqual(c.sync.consecutiveFailures, 0);
  assert.ok(Date.now() - new Date(c.sync.lastSuccessAt).getTime() < 10_000);
});

test("another worker is syncing at that moment: the booking waits for its outcome", async () => {
  const x = await connected([]);
  await ageConnection(x.id, 30);
  let release;
  ota.set(x.path, { body: S.vcal([]), gate: new Promise((r) => (release = r)) });
  const engine = require("../../services/calendarSync/engine");
  const bg = engine.syncConnection(x.id, { force: true }); // holds the lease
  await new Promise((r) => setTimeout(r, 100));
  const pending = book(x, 30, 32);
  await new Promise((r) => setTimeout(r, 250));
  release();
  await bg;
  const r = await pending;
  assert.strictEqual(r.status, 201, JSON.stringify(r.body));
});

test("an OTA booking found at commitment wins: 409 DATES_UNAVAILABLE, import owns the nights, metric counted", async () => {
  const x = await connected([]);
  await ageConnection(x.id, 30);
  ota.events(x.path, [{ uid: "NEW@airbnb.com", start: S.day(30), end: S.day(32), summary: "Reserved" }]);
  const r = await book(x, 30, 32);
  assert.strictEqual(r.status, 409);
  assert.strictEqual(r.body.code, "DATES_UNAVAILABLE");
  assert.deepStrictEqual(await S.nightOwners(x.listing._id), { [S.day(30)]: "ical:AIRBNB", [S.day(31)]: "ical:AIRBNB" });
  await new Promise((res) => setTimeout(res, 100));
  assert.strictEqual(((await ExternalCalendar.findById(x.id).lean()).stats || {}).prebookPrevented, 1);
  record("ota-found-at-commit", { http: { status: r.status, code: r.body.code }, db: await S.snapshot(x.listing._id) });
});

test("two direct bookings in the same millisecond on a connected listing: exactly one wins", async () => {
  const x = await connected([]);
  const g2 = await H.makeUser();
  const [a, b] = await Promise.all([book(x, 40, 42), H.api("POST", "/booking", { token: H.userToken(g2), body: H.bookingBody(x.listing, { checkIn: S.day(40), checkOut: S.day(42) }) })]);
  assert.deepStrictEqual([a.status, b.status].sort(), [201, 409]);
  assert.strictEqual(await BookingNight.countDocuments({ propertyId: x.listing._id }), 2);
});

test("OTA event appears while the guest is paying: create-order refuses before any money (hold displaced)", async () => {
  const x = await connected([]);
  const r = await book(x, 50, 52);
  assert.strictEqual(r.status, 201);
  await ageConnection(x.id, 30);
  ota.events(x.path, [{ uid: "DURING@airbnb.com", start: S.day(50), end: S.day(52), summary: "Reserved" }]);
  const before = H.razorpay().__mock.calls.ordersCreate;
  const o = await H.api("POST", "/payment/create-order", { token: x.gToken, body: { bookingId: r.body.data._id, amount: r.body.data.quote.totalPaise, currency: "INR" } });
  assert.strictEqual(o.status, 409, JSON.stringify(o.body));
  assert.strictEqual(o.body.code, "DATES_UNAVAILABLE");
  assert.strictEqual(H.razorpay().__mock.calls.ordersCreate - before, 0, "no gateway order");
  assert.deepStrictEqual(await S.nightOwners(x.listing._id), { [S.day(50)]: "ical:AIRBNB", [S.day(51)]: "ical:AIRBNB" });
  record("ota-during-payment", { http: { status: o.status, code: o.body.code }, db: await S.snapshot(x.listing._id) });
});

test("create-order refuses when the calendar cannot be verified (no gateway order)", async () => {
  const x = await connected([]);
  const r = await book(x, 55, 56);
  assert.strictEqual(r.status, 201);
  await ageConnection(x.id, 45);
  ota.set(x.path, { hang: true });
  const before = H.razorpay().__mock.calls.ordersCreate;
  const o = await H.api("POST", "/payment/create-order", { token: x.gToken, body: { bookingId: r.body.data._id, amount: r.body.data.quote.totalPaise, currency: "INR" } });
  assert.strictEqual(o.status, 409);
  assert.strictEqual(o.body.code, "AVAILABILITY_UNVERIFIED");
  assert.strictEqual(H.razorpay().__mock.calls.ordersCreate - before, 0);
});

test("payment callback after the hold was lost to an OTA booking: paid but flagged, never confirmed", async () => {
  const x = await connected([]);
  const r = await book(x, 60, 62);
  const order = await H.api("POST", "/payment/create-order", { token: x.gToken, body: { bookingId: r.body.data._id, amount: r.body.data.quote.totalPaise, currency: "INR" } });
  assert.strictEqual(order.status, 200, JSON.stringify(order.body));
  // While the guest is on the gateway page, the OTA reservation is imported.
  ota.events(x.path, [{ uid: "LATE@airbnb.com", start: S.day(60), end: S.day(62), summary: "Reserved" }]);
  await require("../../services/calendarSync/engine").syncConnection(x.id, { force: true });
  assert.deepStrictEqual(await S.nightOwners(x.listing._id), { [S.day(60)]: "ical:AIRBNB", [S.day(61)]: "ical:AIRBNB" }, "hold displaced by the OTA booking");
  const pay = H.razorpay().__registerPayment({ id: "pay_sg_late", order_id: order.body.data.id, amount: order.body.data.amount, currency: "INR", status: "captured", method: "upi" });
  const v = await H.api("POST", "/payment/verify-payment", { token: x.gToken, body: { razorpay_order_id: order.body.data.id, razorpay_payment_id: pay.id, razorpay_signature: H.signature(order.body.data.id, pay.id), paymentMethod: "upi" } });
  assert.strictEqual(v.status, 200, JSON.stringify(v.body));
  const b = await Booking.findById(r.body.data._id).lean();
  assert.deepStrictEqual([b.paymentStatus, b.status, b.needsAttention], ["paid", "pending", "inventory_conflict"]);
  // Duplicate callback: no second transition.
  const v2 = await H.api("POST", "/payment/verify-payment", { token: x.gToken, body: { razorpay_order_id: order.body.data.id, razorpay_payment_id: pay.id, razorpay_signature: H.signature(order.body.data.id, pay.id), paymentMethod: "upi" } });
  assert.strictEqual(v2.status, 200);
  assert.strictEqual(await Payment.countDocuments({ bookingId: b._id, status: "paid" }), 1);
  record("callback-after-hold-loss", { booking: { paymentStatus: b.paymentStatus, status: b.status, needsAttention: b.needsAttention }, db: await S.snapshot(x.listing._id) });
});

test("genuine OTA double-sale of a paid Majestic night: conflict recorded, admin attention + host e-mail exactly once", async () => {
  const x = await connected([]);
  const r = await book(x, 70, 72);
  const order = await H.api("POST", "/payment/create-order", { token: x.gToken, body: { bookingId: r.body.data._id, amount: r.body.data.quote.totalPaise, currency: "INR" } });
  const pay = H.razorpay().__registerPayment({ id: "pay_sg_conf", order_id: order.body.data.id, amount: order.body.data.amount, currency: "INR", status: "captured", method: "upi" });
  const v = await H.api("POST", "/payment/verify-payment", { token: x.gToken, body: { razorpay_order_id: order.body.data.id, razorpay_payment_id: pay.id, razorpay_signature: H.signature(order.body.data.id, pay.id), paymentMethod: "upi" } });
  assert.strictEqual(v.status, 200);
  H.resetEmails();
  ota.events(x.path, [{ uid: "DOUBLE@airbnb.com", start: S.day(70), end: S.day(72), summary: "Reserved" }]);
  const engine = require("../../services/calendarSync/engine");
  for (let i = 0; i < 3; i++) await engine.syncConnection(x.id, { force: true, full: i === 2 });
  const paid = await Booking.findById(r.body.data._id).lean();
  assert.strictEqual(paid.needsAttention, "ota_conflict");
  assert.strictEqual(paid.status, "confirmed", "the Majestic booking keeps its nights and status");
  const imp = await Booking.findOne({ propertyId: x.listing._id, source: "ical" }).lean();
  assert.strictEqual(imp.external.conflict.kind, "paid_booking");
  assert.strictEqual(imp.status, "confirmed", "the OTA booking still blocks (it is real)");
  const hostMails = H.sentEmails().filter((e) => String(e.to || e.email || JSON.stringify(e)).includes(x.host.email));
  assert.strictEqual(hostMails.length, 1, `host e-mailed once (${H.sentEmails().length} total)`);
  const list = await H.api("GET", `/calendarSync/properties/${x.listing._id}/connections`, { token: H.userToken(x.host) });
  assert.strictEqual(list.body.data.connections[0].health.state, "NEEDS_ATTENTION");
  assert.strictEqual(list.body.data.connections[0].protection, "ACTION_REQUIRED");
  record("genuine-conflict", { attention: paid.needsAttention, row: imp.external.conflict, emails: H.sentEmails().length, db: await S.snapshot(x.listing._id) });
});

test("adversarial: the admin 'modify booking' tool cannot move a guest onto nights it has not verified", async () => {
  const x = await connected([]);
  const r = await book(x, 90, 92);
  const o = await H.api("POST", "/payment/create-order", { token: x.gToken, body: { bookingId: r.body.data._id, amount: r.body.data.quote.totalPaise, currency: "INR" } });
  const pay = H.razorpay().__registerPayment({ id: "pay_sg_modify", order_id: o.body.data.id, amount: o.body.data.amount, currency: "INR", status: "captured", method: "upi" });
  await H.api("POST", "/payment/verify-payment", { token: x.gToken, body: { razorpay_order_id: o.body.data.id, razorpay_payment_id: pay.id, razorpay_signature: H.signature(o.body.data.id, pay.id) } });
  const nightsBefore = await S.nightOwners(x.listing._id);
  await ageConnection(x.id, 30);
  ota.set(x.path, { hang: true });
  const admin = H.adminToken(await H.makeAdmin());
  const mdy = (n) => {
    const d = new Date(Date.now() + n * 86_400_000);
    return `${d.getUTCMonth() + 1}/${d.getUTCDate()}/${d.getUTCFullYear()}`;
  };
  const q = (a, b) => `/booking/admin-modify?bookingId=${r.body.data._id}&from=${encodeURIComponent(mdy(a))}&to=${encodeURIComponent(mdy(b))}&guest=2&adults=2`;
  const refused = await H.api("POST", q(95, 97), { token: admin });
  assert.strictEqual(refused.status, 409, JSON.stringify(refused.body));
  assert.strictEqual(refused.body.code, "AVAILABILITY_UNVERIFIED");
  assert.deepStrictEqual(await S.nightOwners(x.listing._id), nightsBefore, "nothing moved");
  ota.events(x.path, []);
  await new Promise((res) => setTimeout(res, 31_000)); // the failed source is not retried within 30 s (no hammering)
  const ok = await H.api("POST", q(95, 97), { token: admin });
  assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
  assert.deepStrictEqual(Object.keys(await S.nightOwners(x.listing._id)).sort(), [S.day(95), S.day(96)]);
});

test("host calendar blocks need no verification (host is blocking their own dates)", async () => {
  const x = await connected([]);
  await ageConnection(x.id, 600);
  ota.set(x.path, { hang: true });
  const r = await H.api("POST", "/booking", { token: H.userToken(x.host), body: { ...H.bookingBody(x.listing, { checkIn: S.day(80), checkOut: S.day(81) }), action: "host" } });
  assert.strictEqual(r.status, 201, JSON.stringify(r.body));
});

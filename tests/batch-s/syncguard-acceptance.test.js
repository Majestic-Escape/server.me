// SyncGuard acceptance: "Property X" (brief §44) and the 8-step provider
// harness (brief §43). Every step records HTTP output AND database state.
const { test, before, after } = require("node:test");
const assert = require("node:assert");
const S = require("./syncguard-helpers");
const H = require("./setup");

const ota = new S.FakeOta();
const record = S.evidence("acceptance");
let base;
let engine;
let Booking;
const { parseIcs } = require("../../services/calendarSync/icsReader");
const T0 = Date.now();
const at = (m) => new Date(T0 + m * 60_000);

before(async () => {
  base = (await H.start()).baseUrl;
  await ota.start();
  engine = require("../../services/calendarSync/engine");
  Booking = require("../../models/Booking");
  await Promise.all([require("../../models/ExternalCalendar").syncIndexes(), require("../../models/CalendarSyncLog").syncIndexes()]);
});
after(async () => {
  await ota.stop();
  await H.stop();
});

// The next 12 October at least two days away (the brief's dates).
function nextOct12() {
  const now = new Date();
  let y = now.getUTCFullYear();
  if (Date.UTC(y, 9, 12) - now.getTime() < 2 * 86_400_000) y += 1;
  return { d12: `${y}-10-12`, d13: `${y}-10-13`, d15: `${y}-10-15`, d16: `${y}-10-16` };
}
const D = nextOct12();
const feedOf = async (secret) => parseIcs(await (await fetch(`${base}/calendarSync/ics/${secret}.ics`)).text()).events.map((e) => `${e.startDay}..${e.endDay}`).sort();
async function connectAll(x, specs) {
  const out = {};
  for (const [name, channel, events] of specs) {
    const p = `/acc-${name}-${Math.random().toString(36).slice(2, 8)}.ics`;
    ota.events(p, events);
    const r = await H.api("POST", `/calendarSync/properties/${x.listing._id}/connections`, { token: x.token, body: { channel, url: ota.url(p) } });
    assert.strictEqual(r.status, 201, JSON.stringify(r.body));
    out[name] = { id: r.body.id, path: p, secret: r.body.data.connections.find((c) => c.id === r.body.id).export.url.match(/\/ics\/([^/]+)\.ics$/)[1] };
  }
  return out;
}

test("Property X: Person A books Airbnb 12→13 Oct — points 1–10 proven", async () => {
  const host = await H.makeUser({ firstName: "PropertyX" });
  const listing = await H.makeListing(host, { title: "Property X" });
  const x = { host, listing, token: H.userToken(host) };
  const c = await connectAll(x, [
    ["airbnb", "AIRBNB", []],
    ["agoda", "AGODA", []],
    ["generic", "GENERIC_ICAL", []],
  ]);
  const ev = { uid: "1418fb94e984-a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6@airbnb.com", start: D.d12, end: D.d13, summary: "Reserved" };
  ota.events(c.airbnb.path, [ev]);
  const steps = {};
  // 1. detection
  const s1 = await engine.syncConnection(c.airbnb.id, { force: true, now: at(1) });
  assert.strictEqual(s1.stats.added, 1);
  const row = await Booking.findOne({ propertyId: listing._id, source: "ical" }).lean();
  steps.p1 = { sync: s1.stats, rowId: String(row._id) };
  // 2. attribution
  assert.deepStrictEqual([row.external.channel, String(row.external.connectionId), row.external.uid, String(row.hostId)], ["AIRBNB", c.airbnb.id, ev.uid, String(host._id)]);
  steps.p2 = { channel: row.external.channel, connectionId: String(row.external.connectionId) };
  // 3. unavailable on Majestic (calendar + ledger)
  const cd = await H.api("GET", `/booking/check-dates/${listing._id}`);
  assert.ok(cd.body.data.includes(D.d12));
  assert.deepStrictEqual(await S.nightOwners(listing._id), { [D.d12]: "ical:AIRBNB" });
  steps.p3 = { checkDates: cd.body.data, nights: await S.nightOwners(listing._id) };
  // 4. not duplicated on the next syncs
  for (let i = 2; i <= 4; i++) await engine.syncConnection(c.airbnb.id, { force: true, now: at(i) });
  assert.strictEqual(await Booking.countDocuments({ propertyId: listing._id, source: "ical" }), 1);
  // 5. Airbnb's own feed does not mirror it back
  const fa = await feedOf(c.airbnb.secret);
  assert.deepStrictEqual(fa, []);
  // 6. Agoda and the generic calendar do get it
  const fg = await feedOf(c.agoda.secret);
  const fx = await feedOf(c.generic.secret);
  assert.deepStrictEqual(fg, [`${D.d12}..${D.d13}`]);
  assert.deepStrictEqual(fx, [`${D.d12}..${D.d13}`]);
  steps.p5p6 = { airbnbFeed: fa, agodaFeed: fg, genericFeed: fx };
  // 7. Majestic explains why 12 Oct is blocked
  const why = await H.api("GET", `/calendarSync/properties/${listing._id}/explain?date=${D.d12}`, { token: x.token });
  assert.strictEqual(why.body.data.reasons[0].channelLabel, "Airbnb");
  assert.ok(why.body.data.timeline.some((t) => t.type === "added"));
  steps.p7 = why.body.data;
  // 8. a direct Majestic booking cannot claim 12 Oct
  const guest = await H.makeUser();
  const direct = await H.api("POST", "/booking", { token: H.userToken(guest), body: H.bookingBody(listing, { checkIn: D.d12, checkOut: D.d13 }) });
  assert.strictEqual(direct.status, 409);
  steps.p8 = { status: direct.status, code: direct.body.code };
  // 9. Airbnb feed fails later: the block stays
  ota.set(c.airbnb.path, { status: 503, body: "" });
  await engine.syncConnection(c.airbnb.id, { force: true, now: at(10) });
  ota.set(c.airbnb.path, { hang: true });
  await engine.syncConnection(c.airbnb.id, { force: true, now: at(20), deadline: Date.now() + 400 });
  assert.deepStrictEqual(await S.nightOwners(listing._id), { [D.d12]: "ical:AIRBNB" });
  assert.deepStrictEqual(await feedOf(c.agoda.secret), [`${D.d12}..${D.d13}`], "Agoda keeps receiving it while Airbnb is down");
  steps.p9 = { nights: await S.nightOwners(listing._id) };
  // 10. cancellation releases safely: Airbnb's calendar is empty again — the
  // only event vanished (1 → 0), so the anomaly rule applies: blocked for
  // 12 h of successful syncs, then released; 12 Oct becomes bookable.
  ota.events(c.airbnb.path, []);
  const timeline = [];
  for (const m of [30, 90, 240, 480, 760]) {
    await engine.syncConnection(c.airbnb.id, { force: true, now: at(m) });
    timeline.push({ m, blocked: !!(await S.nightOwners(listing._id))[D.d12] });
  }
  assert.deepStrictEqual(timeline.map((t) => t.blocked), [true, true, true, true, false]);
  assert.deepStrictEqual(await feedOf(c.agoda.secret), []);
  const after = await H.api("POST", "/booking", { token: H.userToken(guest), body: H.bookingBody(listing, { checkIn: D.d12, checkOut: D.d13 }) });
  assert.strictEqual(after.status, 201, JSON.stringify(after.body));
  steps.p10 = { timeline, rebook: after.status };
  record("property-x", { steps, db: await S.snapshot(listing._id) });
});

test("8-step provider harness (brief §43)", async () => {
  const host = await H.makeUser();
  const listing = await H.makeListing(host);
  const x = { host, listing, token: H.userToken(host) };
  // Step 1: provider says Property X is available
  const c = await connectAll(x, [["airbnb", "AIRBNB", []], ["agoda", "AGODA", [{ uid: "AG-KEEP@agoda", start: S.day(80), end: S.day(81) }]]]);
  const steps = [];
  const snap = async (n, extra = {}) => steps.push({ step: n, nights: await S.nightOwners(listing._id), airbnbFeed: await feedOf(c.airbnb.secret), agodaFeed: await feedOf(c.agoda.secret), ...extra });
  await snap(1);
  assert.deepStrictEqual(steps[0].nights, { [S.day(80)]: "ical:AGODA" });
  // Step 2: AIRBNB-123 12→13
  const uid = "AIRBNB-123@airbnb.com";
  ota.events(c.airbnb.path, [{ uid, start: D.d12, end: D.d13, summary: "Reserved" }]);
  await engine.syncConnection(c.airbnb.id, { force: true, now: at(1) });
  await snap(2);
  assert.strictEqual(steps[1].nights[D.d12], "ical:AIRBNB");
  assert.ok(steps[1].agodaFeed.includes(`${D.d12}..${D.d13}`), "non-Airbnb feed contains the block");
  assert.ok(!steps[1].airbnbFeed.includes(`${D.d12}..${D.d13}`), "Airbnb feed excludes its own event");
  // Step 3: modified to 15→16
  ota.events(c.airbnb.path, [{ uid, start: D.d15, end: D.d16, summary: "Reserved" }]);
  await engine.syncConnection(c.airbnb.id, { force: true, now: at(2) });
  await snap(3);
  assert.ok(!steps[2].nights[D.d12] && steps[2].nights[D.d15] === "ical:AIRBNB", "12 Oct released, 15 Oct blocked");
  assert.ok(steps[2].agodaFeed.includes(`${D.d15}..${D.d16}`) && !steps[2].agodaFeed.includes(`${D.d12}..${D.d13}`));
  // Step 4: feed temporarily fails
  ota.set(c.airbnb.path, { status: 500, body: "" });
  const f = await engine.syncConnection(c.airbnb.id, { force: true, now: at(3) });
  await snap(4, { result: f.code });
  assert.strictEqual(steps[3].nights[D.d15], "ical:AIRBNB");
  // Step 5: feed becomes empty ONCE
  ota.events(c.airbnb.path, []);
  await engine.syncConnection(c.airbnb.id, { force: true, now: at(4) });
  await snap(5);
  assert.strictEqual(steps[4].nights[D.d15], "ical:AIRBNB", "no unsafe reopening");
  ota.events(c.airbnb.path, [{ uid, start: D.d15, end: D.d16, summary: "Reserved" }]);
  await engine.syncConnection(c.airbnb.id, { force: true, now: at(5) }); // back to normal
  // Step 6: confirmed cancellation
  ota.events(c.airbnb.path, [{ uid, start: D.d15, end: D.d16, summary: "Reserved", status: "CANCELLED" }]);
  await engine.syncConnection(c.airbnb.id, { force: true, now: at(6) });
  await snap(6);
  assert.ok(!steps[5].nights[D.d15], "released on an explicit cancellation");
  // Step 7: the same sync replayed
  const before7 = await Booking.countDocuments({ propertyId: listing._id });
  for (let i = 0; i < 3; i++) await engine.syncConnection(c.airbnb.id, { force: true, now: at(7 + i) });
  assert.strictEqual(await Booking.countDocuments({ propertyId: listing._id }), before7, "no duplicates");
  await snap(7);
  // Step 8: a Majestic booking is created → destination feeds update
  const guest = await H.makeUser();
  const t = H.userToken(guest);
  const b = await H.api("POST", "/booking", { token: t, body: H.bookingBody(listing, { checkIn: S.day(85), checkOut: S.day(87) }) });
  const o = await H.api("POST", "/payment/create-order", { token: t, body: { bookingId: b.body.data._id, amount: b.body.data.quote.totalPaise, currency: "INR" } });
  const pay = H.razorpay().__registerPayment({ id: "pay_acc_8", order_id: o.body.data.id, amount: o.body.data.amount, currency: "INR", status: "captured", method: "upi" });
  const v = await H.api("POST", "/payment/verify-payment", { token: t, body: { razorpay_order_id: o.body.data.id, razorpay_payment_id: pay.id, razorpay_signature: H.signature(o.body.data.id, pay.id) } });
  assert.strictEqual(v.status, 200);
  await snap(8);
  const M = `${S.day(85)}..${S.day(87)}`;
  assert.ok(steps[7].airbnbFeed.includes(M) && steps[7].agodaFeed.includes(M), "Majestic booking in every destination feed, immediately");
  record("eight-step-harness", { steps });
});

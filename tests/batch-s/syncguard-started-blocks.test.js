// SyncGuard: a STARTED block that disappears from a feed (docs/syncguard.md §3).
//
// Found in production 2026-11-28: an old Airbnb "Not available" window
// (12 Aug 2026 → 15 May 2027) that Airbnb had dropped was held as a stay "in
// progress" — never released by disappearance — so 65 nights free on Airbnb
// stayed blocked on Majestic for weeks. Only a provider's VERIFIED block
// marker (Airbnb) may narrow the started-stay protection; reservations,
// unknown entries and other providers' markers keep it.
const { test, before, after } = require("node:test");
const assert = require("node:assert");
const S = require("./syncguard-helpers");
const H = require("./setup");

const ota = new S.FakeOta();
let Booking;
let BookingNight;
let ExternalCalendar;
let engine;
let mongoose;

before(async () => {
  await H.start();
  await ota.start();
  mongoose = require("mongoose");
  Booking = require("../../models/Booking");
  BookingNight = require("../../models/BookingNight");
  ExternalCalendar = require("../../models/ExternalCalendar");
  engine = require("../../services/calendarSync/engine");
  await Promise.all([ExternalCalendar.syncIndexes(), require("../../models/CalendarSyncLog").syncIndexes()]);
});
after(async () => {
  await ota.stop();
  await H.stop();
});

const NA = "Airbnb (Not available)";
let seq = 0;
async function connected(channel, events) {
  const host = await H.makeUser();
  const listing = await H.makeListing(host);
  const p = `/sb${++seq}.ics`;
  ota.events(p, events);
  const r = await H.api("POST", `/calendarSync/properties/${listing._id}/connections`, { token: H.userToken(host), body: { channel, url: ota.url(p) } });
  assert.strictEqual(r.status, 201, JSON.stringify(r.body));
  const guest = await H.makeUser();
  return { listing, path: p, id: r.body.id, gToken: H.userToken(guest) };
}
const rowOf = (x, uid) => Booking.findOne({ "external.connectionId": new mongoose.Types.ObjectId(x.id), sourceId: uid }).lean();
const state = (b) => [b.status, b.external.state];
// syncs at t0, t0 + 61 min, … (the release rule needs ≥ 3 syncs over ≥ 2 h)
async function syncs(x, t0, from, to) {
  for (let k = from; k <= to; k++) await engine.syncConnection(x.id, { force: true, now: new Date(t0 + k * 61 * 60_000) });
}

test("Airbnb 'Not available' block that already started: the host reopens the dates → released after the normal confirmation", async () => {
  const future = { uid: "R1@airbnb.com", start: S.day(20), end: S.day(22), summary: "Reserved" };
  const x = await connected("AIRBNB", [{ uid: "B1@airbnb.com", start: S.day(-2), end: S.day(6), summary: NA }, future]);
  const block = await rowOf(x, "B1@airbnb.com");
  assert.strictEqual(block.external.kind, "blocked");
  assert.ok((await BookingNight.countDocuments({ bookingId: block._id })) >= 6, "owns tonight onwards");

  ota.events(x.path, [future]); // the host reopened the remaining nights on Airbnb
  const t0 = Date.now();
  await syncs(x, t0, 0, 1);
  assert.deepStrictEqual(state(await rowOf(x, "B1@airbnb.com")), ["confirmed", "missing"], "still blocking before the confirmation window");
  await syncs(x, t0, 2, 2);
  const after = await rowOf(x, "B1@airbnb.com");
  assert.deepStrictEqual(state(after), ["cancelled", "removed"]);
  assert.strictEqual(after.external.releaseReason, "missing_confirmed");
  assert.strictEqual(await BookingNight.countDocuments({ bookingId: block._id }), 0, "nights freed");
  assert.deepStrictEqual(state(await rowOf(x, "R1@airbnb.com")), ["confirmed", "active"], "the other booking is untouched");
  assert.strictEqual((await ExternalCalendar.findById(x.id).lean()).sync.anomaly, null);
});

test("Airbnb re-issues a started block from today under a new UID: the old row goes, the remaining nights stay blocked for guests and direct bookings", async () => {
  const future = { uid: "R2@airbnb.com", start: S.day(20), end: S.day(22), summary: "Reserved" };
  const x = await connected("AIRBNB", [{ uid: "OLD@airbnb.com", start: S.day(-2), end: S.day(6), summary: NA }, future]);
  ota.events(x.path, [{ uid: "NEW@airbnb.com", start: S.day(0), end: S.day(6), summary: NA }, future]);
  const t0 = Date.now();
  await syncs(x, t0, 0, 2);
  assert.deepStrictEqual(state(await rowOf(x, "OLD@airbnb.com")), ["cancelled", "removed"]);
  const fresh = await rowOf(x, "NEW@airbnb.com");
  assert.deepStrictEqual(state(fresh), ["confirmed", "active"]);

  // Guests still see every remaining night as taken …
  const cal = await H.api("GET", `/booking/check-dates/${x.listing._id}`);
  assert.strictEqual(cal.status, 200);
  for (let d = 0; d < 6; d++) assert.ok(cal.body.data.includes(S.day(d)), `${S.day(d)} still blocked`);
  // … and a direct booking on them is refused, even before the daily full pass re-claims the nights
  const r = await H.api("POST", "/booking", { token: x.gToken, body: H.bookingBody(x.listing, { checkIn: S.day(2), checkOut: S.day(4) }) });
  assert.strictEqual(r.status, 409, JSON.stringify(r.body));
  assert.strictEqual(r.body.code, "DATES_UNAVAILABLE");

  // The full pass hands the nights to the new row.
  await engine.syncConnection(x.id, { force: true, full: true, now: new Date(t0 + 3 * 61 * 60_000) });
  const owners = await S.nightOwners(x.listing._id);
  for (let d = 1; d < 6; d++) assert.strictEqual(owners[S.day(d)], "ical:AIRBNB", `${S.day(d)} owned by the import`);
  assert.strictEqual(await BookingNight.countDocuments({ bookingId: fresh._id, date: { $gte: new Date(`${S.day(1)}T00:00:00Z`), $lt: new Date(`${S.day(6)}T00:00:00Z`) } }), 5);
});

test("an Airbnb reservation or an unlabelled entry that already started stays protected (some feeds drop a stay at check-in)", async () => {
  // three future bookings stay, so two vanishing rows are below the mass-disappearance share
  const future = [20, 24, 28].map((d) => ({ uid: `R3-${d}@airbnb.com`, start: S.day(d), end: S.day(d + 2), summary: "Reserved" }));
  const x = await connected("AIRBNB", [
    { uid: "STAY@airbnb.com", start: S.day(-1), end: S.day(3), summary: "Reserved" },
    { uid: "PLAIN@airbnb.com", start: S.day(-3), end: S.day(9) },
    ...future,
  ]);
  assert.strictEqual((await rowOf(x, "PLAIN@airbnb.com")).external.kind, "unknown");
  ota.events(x.path, future);
  await syncs(x, Date.now(), 0, 4);
  assert.deepStrictEqual(state(await rowOf(x, "STAY@airbnb.com")), ["confirmed", "missing"]);
  assert.deepStrictEqual(state(await rowOf(x, "PLAIN@airbnb.com")), ["confirmed", "missing"]);
  assert.strictEqual((await rowOf(x, "STAY@airbnb.com")).external.missingMass, false, "judged by the started-stay rule, not the anomaly");
});

test("a started 'Not available' block of a provider whose marker is not verified (Booking.com) stays protected", async () => {
  const future = { uid: "F4@booking.com", start: S.day(20), end: S.day(22), summary: "CLOSED - Not available" };
  const x = await connected("BOOKING_COM", [{ uid: "B4@booking.com", start: S.day(-1), end: S.day(4), summary: "CLOSED - Not available" }, future]);
  assert.strictEqual((await rowOf(x, "B4@booking.com")).external.kind, "blocked");
  ota.events(x.path, [future]);
  await syncs(x, Date.now(), 0, 4);
  assert.deepStrictEqual(state(await rowOf(x, "B4@booking.com")), ["confirmed", "missing"]);
});

test("a started Airbnb block still counts towards the mass-disappearance safeguard (12 h, not 2 h)", async () => {
  const x = await connected("AIRBNB", [{ uid: "ONLY@airbnb.com", start: S.day(-2), end: S.day(6), summary: NA }]);
  ota.events(x.path, []); // the whole calendar came back empty
  const t0 = Date.now();
  await syncs(x, t0, 0, 4);
  const held = await rowOf(x, "ONLY@airbnb.com");
  assert.deepStrictEqual(state(held), ["confirmed", "missing"], "still blocking after 4 h");
  assert.strictEqual(held.external.missingMass, true);
  assert.strictEqual((await ExternalCalendar.findById(x.id).lean()).sync.anomaly, "MASS_DISAPPEARANCE");
  await engine.syncConnection(x.id, { force: true, now: new Date(t0 + 13 * 3600_000) });
  const after = await rowOf(x, "ONLY@airbnb.com");
  assert.deepStrictEqual(state(after), ["cancelled", "removed"]);
  assert.strictEqual(after.external.releaseReason, "missing_confirmed_after_anomaly");
});

// --- boundaries, edge and negative cases ---------------------------------------------
const at = (x, t0, min) => engine.syncConnection(x.id, { force: true, now: new Date(t0 + min * 60_000) });
const KEEP = { uid: "KEEP@airbnb.com", start: S.day(180), end: S.day(182), summary: "Reserved" };
const blockEv = (start, end, summary = NA) => ({ uid: "B@airbnb.com", start: S.day(start), end: S.day(end), summary });
const blockState = async (x) => state(await rowOf(x, "B@airbnb.com"));

for (const [label, start, end] of [["100 days ago (like production)", -100, 170], ["yesterday", -1, 5], ["today", 0, 5], ["tomorrow (not started)", 1, 5]]) {
  test(`boundary: an Airbnb block starting ${label} is released by the normal rule once Airbnb drops it`, async () => {
    const x = await connected("AIRBNB", [blockEv(start, end), KEEP]);
    const block = await rowOf(x, "B@airbnb.com");
    assert.strictEqual(block.external.kind, "blocked");
    ota.events(x.path, [KEEP]);
    const t0 = Date.now();
    await syncs(x, t0, 0, 1);
    assert.deepStrictEqual(await blockState(x), ["confirmed", "missing"]);
    await syncs(x, t0, 2, 2);
    assert.deepStrictEqual(await blockState(x), ["cancelled", "removed"]);
    assert.strictEqual(await BookingNight.countDocuments({ bookingId: block._id }), 0);
  });
}

test("boundary: released at exactly 2 h after it vanished, not a minute earlier", async () => {
  const x = await connected("AIRBNB", [blockEv(-3, 4), KEEP]);
  ota.events(x.path, [KEEP]);
  const t0 = Date.now();
  for (const m of [0, 60, 119]) await at(x, t0, m);
  assert.deepStrictEqual(await blockState(x), ["confirmed", "missing"], "3 checks but 1 h 59 min");
  await at(x, t0, 120);
  assert.deepStrictEqual(await blockState(x), ["cancelled", "removed"], "2 h 00 min");
});

test("boundary: 3 h but only 2 checks is not enough; the 3rd check releases it", async () => {
  const x = await connected("AIRBNB", [blockEv(-3, 4), KEEP]);
  ota.events(x.path, [KEEP]);
  const t0 = Date.now();
  await at(x, t0, 0);
  await at(x, t0, 180);
  assert.deepStrictEqual(await blockState(x), ["confirmed", "missing"]);
  await at(x, t0, 181);
  assert.deepStrictEqual(await blockState(x), ["cancelled", "removed"]);
});

test("edge: the block reappears before it is released → the count starts again", async () => {
  const x = await connected("AIRBNB", [blockEv(-3, 4), KEEP]);
  const t0 = Date.now();
  ota.events(x.path, [KEEP]);
  await at(x, t0, 0);
  await at(x, t0, 60);
  ota.events(x.path, [blockEv(-3, 4), KEEP]); // back on Airbnb
  await at(x, t0, 90);
  const back = await rowOf(x, "B@airbnb.com");
  assert.deepStrictEqual([back.external.state, back.external.missingSyncs || 0], ["active", 0]);
  ota.events(x.path, [KEEP]); // gone again
  for (const m of [100, 160, 219]) await at(x, t0, m);
  assert.deepStrictEqual(await blockState(x), ["confirmed", "missing"], "1 h 59 min since it vanished the 2nd time");
  await at(x, t0, 220);
  assert.deepStrictEqual(await blockState(x), ["cancelled", "removed"]);
});

test("negative: while Airbnb's calendar fails to load (HTTP 500) nothing is released, even after 3 h", async () => {
  const x = await connected("AIRBNB", [blockEv(-3, 4), KEEP]);
  const block = await rowOf(x, "B@airbnb.com");
  const owned = await BookingNight.countDocuments({ bookingId: block._id });
  const t0 = Date.now();
  ota.set(x.path, { status: 500, body: "Internal Server Error" });
  for (const m of [0, 61, 122, 183]) await at(x, t0, m);
  assert.deepStrictEqual(await blockState(x), ["confirmed", "active"], "a failed fetch is never an absence");
  assert.strictEqual(await BookingNight.countDocuments({ bookingId: block._id }), owned);
  ota.events(x.path, [KEEP]); // the calendar loads again, without the block: the count starts now
  await at(x, t0, 184);
  await at(x, t0, 245);
  assert.deepStrictEqual(await blockState(x), ["confirmed", "missing"]);
  await at(x, t0, 304);
  assert.deepStrictEqual(await blockState(x), ["cancelled", "removed"]);
});

test("safety: the started block vanishing with another booking (2 of 3 at once) is an anomaly: held 12 h", async () => {
  const r1 = { uid: "R1@airbnb.com", start: S.day(40), end: S.day(42), summary: "Reserved" };
  const r2 = { uid: "R2@airbnb.com", start: S.day(50), end: S.day(52), summary: "Reserved" };
  const x = await connected("AIRBNB", [blockEv(-2, 6), r1, r2]);
  ota.events(x.path, [r2]);
  const t0 = Date.now();
  for (const m of [0, 61, 122, 183, 244]) await at(x, t0, m);
  const held = await rowOf(x, "B@airbnb.com");
  assert.deepStrictEqual([...state(held), held.external.missingMass], ["confirmed", "missing", true], "still blocked after 4 h");
  assert.deepStrictEqual(state(await rowOf(x, "R1@airbnb.com")), ["confirmed", "missing"]);
  assert.strictEqual((await ExternalCalendar.findById(x.id).lean()).sync.anomaly, "MASS_DISAPPEARANCE");
  await at(x, t0, 12 * 60 + 1);
  for (const uid of ["B@airbnb.com", "R1@airbnb.com"]) {
    const r = await rowOf(x, uid);
    assert.deepStrictEqual([...state(r), r.external.releaseReason], ["cancelled", "removed", "missing_confirmed_after_anomaly"], uid);
  }
  assert.deepStrictEqual(state(await rowOf(x, "R2@airbnb.com")), ["confirmed", "active"]);
});

test("edge: Airbnb marks the started block CANCELLED → released at once", async () => {
  const x = await connected("AIRBNB", [blockEv(-2, 6), KEEP]);
  const block = await rowOf(x, "B@airbnb.com");
  ota.events(x.path, [{ ...blockEv(-2, 6), status: "CANCELLED" }, KEEP]);
  await at(x, Date.now(), 0);
  assert.strictEqual((await rowOf(x, "B@airbnb.com")).status, "cancelled");
  assert.strictEqual(await BookingNight.countDocuments({ bookingId: block._id }), 0);
});

test("negative: a block held for the host (calendar link replaced) is still released only by the host", async () => {
  const x = await connected("AIRBNB", [blockEv(-2, 6), KEEP]);
  const block = await rowOf(x, "B@airbnb.com");
  await Booking.updateOne({ _id: block._id }, { $set: { "external.hostHold": true } });
  ota.events(x.path, [KEEP]);
  await syncs(x, Date.now(), 0, 4);
  assert.deepStrictEqual(await blockState(x), ["confirmed", "missing"]);
});

for (const channel of ["AGODA", "VRBO", "GENERIC_ICAL"]) {
  test(`negative: a started 'Not available' entry from ${channel} (marker not verified) stays blocked`, async () => {
    const keep = { uid: "K@ota.test", start: S.day(40), end: S.day(42) };
    const x = await connected(channel, [{ uid: "B@ota.test", start: S.day(-2), end: S.day(6), summary: "Not available" }, keep]);
    ota.events(x.path, [keep]);
    await syncs(x, Date.now(), 0, 4);
    assert.deepStrictEqual(state(await rowOf(x, "B@ota.test")), ["confirmed", "missing"]);
  });
}

test("edge: Airbnb's short label 'Not available' is recognised as a block too", async () => {
  const x = await connected("AIRBNB", [blockEv(-2, 6, "Not available"), KEEP]);
  assert.strictEqual((await rowOf(x, "B@airbnb.com")).external.kind, "blocked");
  ota.events(x.path, [KEEP]);
  await syncs(x, Date.now(), 0, 2);
  assert.deepStrictEqual(await blockState(x), ["cancelled", "removed"]);
});

test("boundary (India midnight): on its check-in day in India an Airbnb reservation stays protected, an Airbnb block does not", async () => {
  // 19:30 UTC the day before = 01:00 IST on the check-in day
  const checkIn = S.day(3);
  const t0 = Date.parse(`${checkIn}T00:00:00Z`) - 4.5 * 3600_000;
  const stay = await connected("AIRBNB", [{ uid: "STAY@airbnb.com", start: checkIn, end: S.day(5), summary: "Reserved" }, KEEP]);
  const blk = await connected("AIRBNB", [blockEv(3, 6), KEEP]);
  ota.events(stay.path, [KEEP]);
  ota.events(blk.path, [KEEP]);
  for (let k = 0; k < 6; k++) {
    await at(stay, t0, k * 50);
    await at(blk, t0, k * 50);
  }
  assert.deepStrictEqual(state(await rowOf(stay, "STAY@airbnb.com")), ["confirmed", "missing"], "a guest may be arriving: kept");
  assert.deepStrictEqual(await blockState(blk), ["cancelled", "removed"]);
});

test("end to end: once released, the nights show as free to guests and can be booked; Airbnb's other booking still cannot", async () => {
  const x = await connected("AIRBNB", [blockEv(-3, 8), KEEP]);
  let cal = await H.api("GET", `/booking/check-dates/${x.listing._id}`);
  assert.ok(cal.body.data.includes(S.day(4)), "blocked while Airbnb has it");
  ota.events(x.path, [KEEP]);
  await engine.syncConnection(x.id, { force: true }); // real clock: noticed as missing
  // 3 h pass with 2 checks done: rewind the stored disappearance instead of mixing a simulated clock with the real one
  const block = await rowOf(x, "B@airbnb.com");
  await Booking.updateOne({ _id: block._id }, { $set: { "external.missingSince": new Date(Date.now() - 3 * 3600_000), "external.missingSyncs": 2 } });
  await engine.syncConnection(x.id, { force: true });
  assert.deepStrictEqual(await blockState(x), ["cancelled", "removed"]);
  cal = await H.api("GET", `/booking/check-dates/${x.listing._id}`);
  assert.ok(![S.day(4), S.day(5)].some((d) => cal.body.data.includes(d)), "free for guests");
  const ok = await H.api("POST", "/booking", { token: x.gToken, body: H.bookingBody(x.listing, { checkIn: S.day(4), checkOut: S.day(6) }) });
  assert.strictEqual(ok.status, 201, JSON.stringify(ok.body));
  const other = H.userToken(await H.makeUser());
  const refused = await H.api("POST", "/booking", { token: other, body: H.bookingBody(x.listing, { checkIn: S.day(180), checkOut: S.day(182) }) });
  assert.strictEqual(refused.status, 409, JSON.stringify(refused.body));
  assert.strictEqual(refused.body.code, "DATES_UNAVAILABLE");
});

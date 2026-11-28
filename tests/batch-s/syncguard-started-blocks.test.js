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

// SyncGuard: regressions for the THIRD adversarial pass (re-review of the
// second review's fixes; docs/syncguard.md §22). Each test reproduces the
// reviewer's verified experiment and asserts the fixed behaviour.
const { test, before, after } = require("node:test");
const assert = require("node:assert");
const S = require("./syncguard-helpers");
const H = require("./setup");

const ota = new S.FakeOta();
let Booking;
let BookingNight;
let ExternalCalendar;
let engine;
let ics;
let mongoose;

before(async () => {
  await H.start();
  await ota.start();
  mongoose = require("mongoose");
  Booking = require("../../models/Booking");
  BookingNight = require("../../models/BookingNight");
  ExternalCalendar = require("../../models/ExternalCalendar");
  engine = require("../../services/calendarSync/engine");
  ics = require("../../services/calendarSync/icsReader");
});
after(async () => {
  await ota.stop();
  await H.stop();
});

let seq = 0;
const reserved = (uid, a, b) => ({ uid, start: S.day(a), end: S.day(b), summary: "Reserved" });
async function setup(channel, events) {
  const h = await H.makeUser();
  const listing = await H.makeListing(h);
  const token = H.userToken(h);
  const p = `/r3-${++seq}.ics`;
  ota.events(p, events);
  const c = await H.api("POST", `/calendarSync/properties/${listing._id}/connections`, { token, body: { channel, url: ota.url(p) } });
  assert.strictEqual(c.status, 201, JSON.stringify(c.body));
  return { host: h, listing, token, path: p, id: c.body.id };
}
const book = async (x, a, b) => H.api("POST", "/booking", { token: H.userToken(await H.makeUser()), body: H.bookingBody(x.listing, { checkIn: S.day(a), checkOut: S.day(b) }) });
const feed = async (secret, ua = "Airbnb Calendar Fetcher/1.0") => (await fetch(`${H.baseUrl()}/calendarSync/ics/${secret}.ics`, { headers: { "user-agent": ua } })).status;
const listOf = async (x) => (await H.api("GET", `/calendarSync/properties/${x.listing._id}/connections`, { token: x.token })).body.data;
const mdy = (n) => {
  const [y, m, d] = S.day(n).split("-");
  return `${m}/${d}/${y}`;
};
const night = (d) => new Date(`${S.day(d)}T00:00:00Z`);
const wrap = (lines) => ["BEGIN:VCALENDAR", "VERSION:2.0", ...lines, "END:VCALENDAR"].join("\r\n");
async function paidBooking(x, a, b) {
  const t = H.userToken(await H.makeUser());
  const r = await H.api("POST", "/booking", { token: t, body: H.bookingBody(x.listing, { checkIn: S.day(a), checkOut: S.day(b) }) });
  assert.strictEqual(r.status, 201, JSON.stringify(r.body));
  const o = await H.api("POST", "/payment/create-order", { token: t, body: { bookingId: r.body.data._id, amount: r.body.data.quote.totalPaise, currency: "INR" } });
  assert.strictEqual(o.status, 200, JSON.stringify(o.body));
  const pay = H.razorpay().__registerPayment({ id: `pay_r3_${Date.now()}_${++seq}`, order_id: o.body.data.id, amount: o.body.data.amount, currency: "INR", status: "captured", method: "upi" });
  await H.api("POST", "/payment/verify-payment", { token: t, body: { razorpay_order_id: o.body.data.id, razorpay_payment_id: pay.id, razorpay_signature: H.signature(o.body.data.id, pay.id) } });
  return r.body.data;
}

test("R1: reconnecting keeps the OTA's Majestic link; a disconnected site's live link is listed and can be stopped", async () => {
  const x = await setup("AIRBNB", [reserved("R1@airbnb.com", 20, 22)]);
  const s1 = (await ExternalCalendar.findById(x.id).lean()).secret;
  assert.strictEqual(await feed(s1), 200);
  assert.strictEqual((await H.api("POST", `/calendarSync/connections/${x.id}/disconnect`, { token: x.token, body: { acknowledge: true } })).status, 200);
  assert.strictEqual(await feed(s1), 200, "still serves while disconnected");
  const gone = (await listOf(x)).disconnected.find((d) => d.id === x.id);
  assert.ok(gone && gone.linkLive === true, "the host sees the live link");
  assert.ok(!JSON.stringify(gone).includes(s1), "the token itself is not returned");
  // reconnect the same calendar: the OTA's saved link keeps working
  const re = await H.api("POST", `/calendarSync/properties/${x.listing._id}/connections`, { token: x.token, body: { channel: "AIRBNB", url: ota.url(x.path) } });
  assert.strictEqual(re.body.reconnected, true);
  assert.strictEqual((await ExternalCalendar.findById(x.id).lean()).secret, s1, "same link after reconnect");
  assert.strictEqual(await feed(s1), 200);
  // an active connection's link is not "stopped" (it is replaced instead)
  assert.strictEqual((await H.api("POST", `/calendarSync/connections/${x.id}/stop-export`, { token: x.token })).status, 409);
  // disconnect again, then stop the link: revoked at once, and no longer listed
  await H.api("POST", `/calendarSync/connections/${x.id}/disconnect`, { token: x.token, body: { acknowledge: true, releaseBlocks: true } });
  const other = await H.api("POST", `/calendarSync/connections/${x.id}/stop-export`, { token: H.userToken(await H.makeUser()) });
  assert.strictEqual(other.status, 404, "another account cannot stop it (no oracle)");
  const stop = await H.api("POST", `/calendarSync/connections/${x.id}/stop-export`, { token: x.token });
  assert.strictEqual(stop.status, 200, JSON.stringify(stop.body));
  assert.strictEqual(await feed(s1), 404);
  assert.ok(!(await listOf(x)).disconnected.some((d) => d.id === x.id), "nothing left to show");
  // reconnecting after a stop issues a NEW link (the stopped one stays dead)
  await H.api("POST", `/calendarSync/properties/${x.listing._id}/connections`, { token: x.token, body: { channel: "AIRBNB", url: ota.url(x.path) } });
  const s2 = (await ExternalCalendar.findById(x.id).lean()).secret;
  assert.ok(s2 && s2 !== s1);
  assert.strictEqual(await feed(s1), 404);
});

test("R2: the legacy endpoint never replaces a link that is only failing for now (429 ×5) — the old blocks stay", async (t) => {
  const channels = require("../../services/calendarSync/channels");
  t.mock.method(channels, "inferChannel", () => "AIRBNB");
  const x = await setup("AIRBNB", [reserved("R2-A@airbnb.com", 20, 23), reserved("R2-B@airbnb.com", 40, 42)]);
  ota.set(x.path, { status: 429, body: "" });
  for (let i = 0; i < 5; i++) await engine.syncConnection(x.id, { force: true });
  assert.strictEqual((await listOf(x)).connections[0].health.state, "BROKEN");
  ota.events(x.path, [reserved("R2-A@airbnb.com", 20, 23), reserved("R2-B@airbnb.com", 40, 42)]);
  const other = `/r3-${++seq}.ics`;
  ota.events(other, [reserved("OTHER@airbnb.com", 70, 71)]);
  const save = await H.api("POST", "/calendarSync/saveCalendar", { token: x.token, body: { propertyId: String(x.listing._id), kind: "import", url: ota.url(other) } });
  assert.strictEqual(save.status, 200);
  assert.doesNotMatch(String(save.body.message), /replaced/i);
  assert.strictEqual(await ExternalCalendar.countDocuments({ propertyId: x.listing._id, kind: "import", status: "active" }), 2, "added beside it");
  assert.strictEqual((await ExternalCalendar.findById(x.id).lean()).url, ota.url(x.path), "the old link is untouched");
  await ExternalCalendar.updateMany({ propertyId: x.listing._id }, { $set: { "sync.lastSuccessAt": new Date(Date.now() - 10 * 60_000) } });
  assert.strictEqual((await book(x, 20, 23)).status, 409, "the Airbnb guest's nights stay blocked");
});

test("R2b: a reset link (404) replaced through the legacy endpoint keeps the old link's bookings blocking until the host confirms", async (t) => {
  const channels = require("../../services/calendarSync/channels");
  t.mock.method(channels, "inferChannel", () => "AIRBNB");
  const x = await setup("AIRBNB", [reserved("R2B-A@airbnb.com", 20, 23), reserved("R2B-B@airbnb.com", 40, 42)]);
  ota.set(x.path, { status: 404, body: "" });
  for (let i = 0; i < 3; i++) await engine.syncConnection(x.id, { force: true });
  // "not found" for hours (the replacement rule, §8.3): 3 failures, nothing good for 6 h
  await ExternalCalendar.updateOne({ _id: x.id }, { $set: { "sync.lastSuccessAt": new Date(Date.now() - 7 * 3600_000) } });
  assert.strictEqual((await listOf(x)).connections[0].health.state, "BROKEN");
  // the pasted link shows only one of the two stays (e.g. another listing)
  const fresh = `/r3-${++seq}.ics`;
  ota.events(fresh, [reserved("R2B-B@airbnb.com", 40, 42)]);
  const save = await H.api("POST", "/calendarSync/saveCalendar", { token: x.token, body: { propertyId: String(x.listing._id), kind: "import", url: ota.url(fresh) } });
  assert.match(save.body.message, /replaced/i);
  const t0 = Date.now();
  for (let k = 1; k <= 6; k++) await engine.syncConnection(x.id, { force: true, now: new Date(t0 + k * 4 * 3600_000) });
  const a = await Booking.findOne({ "external.connectionId": new mongoose.Types.ObjectId(x.id), "external.uid": "R2B-A@airbnb.com" }).lean();
  assert.strictEqual(a.status, "confirmed", "not released by the missing rules");
  assert.strictEqual(a.external.state, "missing");
  assert.strictEqual(await BookingNight.countDocuments({ bookingId: a._id }), 3);
  // the host confirms it was cancelled
  const rel = await H.api("POST", `/calendarSync/connections/${x.id}/release-blocks`, { token: x.token, body: { acknowledge: true } });
  assert.strictEqual(rel.status, 200, JSON.stringify(rel.body));
  assert.strictEqual((await Booking.findById(a._id).lean()).status, "cancelled");
  const b = await Booking.findOne({ "external.connectionId": new mongoose.Types.ObjectId(x.id), "external.uid": "R2B-B@airbnb.com" }).lean();
  assert.strictEqual(b.status, "confirmed", "the stay the new link shows is untouched");
  assert.notStrictEqual(b.external.hostHold, true, "back under the feed's control");
});

test("R3: EXDATE values are bounded (per event and per file); past the cap the event over-blocks and says so", () => {
  const many = Array.from({ length: 1500 }, (_, i) => `2026${String(11 + Math.floor(i / 28)).slice(-2).padStart(2, "0")}${String((i % 28) + 1).padStart(2, "0")}T150000`).join(",");
  let t0 = Date.now();
  const r = ics.parseIcs(wrap(["BEGIN:VEVENT", "UID:ex1", "DTSTART:20261201T150000", "DTEND:20261201T160000", "RRULE:FREQ=DAILY;COUNT=5", `EXDATE:20261202T150000,${many}`, "END:VEVENT"]), { now: new Date("2026-10-03T06:00:00Z") });
  assert.ok(Date.now() - t0 < 500);
  assert.strictEqual(r.events.length, 5, "every occurrence blocks (exceptions ignored)");
  assert.strictEqual(r.stats.tooManyExceptions, 1);
  // a huge single EXDATE line under an unknown zone (the reviewer's 2 MB case: 2.1–4.5 s before)
  const big = Array.from({ length: 130_000 }, () => "20261102T150000").join(",");
  t0 = Date.now();
  ics.parseIcs(wrap(["BEGIN:VEVENT", "UID:ex2", "DTSTART:20261101T150000", "DTEND:20261101T160000", "RRULE:FREQ=DAILY;COUNT=5", `EXDATE;TZID=${"Q".repeat(128)}:${big}`, "END:VEVENT"]), { now: new Date("2026-10-03T06:00:00Z") });
  const ms = Date.now() - t0;
  assert.ok(ms < 500, `${ms} ms`);
  // many distinct unknown zone names: each validation is bounded per file
  const evs = [];
  for (let i = 0; i < 600; i++) {
    const tz = "Q" + i.toString(36).padStart(127, "z");
    evs.push("BEGIN:VEVENT", `UID:z${i}`, `DTSTART;TZID=${tz}:20261101T150000`, `DTEND;TZID=${tz}:20261102T100000`, "END:VEVENT");
  }
  t0 = Date.now();
  const z = ics.parseIcs(wrap(evs), { now: new Date("2026-10-03T06:00:00Z") });
  assert.strictEqual(z.stats.unknownTz, 1200);
  assert.ok(Date.now() - t0 < 500, `${Date.now() - t0} ms`);
  // a normal file with real zones is unaffected
  const ok = ics.parseIcs(wrap(["BEGIN:VEVENT", "UID:k", "DTSTART;TZID=Asia/Kolkata:20261110T150000", "DTEND;TZID=Asia/Kolkata:20261112T100000", "END:VEVENT"]), { now: new Date("2026-10-03T06:00:00Z") });
  assert.strictEqual(ok.stats.unknownTz, 0);
});

function raceRevWrites(times) {
  const orig = Booking.updateOne;
  let fired = 0;
  Booking.updateOne = function patched(filter, ...rest) {
    if (fired < times && filter && filter["external.rev"] !== undefined) {
      fired += 1;
      return Promise.resolve({ matchedCount: 0, modifiedCount: 0 });
    }
    return orig.call(this, filter, ...rest);
  };
  return { restore: () => (Booking.updateOne = orig), fired: () => fired };
}

test("R4: a booking-time check whose sync lost a write race is not 'verified': it reads again, and refuses if it races again", async () => {
  const x = await setup("AIRBNB", [reserved("R4@airbnb.com", 110, 112)]);
  ota.events(x.path, [reserved("R4@airbnb.com", 110, 113)]); // the OTA guest extends by a night
  await ExternalCalendar.updateOne({ _id: x.id }, { $set: { "sync.lastSuccessAt": new Date(Date.now() - 10 * 60_000) } });
  const once = raceRevWrites(1);
  let r;
  try {
    r = await book(x, 112, 113);
  } finally {
    once.restore();
  }
  assert.strictEqual(once.fired(), 1);
  assert.deepStrictEqual([r.status, r.body.code], [409, "DATES_UNAVAILABLE"], "the second read applied the extension");
  const y = await setup("AIRBNB", [reserved("R4b@airbnb.com", 110, 112)]);
  ota.events(y.path, [reserved("R4b@airbnb.com", 110, 113)]);
  await ExternalCalendar.updateOne({ _id: y.id }, { $set: { "sync.lastSuccessAt": new Date(Date.now() - 10 * 60_000) } });
  const always = raceRevWrites(1000);
  try {
    r = await book(y, 112, 113);
  } finally {
    always.restore();
  }
  assert.deepStrictEqual([r.status, r.body.code], [409, "AVAILABILITY_UNVERIFIED"]);
});

test("R5: an OTA double sale that arrives while another admin item is open reaches the admin queue once that item is closed", async () => {
  const x = await setup("AGODA", []);
  const b = await paidBooking(x, 50, 52);
  await Booking.updateOne({ _id: b._id }, { $set: { needsAttention: "amount_mismatch", "notifications.attentionAt": new Date() } });
  ota.events(x.path, [{ uid: "R5@agoda.com", start: S.day(50), end: S.day(52) }]);
  await engine.syncConnection(x.id, { force: true });
  const imp = await Booking.findOne({ propertyId: x.listing._id, source: "ical" }).lean();
  assert.strictEqual(imp.external.conflict.kind, "paid_booking");
  assert.ok(!imp.external.conflict.adminFlaggedAt, "not recorded as queued: the other item held the booking");
  const admin = H.adminToken(await H.makeAdmin());
  assert.strictEqual((await H.api("PATCH", "/booking/admin/attention/resolve", { token: admin, body: { bookingId: String(b._id), resolution: "dismiss" } })).status, 200);
  await engine.syncConnection(x.id, { force: true, full: true, now: new Date(Date.now() + 86_400_000) });
  assert.strictEqual((await Booking.findById(b._id).lean()).needsAttention, "ota_conflict");
  assert.ok((await Booking.findById(imp._id).lean()).external.conflict.adminFlaggedAt);
});

test("R6: a resolved conflict does not re-alert while the stay is in progress (past nights dropping off is not new)", async () => {
  const x = await setup("AGODA", []);
  const b = await paidBooking(x, 5, 9);
  ota.events(x.path, [{ uid: "R6@agoda.com", start: S.day(5), end: S.day(9) }]);
  await engine.syncConnection(x.id, { force: true });
  assert.strictEqual((await Booking.findById(b._id).lean()).needsAttention, "ota_conflict");
  const admin = H.adminToken(await H.makeAdmin());
  assert.strictEqual((await H.api("PATCH", "/booking/admin/attention/resolve", { token: admin, body: { bookingId: String(b._id), resolution: "keep" } })).status, 200);
  H.resetEmails();
  const base = Date.now();
  for (const d of [1, 6, 7]) {
    await engine.syncConnection(x.id, { force: true, full: true, now: new Date(base + d * 86_400_000) });
    assert.strictEqual((await Booking.findById(b._id).lean()).needsAttention, null, `day +${d}`);
  }
  assert.strictEqual(H.sentEmails().length, 0);
});

test("R7: Confirm never reclaims the expired hold-style nights of a PAID booking (crash between paid and permanent)", async () => {
  const x = await setup("AIRBNB", []);
  const g = await H.makeUser();
  const id = new mongoose.Types.ObjectId();
  await Booking.create({ _id: id, userId: g._id, hostId: x.host._id, propertyId: x.listing._id, source: "local", action: "user", checkIn: night(130), checkOut: night(132), nights: 2, price: 1, subTotal: 1, currency: "INR", status: "confirmed", paymentStatus: "paid", guests: 1 });
  await BookingNight.insertMany([130, 131].map((d) => ({ propertyId: x.listing._id, date: night(d), bookingId: id, kind: "booking", expiresAt: new Date(Date.now() - 60_000) })));
  const r = await book(x, 130, 132);
  assert.strictEqual(r.status, 409, JSON.stringify(r.body));
  assert.strictEqual(await BookingNight.countDocuments({ bookingId: id }), 2, "the paid stay keeps its nights");
  // an unpaid expired hold is still reclaimed as before
  const u = new mongoose.Types.ObjectId();
  await Booking.create({ _id: u, userId: g._id, hostId: x.host._id, propertyId: x.listing._id, source: "local", action: "user", checkIn: night(140), checkOut: night(142), nights: 2, price: 1, subTotal: 1, currency: "INR", status: "pending", paymentStatus: "unpaid", guests: 1 });
  await BookingNight.insertMany([140, 141].map((d) => ({ propertyId: x.listing._id, date: night(d), bookingId: u, kind: "booking", expiresAt: new Date(Date.now() - 60_000) })));
  assert.strictEqual((await book(x, 140, 142)).status, 201);
});

test("R8: a block on dates an admin just moved a booking to is not a 'possible copy' until the OTA fetched the link after the move", async () => {
  const x = await setup("AGODA", []);
  const b = await paidBooking(x, 60, 62);
  // Agoda fetched its Majestic link an hour ago (it saw the old dates)
  await ExternalCalendar.updateOne({ _id: x.id }, { $set: { "export.lastServedAt": new Date(Date.now() - 3600_000) } });
  await Booking.collection.updateOne({ _id: new mongoose.Types.ObjectId(b._id) }, { $set: { createdAt: new Date(Date.now() - 2 * 86_400_000), "notifications.paidAt": new Date(Date.now() - 2 * 86_400_000) } });
  const admin = H.adminToken(await H.makeAdmin());
  const mv = await H.api("POST", `/booking/admin-modify?bookingId=${b._id}&from=${encodeURIComponent(mdy(70))}&to=${encodeURIComponent(mdy(72))}&guest=2&adults=2`, { token: admin });
  assert.strictEqual(mv.status, 200, JSON.stringify(mv.body));
  assert.ok((await Booking.findById(b._id).lean()).datesChangedAt, "the move is stamped");
  ota.events(x.path, [{ uid: "R8@agoda.com", start: S.day(70), end: S.day(72) }]);
  await engine.syncConnection(x.id, { force: true });
  const imp = await Booking.findOne({ propertyId: x.listing._id, source: "ical" }).lean();
  assert.notStrictEqual(imp.external.echo && imp.external.echo.suspect, true, "Agoda never saw the new dates: genuine");
});

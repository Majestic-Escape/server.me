// SyncGuard: regressions for the SECOND independent adversarial review
// (release gate, docs/syncguard.md §21). Each test reproduces the reviewer's
// failing input or interleaving and asserts the fixed behaviour.
const { test, before, after } = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const S = require("./syncguard-helpers");
const H = require("./setup");

const ota = new S.FakeOta();
const record = S.evidence("review2-fixes");
let Booking;
let BookingNight;
let ExternalCalendar;
let CalendarSyncState;
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
  CalendarSyncState = require("../../models/CalendarSyncState");
  engine = require("../../services/calendarSync/engine");
  ics = require("../../services/calendarSync/icsReader");
});
after(async () => {
  await ota.stop();
  await H.stop();
});

let seq = 0;
const reserved = (uid, a, b) => ({ uid, start: S.day(a), end: S.day(b), summary: "Reserved" });
async function setup(channel, events, { host } = {}) {
  const h = host || (await H.makeUser());
  const listing = await H.makeListing(h);
  const token = H.userToken(h);
  const p = `/r2-${++seq}.ics`;
  ota.events(p, events);
  const c = await H.api("POST", `/calendarSync/properties/${listing._id}/connections`, { token, body: { channel, url: ota.url(p) } });
  assert.strictEqual(c.status, 201, JSON.stringify(c.body));
  return { host: h, listing, token, path: p, id: c.body.id };
}
async function addConn(x, channel, events) {
  const p = `/r2-${++seq}.ics`;
  ota.events(p, events);
  const c = await H.api("POST", `/calendarSync/properties/${x.listing._id}/connections`, { token: x.token, body: { channel, url: ota.url(p) } });
  assert.strictEqual(c.status, 201, JSON.stringify(c.body));
  return { path: p, id: c.body.id };
}
const book = async (x, a, b) => H.api("POST", "/booking", { token: H.userToken(await H.makeUser()), body: H.bookingBody(x.listing, { checkIn: S.day(a), checkOut: S.day(b) }) });
const listOf = async (x) => {
  const r = await H.api("GET", `/calendarSync/properties/${x.listing._id}/connections`, { token: x.token });
  return r.body.data.connections || r.body.data;
};
const NOW = new Date("2026-10-03T06:00:00Z");
const wrap = (lines) => ["BEGIN:VCALENDAR", "VERSION:2.0", ...lines, "END:VCALENDAR"].join("\r\n");

test("C1: a huge time-zone name cannot freeze the parser (and still counts as unknown)", () => {
  const tz = "A".repeat(80_000);
  let t0 = Date.now();
  const r = ics.parseIcs(wrap(["BEGIN:VEVENT", "UID:z1", `DTSTART;TZID=${tz}:20261010T150000`, `DTEND;TZID=${tz}:20261012T100000`, "END:VEVENT"]), { now: NOW });
  const ms1 = Date.now() - t0;
  assert.ok(ms1 < 500, `${ms1} ms`);
  assert.strictEqual(r.stats.unknownTz, 2);
  // over 128 characters is unknown even when a real zone ends it (the cap runs before any matching)
  const padded = "X".repeat(129 - " Asia/Kolkata".length) + " Asia/Kolkata";
  assert.strictEqual(padded.length, 129);
  assert.strictEqual(ics.resolveTz(padded), null);
  assert.strictEqual(ics.resolveTz("(UTC+05:30) Asia/Kolkata"), "Asia/Kolkata", "a normal vendor spelling still resolves");
  const mid = "B".repeat(3000);
  const ex = Array.from({ length: 600 }, (_, i) => `EXDATE;TZID=${mid}:2026${String(11 + Math.floor(i / 28)).padStart(2, "0").slice(-2)}${String((i % 28) + 1).padStart(2, "0")}T150000`);
  t0 = Date.now();
  ics.parseIcs(wrap(["BEGIN:VEVENT", "UID:z2", "DTSTART:20261101T150000", "DTEND:20261101T160000", "RRULE:FREQ=DAILY;COUNT=5", ...ex, "END:VEVENT"]), { now: NOW });
  const ms2 = Date.now() - t0;
  assert.ok(ms2 < 1000, `${ms2} ms`);
  assert.ok(ics._cacheSizes().zones <= 256);
  record("tzid", { ms1, ms2 });
});

test("M1: a BYMONTHDAY list bomb is bounded", () => {
  const list = Array.from({ length: 200_000 }, () => "1").join(",");
  const t0 = Date.now();
  const r = ics.parseIcs(wrap(["BEGIN:VEVENT", "UID:m1", "DTSTART;VALUE=DATE:20261101", "DTEND;VALUE=DATE:20261102", `RRULE:FREQ=MONTHLY;BYMONTHDAY=${list}`, "END:VEVENT"]), { now: NOW });
  const ms = Date.now() - t0;
  assert.ok(ms < 1000, `${ms} ms`);
  assert.ok(r.events.length >= 1 && r.events.length <= 30, `${r.events.length}`);
});

test("H4: an error or redirect response is closed at once, never drained", async () => {
  let sent = 0;
  const open = new Set();
  const srv = http.createServer((req, res) => {
    open.add(req.socket);
    req.socket.on("close", () => open.delete(req.socket));
    res.writeHead(req.url.startsWith("/302") ? 302 : 500, req.url.startsWith("/302") ? { location: "/302" } : {});
    const chunk = Buffer.alloc(64 * 1024, 0x41);
    const pump = () => {
      while (!res.destroyed && res.write(chunk)) sent += chunk.length;
      if (!res.destroyed) res.once("drain", pump);
    };
    pump();
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const { safeFetch } = require("../../services/calendarSync/safeFetch");
  try {
    for (const path of ["/500", "/302"]) {
      sent = 0;
      await assert.rejects(safeFetch(`http://127.0.0.1:${srv.address().port}${path}`, { timeoutMs: 3000 }));
      const atSettle = sent;
      await new Promise((r) => setTimeout(r, 1500));
      assert.ok(sent - atSettle < 2 * 1024 * 1024, `${path}: ${(sent - atSettle) / 1048576} MB more after giving up`);
      assert.strictEqual(open.size, 0, `${path}: ${open.size} socket(s) still open`);
    }
  } finally {
    srv.closeAllConnections && srv.closeAllConnections();
    srv.close();
  }
});

async function paidBooking(x, a, b) {
  const t = H.userToken(await H.makeUser());
  const r = await H.api("POST", "/booking", { token: t, body: H.bookingBody(x.listing, { checkIn: S.day(a), checkOut: S.day(b) }) });
  assert.strictEqual(r.status, 201, JSON.stringify(r.body));
  const o = await H.api("POST", "/payment/create-order", { token: t, body: { bookingId: r.body.data._id, amount: r.body.data.quote.totalPaise, currency: "INR" } });
  assert.strictEqual(o.status, 200, JSON.stringify(o.body));
  return { t, booking: r.body.data, order: o.body.data };
}

test("H1: admin 'keep' re-reads the OTA calendars first — a night an OTA sold meanwhile is not confirmed twice", async () => {
  const x = await setup("BOOKING_COM", []);
  const { t, booking, order } = await paidBooking(x, 30, 32);
  // the hold is lost to someone else before the payment completes → inventory_conflict
  await BookingNight.deleteMany({ bookingId: booking._id });
  const other = new mongoose.Types.ObjectId();
  await BookingNight.insertMany([30, 31].map((d) => ({ propertyId: x.listing._id, date: new Date(`${S.day(d)}T00:00:00Z`), bookingId: other, kind: "booking", expiresAt: new Date(Date.now() + 60_000) })));
  const pay = H.razorpay().__registerPayment({ id: `pay_r2_h1_${Date.now()}`, order_id: order.id, amount: order.amount, currency: "INR", status: "captured", method: "upi" });
  await H.api("POST", "/payment/verify-payment", { token: t, body: { razorpay_order_id: order.id, razorpay_payment_id: pay.id, razorpay_signature: H.signature(order.id, pay.id) } });
  assert.strictEqual((await Booking.findById(booking._id).lean()).needsAttention, "inventory_conflict");
  // the other holder lets go; meanwhile Booking.com sells those nights (calendar last read 10 min ago)
  await BookingNight.deleteMany({ bookingId: other });
  ota.events(x.path, [{ uid: "BDC-SOLD@booking.com", start: S.day(30), end: S.day(32) }]);
  await ExternalCalendar.updateOne({ _id: x.id }, { $set: { "sync.lastSuccessAt": new Date(Date.now() - 10 * 60_000) } });
  const admin = H.adminToken(await H.makeAdmin());
  const before = ota.count(x.path);
  const keep = await H.api("PATCH", "/booking/admin/attention/resolve", { token: admin, body: { bookingId: String(booking._id), resolution: "keep" } });
  assert.ok(ota.count(x.path) > before, "the calendar was re-read before keeping");
  assert.strictEqual(keep.status, 409, JSON.stringify(keep.body));
  const after = await Booking.findById(booking._id).lean();
  assert.notStrictEqual(after.status, "confirmed", "not confirmed over the OTA's booking");
  record("keep-reverify", { keep: keep.status, code: keep.body.code });
});

test("H2: after the admin resolves an alert, a NEW OTA conflict on the same booking alerts again — an unchanged one does not", async () => {
  const x = await setup("AGODA", []);
  const { t, booking, order } = await paidBooking(x, 40, 42);
  const pay = H.razorpay().__registerPayment({ id: `pay_r2_h2_${Date.now()}`, order_id: order.id, amount: order.amount, currency: "INR", status: "captured", method: "upi" });
  await H.api("POST", "/payment/verify-payment", { token: t, body: { razorpay_order_id: order.id, razorpay_payment_id: pay.id, razorpay_signature: H.signature(order.id, pay.id) } });
  ota.events(x.path, [{ uid: "AG-1@agoda.com", start: S.day(40), end: S.day(42) }]);
  await engine.syncConnection(x.id, { force: true });
  assert.strictEqual((await Booking.findById(booking._id).lean()).needsAttention, "ota_conflict");
  const admin = H.adminToken(await H.makeAdmin());
  const keep = await H.api("PATCH", "/booking/admin/attention/resolve", { token: admin, body: { bookingId: String(booking._id), resolution: "keep" } });
  assert.strictEqual(keep.status, 200, JSON.stringify(keep.body));
  // the same conflict seen again by the daily full pass: no new alert
  await engine.syncConnection(x.id, { force: true, full: true });
  assert.strictEqual((await Booking.findById(booking._id).lean()).needsAttention, null, "an unchanged conflict does not re-alert");
  // a NEW, genuine reservation on another site for the same nights
  const vr = await addConn(x, "VRBO", [{ uid: "VR-NEW@vrbo.com", start: S.day(40), end: S.day(42) }]);
  assert.ok(vr.id);
  const again = await Booking.findById(booking._id).lean();
  assert.strictEqual(again.needsAttention, "ota_conflict", "the new conflict reaches the admin queue again");
});

test("H3: the legacy endpoint (mobile app) REPLACES a dead link of the same site; a merely flaky one is kept; the card restricts at the first failure", async (t) => {
  // the fake OTA serves from 127.0.0.1: make its links read as Airbnb links,
  // as a real www.airbnb.com/calendar/ical/… link would
  const channels = require("../../services/calendarSync/channels");
  t.mock.method(channels, "inferChannel", () => "AIRBNB");
  const x = await setup("AIRBNB", [reserved("H3-A@airbnb.com", 50, 51)]);
  // the OTA resets the link: the old URL now 404s (permanent) → BROKEN
  ota.set(x.path, { status: 404, body: "" });
  for (let i = 0; i < 3; i++) await engine.syncConnection(x.id, { force: true });
  // "not found" for hours (the replacement rule, §8.3): 3 failures, nothing good for 6 h
  await ExternalCalendar.updateOne({ _id: x.id }, { $set: { "sync.lastSuccessAt": new Date(Date.now() - 7 * 3600_000) } });
  const first = (await listOf(x))[0];
  assert.strictEqual(first.health.state, "BROKEN");
  assert.strictEqual(first.bookingRestricted, true);
  // the host pastes the fresh link in the mobile app
  const fresh = `/r2-${++seq}.ics`;
  ota.events(fresh, [reserved("H3-A@airbnb.com", 50, 51)]);
  const save = await H.api("POST", "/calendarSync/saveCalendar", { token: x.token, body: { propertyId: String(x.listing._id), kind: "import", url: ota.url(fresh) } });
  assert.strictEqual(save.status, 200);
  assert.strictEqual(save.body.success, true);
  assert.match(save.body.message, /replaced/i);
  const conns = await ExternalCalendar.find({ propertyId: x.listing._id, kind: "import", status: "active" }).lean();
  assert.strictEqual(conns.length, 1, "still one Airbnb connection");
  assert.strictEqual(String(conns[0]._id), x.id, "the same connection, with the new link");
  assert.strictEqual((await book(x, 60, 61)).status, 201, "guests can book again");
  // a merely flaky link (one transient failure) is NOT replaced: it may be another real listing
  const y = await setup("AIRBNB", []);
  ota.set(y.path, { status: 503, body: "" });
  await engine.syncConnection(y.id, { force: true });
  const flaky = (await listOf(y))[0];
  assert.strictEqual(flaky.bookingRestricted, true, "restricted as soon as the last check failed");
  const other = `/r2-${++seq}.ics`;
  ota.events(other, []);
  await H.api("POST", "/calendarSync/saveCalendar", { token: y.token, body: { propertyId: String(y.listing._id), kind: "import", url: ota.url(other) } });
  assert.strictEqual(await ExternalCalendar.countDocuments({ propertyId: y.listing._id, kind: "import", status: "active" }), 2);
});

test("M2: entries Majestic cannot fully read make the card PARTIAL with a plain explanation (never a silent green)", async () => {
  const x = await setup("GENERIC_ICAL", []);
  ota.set(x.path, { body: wrap(["BEGIN:VEVENT", "UID:rr", "DTSTART;VALUE=DATE:20261205", "DTEND;VALUE=DATE:20261206", "RRULE:FREQ=MONTHLY;BYDAY=1SA", "END:VEVENT", "BEGIN:VEVENT", "UID:bad", "DTSTART;VALUE=DATE:2026-12-20", "DTEND;VALUE=DATE:2026-12-21", "END:VEVENT"]) });
  await engine.syncConnection(x.id, { force: true });
  const c = (await listOf(x))[0];
  assert.strictEqual(c.health.state, "PARTIAL");
  assert.match(c.health.reason, /repeating entries/);
  assert.match(c.health.reason, /dates Majestic can't read/);
  assert.strictEqual(c.protection, "DEGRADED");
});

test("M3: a double sale on a site whose Majestic link was never requested is a GENUINE overlap (alerted), not a 'likely copy'", async () => {
  const x = await setup("AIRBNB", [reserved("M3-A@airbnb.com", 70, 72)]);
  H.resetEmails();
  const b = await addConn(x, "BOOKING_COM", [{ uid: "M3-B@booking.com", start: S.day(70), end: S.day(72) }]);
  const row = await Booking.findOne({ "external.connectionId": new mongoose.Types.ObjectId(b.id) }).lean();
  assert.notStrictEqual(row.external.echo && row.external.echo.suspect, true, "Booking.com never fetched anything: it cannot be a copy");
  assert.deepStrictEqual([row.external.conflict.kind, row.external.conflict.likelyMirror], ["external_overlap", false]);
  assert.strictEqual(H.sentEmails().filter((e) => /booked or unavailable/.test(JSON.stringify(e))).length, 1);
  const card = (await listOf(x)).find((c) => c.id === b.id);
  assert.strictEqual(card.health.state, "NEEDS_ATTENTION");
});

test("M6: a listing with connected calendars does not commit a stay beyond the 2-year sync horizon", async () => {
  const x = await setup("AIRBNB", []);
  const far = await book(x, 735, 737);
  assert.strictEqual(far.status, 409, JSON.stringify(far.body));
  assert.strictEqual(far.body.code, "BEYOND_SYNC_HORIZON");
  assert.strictEqual((await book(x, 700, 702)).status, 201, "within the horizon: fine");
});

test("M7: a feed that re-issues every UID on every fetch keeps ONE row per booking (no growth, no anomaly)", async () => {
  const x = await setup("GENERIC_ICAL", [{ uid: "ROT-0@x.example", start: S.day(80), end: S.day(82) }, { uid: "KEEP@x.example", start: S.day(90), end: S.day(91) }]);
  const t0 = Date.now();
  for (let i = 1; i <= 8; i++) {
    ota.events(x.path, [{ uid: `ROT-${i}@x.example`, start: S.day(80), end: S.day(82) }, { uid: "KEEP@x.example", start: S.day(90), end: S.day(91) }]);
    await engine.syncConnection(x.id, { force: true, now: new Date(t0 + i * 30 * 60_000) });
  }
  const rows = await Booking.find({ propertyId: x.listing._id, source: "ical" }).lean();
  assert.strictEqual(rows.length, 2, rows.map((r) => r.external.key).join(","));
  assert.ok(rows.every((r) => r.external.state === "active"));
  assert.strictEqual((await ExternalCalendar.findById(x.id).lean()).sync.anomaly, null);
});

test("L1: an import never takes the nights of a PAID booking that still carries hold-style rows (e.g. mid date-move)", async () => {
  const x = await setup("AGODA", []);
  const g = await H.makeUser();
  const id = new mongoose.Types.ObjectId();
  await Booking.create({ _id: id, userId: g._id, hostId: x.host._id, propertyId: x.listing._id, source: "local", action: "user", checkIn: new Date(`${S.day(100)}T00:00:00Z`), checkOut: new Date(`${S.day(102)}T00:00:00Z`), nights: 2, price: 1, subTotal: 1, currency: "INR", status: "confirmed", paymentStatus: "paid", guests: 1 });
  await BookingNight.insertMany([100, 101].map((d) => ({ propertyId: x.listing._id, date: new Date(`${S.day(d)}T00:00:00Z`), bookingId: id, kind: "booking", expiresAt: new Date(Date.now() + 30 * 60_000) })));
  ota.events(x.path, [{ uid: "L1@agoda.com", start: S.day(100), end: S.day(102) }]);
  await engine.syncConnection(x.id, { force: true });
  assert.strictEqual(await BookingNight.countDocuments({ bookingId: id }), 2, "the paid booking keeps its nights");
  const imp = await Booking.findOne({ propertyId: x.listing._id, source: "ical" }).lean();
  assert.strictEqual(imp.external.conflict && imp.external.conflict.kind, "paid_booking", "recorded as a conflict, not a displaced hold");
  assert.strictEqual((await Booking.findById(id).lean()).needsAttention, "ota_conflict");
});

test("L2: a pass that lost a write race does not stamp the calendar as verified", async () => {
  const x = await setup("AIRBNB", [reserved("L2@airbnb.com", 110, 112)]);
  const before = (await ExternalCalendar.findById(x.id).lean()).sync.lastSuccessAt;
  ota.events(x.path, [reserved("L2@airbnb.com", 110, 113)]);
  const orig = Booking.updateOne;
  let fired = false;
  Booking.updateOne = function patched(filter, ...rest) {
    if (!fired && filter && filter["external.rev"] !== undefined) {
      fired = true;
      return Promise.resolve({ matchedCount: 0, modifiedCount: 0 });
    }
    return orig.call(this, filter, ...rest);
  };
  try {
    await engine.syncConnection(x.id, { force: true, now: new Date(Date.now() + 5 * 60_000) });
  } finally {
    Booking.updateOne = orig;
  }
  const after = await ExternalCalendar.findById(x.id).lean();
  assert.strictEqual(String(after.sync.lastSuccessAt), String(before), "lastSuccessAt untouched by a raced pass");
});

test("L4: a commitment check re-reads the calendar unconditionally (a wrong 304 cannot count as 'verified')", async () => {
  const x = await setup("AIRBNB", []);
  let conditional = 0;
  ota.set(x.path, {
    handler: (req, res) => {
      if (req.headers["if-none-match"] || req.headers["if-modified-since"]) {
        conditional += 1;
        res.writeHead(304);
        return res.end();
      }
      res.writeHead(200, { "content-type": "text/calendar", etag: '"v2"' });
      res.end(S.vcal([reserved("L4@airbnb.com", 120, 121)]));
    },
  });
  await ExternalCalendar.updateOne({ _id: x.id }, { $set: { etag: '"v1"', "sync.lastSuccessAt": new Date(Date.now() - 10 * 60_000) } });
  const r = await book(x, 120, 121);
  assert.strictEqual(conditional, 0, "no conditional request at commitment");
  assert.strictEqual(r.status, 409, "the booking published on the OTA is seen");
});

test("L5: 'the stay has started' is judged on the property's calendar (just after midnight in India)", async () => {
  // 19:30 UTC on day D-1 = 01:00 IST on day D, the check-in day
  const checkIn = S.day(3);
  const t0 = new Date(Date.parse(`${checkIn}T00:00:00Z`) - 4.5 * 3600_000);
  const x = await setup("AGODA", [{ uid: "L5@agoda.com", start: checkIn, end: S.day(5) }, { uid: "OTHER@agoda.com", start: S.day(30), end: S.day(31) }]);
  ota.events(x.path, [{ uid: "OTHER@agoda.com", start: S.day(30), end: S.day(31) }]); // the OTA drops the stay at check-in
  for (let k = 0; k < 6; k++) await engine.syncConnection(x.id, { force: true, now: new Date(t0.getTime() + k * 50 * 60_000) });
  const row = await Booking.findOne({ "external.connectionId": new mongoose.Types.ObjectId(x.id), "external.uid": "L5@agoda.com" }).lean();
  assert.strictEqual(row.status, "confirmed", "not released by disappearance on its check-in day");
});

test("L6: a link opened by an unrecognised app (a chat preview) is not shown as 'in use'", async () => {
  const x = await setup("AIRBNB", []);
  const secret = (await ExternalCalendar.findById(x.id).lean()).secret;
  await fetch(`${H.baseUrl()}/calendarSync/ics/${secret}.ics`, { headers: { "user-agent": "WhatsApp/2.23.20" } });
  await new Promise((r) => setTimeout(r, 200));
  const c = (await listOf(x))[0];
  assert.strictEqual(c.export.state, "OPENED");
  assert.notStrictEqual(c.protection, "HEALTHY");
  await ExternalCalendar.updateOne({ _id: x.id }, { $set: { "export.lastServedAt": new Date(Date.now() - 5 * 60_000) } });
  await fetch(`${H.baseUrl()}/calendarSync/ics/${secret}.ics`, { headers: { "user-agent": "Airbnb Calendar Fetcher/1.0" } });
  await new Promise((r) => setTimeout(r, 200));
  assert.strictEqual((await listOf(x))[0].export.state, "ACTIVE");
});

test("L7: the journal's 90-day expiry index is part of the startup check", async () => {
  const { SYNCGUARD } = require("../../services/startupChecks");
  assert.ok(SYNCGUARD.some((r) => r.collection === "calendarsynclogs" && r.name === "ttl_90d"));
});

test("L12: when the sync clock has stopped, the daily cron e-mails ops — at most once a day", async () => {
  await setup("AIRBNB", []);
  await CalendarSyncState.updateOne({ _id: "scheduler" }, { $set: { lastSweepFinishedAt: new Date(Date.now() - 6 * 3600_000), clockAlertAt: null } }, { upsert: true });
  H.resetEmails();
  const call = () => H.api("GET", "/calendarSync/cron/sweep?mode=full", { headers: { authorization: `Bearer ${process.env.CRON_SECRET}` } });
  assert.strictEqual((await call()).status, 200);
  const first = H.sentEmails().filter((e) => /sync clock/i.test(JSON.stringify(e))).length;
  assert.ok(first >= 1, "ops alerted");
  await CalendarSyncState.updateOne({ _id: "scheduler" }, { $set: { lastSweepFinishedAt: new Date(Date.now() - 6 * 3600_000) } });
  await call();
  assert.strictEqual(H.sentEmails().filter((e) => /sync clock/i.test(JSON.stringify(e))).length, first, "not again within the day");
});

test("L6b: a calendar service's request is recorded even right after a chat preview, and a later preview does not hide it", async () => {
  const x = await setup("AIRBNB", []);
  const secret = (await ExternalCalendar.findById(x.id).lean()).secret;
  const hit = async (ua) => {
    await fetch(`${H.baseUrl()}/calendarSync/ics/${secret}.ics`, { headers: { "user-agent": ua } });
    await new Promise((r) => setTimeout(r, 200));
    return (await listOf(x))[0].export.state;
  };
  assert.strictEqual(await hit("WhatsApp/2.23.20"), "OPENED");
  assert.strictEqual(await hit("Airbnb Calendar Fetcher/1.0"), "ACTIVE", "Airbnb fetched 1 s after the preview");
  await ExternalCalendar.updateOne({ _id: x.id }, { $set: { "export.lastServedAt": new Date(Date.now() - 10 * 60_000) } });
  assert.strictEqual(await hit("Mozilla/5.0 (Linux; Android 14) Chrome/128"), "ACTIVE", "a browser opening the link 10 min later");
  const row = (await ExternalCalendar.findById(x.id).lean()).export;
  assert.strictEqual(row.lastServedAgent, "Airbnb");
});

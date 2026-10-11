// SyncGuard: regressions for the independent adversarial review (docs/syncguard.md
// §17). Each test reproduces the reviewer's failing interleaving or input and
// asserts the fixed behaviour.
const { test, before, after } = require("node:test");
const assert = require("node:assert");
const S = require("./syncguard-helpers");
const H = require("./setup");

const ota = new S.FakeOta();
const record = S.evidence("review-fixes");
let Booking;
let BookingNight;
let ExternalCalendar;
let engine;
let inventory;
let mongoose;
let ics;

before(async () => {
  await H.start();
  await ota.start();
  mongoose = require("mongoose");
  Booking = require("../../models/Booking");
  BookingNight = require("../../models/BookingNight");
  ExternalCalendar = require("../../models/ExternalCalendar");
  engine = require("../../services/calendarSync/engine");
  inventory = require("../../services/inventory");
  ics = require("../../services/calendarSync/icsReader");
});
after(async () => {
  await ota.stop();
  await H.stop();
});

let seq = 0;
async function connected(channel, events, { summary } = {}) {
  const host = await H.makeUser();
  const listing = await H.makeListing(host);
  const token = H.userToken(host);
  const p = `/rf${++seq}.ics`;
  ota.events(p, events.map((e) => ({ summary, ...e })));
  const c = await H.api("POST", `/calendarSync/properties/${listing._id}/connections`, { token, body: { channel, url: ota.url(p) } });
  assert.strictEqual(c.status, 201, JSON.stringify(c.body));
  return { host, listing, token, path: p, id: c.body.id };
}
async function addConnection(x, channel, events) {
  const p = `/rf${++seq}.ics`;
  ota.events(p, events);
  const c = await H.api("POST", `/calendarSync/properties/${x.listing._id}/connections`, { token: x.token, body: { channel, url: ota.url(p) } });
  assert.strictEqual(c.status, 201, JSON.stringify(c.body));
  return { path: p, id: c.body.id };
}
const nights = (a, b) => inventory.nightsBetween(new Date(`${S.day(a)}T00:00:00Z`), new Date(`${S.day(b)}T00:00:00Z`));
const bodyText = (r) => (typeof r.body === "string" ? r.body : r.text || JSON.stringify(r.body || ""));

// --- Finding 1: calendar files that cost CPU or memory --------------------------
const NOW = new Date("2026-10-03T06:00:00Z");
function ruleFeed(n, rule, dtstart = "04000101") {
  const L = ["BEGIN:VCALENDAR", "VERSION:2.0"];
  for (let i = 0; i < n; i++) L.push("BEGIN:VEVENT", `UID:r${i}`, `DTSTART;VALUE=DATE:${dtstart}`, `DTEND;VALUE=DATE:${dtstart.slice(0, 6)}${String(Number(dtstart.slice(6)) + 1).padStart(2, "0")}`, rule, "END:VEVENT");
  L.push("END:VCALENDAR");
  return L.join("\r\n");
}

test("F1: 5,000 monthly rules starting in the year 400 parse in well under a second (was 28 s)", () => {
  const t = Date.now();
  const r = ics.parseIcs(ruleFeed(5000, "RRULE:FREQ=MONTHLY;UNTIL=20200101"), { now: NOW });
  const ms = Date.now() - t;
  assert.strictEqual(r.events.length, 0);
  assert.ok(ms < 1500, `took ${ms} ms`);
  record("cpu-until", { ms });
});

test("F1: COUNT rules that would walk centuries are refused quickly by the per-file budget", () => {
  for (const rule of ["RRULE:FREQ=MONTHLY;COUNT=1000", "RRULE:FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=30;COUNT=1000", "RRULE:FREQ=WEEKLY;COUNT=1000", "RRULE:FREQ=DAILY;COUNT=1000"]) {
    const t = Date.now();
    assert.throws(() => ics.parseIcs(ruleFeed(5000, rule), { now: NOW }), (e) => e.code === "TOO_MANY_OCCURRENCES", rule);
    const ms = Date.now() - t;
    assert.ok(ms < 1500, `${rule}: ${ms} ms`);
  }
});

test("F1: skipping ahead to the window yields exactly the occurrences of a full walk", () => {
  const ws = ics.dayFromYmd(2026, 9, 1);
  const we = ws + 730;
  for (const [value, y, m, d] of [
    ["FREQ=MONTHLY;INTERVAL=5", 1990, 1, 15],
    ["FREQ=MONTHLY;BYMONTHDAY=31", 1950, 3, 31],
    ["FREQ=YEARLY;INTERVAL=3", 1901, 6, 10],
    ["FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=29", 1904, 2, 29],
  ]) {
    const rule = ics.parseRule(value, "UTC");
    const start = ics.dayFromYmd(y, m, d);
    const fast = ics.expandRule(rule, start, ws, we);
    const slow = ics.expandRule(rule, start, start, we).filter((x) => x >= ws);
    assert.deepStrictEqual(fast, slow, value);
    assert.ok(fast.length > 0, value);
  }
});

test("F1: time-zone spellings cannot grow the caches (Intl accepts any capitalisation)", () => {
  const base = "America/Argentina/ComodRivadavia";
  const variant = (n) => {
    let s = "";
    let k = n;
    for (const ch of base) {
      if (/[a-z]/i.test(ch)) {
        s += k & 1 ? ch.toUpperCase() : ch.toLowerCase();
        k >>= 1;
      } else s += ch;
    }
    return s;
  };
  const L = ["BEGIN:VCALENDAR", "VERSION:2.0"];
  for (let i = 0; i < 790; i++) L.push("BEGIN:VEVENT", `UID:x${i}`, `DTSTART;TZID=${variant(i * 7919)}:20261010T120000`, `DTEND;TZID=${variant(i * 7919)}:20261011T100000`, "END:VEVENT");
  L.push("END:VCALENDAR");
  const r = ics.parseIcs(L.join("\r\n"), { now: NOW });
  assert.strictEqual(r.events.length, 790);
  // 12:00 ART Oct 10 = 20:30 IST; 10:00 ART Oct 11 = 18:30 IST (after noon → that night too)
  assert.ok(r.events.every((e) => e.startDay === "2026-10-10" && e.endDay === "2026-10-12"), "every spelling is the same zone");
  const sizes = ics._cacheSizes();
  assert.ok(sizes.zones <= 256 && sizes.formatters <= 256, JSON.stringify(sizes));
  assert.ok(sizes.formatters < 10, `one formatter per real zone, not per spelling: ${JSON.stringify(sizes)}`);
});

// --- Finding 3: a cancelled or free duplicate hid the booking ---------------------
test("F3: a cancelled or transparent copy of an event never hides the confirmed copy, in any order", () => {
  const cal = (evs) => ["BEGIN:VCALENDAR", "VERSION:2.0", ...evs.flatMap((e) => ["BEGIN:VEVENT", `UID:${e.uid}`, `DTSTART;VALUE=DATE:${e.s}`, `DTEND;VALUE=DATE:${e.e}`, ...(e.status ? [`STATUS:${e.status}`] : []), ...(e.transp ? [`TRANSP:${e.transp}`] : []), "END:VEVENT"]), "END:VCALENDAR"].join("\r\n");
  const cases = [
    [{ uid: "R1", s: "20261010", e: "20261012" }, { uid: "R1", s: "20261010", e: "20261015", status: "CANCELLED" }],
    [{ uid: "R2", s: "20261010", e: "20261015", status: "CANCELLED" }, { uid: "R2", s: "20261010", e: "20261012" }],
    [{ uid: "R3", s: "20261010", e: "20261012" }, { uid: "R3", s: "20261010", e: "20261013", transp: "TRANSPARENT" }],
    [{ uid: "R4", s: "20261010", e: "20261012" }, { uid: "R4", s: "20261010", e: "20261015", status: "CANCELLED" }, { uid: "R4", s: "20261010", e: "20261011" }],
  ];
  for (const evs of cases) {
    const r = ics.parseIcs(cal(evs), { now: NOW });
    const blocking = r.events.filter((e) => e.status !== "cancelled" && !e.transparent);
    assert.strictEqual(blocking.length, 1, JSON.stringify(r.events));
    assert.deepStrictEqual([blocking[0].startDay, blocking[0].endDay], ["2026-10-10", "2026-10-12"], JSON.stringify(r.events));
  }
  // two blocking copies merge into the longer stay
  const both = ics.parseIcs(cal([{ uid: "R5", s: "20261010", e: "20261012" }, { uid: "R5", s: "20261010", e: "20261014" }]), { now: NOW });
  assert.deepStrictEqual(both.events.map((e) => [e.startDay, e.endDay, e.status]), [["2026-10-10", "2026-10-14", "confirmed"]]);
});

// --- Finding 2: generic booking endpoints reopened OTA-booked nights --------------
test("F2: cancel / reject / terminate / delete / modify of an imported OTA stay are refused; its nights stay blocked", async () => {
  const x = await connected("AIRBNB", [{ uid: "RES-1@airbnb.com", start: S.day(40), end: S.day(42), summary: "Reserved" }]);
  const imp = await Booking.findOne({ propertyId: x.listing._id, source: "ical" }).lean();
  const admin = H.adminToken(await H.makeAdmin());
  const id = String(imp._id);
  const mdy = (o) => {
    const d = new Date(`${S.day(o)}T00:00:00Z`);
    return `${d.getUTCMonth() + 1}/${d.getUTCDate()}/${d.getUTCFullYear()}`;
  };
  const attempts = {
    hostTerminate: await H.api("PATCH", "/booking/host/terminate", { token: x.token, body: { bookingId: id } }),
    hostReject: await H.api("PATCH", "/booking/host/cancel", { token: x.token, body: { bookingId: id } }),
    userTerminate: await H.api("PATCH", "/booking/user/terminate", { token: x.token, body: { bookingId: id } }), // the host is also the row's "guest"
    adminCancel: await H.api("PATCH", "/booking/admin/cancel", { token: admin, body: { bookingId: id } }),
    adminDelete: await H.api("DELETE", `/booking/${id}`, { token: admin }),
    adminModify: await H.api("POST", `/booking/admin-modify?bookingId=${id}&from=${encodeURIComponent(mdy(43))}&to=${encodeURIComponent(mdy(45))}&guest=2&adults=2`, { token: admin }),
  };
  for (const [name, r] of Object.entries(attempts)) {
    assert.strictEqual(r.status, 409, `${name}: ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.code, "EXTERNAL_BOOKING", name);
  }
  const after = await Booking.findById(imp._id).lean();
  assert.deepStrictEqual([after.status, after.external.state, +after.checkIn], ["confirmed", "active", +imp.checkIn]);
  assert.strictEqual(await BookingNight.countDocuments({ bookingId: imp._id }), 2, "nights still owned");
  const g = await H.makeUser();
  const r = await H.api("POST", "/booking", { token: H.userToken(g), body: H.bookingBody(x.listing, { checkIn: S.day(40), checkOut: S.day(42) }) });
  assert.strictEqual(r.status, 409, "the OTA-booked nights cannot be sold");
  record("imported-row-guard", { attempts: Object.fromEntries(Object.entries(attempts).map(([k, v]) => [k, `${v.status} ${v.body.code}`])), guestBooking: r.status });
});

test("F2: a live row whose status was changed outside SyncGuard is repaired (status + nights) by the next full pass", async () => {
  const x = await connected("AIRBNB", [{ uid: "RES-2@airbnb.com", start: S.day(46), end: S.day(48), summary: "Reserved" }]);
  const imp = await Booking.findOne({ propertyId: x.listing._id, source: "ical" }).lean();
  // what the old endpoints did: cancelled + nights released, external state untouched
  await Booking.collection.updateOne({ _id: imp._id }, { $set: { status: "cancelled" } });
  await BookingNight.deleteMany({ bookingId: imp._id });
  const r = await engine.syncConnection(x.id, { force: true, full: true });
  assert.ok(r.ok, JSON.stringify(r));
  const fixed = await Booking.findById(imp._id).lean();
  assert.strictEqual(fixed.status, "confirmed");
  assert.strictEqual(await BookingNight.countDocuments({ bookingId: imp._id }), 2);
  const CalendarSyncLog = require("../../models/CalendarSyncLog");
  assert.ok(await CalendarSyncLog.exists({ bookingId: imp._id, type: "status_repaired" }), "journalled");
});

// --- Finding 4: "Sync now" on a database error --------------------------------------
test("F4: a sync that rejects during 'Sync now' is not an unhandled rejection (the process stays up)", async () => {
  const x = await connected("AGODA", []);
  const connections = require("../../services/calendarSync/connections");
  const orig = engine.syncConnection;
  let unhandled = 0;
  const onUnhandled = () => {
    unhandled += 1;
  };
  process.on("unhandledRejection", onUnhandled);
  engine.syncConnection = () => Promise.reject(new Error("simulated database outage"));
  try {
    const conn = await ExternalCalendar.findById(x.id).lean();
    const r = await connections.syncNow({ conn });
    assert.strictEqual(r.state, "failed");
    await new Promise((res) => setTimeout(res, 100));
    assert.strictEqual(unhandled, 0);
  } finally {
    engine.syncConnection = orig;
    process.off("unhandledRejection", onUnhandled);
  }
});

// --- Finding 5: echo window + cross-OTA overlaps ------------------------------------------
async function echoWindowCase({ cancelledMinutesAgo }) {
  const x = await connected("AGODA", []);
  const airbnb = await addConnection(x, "AIRBNB", []);
  // A Majestic booking on nights N was exported to Agoda, then cancelled.
  const b = await Booking.create({ userId: x.host._id, hostId: x.host._id, propertyId: x.listing._id, source: "local", action: "user", checkIn: new Date(`${S.day(60)}T00:00:00Z`), checkOut: new Date(`${S.day(62)}T00:00:00Z`), nights: 2, price: 1, subTotal: 1, currency: "INR", status: "cancelled", paymentStatus: "paid", guests: 1 });
  // booked two days ago, and Agoda fetched its Majestic link since (so it COULD reflect it)
  await Booking.collection.updateOne({ _id: b._id }, { $set: { createdAt: new Date(Date.now() - 2 * 86_400_000), updatedAt: new Date(Date.now() - cancelledMinutesAgo * 60_000) } });
  await ExternalCalendar.updateOne({ _id: x.id }, { $set: { "export.lastServedAt": new Date(Date.now() - 20 * 60 * 60_000) } });
  // our previous successful read of the Agoda feed was 30 min ago
  await ExternalCalendar.updateOne({ _id: x.id }, { $set: { "sync.lastSuccessAt": new Date(Date.now() - 30 * 60_000) } });
  // a reservation on N now appears in Agoda (no marker: Agoda cannot say "reserved")
  ota.events(x.path, [{ uid: "AG-REAL@agoda.com", start: S.day(60), end: S.day(62) }]);
  await engine.syncConnection(x.id, { force: true });
  const row = await Booking.findOne({ "external.connectionId": new mongoose.Types.ObjectId(x.id) }).lean();
  const sec = (await ExternalCalendar.findById(airbnb.id).lean()).secret;
  const feed = bodyText(await H.api("GET", `/calendarSync/ics/${sec}.ics`, {}));
  return { row, toAirbnb: feed.includes(`DTSTART;VALUE=DATE:${S.day(60).replace(/-/g, "")}`), listing: x.listing };
}

test("F5: a reservation on nights freed before our previous read of that feed is genuine and reaches the other OTAs at once", async () => {
  const r = await echoWindowCase({ cancelledMinutesAgo: 180 });
  assert.notStrictEqual(r.row.external.echo && r.row.external.echo.suspect, true, "not a possible echo");
  assert.strictEqual(r.toAirbnb, true, "propagated to Airbnb immediately");
  assert.strictEqual(await BookingNight.countDocuments({ bookingId: r.row._id }), 2, "and blocks Majestic");
  record("echo-window-genuine", { suspect: !!(r.row.external.echo && r.row.external.echo.suspect), toAirbnb: r.toAirbnb });
});

test("F5: an event first seen right after we stopped exporting those nights stays a possible echo (loop protection kept)", async () => {
  const r = await echoWindowCase({ cancelledMinutesAgo: 10 });
  assert.strictEqual(r.row.external.echo.suspect, true);
  assert.strictEqual(r.toAirbnb, false, "withheld from propagation");
  assert.strictEqual(await BookingNight.countDocuments({ bookingId: r.row._id }), 2, "but still blocks Majestic");
});

test("F5: two OTAs reporting the same nights is surfaced to the host once (NEEDS_ATTENTION + e-mail)", async () => {
  const x = await connected("AGODA", [{ uid: "AG-G@agoda.com", start: S.day(70), end: S.day(72) }]);
  H.resetEmails();
  const airbnb = await addConnection(x, "AIRBNB", [{ uid: "A-1@airbnb.com", start: S.day(70), end: S.day(72), summary: "Reserved" }]);
  const a = await Booking.findOne({ "external.connectionId": new mongoose.Types.ObjectId(airbnb.id) }).lean();
  assert.strictEqual(a.external.conflict && a.external.conflict.kind, "external_overlap");
  await engine.syncConnection(airbnb.id, { force: true, full: true });
  const mails = H.sentEmails().filter((e) => JSON.stringify(e).includes(x.host.email) && /booked or unavailable/.test(JSON.stringify(e)));
  assert.strictEqual(mails.length, 1, `host told exactly once (${H.sentEmails().length} e-mails)`);
  const list = await H.api("GET", `/calendarSync/properties/${x.listing._id}/connections`, { token: x.token });
  const conns = (list.body.data && (list.body.data.connections || list.body.data)) || [];
  const c = conns.find((k) => k.id === airbnb.id);
  assert.strictEqual(c.counts.overlaps, 1);
  assert.strictEqual(c.health.state, "NEEDS_ATTENTION");
  record("cross-ota-overlap", { counts: c.counts, health: c.health, emails: mails.length });
});

// --- Finding 6: a mirror of the booking blocked the booking itself -------------------------
test("F6: Airbnb mirroring a paid Majestic booking does not block that booking's admin move or 'keep'; it still blocks everyone else", async () => {
  const x = await connected("AIRBNB", []);
  const guest = await H.makeUser();
  const gid = new mongoose.Types.ObjectId();
  const cin = new Date(`${S.day(50)}T00:00:00Z`);
  const cout = new Date(`${S.day(52)}T00:00:00Z`);
  await Booking.create({ _id: gid, userId: guest._id, hostId: x.host._id, propertyId: x.listing._id, source: "local", action: "user", checkIn: cin, checkOut: cout, nights: 2, price: 100, subTotal: 100, currency: "INR", status: "confirmed", paymentStatus: "paid", guests: 2 });
  await BookingNight.insertMany(inventory.nightsBetween(cin, cout).map((date) => ({ propertyId: x.listing._id, date, bookingId: gid, kind: "booking", expiresAt: null })));
  // Airbnb fetched its Majestic link (which now carries the booking)…
  await ExternalCalendar.updateOne({ _id: x.id }, { $set: { "export.lastServedAt": new Date() } });
  // …and exports it back as a block
  ota.events(x.path, [{ uid: "aaaaaaaaaaaa-0123456789abcdef0123456789abcdef@airbnb.com", start: S.day(50), end: S.day(52), summary: "Airbnb (Not available)" }]);
  await engine.syncConnection(x.id, { force: true });
  const mirror = await Booking.findOne({ propertyId: x.listing._id, source: "ical" }).lean();
  assert.strictEqual(mirror.external.echo.suspect, true);
  assert.deepStrictEqual(mirror.external.conflict.withBookingIds.map(String), [String(gid)]);
  // the booking's own checks ignore its mirror
  assert.strictEqual(await inventory.importedOverlap(x.listing._id, nights(50, 52), gid), null);
  const p = await inventory.securePermanent({ propertyId: x.listing._id, bookingId: gid, nights: nights(50, 52) });
  assert.strictEqual(p.ok, true, "keep / payment confirmation of the booking itself");
  await inventory.releaseNights(gid);
  const moved = await inventory.reserveNights({ propertyId: x.listing._id, nights: nights(50, 53), bookingId: gid, kind: "booking" });
  assert.strictEqual(moved.ok, true, "admin move by +1 night");
  // ...but anyone else is still blocked by it
  const other = await inventory.importedOverlap(x.listing._id, nights(50, 52), new mongoose.Types.ObjectId());
  assert.ok(other && String(other._id) === String(mirror._id));
});

// --- Low findings ---------------------------------------------------------------------------
function patchUpdateOnce(predicate, before) {
  const orig = Booking.updateOne;
  let fired = false;
  Booking.updateOne = async function patched(filter, update, ...rest) {
    if (!fired && filter && filter["external.rev"] !== undefined && predicate(filter, update)) {
      fired = true;
      if (before) await before(filter, update);
    }
    return orig.call(this, filter, update, ...rest);
  };
  return () => {
    Booking.updateOne = orig;
  };
}

test("low: a release that loses its revision race frees no night, and the feed is re-applied next time (hash not saved)", async () => {
  const x = await connected("AGODA", [{ uid: "AG-R@agoda.com", start: S.day(80), end: S.day(82) }]);
  const row = await Booking.findOne({ "external.connectionId": new mongoose.Types.ObjectId(x.id) }).lean();
  ota.events(x.path, [{ uid: "AG-R@agoda.com", start: S.day(80), end: S.day(82), status: "CANCELLED" }]);
  // another worker writes the row between our read and our release
  const restore = patchUpdateOnce((f, u) => u && u.$set && u.$set.status === "cancelled", (f) => Booking.collection.updateOne({ _id: f._id }, { $inc: { "external.rev": 1 } }));
  try {
    await engine.syncConnection(x.id, { force: true });
  } finally {
    restore();
  }
  assert.strictEqual(await BookingNight.countDocuments({ bookingId: row._id }), 2, "no hole: the nights are still blocked");
  const conn = await ExternalCalendar.findById(x.id).lean();
  assert.strictEqual(conn.sync.contentHash, null, "the next poll reconciles again");
  await engine.syncConnection(x.id, { force: true });
  assert.strictEqual((await Booking.findById(row._id).lean()).status, "cancelled", "converges");
  assert.strictEqual(await BookingNight.countDocuments({ bookingId: row._id }), 0);
});

test("low: a stay that has already started is never released by disappearance alone, and does not trigger the anomaly", async () => {
  const x = await connected("AGODA", [{ uid: "STAY@agoda.com", start: S.day(-1), end: S.day(3) }]);
  const row = await Booking.findOne({ "external.connectionId": new mongoose.Types.ObjectId(x.id) }).lean();
  const owned = await BookingNight.countDocuments({ bookingId: row._id });
  assert.ok(owned >= 3, `owns tonight onwards (${owned})`);
  ota.events(x.path, []); // the OTA drops the stay at check-in
  const t0 = Date.now();
  for (let k = 0; k < 5; k++) await engine.syncConnection(x.id, { force: true, now: new Date(t0 + k * 61 * 60_000) });
  const after = await Booking.findById(row._id).lean();
  assert.deepStrictEqual([after.status, after.external.state, after.external.missingMass], ["confirmed", "missing", false]);
  assert.strictEqual(await BookingNight.countDocuments({ bookingId: row._id }), owned, "still blocked after 4 h and 5 syncs");
  const conn = await ExternalCalendar.findById(x.id).lean();
  assert.strictEqual(conn.sync.anomaly, null);
  // an explicit cancellation still ends it at once
  ota.events(x.path, [{ uid: "STAY@agoda.com", start: S.day(-1), end: S.day(3), status: "CANCELLED" }]);
  await engine.syncConnection(x.id, { force: true, now: new Date(t0 + 6 * 61 * 60_000) });
  assert.strictEqual((await Booking.findById(row._id).lean()).status, "cancelled");
});

test("low: DNS resolution honours the request deadline", async () => {
  const { safeFetch } = require("../../services/calendarSync/safeFetch");
  const t = Date.now();
  await assert.rejects(safeFetch("https://calendar.example.com/a.ics", { timeoutMs: 300, resolve: () => new Promise(() => {}) }), (e) => e.code === "DNS_FAILED");
  assert.ok(Date.now() - t < 2000, `${Date.now() - t} ms`);
});

test("low: re-saving the same link through the legacy endpoint syncs at most once a minute", async () => {
  const host = await H.makeUser();
  const listing = await H.makeListing(host);
  const token = H.userToken(host);
  const p = `/rf${++seq}.ics`;
  ota.events(p, []);
  const save = () => H.api("POST", "/calendarSync/saveCalendar", { token, body: { propertyId: String(listing._id), kind: "import", url: ota.url(p) } });
  assert.strictEqual((await save()).status, 200);
  const afterFirst = ota.count(p);
  assert.strictEqual((await save()).status, 200);
  const afterSecond = ota.count(p);
  for (let i = 0; i < 5; i++) assert.strictEqual((await save()).status, 200);
  assert.strictEqual(ota.count(p), afterSecond, `no further fetches (${afterFirst} → ${afterSecond} → ${ota.count(p)})`);
});

test("low: migration — a retired duplicate connection's live rows become orphaned (visible, still blocking)", async () => {
  const x = await connected("AGODA", []);
  const conn = await ExternalCalendar.findById(x.id).lean();
  const dupId = new mongoose.Types.ObjectId();
  await ExternalCalendar.collection.insertOne({ _id: dupId, kind: "import", propertyId: x.listing._id, url: conn.url, status: "active", channel: "AGODA" });
  const rowId = new mongoose.Types.ObjectId();
  await Booking.collection.insertOne({ _id: rowId, userId: x.host._id, hostId: x.host._id, propertyId: x.listing._id, source: "ical", sourceId: "DUP@agoda.com", action: "user", checkIn: new Date(`${S.day(90)}T00:00:00Z`), checkOut: new Date(`${S.day(91)}T00:00:00Z`), status: "confirmed", paymentStatus: "paid", external: { connectionId: dupId, channel: "AGODA", key: "DUP@agoda.com", uid: "DUP@agoda.com", state: "active", rev: 0 } });
  const M = require("../../scripts/syncguard-migrate");
  const out = await M.apply({ log: () => {} });
  const dup = await ExternalCalendar.findById(dupId).lean();
  assert.deepStrictEqual([dup.status, dup.disconnectReason], ["disconnected", "duplicate_merged"]);
  const r = await Booking.findById(rowId).lean();
  assert.deepStrictEqual([r.status, r.external.state], ["confirmed", "orphaned"]);
  assert.ok(out.duplicateRowsOrphaned >= 1);
});

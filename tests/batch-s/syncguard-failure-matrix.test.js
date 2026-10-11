// SyncGuard release gate: every way a fetch can fail leaves valid inventory
// exactly as it was (rows, night ledger, what other OTAs are told), and the
// import edge cases behave as specified. DB state is asserted, not only the
// sync outcome.
const { test, before, after } = require("node:test");
const assert = require("node:assert");
const zlib = require("node:zlib");
const dns = require("node:dns");
const S = require("./syncguard-helpers");
const H = require("./setup");

const ota = new S.FakeOta();
const record = S.evidence("failure-matrix");
let Booking;
let ExternalCalendar;
let engine;
let mongoose;

before(async () => {
  await H.start();
  await ota.start();
  mongoose = require("mongoose");
  Booking = require("../../models/Booking");
  ExternalCalendar = require("../../models/ExternalCalendar");
  engine = require("../../services/calendarSync/engine");
});
after(async () => {
  await ota.stop();
  await H.stop();
});

let seq = 0;
const EVENTS = [
  { uid: "FM-1@airbnb.com", start: S.day(40), end: S.day(42), summary: "Reserved" },
  { uid: "FM-2@airbnb.com", start: S.day(50), end: S.day(51), summary: "Reserved" },
  { uid: "FM-3@airbnb.com", start: S.day(60), end: S.day(62), summary: "Reserved" },
];

// A listing with an Airbnb connection holding 3 live bookings and an Agoda
// connection whose destination feed forwards them.
async function property() {
  const host = await H.makeUser();
  const listing = await H.makeListing(host);
  const token = H.userToken(host);
  const p = `/fm${++seq}.ics`;
  ota.events(p, EVENTS);
  const a = await H.api("POST", `/calendarSync/properties/${listing._id}/connections`, { token, body: { channel: "AIRBNB", url: ota.url(p) } });
  assert.strictEqual(a.status, 201, JSON.stringify(a.body));
  const q = `/fm${++seq}.ics`;
  ota.events(q, []);
  const g = await H.api("POST", `/calendarSync/properties/${listing._id}/connections`, { token, body: { channel: "AGODA", url: ota.url(q) } });
  assert.strictEqual(g.status, 201, JSON.stringify(g.body));
  const agodaSecret = (await ExternalCalendar.findById(g.body.id).lean()).secret;
  return { host, listing, token, path: p, id: a.body.id, agodaSecret };
}

// Everything that protects inventory, as data.
async function inventoryState(x) {
  const snap = await S.snapshot(x.listing._id);
  const feed = await H.api("GET", `/calendarSync/ics/${x.agodaSecret}.ics`, {});
  const text = (feed.body && feed.body.raw) || "";
  return {
    rows: snap.bookings.map((b) => [b.id, b.status, b.state, b.checkIn, b.checkOut, b.missingSyncs]),
    nights: snap.nights.map((n) => [n.date, n.bookingId]),
    agodaFeed: (text.match(/DTSTART;VALUE=DATE:\d+/g) || []).sort(),
  };
}

function patchDns(host, behaviour) {
  const orig = dns.lookup;
  dns.lookup = function patched(hostname, options, cb) {
    if (typeof options === "function") {
      cb = options;
      options = {};
    }
    if (hostname !== host) return orig.call(dns, hostname, options, cb);
    if (behaviour === "fail") return process.nextTick(() => cb(Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), { code: "ENOTFOUND" })));
    if (behaviour === "hang") return undefined;
    if (behaviour === "private") return process.nextTick(() => cb(null, [{ address: "10.1.2.3", family: 4 }]));
    return orig.call(dns, hostname, options, cb);
  };
  return () => {
    dns.lookup = orig;
  };
}

const HTML = "<!doctype html><html><body>Please log in</body></html>";
const bigCal = () => {
  const L = ["BEGIN:VCALENDAR", "VERSION:2.0"];
  while (L.join("\r\n").length < 2.2 * 1024 * 1024) L.push("BEGIN:VEVENT", `UID:x${L.length}@big`, "DTSTART;VALUE=DATE:20300101", "DTEND;VALUE=DATE:20300102", `SUMMARY:${"x".repeat(200)}`, "END:VEVENT");
  L.push("END:VCALENDAR");
  return L.join("\r\n");
};
const budgetBomb = () => {
  const L = ["BEGIN:VCALENDAR", "VERSION:2.0"];
  for (let i = 0; i < 400; i++) L.push("BEGIN:VEVENT", `UID:b${i}@bomb`, "DTSTART;VALUE=DATE:04000101", "DTEND;VALUE=DATE:04000102", "RRULE:FREQ=DAILY;COUNT=1000", "END:VEVENT");
  L.push("END:VCALENDAR");
  return L.join("\r\n");
};

// Built once: compressing 40 MB inside the request would let a loaded
// machine hit the fetch deadline before Majestic reads a byte.
const GZIP_BOMB = zlib.gzipSync(Buffer.alloc(40 * 1024 * 1024, 0x20));
// [name, route spec | special, expected error code (null = success)]
const FAILURES = [
  ["connection reset", { handler: (req) => req.socket.destroy() }, "CONNECTION_FAILED"],
  ["hang (connection timeout)", { hang: true }, "TIMEOUT"],
  ["slow loris (1 byte / 300 ms)", { handler: (req, res) => {
    res.writeHead(200, { "content-type": "text/calendar" });
    const t = setInterval(() => (res.destroyed ? clearInterval(t) : res.write("B")), 300);
    req.on("close", () => clearInterval(t));
  } }, "TIMEOUT"],
  ["endless chunked body", { handler: (req, res) => {
    res.writeHead(200, { "content-type": "text/calendar" });
    const chunk = Buffer.alloc(64 * 1024, 0x41);
    const pump = () => {
      while (!res.destroyed && res.write(chunk));
      if (!res.destroyed) res.once("drain", pump);
    };
    pump();
  } }, "BODY_TOO_LARGE"],
  ["HTTP 400", { status: 400, body: "" }, "HTTP_ERROR"],
  ["HTTP 401", { status: 401, body: "" }, "AUTH_REFUSED"],
  ["HTTP 403", { status: 403, body: "" }, "AUTH_REFUSED"],
  ["HTTP 404", { status: 404, body: "" }, "NOT_FOUND"],
  ["HTTP 410", { status: 410, body: "" }, "NOT_FOUND"],
  ["HTTP 429", { status: 429, body: "", headers: { "retry-after": "120" } }, "RATE_LIMITED"],
  ["HTTP 500", { status: 500, body: "" }, "UPSTREAM_ERROR"],
  ["HTTP 502", { status: 502, body: "" }, "UPSTREAM_ERROR"],
  ["HTTP 503", { status: 503, body: "" }, "UPSTREAM_ERROR"],
  ["HTML login page (200)", { status: 200, body: HTML, headers: { "content-type": "text/html" } }, "NOT_ICALENDAR"],
  ["empty body (200, 0 bytes)", { status: 200, body: "" }, "NOT_ICALENDAR"],
  ["truncated calendar", { body: S.vcal(EVENTS).replace(/END:VCALENDAR\s*$/, "") }, "TRUNCATED"],
  ["oversized calendar (> 2 MB)", { body: bigCal() }, "BODY_TOO_LARGE"],
  ["gzip bomb", { handler: (req, res) => {
    res.writeHead(200, { "content-type": "text/calendar", "content-encoding": "gzip" });
    res.end(GZIP_BOMB);
  } }, "BODY_TOO_LARGE"],
  ["parser budget exhaustion (recurrence explosion)", { body: budgetBomb() }, "TOO_MANY_OCCURRENCES"],
  ["invalid UTF-8 / binary garbage", { body: Buffer.from([0xff, 0xfe, 0x00, 0x42, 0xc3, 0x28, 0xa0, 0xa1]) }, "NOT_ICALENDAR"],
];

test("every fetch failure leaves inventory untouched (rows, nights, forwarded feeds)", async () => {
  const x = await property();
  const baseline = await inventoryState(x);
  assert.strictEqual(baseline.nights.length, 5, "3 bookings, 5 nights");
  assert.strictEqual(baseline.agodaFeed.length, 3, "Agoda is told about all 3");
  const results = [];
  for (const [name, spec, code] of FAILURES) {
    ota.set(x.path, spec);
    const t0 = Date.now();
    const r = await engine.syncConnection(x.id, { force: true, deadline: Date.now() + 1500 });
    const ms = Date.now() - t0;
    const after = await inventoryState(x);
    const conn = await ExternalCalendar.findById(x.id).lean();
    results.push({ name, ok: r.ok, code: conn.sync.lastErrorCode, ms });
    assert.notStrictEqual(r.ok, true, `${name}: must not count as a successful read`);
    assert.strictEqual(conn.sync.lastErrorCode, code, `${name}: error code`);
    assert.deepStrictEqual(after, baseline, `${name}: inventory changed`);
    assert.ok(ms < 6000, `${name}: bounded (${ms} ms)`);
  }
  // DNS failures, a DNS timeout and a private DNS answer, at the engine level.
  for (const [behaviour, code] of [["fail", "DNS_FAILED"], ["hang", "DNS_FAILED"], ["private", "PRIVATE_ADDRESS"]]) {
    const hostname = `dns-${behaviour}.sgtest-syncguard.org`;
    await ExternalCalendar.updateOne({ _id: x.id }, { $set: { url: `http://${hostname}/feed.ics` } });
    const restore = patchDns(hostname, behaviour);
    try {
      const t0 = Date.now();
      const r = await engine.syncConnection(x.id, { force: true, deadline: Date.now() + 1500 });
      const ms = Date.now() - t0;
      const conn = await ExternalCalendar.findById(x.id).lean();
      results.push({ name: `DNS ${behaviour}`, ok: r.ok, code: conn.sync.lastErrorCode, ms });
      assert.strictEqual(conn.sync.lastErrorCode, code, `DNS ${behaviour}`);
      assert.ok(ms < 4000, `DNS ${behaviour}: bounded by the deadline (${ms} ms)`);
      assert.deepStrictEqual(await inventoryState(x), baseline, `DNS ${behaviour}: inventory changed`);
    } finally {
      restore();
    }
  }
  // 304 is a successful read of an unchanged calendar: nothing changes either.
  await ExternalCalendar.updateOne({ _id: x.id }, { $set: { url: ota.url(x.path), etag: '"v1"' } });
  ota.set(x.path, { status: 304, body: "" });
  const r304 = await engine.syncConnection(x.id, { force: true });
  assert.strictEqual(r304.notModified, true);
  assert.deepStrictEqual(await inventoryState(x), baseline, "304: inventory changed");
  // and the source recovers cleanly
  ota.events(x.path, EVENTS);
  const ok = await engine.syncConnection(x.id, { force: true, full: true });
  assert.strictEqual(ok.ok, true);
  assert.deepStrictEqual(await inventoryState(x), baseline, "recovery changed nothing");
  record("failure-matrix", { results, baseline });
});

test("a valid but EMPTY calendar is not a failure, yet releases nothing on first sight (anomaly)", async () => {
  const x = await property();
  const baseline = await inventoryState(x);
  ota.events(x.path, []);
  await engine.syncConnection(x.id, { force: true });
  const after = await inventoryState(x);
  assert.deepStrictEqual(after.nights, baseline.nights, "nights kept");
  assert.deepStrictEqual(after.agodaFeed, baseline.agodaFeed, "still forwarded");
  const conn = await ExternalCalendar.findById(x.id).lean();
  assert.strictEqual(conn.sync.anomaly, "MASS_DISAPPEARANCE");
});

test("mass disappearance by share: 3 of 6 vanish at once → anomaly rule (12 h), not the 2 h rule", async () => {
  const host = await H.makeUser();
  const listing = await H.makeListing(host);
  const token = H.userToken(host);
  const p = `/fm${++seq}.ics`;
  const six = [0, 1, 2, 3, 4, 5].map((i) => ({ uid: `SIX-${i}@agoda.com`, start: S.day(70 + i * 3), end: S.day(71 + i * 3) }));
  ota.events(p, six);
  const c = await H.api("POST", `/calendarSync/properties/${listing._id}/connections`, { token, body: { channel: "AGODA", url: ota.url(p) } });
  ota.events(p, six.slice(3));
  const t0 = Date.now();
  for (const m of [0, 40, 80, 130, 180]) await engine.syncConnection(c.body.id, { force: true, now: new Date(t0 + m * 60_000) });
  const rows = await Booking.find({ propertyId: listing._id, source: "ical" }).lean();
  const gone = rows.filter((r) => ["SIX-0@agoda.com", "SIX-1@agoda.com", "SIX-2@agoda.com"].includes(r.external.uid));
  assert.ok(gone.every((r) => r.external.state === "missing" && r.external.missingMass === true), "anomaly, still blocking after 3 h");
  for (const m of [400, 600, 760]) await engine.syncConnection(c.body.id, { force: true, now: new Date(t0 + m * 60_000) });
  const later = await Booking.find({ _id: { $in: gone.map((r) => r._id) } }).lean();
  assert.ok(later.every((r) => r.status === "cancelled" && r.external.state === "removed"), "released only after ≥ 4 syncs over ≥ 12 h");
});

test("provider changes an event's UID (same dates): the night never becomes free, and no cross-site alarm is raised", async () => {
  const host = await H.makeUser();
  const listing = await H.makeListing(host);
  const token = H.userToken(host);
  const p = `/fm${++seq}.ics`;
  ota.events(p, [{ uid: "OLD-UID@booking.com", start: S.day(80), end: S.day(82) }, { uid: "OTHER@booking.com", start: S.day(90), end: S.day(91) }]);
  const c = await H.api("POST", `/calendarSync/properties/${listing._id}/connections`, { token, body: { channel: "BOOKING_COM", url: ota.url(p) } });
  H.resetEmails();
  ota.events(p, [{ uid: "NEW-UID@booking.com", start: S.day(80), end: S.day(82) }, { uid: "OTHER@booking.com", start: S.day(90), end: S.day(91) }]);
  const t0 = Date.now();
  const timeline = [];
  for (const m of [0, 30, 70, 130, 200]) {
    await engine.syncConnection(c.body.id, { force: true, now: new Date(t0 + m * 60_000) });
    const g = await H.makeUser();
    const r = await H.api("POST", "/booking", { token: H.userToken(g), body: H.bookingBody(listing, { checkIn: S.day(80), checkOut: S.day(81) }) });
    timeline.push({ m, guestBooking: r.status });
    assert.strictEqual(r.status, 409, `+${m} min: the night must stay unavailable`);
  }
  const rows = await Booking.find({ propertyId: listing._id, source: "ical" }).lean();
  // Same dates, new UID, old UID gone from the same feed: the row is
  // re-keyed (release gate, M7) — no second row, nothing ever released.
  assert.strictEqual(rows.length, 2, `one row per booking: ${rows.map((r) => r.external.uid)}`);
  const byUid = Object.fromEntries(rows.map((r) => [r.external.uid, r]));
  assert.strictEqual(byUid["NEW-UID@booking.com"].status, "confirmed");
  assert.strictEqual(byUid["NEW-UID@booking.com"].external.key, "NEW-UID@booking.com");
  assert.ok(!byUid["OLD-UID@booking.com"], "the old key now names the same row");
  const conflict = byUid["NEW-UID@booking.com"].external.conflict;
  assert.ok(!(conflict && conflict.kind === "external_overlap"), `same connection is not "another site": ${JSON.stringify(conflict)}`);
  const list = await H.api("GET", `/calendarSync/properties/${listing._id}/connections`, { token });
  const conns = (list.body.data && (list.body.data.connections || list.body.data)) || [];
  assert.strictEqual(conns[0].counts.overlaps || 0, 0);
  assert.notStrictEqual(conns[0].health.state, "NEEDS_ATTENTION");
  assert.strictEqual(H.sentEmails().filter((e) => /booked or unavailable/.test(JSON.stringify(e))).length, 0, "no cross-site e-mail");
  record("uid-change", { timeline });
});

test("two overlapping events inside ONE feed (a reservation and a block) are not a cross-site overlap", async () => {
  const host = await H.makeUser();
  const listing = await H.makeListing(host);
  const token = H.userToken(host);
  const p = `/fm${++seq}.ics`;
  H.resetEmails();
  ota.events(p, [{ uid: "R@airbnb.com", start: S.day(95), end: S.day(97), summary: "Reserved" }, { uid: "B@airbnb.com", start: S.day(96), end: S.day(98), summary: "Airbnb (Not available)" }]);
  const c = await H.api("POST", `/calendarSync/properties/${listing._id}/connections`, { token, body: { channel: "AIRBNB", url: ota.url(p) } });
  assert.strictEqual(c.status, 201);
  const rows = await Booking.find({ propertyId: listing._id, source: "ical" }).lean();
  assert.ok(rows.every((r) => !(r.external.conflict && r.external.conflict.kind === "external_overlap")), JSON.stringify(rows.map((r) => r.external.conflict)));
  assert.strictEqual(H.sentEmails().length, 0);
  assert.deepStrictEqual(Object.keys(await S.nightOwners(listing._id)).sort(), [S.day(95), S.day(96), S.day(97)]);
});

test("two DIFFERENT connections reporting the same nights is still reported (the cross-site rule keeps working)", async () => {
  const host = await H.makeUser();
  const listing = await H.makeListing(host);
  const token = H.userToken(host);
  const p1 = `/fm${++seq}.ics`;
  const p2 = `/fm${++seq}.ics`;
  ota.events(p1, [{ uid: "VR-1@vrbo.com", start: S.day(100), end: S.day(102) }]);
  ota.events(p2, [{ uid: "AB-1@airbnb.com", start: S.day(100), end: S.day(102), summary: "Reserved" }]);
  await H.api("POST", `/calendarSync/properties/${listing._id}/connections`, { token, body: { channel: "VRBO", url: ota.url(p1) } });
  const b = await H.api("POST", `/calendarSync/properties/${listing._id}/connections`, { token, body: { channel: "AIRBNB", url: ota.url(p2) } });
  const row = await Booking.findOne({ "external.connectionId": new mongoose.Types.ObjectId(b.body.id) }).lean();
  assert.strictEqual(row.external.conflict && row.external.conflict.kind, "external_overlap");
});

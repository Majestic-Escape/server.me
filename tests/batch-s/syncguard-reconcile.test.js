// SyncGuard: reconciliation state machine, failure handling, fencing.
// Real Express app + in-memory replica set + fake OTA over HTTP.
const { test, before, after } = require("node:test");
const assert = require("node:assert");
const S = require("./syncguard-helpers");
const H = require("./setup");

const ota = new S.FakeOta();
const record = S.evidence("reconcile");
let engine;
let Booking;
let ExternalCalendar;
let BookingNight;
const T0 = Date.now();
const at = (minutes) => new Date(T0 + minutes * 60_000);

before(async () => {
  await H.start();
  await ota.start();
  engine = require("../../services/calendarSync/engine");
  Booking = require("../../models/Booking");
  ExternalCalendar = require("../../models/ExternalCalendar");
  BookingNight = require("../../models/BookingNight");
  await Promise.all([ExternalCalendar.syncIndexes(), require("../../models/CalendarSyncLog").syncIndexes()]);
});
after(async () => {
  await ota.stop();
  await H.stop();
});

async function setup(channel = "AIRBNB", events = []) {
  const host = await H.makeUser();
  const listing = await H.makeListing(host);
  const p = `/${Math.random().toString(36).slice(2)}.ics`;
  ota.events(p, events);
  const r = await H.api("POST", `/calendarSync/properties/${listing._id}/connections`, { token: H.userToken(host), body: { channel, url: ota.url(p) } });
  assert.strictEqual(r.status, 201, JSON.stringify(r.body));
  return { host, listing, path: p, id: r.body.id, token: H.userToken(host) };
}
const sync = (id, minutes, opts = {}) => engine.syncConnection(id, { force: true, now: at(minutes), ...opts });
const owners = (listing) => S.nightOwners(listing._id);
const ev = (uid, from, to, extra = {}) => ({ uid, start: S.day(from), end: S.day(to), summary: "Reserved", ...extra });

test("NEW → UNCHANGED (replay writes nothing) → MODIFIED without a ghost night", async () => {
  const x = await setup("AIRBNB", [ev("AIRBNB-123@airbnb.com", 10, 11)]);
  assert.deepStrictEqual(await owners(x.listing), { [S.day(10)]: "ical:AIRBNB" });
  const before = await Booking.findOne({ propertyId: x.listing._id }).lean();
  for (let i = 1; i <= 3; i++) await sync(x.id, i); // same feed, new DTSTAMPs every time
  const replay = await Booking.find({ propertyId: x.listing._id }).lean();
  assert.strictEqual(replay.length, 1, "no duplicate on replay");
  assert.strictEqual(String(replay[0].updatedAt), String(before.updatedAt), "unchanged row not rewritten");
  assert.strictEqual(replay[0].external.rev, before.external.rev);
  ota.events(x.path, [ev("AIRBNB-123@airbnb.com", 13, 14)]);
  const r = await sync(x.id, 5);
  assert.strictEqual(r.stats.modified, 1);
  assert.deepStrictEqual(await owners(x.listing), { [S.day(13)]: "ical:AIRBNB" }, "old night released, new night blocked");
  record("modify-no-ghost", { db: await S.snapshot(x.listing._id) });
});

test("explicit STATUS:CANCELLED releases at once; TRANSPARENT is free time on an OTA calendar", async () => {
  const x = await setup("VRBO", [ev("c1", 10, 12), ev("c2", 15, 16)]);
  ota.events(x.path, [ev("c1", 10, 12, { status: "CANCELLED" }), ev("c2", 15, 16, { extra: ["TRANSP:TRANSPARENT"] })]);
  const r = await sync(x.id, 1);
  assert.strictEqual(r.stats.cancelled, 2);
  assert.deepStrictEqual(await owners(x.listing), {});
  const rows = await Booking.find({ propertyId: x.listing._id }).lean();
  assert.deepStrictEqual(rows.map((b) => [b.status, b.external.state, b.external.releaseReason]).sort(), [["cancelled", "cancelled", "cancelled_by_source"], ["cancelled", "cancelled", "transparent"]]);
});

test("a GENERIC calendar's entries block even when marked free (TRANSP:TRANSPARENT) — it is connected to block dates", async () => {
  const x = await setup("GENERIC_ICAL", [ev("g1", 18, 20, { extra: ["TRANSP:TRANSPARENT"] })]);
  assert.deepStrictEqual(Object.keys(await owners(x.listing)).sort(), [S.day(18), S.day(19)]);
  const row = await Booking.findOne({ propertyId: x.listing._id, source: "ical" }).lean();
  assert.deepStrictEqual([row.status, row.external.state], ["confirmed", "active"]);
});

test("plain disappearance (others remain): blocked until ≥ 3 syncs over ≥ 2 h", async () => {
  const x = await setup("AIRBNB", [ev("keep", 10, 11), ev("gone", 20, 22)]);
  ota.events(x.path, [ev("keep", 10, 11)]);
  const states = [];
  for (const m of [5, 35, 65, 100]) {
    await sync(x.id, m);
    const row = await Booking.findOne({ propertyId: x.listing._id, "external.key": "gone" }).lean();
    states.push([m, row.external.state, row.external.missingSyncs, row.status]);
    assert.strictEqual(row.status, "confirmed", `still blocking at +${m} min`);
    assert.ok((await owners(x.listing))[S.day(20)], `night still owned at +${m} min`);
  }
  await sync(x.id, 125);
  const row = await Booking.findOne({ propertyId: x.listing._id, "external.key": "gone" }).lean();
  assert.deepStrictEqual([row.status, row.external.state, row.external.releaseReason], ["cancelled", "removed", "missing_confirmed"]);
  assert.deepStrictEqual(await owners(x.listing), { [S.day(10)]: "ical:AIRBNB" });
  record("plain-disappearance", { states, db: await S.snapshot(x.listing._id) });
});

for (const n of [1, 2, 30]) {
  test(`${n} → 0 (valid empty feed) is an ANOMALY: nothing reopens before ≥ 4 syncs over ≥ 12 h`, async () => {
    const events = Array.from({ length: n }, (_, i) => ev(`r${i}`, 10 + i * 2, 11 + i * 2));
    const x = await setup("AIRBNB", events);
    const blockedBefore = Object.keys(await owners(x.listing)).length;
    assert.strictEqual(blockedBefore, n);
    ota.events(x.path, []); // HTTP 200, a valid calendar, zero events
    const timeline = [];
    for (const m of [15, 30, 60, 120, 240, 480, 700]) {
      await sync(x.id, m);
      const s = await S.snapshot(x.listing._id);
      timeline.push({ m, blocked: s.nights.length, anomaly: s.connections[0].health.anomaly });
      assert.strictEqual(s.nights.length, blockedBefore, `+${m} min: every night still blocked`);
      assert.strictEqual(s.connections[0].health.anomaly, "MASS_DISAPPEARANCE");
    }
    const list = await H.api("GET", `/calendarSync/properties/${x.listing._id}/connections`, { token: x.token });
    assert.strictEqual(list.body.data.connections[0].health.state, "NEEDS_ATTENTION");
    await sync(x.id, 700 + 36); // first absence was at +15 min: +735 is the first moment ≥ 12 h later (and ≥ 4 syncs)
    assert.deepStrictEqual(await owners(x.listing), {}, "released only after the anomaly window");
    const rows = await Booking.find({ propertyId: x.listing._id }).lean();
    assert.ok(rows.every((r) => r.external.releaseReason === "missing_confirmed_after_anomaly"));
    record(`${n}-to-0`, { timeline, db: await S.snapshot(x.listing._id) });
  });
}

test("anomaly: the host is e-mailed exactly once per episode (and again for a new one)", async () => {
  const x = await setup("AIRBNB", [ev("solo", 10, 11)]);
  const mails = () => H.sentEmails().filter((e) => JSON.stringify(e).includes(x.host.email) && /suddenly shows no upcoming bookings/.test(JSON.stringify(e))).length;
  H.resetEmails();
  ota.events(x.path, []);
  for (const m of [5, 20, 40, 60]) await sync(x.id, m);
  assert.strictEqual(mails(), 1, "one e-mail for one episode");
  ota.events(x.path, [ev("solo", 10, 11)]);
  await sync(x.id, 80); // back to normal — episode closed
  ota.events(x.path, []);
  await sync(x.id, 100);
  assert.strictEqual(mails(), 2, "a new episode is a new e-mail");
});

test("host can confirm a disappearance early (release-missing), with acknowledgement", async () => {
  const x = await setup("AIRBNB", [ev("only", 10, 12)]);
  ota.events(x.path, []);
  await sync(x.id, 5);
  const noAck = await H.api("POST", `/calendarSync/connections/${x.id}/release-blocks`, { token: x.token, body: {} });
  assert.strictEqual(noAck.status, 400);
  assert.strictEqual(noAck.body.code, "ACK_REQUIRED");
  assert.strictEqual(Object.keys(await owners(x.listing)).length, 2, "nothing released without acknowledgement");
  const ok = await H.api("POST", `/calendarSync/connections/${x.id}/release-blocks`, { token: x.token, body: { acknowledge: true } });
  assert.strictEqual(ok.status, 200);
  assert.strictEqual(ok.body.result.released, 1);
  assert.deepStrictEqual(await owners(x.listing), {});
});

test("disappear → return → disappear: the confirmation count restarts", async () => {
  const x = await setup("AIRBNB", [ev("a", 10, 11), ev("b", 14, 15)]);
  ota.events(x.path, [ev("a", 10, 11)]);
  await sync(x.id, 5);
  await sync(x.id, 40);
  ota.events(x.path, [ev("a", 10, 11), ev("b", 14, 15)]);
  await sync(x.id, 80);
  let row = await Booking.findOne({ propertyId: x.listing._id, "external.key": "b" }).lean();
  assert.deepStrictEqual([row.external.state, row.external.missingSyncs], ["active", 0]);
  ota.events(x.path, [ev("a", 10, 11)]);
  await sync(x.id, 130);
  await sync(x.id, 160);
  row = await Booking.findOne({ propertyId: x.listing._id, "external.key": "b" }).lean();
  assert.deepStrictEqual([row.external.state, row.external.missingSyncs, row.status], ["missing", 2, "confirmed"], "counted from the second disappearance only");
});

test("failures never change reservations: 500, timeout, HTML, truncated, oversize, private redirect, bomb", async () => {
  const x = await setup("AIRBNB", [ev("stay", 10, 13)]);
  const baseline = await S.snapshot(x.listing._id);
  const cases = [
    ["HTTP 500", { status: 500, body: "oops" }, "UPSTREAM_ERROR"],
    ["HTTP 404", { status: 404, body: "" }, "NOT_FOUND"],
    ["HTTP 429", { status: 429, body: "", headers: { "retry-after": "60" } }, "RATE_LIMITED"],
    ["HTML login page", { body: "<html><body>Sign in</body></html>" }, "NOT_ICALENDAR"],
    ["truncated", { body: S.vcal([ev("stay", 10, 13)]).replace("END:VCALENDAR", "") }, "TRUNCATED"],
    ["oversize", { body: () => S.vcal([ev("stay", 10, 13)]) + "X".repeat(2.2 * 1024 * 1024) }, "BODY_TOO_LARGE"],
    ["redirect to metadata", { status: 302, body: "", headers: { location: "http://169.254.169.254/latest/meta-data/" } }, "PRIVATE_ADDRESS"],
    ["gzip bomb", { body: require("node:zlib").gzipSync(Buffer.alloc(30 * 1024 * 1024)), headers: { "content-encoding": "gzip" } }, "BODY_TOO_LARGE"],
  ];
  let m = 10;
  for (const [name, spec, code] of cases) {
    ota.set(x.path, spec);
    const r = await sync(x.id, (m += 10));
    assert.strictEqual(r.ok, false, name);
    assert.strictEqual(r.code, code, name);
    const s = await S.snapshot(x.listing._id);
    assert.deepStrictEqual(s.bookings, baseline.bookings, `${name}: rows untouched`);
    assert.deepStrictEqual(s.nights, baseline.nights, `${name}: nights untouched`);
  }
  ota.set(x.path, { hang: true });
  const t = Date.now();
  const r = await sync(x.id, (m += 10), { deadline: Date.now() + 500 });
  assert.strictEqual(r.code, "TIMEOUT");
  assert.ok(Date.now() - t < 3000);
  assert.deepStrictEqual((await S.snapshot(x.listing._id)).nights, baseline.nights);
  const list = await H.api("GET", `/calendarSync/properties/${x.listing._id}/connections`, { token: x.token });
  const c = list.body.data.connections[0];
  assert.ok(["BROKEN", "DEGRADED"].includes(c.health.state), c.health.state);
  assert.ok(c.sync.consecutiveFailures >= cases.length);
  assert.ok(c.sync.lastError && c.sync.lastError.message && !/169\.254|127\.0\.0\.1|https?:|\.ics/.test(c.sync.lastError.message), "the error message carries no address or URL");
  assert.match(c.importUrl, /^127\.0\.0\.1\/…[A-Za-z0-9]{4}$/, "the saved inbound URL is masked: host + last 4 characters only");
  assert.ok(!c.importUrl.includes(x.path.slice(1, -8)), "no path token");
  record("failures-keep-state", { cases: cases.map((c) => c[0]), health: c.health, db: await S.snapshot(x.listing._id) });
});

test("an unreadable event keeps its block (present but unknown)", async () => {
  const x = await setup("GENERIC_ICAL", [ev("x1", 10, 12), ev("x2", 15, 16)]);
  ota.set(x.path, { body: S.vcal([ev("x2", 15, 16)]).replace("END:VCALENDAR", ["BEGIN:VEVENT", "UID:x1", "DTSTART;VALUE=DATE:20261399", "END:VEVENT", "END:VCALENDAR"].join("\r\n")) });
  for (const m of [10, 50, 100, 200, 800]) await sync(x.id, m);
  const row = await Booking.findOne({ propertyId: x.listing._id, "external.key": "x1" }).lean();
  assert.deepStrictEqual([row.status, row.external.state], ["confirmed", "active"]);
});

test("same UID from two different connections are two different events", async () => {
  const x = await setup("AIRBNB", [ev("SAME-UID", 10, 11)]);
  const p2 = "/vrbo-same.ics";
  ota.events(p2, [ev("SAME-UID", 20, 21)]);
  const r = await H.api("POST", `/calendarSync/properties/${x.listing._id}/connections`, { token: x.token, body: { channel: "VRBO", url: ota.url(p2) } });
  assert.strictEqual(r.status, 201);
  const rows = await Booking.find({ propertyId: x.listing._id }).lean();
  assert.strictEqual(rows.length, 2);
  assert.deepStrictEqual(await owners(x.listing), { [S.day(10)]: "ical:AIRBNB", [S.day(20)]: "ical:VRBO" });
});

test("same calendar connected twice is refused (also under a concurrent double click); a second listing of the same OTA is allowed", async () => {
  const x = await setup("AIRBNB", [ev("u", 10, 11)]);
  const dup = await H.api("POST", `/calendarSync/properties/${x.listing._id}/connections`, { token: x.token, body: { channel: "AIRBNB", url: ota.url(x.path) } });
  assert.strictEqual(dup.status, 409);
  assert.strictEqual(dup.body.code, "ALREADY_CONNECTED");
  const p2 = "/airbnb-second-listing.ics";
  ota.events(p2, [ev("v", 30, 31)]);
  const second = await H.api("POST", `/calendarSync/properties/${x.listing._id}/connections`, { token: x.token, body: { channel: "AIRBNB", url: ota.url(p2) } });
  assert.strictEqual(second.status, 201);
  // concurrent double click on the same new URL → exactly one connection
  const p3 = "/race.ics";
  ota.events(p3, []);
  const both = await Promise.all([1, 2, 3].map(() => H.api("POST", `/calendarSync/properties/${x.listing._id}/connections`, { token: x.token, body: { channel: "GENERIC_ICAL", url: ota.url(p3) } })));
  assert.strictEqual(both.filter((r) => r.status === 201).length, 1, JSON.stringify(both.map((b) => b.status)));
  assert.strictEqual(await ExternalCalendar.countDocuments({ propertyId: x.listing._id, kind: "import", status: "active" }), 3);
});

test("legacy rows (pre-SyncGuard) are adopted and their host attribution repaired; unmatched ones go MISSING, not cancelled", async () => {
  const hostA = await H.makeUser();
  const hostB = await H.makeUser();
  const listing = await H.makeListing(hostA);
  const p = "/legacy.ics";
  ota.events(p, [ev("L1@airbnb.com", 10, 12)]);
  const legacyCal = await ExternalCalendar.collection.insertOne({ propertyId: listing._id, url: ota.url(p), kind: "import", __v: 0 });
  const mk = (uid, from, to) => ({ userId: hostB._id, hostId: hostB._id, propertyId: listing._id, source: "ical", sourceId: uid, checkIn: new Date(`${S.day(from)}T12:00:00Z`), checkOut: new Date(`${S.day(to)}T12:00:00Z`), price: 0, subTotal: 0, status: "confirmed", paymentStatus: "paid", action: "user", createdAt: new Date(), updatedAt: new Date() });
  await Booking.collection.insertMany([mk("L1@airbnb.com", 10, 12), mk("L2@airbnb.com", 20, 21)]);
  const r = await engine.syncConnection(legacyCal.insertedId, { force: true, now: at(1) });
  assert.ok(r.ok, JSON.stringify(r));
  const rows = await Booking.find({ propertyId: listing._id }).sort({ checkIn: 1 }).lean();
  assert.ok(rows.every((b) => String(b.hostId) === String(hostA._id) && String(b.userId) === String(hostA._id)), "D3 repaired");
  assert.ok(rows.every((b) => String(b.external.connectionId) === String(legacyCal.insertedId)));
  assert.deepStrictEqual(rows.map((b) => [b.sourceId, b.external.state, b.status]), [["L1@airbnb.com", "active", "confirmed"], ["L2@airbnb.com", "missing", "confirmed"]]);
  const conn = await ExternalCalendar.findById(legacyCal.insertedId).lean();
  assert.strictEqual(conn.channel, undefined, "channel inference is applied in memory; the migration persists it");
  record("legacy-adoption", { db: await S.snapshot(listing._id) });
});

test("304 Not Modified does no reconciliation; pending confirmations force the next full read", async () => {
  const x = await setup("GENERIC_ICAL", [ev("e1", 10, 11), ev("e2", 12, 13)]);
  const body = S.vcal([ev("e1", 10, 11)]);
  ota.set(x.path, { body, headers: { etag: '"v2"' } });
  await sync(x.id, 5); // e2 → missing (pendingMissing 1)
  // Server now answers 304 to our If-None-Match … but we have a pending row,
  // so the ETag was not kept and the next fetch is unconditional.
  let conn = await ExternalCalendar.findById(x.id).lean();
  assert.strictEqual(conn.sync.pendingMissing, 1);
  ota.set(x.path, { status: 304, body: "" });
  const r = await sync(x.id, 10);
  assert.ok(r.notModified);
  conn = await ExternalCalendar.findById(x.id).lean();
  assert.ok(!conn.etag, "etag dropped while confirmations are pending");
  const row = await Booking.findOne({ propertyId: x.listing._id, "external.key": "e2" }).lean();
  assert.strictEqual(row.external.missingSyncs, 1, "a 304 never advances a confirmation");
});

test("fencing: a worker frozen past its lease cannot apply its older response", async () => {
  const x = await setup("AIRBNB", [ev("F@airbnb.com", 10, 11)]);
  let release;
  const gate = new Promise((r) => (release = r));
  // Worker A fetches the feed as it is NOW (v1: night 10) but its response is delayed.
  ota.set(x.path, { body: S.vcal([ev("F@airbnb.com", 10, 11)]), gate });
  const hitsBefore = ota.count(x.path);
  const a = engine.syncConnection(x.id, { force: true, now: at(1) });
  // Wait until A's request has really reached the OTA (it now carries v1).
  for (let i = 0; i < 200 && ota.count(x.path) === hitsBefore; i++) await new Promise((r) => setTimeout(r, 25));
  assert.ok(ota.count(x.path) > hitsBefore, "worker A is mid-fetch");
  // The feed changes (v2: night 13), A's lease expires, worker B syncs v2.
  await ExternalCalendar.updateOne({ _id: x.id }, { $set: { "sync.leaseUntil": new Date(Date.now() - 1000) } });
  ota.events(x.path, [ev("F@airbnb.com", 13, 14)]);
  const b = await engine.syncConnection(x.id, { force: true, now: at(2) });
  assert.ok(b.ok);
  assert.deepStrictEqual(await owners(x.listing), { [S.day(13)]: "ical:AIRBNB" });
  release(); // A finally receives v1
  const ra = await a;
  assert.strictEqual(ra.code, "LEASE_LOST");
  assert.deepStrictEqual(await owners(x.listing), { [S.day(13)]: "ical:AIRBNB" }, "older response not applied");
  record("fencing", { a: ra, db: await S.snapshot(x.listing._id) });
});

test("crash between night release and row update leaves a block, never a hole (and the next sync converges)", async () => {
  const x = await setup("GENERIC_ICAL", [ev("k1", 10, 12)]);
  const row = await Booking.findOne({ propertyId: x.listing._id }).lean();
  // Simulate the crash window of a release: nights gone, row still active.
  await BookingNight.deleteMany({ bookingId: row._id });
  const blocked = await H.api("GET", `/booking/check-dates/${x.listing._id}`);
  assert.ok(blocked.body.data.includes(S.day(10)), "check-dates still shows the night blocked (row-level)");
  const guest = await H.makeUser();
  const tryBook = await H.api("POST", "/booking", { token: H.userToken(guest), body: H.bookingBody(x.listing, { checkIn: S.day(10), checkOut: S.day(11) }) });
  assert.strictEqual(tryBook.status, 409, "the legacy row-level overlap check refuses the night");
  await engine.syncConnection(x.id, { force: true, full: true, now: at(3) }); // full pass repairs ownership
  assert.deepStrictEqual(await owners(x.listing), { [S.day(10)]: "ical:GENERIC_ICAL", [S.day(11)]: "ical:GENERIC_ICAL" });
});

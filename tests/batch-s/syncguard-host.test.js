// SyncGuard host API: tenant isolation, auth posture, cron secrets, safe
// disconnect, reconnect and URL replacement (docs/syncguard.md §5, §8).
const { test, before, after } = require("node:test");
const assert = require("node:assert");
const S = require("./syncguard-helpers");
const H = require("./setup");

const ota = new S.FakeOta();
const record = S.evidence("host");
let base;
let Booking;
let ExternalCalendar;
let CalendarSyncLog;

before(async () => {
  base = (await H.start()).baseUrl;
  await ota.start();
  Booking = require("../../models/Booking");
  ExternalCalendar = require("../../models/ExternalCalendar");
  CalendarSyncLog = require("../../models/CalendarSyncLog");
  await Promise.all([ExternalCalendar.syncIndexes(), CalendarSyncLog.syncIndexes()]);
});
after(async () => {
  await ota.stop();
  await H.stop();
});

let seq = 0;
async function hostWithConnection(events = []) {
  const host = await H.makeUser();
  const listing = await H.makeListing(host);
  const p = `/host${++seq}.ics`;
  ota.events(p, events);
  const token = H.userToken(host);
  const r = await H.api("POST", `/calendarSync/properties/${listing._id}/connections`, { token, body: { channel: "AIRBNB", url: ota.url(p) } });
  assert.strictEqual(r.status, 201, JSON.stringify(r.body));
  return { host, listing, token, id: r.body.id, path: p, data: r.body.data };
}
const ev = (uid, a, b) => ({ uid, start: S.day(a), end: S.day(b), summary: "Reserved" });

test("tenant isolation: host B can do nothing to host A's connections or listing", async () => {
  const A = await hostWithConnection([ev("A1@airbnb.com", 10, 12)]);
  const B = await hostWithConnection([]);
  const before = await S.snapshot(A.listing._id);
  const conn = A.id;
  const attempts = [
    ["GET", `/calendarSync/properties/${A.listing._id}/connections`],
    ["POST", `/calendarSync/properties/${A.listing._id}/connections`, { channel: "AIRBNB", url: ota.url("/evil.ics") }],
    ["GET", `/calendarSync/properties/${A.listing._id}/explain?date=${S.day(10)}`],
    ["POST", `/calendarSync/properties/${A.listing._id}/legacy-feed/revoke`],
    ["PATCH", `/calendarSync/connections/${conn}`, { url: ota.url("/evil.ics") }],
    ["POST", `/calendarSync/connections/${conn}/sync`],
    ["POST", `/calendarSync/connections/${conn}/rotate-export`],
    ["POST", `/calendarSync/connections/${conn}/confirm-export`],
    ["POST", `/calendarSync/connections/${conn}/disconnect`, { acknowledge: true, releaseBlocks: true }],
    ["POST", `/calendarSync/connections/${conn}/release-blocks`, { acknowledge: true }],
    ["POST", "/calendarSync/saveCalendar", { propertyId: String(A.listing._id), kind: "export" }],
    ["POST", "/calendarSync/saveCalendar", { propertyId: String(A.listing._id), kind: "import", url: ota.url("/evil.ics") }],
  ];
  const results = [];
  for (const [method, path, body] of attempts) {
    const r = await H.api(method, path, { token: B.token, body });
    results.push([method, path.replace(String(A.listing._id), ":A").replace(conn, ":connA"), r.status]);
    assert.ok([403, 404].includes(r.status), `${method} ${path} → ${r.status}`);
    assert.ok(!JSON.stringify(r.body).includes(".ics"), "no feed URL / token leaked in the refusal");
  }
  assert.deepStrictEqual(await S.snapshot(A.listing._id), before, "host A's data untouched");
  assert.strictEqual(ota.count("/evil.ics"), 0, "no fetch triggered by the attacker");
  // connection-scoped refusals are 404 (no existence oracle) and identical for a random id
  const fake = await H.api("POST", `/calendarSync/connections/${"0".repeat(24)}/sync`, { token: B.token });
  const real = await H.api("POST", `/calendarSync/connections/${conn}/sync`, { token: B.token });
  assert.deepStrictEqual([fake.status, fake.body.code], [real.status, real.body.code]);
  // admin may act
  const admin = await H.makeAdmin();
  const asAdmin = await H.api("GET", `/calendarSync/properties/${A.listing._id}/connections`, { token: H.adminToken(admin) });
  assert.strictEqual(asAdmin.status, 200);
  record("tenant-isolation", { results });
});

test("auth posture: no token → 401; a cookie alone is ignored (Bearer header only — no CSRF vector); malformed ids → 404", async () => {
  const A = await hostWithConnection([]);
  const anon = await fetch(`${base}/calendarSync/connections/${A.id}/sync`, { method: "POST" });
  assert.strictEqual(anon.status, 401);
  const cookieOnly = await fetch(`${base}/calendarSync/connections/${A.id}/sync`, { method: "POST", headers: { cookie: `token=${A.token}; session=${A.token}` } });
  assert.strictEqual(cookieOnly.status, 401, "cookies never authenticate");
  const bad = await H.api("POST", "/calendarSync/connections/not-an-id/sync", { token: A.token });
  assert.strictEqual(bad.status, 404);
  const list = await H.api("GET", `/calendarSync/properties/${A.listing._id}/connections`, { token: A.token });
  const json = JSON.stringify(list.body);
  assert.ok(!json.includes(A.path.slice(1)), "the inbound URL is never returned in full");
  assert.match(list.body.data.connections[0].importUrl, /^127\.0\.0\.1\/…/);
});

test("cron sweep: refused without a secret; Vercel's CRON_SECRET and the scoped secret work; the scoped one cannot trigger payouts", async () => {
  process.env.CALENDAR_SYNC_CRON_SECRET = "scoped-calendar-secret";
  const call = (path, secret) => fetch(`${base}${path}`, { headers: secret ? { authorization: `Bearer ${secret}` } : {} });
  assert.strictEqual((await call("/calendarSync/cron/sweep")).status, 401);
  assert.strictEqual((await call("/calendarSync/cron/sweep", "wrong")).status, 401);
  assert.strictEqual((await call("/calendarSync/cron/sweep", process.env.CRON_SECRET)).status, 200);
  assert.strictEqual((await call("/calendarSync/cron/sweep?source=github", "scoped-calendar-secret")).status, 200);
  assert.strictEqual((await call("/payment/schedule-cron", "scoped-calendar-secret")).status, 401, "the scoped secret is useless for the payout cron");
});

test("Sync now is rate limited per connection (1/min) and reports the outcome", async () => {
  const A = await hostWithConnection([]);
  await ExternalCalendar.updateOne({ _id: A.id }, { $set: { "sync.manualAt": null } });
  const first = await H.api("POST", `/calendarSync/connections/${A.id}/sync`, { token: A.token });
  assert.strictEqual(first.status, 200);
  assert.strictEqual(first.body.syncState, "done");
  const second = await H.api("POST", `/calendarSync/connections/${A.id}/sync`, { token: A.token });
  assert.strictEqual(second.status, 429);
  assert.strictEqual(second.body.code, "SYNC_RATE_LIMITED");
});

test("safe disconnect: acknowledgement required; blocks KEPT by default (still block + still propagate); audit kept", async () => {
  const A = await hostWithConnection([ev("KEEPME@airbnb.com", 10, 12)]);
  // a second connection (Agoda) to observe propagation of the kept block
  const p2 = `/agoda${++seq}.ics`;
  ota.events(p2, []);
  const ag = await H.api("POST", `/calendarSync/properties/${A.listing._id}/connections`, { token: A.token, body: { channel: "AGODA", url: ota.url(p2) } });
  const agodaFeed = ag.body.data.connections.find((c) => c.id === ag.body.id).export.url.match(/\/ics\/([^/]+)\.ics$/)[1];
  const noAck = await H.api("POST", `/calendarSync/connections/${A.id}/disconnect`, { token: A.token, body: {} });
  assert.strictEqual(noAck.status, 400);
  assert.strictEqual(noAck.body.code, "ACK_REQUIRED");
  assert.strictEqual(noAck.body.blocks, 1, "the refusal says how many bookings are at stake");
  const dis = await H.api("POST", `/calendarSync/connections/${A.id}/disconnect`, { token: A.token, body: { acknowledge: true } });
  assert.strictEqual(dis.status, 200);
  assert.deepStrictEqual(dis.body.result, { mode: "keep", kept: 1, released: 0 });
  assert.deepStrictEqual(await S.nightOwners(A.listing._id), { [S.day(10)]: "ical:AIRBNB", [S.day(11)]: "ical:AIRBNB" }, "dates stay protected");
  const row = await Booking.findOne({ propertyId: A.listing._id, source: "ical" }).lean();
  assert.strictEqual(row.external.state, "orphaned");
  const feed = await (await fetch(`${base}/calendarSync/ics/${agodaFeed}.ics`)).text();
  assert.ok(feed.includes(`DTSTART;VALUE=DATE:${S.day(10).replace(/-/g, "")}`), "the kept Airbnb booking still reaches Agoda");
  const list = await H.api("GET", `/calendarSync/properties/${A.listing._id}/connections`, { token: A.token });
  assert.deepStrictEqual(list.body.data.disconnected.map((d) => [d.channel, d.orphanedBlocks]), [["AIRBNB", 1]]);
  // Majestic can no longer see Airbnb: booking those nights is still refused, other nights still work.
  const guest = await H.makeUser();
  const tryIt = await H.api("POST", "/booking", { token: H.userToken(guest), body: H.bookingBody(A.listing, { checkIn: S.day(10), checkOut: S.day(11) }) });
  assert.strictEqual(tryIt.status, 409);
  const types = (await CalendarSyncLog.find({ connectionId: A.id }).lean()).map((l) => l.type);
  assert.ok(types.includes("connection_created") && types.includes("disconnected"), types.join());
  // explicit release later, with acknowledgement
  const rel = await H.api("POST", `/calendarSync/connections/${A.id}/release-blocks`, { token: A.token, body: { acknowledge: true } });
  assert.strictEqual(rel.body.result.released, 1);
  assert.deepStrictEqual(await S.nightOwners(A.listing._id), {});
  record("disconnect-keep", { result: dis.body.result, afterRelease: await S.snapshot(A.listing._id) });
});

test("disconnect with releaseBlocks (OTA no longer selling) releases at once; disconnecting a stale source works the same", async () => {
  const A = await hostWithConnection([ev("R1@airbnb.com", 20, 22)]);
  await ExternalCalendar.updateOne({ _id: A.id }, { $set: { "sync.lastSuccessAt": new Date(Date.now() - 48 * 3600_000), "sync.consecutiveFailures": 9, "sync.lastErrorCode": "NOT_FOUND" } });
  const dis = await H.api("POST", `/calendarSync/connections/${A.id}/disconnect`, { token: A.token, body: { acknowledge: true, releaseBlocks: true } });
  assert.deepStrictEqual(dis.body.result, { mode: "release", kept: 0, released: 1 });
  assert.deepStrictEqual(await S.nightOwners(A.listing._id), {});
  const row = await Booking.findOne({ propertyId: A.listing._id, source: "ical" }).lean();
  assert.deepStrictEqual([row.status, row.external.state, row.external.releaseReason], ["cancelled", "released", "host_released_on_disconnect"], "row kept for audit");
});

test("reconnect the same calendar revives the connection and its kept blocks (no duplicates)", async () => {
  const A = await hostWithConnection([ev("RC@airbnb.com", 30, 31)]);
  await H.api("POST", `/calendarSync/connections/${A.id}/disconnect`, { token: A.token, body: { acknowledge: true } });
  const again = await H.api("POST", `/calendarSync/properties/${A.listing._id}/connections`, { token: A.token, body: { channel: "AIRBNB", url: ota.url(A.path) } });
  assert.strictEqual(again.status, 200);
  assert.strictEqual(again.body.reconnected, true);
  assert.strictEqual(again.body.id, A.id, "same connection");
  const rows = await Booking.find({ propertyId: A.listing._id, source: "ical" }).lean();
  assert.deepStrictEqual(rows.map((r) => r.external.state), ["active"]);
  assert.strictEqual(await ExternalCalendar.countDocuments({ propertyId: A.listing._id, kind: "import" }), 1);
});

test("URL replacement with active bookings: old events are not dropped in one step; same UIDs carry over", async () => {
  const A = await hostWithConnection([ev("OLD1@airbnb.com", 40, 41), ev("SHARED@airbnb.com", 44, 45)]);
  const p2 = `/newlink${++seq}.ics`;
  ota.events(p2, [ev("SHARED@airbnb.com", 44, 45)]); // reset link: same reservations minus a cancelled one
  const up = await H.api("PATCH", `/calendarSync/connections/${A.id}`, { token: A.token, body: { url: ota.url(p2) } });
  assert.strictEqual(up.status, 200, JSON.stringify(up.body));
  const rows = await Booking.find({ propertyId: A.listing._id, source: "ical" }).sort({ checkIn: 1 }).lean();
  assert.deepStrictEqual(rows.map((r) => [r.external.key, r.external.state, r.status]), [["OLD1@airbnb.com", "missing", "confirmed"], ["SHARED@airbnb.com", "active", "confirmed"]]);
  // Whole-calendar switch to an unrelated, empty calendar: anomaly, nothing reopens.
  const p3 = `/wrongcal${++seq}.ics`;
  ota.events(p3, []);
  await H.api("PATCH", `/calendarSync/connections/${A.id}`, { token: A.token, body: { url: ota.url(p3) } });
  assert.strictEqual(Object.keys(await S.nightOwners(A.listing._id)).length, 2, "both nights still blocked");
  const conn = await ExternalCalendar.findById(A.id).lean();
  assert.strictEqual(conn.sync.anomaly, "MASS_DISAPPEARANCE");
  // invalid replacement URL is refused and changes nothing
  const bad = await H.api("PATCH", `/calendarSync/connections/${A.id}`, { token: A.token, body: { url: "https://127.0.0.1/x.ics" } });
  assert.strictEqual(bad.status, 422);
  assert.strictEqual((await ExternalCalendar.findById(A.id).lean()).url, ota.url(p3));
  record("url-replacement", { db: await S.snapshot(A.listing._id) });
});

test("connect validation: bad URLs, SSRF and non-calendars are refused before anything is saved; attempts are rate limited", async () => {
  const host = await H.makeUser();
  const listing = await H.makeListing(host);
  const token = H.userToken(host);
  ota.set("/page.html", { body: "<html>hi</html>" });
  const cases = [["ftp://x.example.com/c.ics", "INVALID_URL"], ["https://localhost/c.ics", "PRIVATE_ADDRESS"], ["https://169.254.169.254/latest/meta-data", "PRIVATE_ADDRESS"], [ota.url("/page.html"), "NOT_ICALENDAR"], [ota.url("/missing.ics"), "NOT_FOUND"]];
  for (const [url, code] of cases) {
    const r = await H.api("POST", `/calendarSync/properties/${listing._id}/connections`, { token, body: { channel: "AIRBNB", url } });
    assert.strictEqual(r.status, 422, url);
    assert.strictEqual(r.body.code, code, url);
  }
  assert.strictEqual(await ExternalCalendar.countDocuments({ propertyId: listing._id }), 0);
  let limited = null;
  for (let i = 0; i < 25 && !limited; i++) {
    const r = await H.api("POST", `/calendarSync/properties/${listing._id}/connections`, { token, body: { channel: "AIRBNB", url: ota.url("/missing.ics") } });
    if (r.status === 429) limited = r;
  }
  assert.ok(limited, "connect attempts are rate limited");
  // legacy mobile/web endpoint: same validation, legacy shape. The old clients
  // show `message` only for a 2xx `{success:false}` (a 4xx becomes a generic
  // "Request failed…"), so a refusal is answered that way.
  const legacy = await H.api("POST", "/calendarSync/saveCalendar", { token, body: { propertyId: String(listing._id), kind: "import", url: "https://10.0.0.1/c.ics" } });
  assert.strictEqual(legacy.status, 200);
  assert.strictEqual(legacy.body.success, false);
  assert.ok(["PRIVATE_ADDRESS", "TOO_MANY_ATTEMPTS"].includes(legacy.body.code), legacy.body.code);
  assert.ok(legacy.body.message && !/request failed/i.test(legacy.body.message), legacy.body.message);
  assert.strictEqual(await ExternalCalendar.countDocuments({ propertyId: listing._id, kind: "import" }), 0, "nothing saved");
});

test("legacy saveCalendar refusals reach old clients as a readable message (200 + success:false); auth failures keep their status", async () => {
  const host = await H.makeUser();
  const listing = await H.makeListing(host);
  const token = H.userToken(host);
  const save = (url, t = token, pid = String(listing._id)) => H.api("POST", "/calendarSync/saveCalendar", { token: t, body: { propertyId: pid, kind: "import", url } });
  const cases = {
    notHttps: await save("ftp://example.com/c.ics"),
    privateAddress: await save("https://192.168.1.10/c.ics"),
    notACalendar: await (async () => {
      const p = `/notcal${++seq}.ics`;
      ota.set(p, { body: "<html>login</html>", headers: { "content-type": "text/html" } });
      return save(ota.url(p));
    })(),
  };
  for (const [name, r] of Object.entries(cases)) {
    assert.strictEqual(r.status, 200, `${name}: ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.success, false, name);
    assert.ok(r.body.code && r.body.message, name);
  }
  assert.match(cases.notACalendar.body.message, /calendar/i);
  // ownership / auth failures are not "answers": they keep their HTTP status
  const other = H.userToken(await H.makeUser());
  assert.ok([403, 404].includes((await save("https://example.com/c.ics", other)).status));
  assert.strictEqual((await H.api("POST", "/calendarSync/saveCalendar", { body: { propertyId: String(listing._id), kind: "import", url: "https://example.com/c.ics" } })).status, 401);
  assert.strictEqual(await ExternalCalendar.countDocuments({ propertyId: listing._id, kind: "import" }), 0);
});

test("legacy saveCalendar import keeps its contract (mobile app): success + message; re-save syncs; second URL becomes a second connection", async () => {
  const host = await H.makeUser();
  const listing = await H.makeListing(host);
  const token = H.userToken(host);
  const p1 = `/leg${++seq}.ics`;
  const p2 = `/leg${++seq}.ics`;
  ota.events(p1, [ev("L-A@airbnb.com", 50, 51)]);
  ota.events(p2, [ev("L-V@vrbo", 52, 53)]);
  const a = await H.api("POST", "/calendarSync/saveCalendar", { token, body: { propertyId: String(listing._id), kind: "import", url: ota.url(p1) } });
  assert.deepStrictEqual(a.body, { success: true, message: "Calendar sync has started. Please wait a few minutes and refresh the page." });
  const again = await H.api("POST", "/calendarSync/saveCalendar", { token, body: { propertyId: String(listing._id), kind: "import", url: ota.url(p1) } });
  assert.deepStrictEqual(again.body, { success: true, message: "Calendar already synced. We will keep checking for updates." });
  const second = await H.api("POST", "/calendarSync/saveCalendar", { token, body: { propertyId: String(listing._id), kind: "import", url: ota.url(p2) } });
  assert.strictEqual(second.body.success, true);
  assert.strictEqual(await ExternalCalendar.countDocuments({ propertyId: listing._id, kind: "import", status: "active" }), 2, "D4 fixed: Airbnb + another calendar");
  const owners = await S.nightOwners(listing._id);
  assert.deepStrictEqual(Object.keys(owners).sort(), [S.day(50), S.day(52)]);
  // rows carry the listing host, not whoever saved (D3)
  assert.ok((await Booking.find({ propertyId: listing._id, source: "ical" }).lean()).every((b) => String(b.hostId) === String(host._id)));
});

test("adversarial: one account cannot turn the fetcher into a traffic generator (per-host connection cap)", async () => {
  process.env.SYNC_MAX_CONNECTIONS_PER_HOST = "3";
  try {
    const host = await H.makeUser();
    const token = H.userToken(host);
    const statuses = [];
    for (let i = 0; i < 4; i++) {
      const listing = await H.makeListing(host); // listings are cheap: the cap is per account
      const p = `/cap${++seq}.ics`;
      ota.events(p, []);
      const r = await H.api("POST", `/calendarSync/properties/${listing._id}/connections`, { token, body: { channel: "GENERIC_ICAL", url: ota.url(p) } });
      statuses.push(r.status);
    }
    assert.deepStrictEqual(statuses, [201, 201, 201, 409]);
  } finally {
    delete process.env.SYNC_MAX_CONNECTIONS_PER_HOST;
  }
});

test("feed URLs always resolve under /api/v1, whatever PUBLIC_HOSTNAME carries", () => {
  const { feedUrl } = require("../../services/calendarSync/connections");
  const saved = process.env.PUBLIC_HOSTNAME;
  try {
    for (const [v, want] of [["https://server.majesticescape.in/api/v1", "https://server.majesticescape.in/api/v1/calendarSync/ics/T.ics"], ["https://server.majesticescape.in/", "https://server.majesticescape.in/api/v1/calendarSync/ics/T.ics"], ["https://server.majesticescape.in", "https://server.majesticescape.in/api/v1/calendarSync/ics/T.ics"]]) {
      process.env.PUBLIC_HOSTNAME = v;
      assert.strictEqual(feedUrl("T"), want, v);
    }
  } finally {
    process.env.PUBLIC_HOSTNAME = saved;
  }
});

test("explain: why is a date unavailable — owner, provenance, freshness and history, no guest data", async () => {
  const A = await hostWithConnection([ev("WHY@airbnb.com", 60, 62)]);
  const r = await H.api("GET", `/calendarSync/properties/${A.listing._id}/explain?date=${S.day(61)}`, { token: A.token });
  assert.strictEqual(r.status, 200);
  const d = r.body.data;
  assert.strictEqual(d.available, false);
  assert.strictEqual(d.reasons.length, 1);
  assert.deepStrictEqual([d.reasons[0].type, d.reasons[0].channel, d.reasons[0].ownsNight, d.reasons[0].checkIn, d.reasons[0].checkOut], ["external", "AIRBNB", true, S.day(60), S.day(62)]);
  assert.ok(d.reasons[0].sourceLastSyncedAt);
  assert.ok(d.timeline.some((t) => t.type === "added" && t.channel === "AIRBNB"));
  assert.ok(!JSON.stringify(d).includes("WHY@airbnb.com"), "external UIDs are not exposed");
  const free = await H.api("GET", `/calendarSync/properties/${A.listing._id}/explain?date=${S.day(70)}`, { token: A.token });
  assert.strictEqual(free.body.data.available, true);
  const bad = await H.api("GET", `/calendarSync/properties/${A.listing._id}/explain?date=12-10-2026`, { token: A.token });
  assert.strictEqual(bad.status, 400);
  record("explain", { response: d });
});

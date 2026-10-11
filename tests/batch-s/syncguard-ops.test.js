// SyncGuard release gate: authorization matrix, the scheduler as an operator
// sees it, observability of every important state, journal hygiene, and the
// "no calendar connected" regression.
const { test, before, after } = require("node:test");
const assert = require("node:assert");
const S = require("./syncguard-helpers");
const H = require("./setup");

const ota = new S.FakeOta();
const record = S.evidence("ops");
let Booking;
let ExternalCalendar;
let CalendarSyncLog;
let CalendarSyncState;
let engine;
let mongoose;

before(async () => {
  await H.start();
  await ota.start();
  mongoose = require("mongoose");
  Booking = require("../../models/Booking");
  ExternalCalendar = require("../../models/ExternalCalendar");
  CalendarSyncLog = require("../../models/CalendarSyncLog");
  CalendarSyncState = require("../../models/CalendarSyncState");
  engine = require("../../services/calendarSync/engine");
});
after(async () => {
  await ota.stop();
  await H.stop();
});

let seq = 0;
async function hostWithCalendar(events = [{ uid: `OPS-${seq}@airbnb.com`, start: S.day(30), end: S.day(32), summary: "Reserved" }]) {
  const host = await H.makeUser();
  const listing = await H.makeListing(host);
  const token = H.userToken(host);
  const p = `/ops${++seq}.ics`;
  ota.events(p, events);
  const c = await H.api("POST", `/calendarSync/properties/${listing._id}/connections`, { token, body: { channel: "AIRBNB", url: ota.url(p) } });
  assert.strictEqual(c.status, 201, JSON.stringify(c.body));
  return { host, listing, token, path: p, id: c.body.id };
}
const listOf = async (x, token = x.token) => {
  const r = await H.api("GET", `/calendarSync/properties/${x.listing._id}/connections`, { token });
  return (r.body.data && (r.body.data.connections || r.body.data)) || [];
};

test("authorization matrix: host B, an anonymous caller and an admin against host A's calendars — no oracle, no cross-tenant work, no leaks", async () => {
  const A = await hostWithCalendar();
  const B = await hostWithCalendar();
  const admin = H.adminToken(await H.makeAdmin());
  const before = await ExternalCalendar.findById(A.id).lean();
  const hitsBefore = ota.count(A.path);
  const pid = String(A.listing._id);
  const cid = A.id;
  const endpoints = [
    ["GET", `/calendarSync/properties/${pid}/connections`],
    ["POST", `/calendarSync/properties/${pid}/connections`, { channel: "AGODA", url: ota.url(B.path) }],
    ["GET", `/calendarSync/properties/${pid}/explain?date=${S.day(30)}`],
    ["POST", `/calendarSync/properties/${pid}/legacy-feed/revoke`, {}],
    ["PATCH", `/calendarSync/connections/${cid}`, { name: "pwned" }],
    ["PATCH", `/calendarSync/connections/${cid}`, { url: ota.url(B.path) }],
    ["POST", `/calendarSync/connections/${cid}/sync`, {}],
    ["POST", `/calendarSync/connections/${cid}/rotate-export`, {}],
    ["POST", `/calendarSync/connections/${cid}/confirm-export`, {}],
    ["POST", `/calendarSync/connections/${cid}/disconnect`, { acknowledge: true, releaseBlocks: true }],
    ["POST", `/calendarSync/connections/${cid}/release-blocks`, { acknowledge: true }],
    ["POST", "/calendarSync/saveCalendar", { propertyId: pid, kind: "import", url: ota.url(B.path) }],
    ["POST", "/calendarSync/saveCalendar", { propertyId: pid, kind: "export" }],
  ];
  const matrix = [];
  for (const [method, path, body] of endpoints) {
    const asB = await H.api(method, path, { token: B.token, body });
    const anon = await H.api(method, path, { body });
    matrix.push({ endpoint: `${method} ${path.replace(pid, ":A").replace(cid, ":c")}`, hostB: asB.status, anonymous: anon.status });
    assert.strictEqual(anon.status, 401, `${method} ${path}: anonymous`);
    assert.ok([403, 404].includes(asB.status), `${method} ${path}: host B got ${asB.status}`);
    const leaked = JSON.stringify(asB.body);
    assert.ok(!leaked.includes(before.secret) && !leaked.includes(String(before.url)) && !leaked.includes("127.0.0.1"), `${method} ${path}: leaked A's data`);
  }
  // No oracle for what SyncGuard holds. Connection ids are not public: A's
  // real connection answers host B exactly like an id that does not exist.
  // Listing ids ARE public (every stay URL carries one) and the pre-existing
  // listing-ownership middleware answers 403 for someone else's listing — so
  // the check there is that the answer does not depend on whether the listing
  // has calendars connected.
  const ghost = String(new mongoose.Types.ObjectId());
  for (const [method, path, body] of endpoints.filter(([, p]) => p.includes("/connections/"))) {
    const real = await H.api(method, path, { token: B.token, body });
    const fake = await H.api(method, path.replace(cid, ghost), { token: B.token, body });
    assert.strictEqual(real.status, fake.status, `${method} ${path}: ${real.status} for A's connection vs ${fake.status} for a missing one`);
    assert.strictEqual(real.status, 404);
  }
  const noCalendar = await H.makeListing(await H.makeUser());
  for (const [method, path, body] of endpoints.filter(([, p]) => !p.includes("/connections/"))) {
    const withCal = await H.api(method, path, { token: B.token, body });
    const without = await H.api(method, path.replace(pid, String(noCalendar._id)), { token: B.token, body: body && body.propertyId ? { ...body, propertyId: String(noCalendar._id) } : body });
    assert.strictEqual(withCal.status, without.status, `${method} ${path}: answer depends on whether calendars are connected`);
    assert.deepStrictEqual(Object.keys(withCal.body).sort(), Object.keys(without.body).sort());
  }
  // A non-admin cannot read the operator overview; the cron sweep needs its secret
  assert.strictEqual((await H.api("GET", "/calendarSync/admin/overview", { token: B.token })).status, 403);
  assert.strictEqual((await H.api("GET", "/calendarSync/admin/overview")).status, 401);
  assert.strictEqual((await H.api("GET", "/calendarSync/cron/sweep", { token: B.token })).status, 401);
  // nothing of A's moved: same URL, token, status, no manual sync, no fetch, no journal entry by B
  const afterA = await ExternalCalendar.findById(A.id).lean();
  assert.deepStrictEqual([afterA.url, afterA.secret, afterA.status, afterA.name, String(afterA.sync.manualAt || "")], [before.url, before.secret, before.status, before.name, String(before.sync.manualAt || "")]);
  assert.strictEqual(ota.count(A.path), hitsBefore, "B's attempts caused no fetch of A's calendar");
  assert.strictEqual(await CalendarSyncLog.countDocuments({ propertyId: A.listing._id, actorId: B.host._id }), 0);
  assert.strictEqual(await ExternalCalendar.countDocuments({ propertyId: A.listing._id, kind: "import" }), 1, "no connection planted on A's listing");
  // the admin may act on any listing (support), the owner on their own
  for (const t of [admin, A.token]) {
    assert.strictEqual((await H.api("GET", `/calendarSync/properties/${pid}/connections`, { token: t })).status, 200);
    assert.strictEqual((await H.api("GET", `/calendarSync/properties/${pid}/explain?date=${S.day(30)}`, { token: t })).status, 200);
  }
  // the inbound URL is returned masked even to its owner
  const mine = await listOf(A);
  assert.ok(!JSON.stringify(mine).includes(String(before.url)), "owner sees a masked URL");
  record("authz-matrix", { matrix });
});

test("scheduler end to end over HTTP: clock → authenticated sweep → due selection → lease → sync → heartbeat → operator view", async () => {
  process.env.CALENDAR_SYNC_CRON_SECRET = "ops-clock-secret";
  const x = await hostWithCalendar();
  await ExternalCalendar.updateOne({ _id: x.id }, { $set: { "sync.nextSyncAt": new Date(Date.now() - 60_000), "sync.leaseUntil": null } });
  const hits = ota.count(x.path);
  const r = await H.api("GET", "/calendarSync/cron/sweep?source=github", { headers: { authorization: "Bearer ops-clock-secret" } });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.ok(r.body.summary.processed >= 1 && r.body.summary.ok >= 1, JSON.stringify(r.body.summary));
  assert.ok(ota.count(x.path) > hits, "the due calendar was fetched");
  const conn = await ExternalCalendar.findById(x.id).lean();
  assert.ok(new Date(conn.sync.nextSyncAt) > new Date(Date.now() + 5 * 60_000), "moved ~15 min ahead");
  assert.ok(!conn.sync.leaseUntil || new Date(conn.sync.leaseUntil) <= new Date(), "lease released");
  const hb = await CalendarSyncState.findById("scheduler").lean();
  assert.strictEqual(hb.lastTriggerSource, "github");
  const admin = H.adminToken(await H.makeAdmin());
  const ov = await H.api("GET", "/calendarSync/admin/overview", { token: admin });
  assert.strictEqual(ov.status, 200);
  assert.strictEqual(ov.body.data.scheduler.state, "HEALTHY");
  // the clock stops: the operator view degrades, it never stays green
  const states = {};
  for (const [label, minutes] of [["30 min", 31], ["1 h", 61], ["5 h", 300]]) {
    await CalendarSyncState.updateOne({ _id: "scheduler" }, { $set: { lastSweepFinishedAt: new Date(Date.now() - minutes * 60_000) } });
    states[label] = (await H.api("GET", "/calendarSync/admin/overview", { token: admin })).body.data.scheduler.state;
  }
  assert.deepStrictEqual(states, { "30 min": "DEGRADED", "1 h": "DEGRADED", "5 h": "STALE" });
  // a duplicated clock tick does not double the work
  await ExternalCalendar.updateOne({ _id: x.id }, { $set: { "sync.nextSyncAt": new Date(Date.now() - 60_000) } });
  const h0 = ota.count(x.path);
  await Promise.all([1, 2, 3].map(() => H.api("GET", "/calendarSync/cron/sweep?source=github", { headers: { authorization: "Bearer ops-clock-secret" } })));
  assert.strictEqual(ota.count(x.path) - h0, 1, "three simultaneous ticks → one fetch");
  record("scheduler-e2e", { summary: r.body.summary, states });
});

test("observability: every important state is diagnosable from the operator overview, the host panel and the journal", async () => {
  const admin = H.adminToken(await H.makeAdmin());
  // healthy
  const healthy = await hostWithCalendar();
  // stale: last success 4 h ago
  const stale = await hostWithCalendar();
  await ExternalCalendar.updateOne({ _id: stale.id }, { $set: { "sync.lastSuccessAt": new Date(Date.now() - 4 * 3600_000), lastFetched: new Date(Date.now() - 4 * 3600_000) } });
  // broken: the feed is gone
  const broken = await hostWithCalendar();
  ota.set(broken.path, { status: 404, body: "" });
  for (let i = 0; i < 2; i++) await engine.syncConnection(broken.id, { force: true });
  // anomaly: the whole calendar emptied
  const anomaly = await hostWithCalendar();
  ota.events(anomaly.path, []);
  await engine.syncConnection(anomaly.id, { force: true });
  // parser rejection
  const rejected = await hostWithCalendar();
  ota.set(rejected.path, { body: ["BEGIN:VCALENDAR", ...Array.from({ length: 5001 }, (_, i) => `BEGIN:VEVENT\r\nUID:z${i}\r\nDTSTART;VALUE=DATE:20300101\r\nEND:VEVENT`), "END:VCALENDAR"].join("\r\n") });
  await engine.syncConnection(rejected.id, { force: true });
  // conflict: OTA booking over a paid Majestic night
  const conflict = await hostWithCalendar([]);
  const g = await H.makeUser();
  const gt = H.userToken(g);
  const b = await H.api("POST", "/booking", { token: gt, body: H.bookingBody(conflict.listing, { checkIn: S.day(40), checkOut: S.day(41) }) });
  const o = await H.api("POST", "/payment/create-order", { token: gt, body: { bookingId: b.body.data._id, amount: b.body.data.quote.totalPaise, currency: "INR" } });
  const pay = H.razorpay().__registerPayment({ id: `pay_ops_${Date.now()}`, order_id: o.body.data.id, amount: o.body.data.amount, currency: "INR", status: "captured", method: "upi" });
  await H.api("POST", "/payment/verify-payment", { token: gt, body: { razorpay_order_id: o.body.data.id, razorpay_payment_id: pay.id, razorpay_signature: H.signature(o.body.data.id, pay.id) } });
  ota.events(conflict.path, [{ uid: "OPS-CONFLICT@airbnb.com", start: S.day(40), end: S.day(41), summary: "Reserved" }]);
  await engine.syncConnection(conflict.id, { force: true });
  // token rotation, disconnect and host release leave journal entries
  await H.api("POST", `/calendarSync/connections/${healthy.id}/rotate-export`, { token: healthy.token, body: {} });
  const gone = await hostWithCalendar();
  await H.api("POST", `/calendarSync/connections/${gone.id}/disconnect`, { token: gone.token, body: { acknowledge: true } });
  await H.api("POST", `/calendarSync/connections/${gone.id}/release-blocks`, { token: gone.token, body: { acknowledge: true } });

  const ov = (await H.api("GET", "/calendarSync/admin/overview", { token: admin })).body.data;
  const problem = (x) => ov.problems.find((p) => p.connectionId === x.id);
  assert.strictEqual(problem(healthy), undefined, "a healthy calendar is not a problem");
  assert.strictEqual(problem(stale).state, "STALE");
  assert.strictEqual(problem(broken).state, "BROKEN");
  assert.strictEqual(problem(broken).lastErrorCode, "NOT_FOUND");
  assert.strictEqual(problem(anomaly).state, "NEEDS_ATTENTION");
  assert.strictEqual(problem(anomaly).anomaly, "MASS_DISAPPEARANCE");
  assert.strictEqual(problem(rejected).lastErrorCode, "TOO_MANY_EVENTS");
  assert.strictEqual(problem(conflict).state, "NEEDS_ATTENTION", "conflicts count in the operator view too");
  assert.strictEqual(problem(conflict).conflicts, 1);
  assert.ok(problem(conflict).listingTitle, "the operator sees which listing");
  assert.ok(ov.byHealth.NEEDS_ATTENTION >= 2 && ov.byHealth.BROKEN >= 1 && ov.byHealth.STALE >= 1);
  assert.ok(problem(broken).reason && !/http|127\.0/.test(JSON.stringify(ov)), "reasons in plain words; no URL anywhere in the overview");
  for (const s of await ExternalCalendar.find({ _id: { $in: [healthy.id, broken.id] } }).select("secret").lean()) assert.ok(!JSON.stringify(ov).includes(s.secret), "no feed token in the overview");
  // the host sees the same states on their panel
  const brokenCard = (await listOf(broken))[0];
  assert.deepStrictEqual([brokenCard.health.state, brokenCard.bookingRestricted], ["BROKEN", true]);
  assert.ok(brokenCard.sync.lastError && brokenCard.sync.lastError.message);
  // the journal holds the transitions an operator needs afterwards
  const types = async (x) => (await CalendarSyncLog.find({ connectionId: x.id }).select("type").lean()).map((l) => l.type);
  assert.ok((await types(healthy)).includes("token_rotated"));
  assert.ok((await types(gone)).includes("disconnected"));
  assert.ok((await types(conflict)).includes("conflict"));
  // "Why is Property X unavailable on day 30?" — from persisted evidence only
  const why = (await H.api("GET", `/calendarSync/properties/${healthy.listing._id}/explain?date=${S.day(30)}`, { token: healthy.token })).body.data;
  assert.strictEqual(why.reasons[0].channelLabel, "Airbnb");
  assert.ok(why.timeline.some((t) => t.type === "added"));
  assert.ok(!JSON.stringify(why).match(/OPS-\d+@airbnb\.com/), "no raw OTA UID in the explanation");
  record("observability", { byHealth: ov.byHealth, scheduler: ov.scheduler.state, problems: ov.problems.map((p) => ({ state: p.state, error: p.lastErrorCode, conflicts: p.conflicts, anomaly: p.anomaly })), why: { reasons: why.reasons.length, timeline: why.timeline.map((t) => t.type) } });
});

test("journal hygiene: 90-day TTL index; unchanged polls and feed reads write nothing to the journal", async () => {
  const idx = await CalendarSyncLog.collection.indexes();
  const ttl = idx.find((i) => i.expireAfterSeconds !== undefined);
  assert.ok(ttl && ttl.expireAfterSeconds === 90 * 24 * 3600 && ttl.key.at === 1, JSON.stringify(idx));
  const x = await hostWithCalendar();
  const n0 = await CalendarSyncLog.countDocuments({});
  for (let i = 0; i < 10; i++) await engine.syncConnection(x.id, { force: true });
  const secret = (await ExternalCalendar.findById(x.id).lean()).secret;
  for (let i = 0; i < 10; i++) await H.api("GET", `/calendarSync/ics/${secret}.ics`, {});
  assert.strictEqual(await CalendarSyncLog.countDocuments({}) - n0, 0, "10 unchanged polls + 10 feed reads → 0 journal rows");
});

test("regression: a listing with NO calendar connected books and pays exactly as before — no fetch, no journal, no extra refusal", async () => {
  const host = await H.makeUser();
  const listing = await H.makeListing(host);
  const t = H.userToken(await H.makeUser());
  const totalHits = () => [...ota.hits.values()].reduce((a, b) => a + b, 0);
  const hits = totalHits();
  const n0 = await CalendarSyncLog.countDocuments({});
  const b = await H.api("POST", "/booking", { token: t, body: H.bookingBody(listing, { checkIn: S.day(60), checkOut: S.day(62) }) });
  assert.strictEqual(b.status, 201);
  const o = await H.api("POST", "/payment/create-order", { token: t, body: { bookingId: b.body.data._id, amount: b.body.data.quote.totalPaise, currency: "INR" } });
  assert.strictEqual(o.status, 200);
  const pay = H.razorpay().__registerPayment({ id: `pay_nocal_${Date.now()}`, order_id: o.body.data.id, amount: o.body.data.amount, currency: "INR", status: "captured", method: "upi" });
  const v = await H.api("POST", "/payment/verify-payment", { token: t, body: { razorpay_order_id: o.body.data.id, razorpay_payment_id: pay.id, razorpay_signature: H.signature(o.body.data.id, pay.id) } });
  assert.strictEqual(v.status, 200);
  const after = await Booking.findById(b.body.data._id).lean();
  assert.deepStrictEqual([after.paymentStatus, after.needsAttention || null], ["paid", null]);
  assert.strictEqual(totalHits(), hits, "no calendar fetched");
  assert.strictEqual(await CalendarSyncLog.countDocuments({}) - n0, 0, "nothing journalled");
  // host block / unblock and a second booking behave as before
  const blk = await H.api("POST", "/booking", { token: H.userToken(host), body: { ...H.bookingBody(listing, { checkIn: S.day(70), checkOut: S.day(71) }), action: "host" } });
  assert.strictEqual(blk.status, 201);
  assert.strictEqual((await H.api("POST", "/booking", { token: t, body: H.bookingBody(listing, { checkIn: S.day(70), checkOut: S.day(71) }) })).status, 409);
  assert.strictEqual((await H.api("POST", `/booking/unblock-dates/${listing._id}`, { token: H.userToken(host), body: { selectedDate: S.day(70) } })).status, 200);
  assert.strictEqual((await H.api("POST", "/booking", { token: t, body: H.bookingBody(listing, { checkIn: S.day(70), checkOut: S.day(71) }) })).status, 201);
});

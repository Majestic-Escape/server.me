// SyncGuard scheduler: liveness, overlap, crash recovery, fairness,
// starvation and measured cost per operation (docs/syncguard.md §5, §17).
const { test, before, after } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const S = require("./syncguard-helpers");
const H = require("./setup");

const ota = new S.FakeOta();
const record = S.evidence("scheduler");
let engine;
let ExternalCalendar;
let mongoose;

before(async () => {
  await H.start();
  await ota.start();
  mongoose = require("mongoose");
  engine = require("../../services/calendarSync/engine");
  ExternalCalendar = require("../../models/ExternalCalendar");
  await Promise.all([ExternalCalendar.syncIndexes(), require("../../models/CalendarSyncLog").syncIndexes(), require("../../models/Booking").syncIndexes()]);
});
after(async () => {
  await ota.stop();
  await H.stop();
});

let seq = 0;
// Creates n connections (one listing each) straight in the DB, all due now.
async function population(n, { failing = 0, events = 1 } = {}) {
  const host = await H.makeUser();
  const ids = [];
  for (let i = 0; i < n; i++) {
    const listing = await H.makeListing(host);
    const p = `/pop${++seq}.ics`;
    if (i < failing) ota.set(p, { status: 500, body: "down" });
    else ota.events(p, Array.from({ length: events }, (_, k) => ({ uid: `P${seq}-${k}@x`, start: S.day(10 + k * 3), end: S.day(11 + k * 3) })));
    const doc = await ExternalCalendar.create({ propertyId: listing._id, kind: "import", url: ota.url(p), urlHash: `h${seq}`, channel: "AIRBNB", status: "active", secret: `tok${String(seq).padStart(30, "0")}`, sync: { nextSyncAt: new Date(Date.now() - (n - i) * 1000) } });
    ids.push({ id: String(doc._id), path: p });
  }
  return ids;
}
async function clearConnections() {
  await ExternalCalendar.deleteMany({});
  ota.resetHits();
}

test("liveness: no sweep for 31 min / 1 h / 5 h shows DEGRADED → STALE (never silently healthy)", async () => {
  await clearConnections();
  await population(5);
  await engine.runDue({ reason: "test", reserveMs: 0 });
  const t = Date.now();
  const st0 = await engine.schedulerStatus(new Date(t));
  assert.strictEqual(st0.state, "HEALTHY");
  assert.strictEqual(st0.overdueConnections, 0);
  const st31 = await engine.schedulerStatus(new Date(t + 31 * 60_000));
  assert.strictEqual(st31.state, "DEGRADED", JSON.stringify(st31));
  assert.ok(st31.overdueConnections >= 1, "connections overdue after a missed beat");
  const st60 = await engine.schedulerStatus(new Date(t + 60 * 60_000));
  assert.strictEqual(st60.state, "DEGRADED");
  const st300 = await engine.schedulerStatus(new Date(t + 300 * 60_000));
  assert.strictEqual(st300.state, "STALE");
  assert.ok(st300.oldestOverdueMinutes > 250);
  // Connection health ages on its own, whatever the scheduler does.
  const health = require("../../services/calendarSync/health");
  const c = await ExternalCalendar.findOne({}).lean();
  assert.strictEqual(health.inbound(c, {}, new Date(t + 30 * 60_000)).state, "HEALTHY");
  assert.strictEqual(health.inbound(c, {}, new Date(t + 4 * 3600_000)).state, "STALE");
  const admin = await H.makeAdmin();
  const ov = await H.api("GET", "/calendarSync/admin/overview", { token: H.adminToken(admin) });
  assert.strictEqual(ov.status, 200);
  assert.ok(ov.body.data.scheduler && ov.body.data.scheduler.lastSweepFinishedAt);
  record("liveness", { st0, st31, st60, st300 });
});

test("duplicate / concurrent sweeps: every connection is fetched exactly once", async () => {
  await clearConnections();
  const pop = await population(20);
  const [a, b, c] = await Promise.all([1, 2, 3].map(() => engine.runDue({ reason: "dup", reserveMs: 0 })));
  const fetched = pop.map((p) => ota.count(p.path));
  assert.ok(fetched.every((n) => n === 1), JSON.stringify(fetched));
  assert.strictEqual(a.ok + b.ok + c.ok, 20);
  // a repeat right away finds nothing due
  const d = await engine.runDue({ reason: "dup2", reserveMs: 0 });
  assert.strictEqual(d.processed, 0);
  record("concurrent-sweeps", { a, b, c, d });
});

test("a sweep killed mid-run: its leases expire and the next sweep takes over (no permanent lock)", async () => {
  await clearConnections();
  const pop = await population(6);
  // A dead worker left leases on 3 connections.
  await ExternalCalendar.updateMany({ _id: { $in: pop.slice(0, 3).map((p) => p.id) } }, { $set: { "sync.leaseUntil": new Date(Date.now() + 4 * 60_000), "sync.leaseToken": "dead-worker" } });
  const first = await engine.runDue({ reason: "after-crash", reserveMs: 0 });
  assert.strictEqual(first.processed, 3, "leased ones are skipped, the rest proceed");
  await ExternalCalendar.updateMany({ "sync.leaseToken": "dead-worker" }, { $set: { "sync.leaseUntil": new Date(Date.now() - 1000) } }); // the 5-min lease expires
  const second = await engine.runDue({ reason: "after-expiry", reserveMs: 0 });
  assert.strictEqual(second.processed, 3);
  assert.ok(pop.every((p) => ota.count(p.path) === 1));
});

test("fairness under a budget: oldest-due first, no connection processed twice before all have run, failures back off", async () => {
  await clearConnections();
  const pop = await population(120, { failing: 10 });
  const order = [];
  for (let i = 0; i < 3; i++) {
    const s = await engine.runDue({ reason: `budget${i}`, limit: 40, reserveMs: 0 });
    assert.strictEqual(s.processed, 40);
    assert.ok(s.budgetExhausted);
    order.push(s);
  }
  const counts = pop.map((p) => ota.count(p.path));
  assert.ok(counts.every((n) => n === 1), `each fetched exactly once across 3 budget-limited sweeps: ${JSON.stringify(counts)}`);
  const failing = await ExternalCalendar.find({ "sync.consecutiveFailures": { $gt: 0 } }).lean();
  assert.strictEqual(failing.length, 10);
  assert.ok(failing.every((f) => new Date(f.sync.nextSyncAt) > new Date(Date.now() + 3 * 60_000)), "failures backed off (≥ 4 min)");
  const st = await engine.schedulerStatus();
  assert.strictEqual(st.overdueConnections, 0);
  record("fairness", { sweeps: order, failingBackedOff: failing.length });
});

test("the due query stays indexed at 10,000 connections (no collection scan)", async () => {
  await clearConnections();
  const docs = [];
  const pid = new mongoose.Types.ObjectId();
  for (let i = 0; i < 10_000; i++) {
    docs.push({ propertyId: pid, kind: "import", url: `https://example.com/${i}.ics`, status: "active", channel: "AIRBNB", sync: { nextSyncAt: new Date(Date.now() + (i % 100 === 0 ? -10 * 60_000 : 15 * 60_000)), leaseUntil: null } });
  }
  await ExternalCalendar.insertMany(docs, { ordered: false });
  const t = new Date();
  const filter = { $and: [{ kind: "import", status: { $ne: "disconnected" }, url: { $type: "string" } }, { $or: [{ "sync.leaseUntil": null }, { "sync.leaseUntil": { $lte: t } }] }, { $or: [{ "sync.nextSyncAt": null }, { "sync.nextSyncAt": { $lte: t } }] }] };
  const ex = await ExternalCalendar.find(filter).sort({ "sync.nextSyncAt": 1, _id: 1 }).limit(8).select("_id").explain("executionStats");
  const stats = ex.executionStats || (ex[0] && ex[0].executionStats);
  const planText = JSON.stringify(ex.queryPlanner || ex[0].queryPlanner);
  assert.ok(/IXSCAN/.test(planText), "uses an index");
  assert.ok(planText.includes("sync.nextSyncAt"), "the scheduling index");
  assert.ok(stats.totalDocsExamined <= 400, `docs examined ${stats.totalDocsExamined} for 100 due among 10,000`);
  const st = await engine.schedulerStatus();
  assert.strictEqual(st.overdueConnections, 100);
  record("due-query-10k", { docsExamined: stats.totalDocsExamined, keysExamined: stats.totalKeysExamined, ms: stats.executionTimeMillis, overdue: st.overdueConnections });
  await clearConnections();
});

test("measured cost per operation (Mongo ops), used for the cost table", async () => {
  await clearConnections();
  const ops = [];
  mongoose.set("debug", (coll, method) => ops.push(`${coll}.${method}`));
  const measure = async (fn) => {
    ops.length = 0;
    await fn();
    await new Promise((r) => setTimeout(r, 50));
    const reads = ops.filter((o) => /\.(find|findOne|countDocuments|aggregate|exists|distinct)$/.test(o)).length;
    const writes = ops.filter((o) => /\.(updateOne|updateMany|insertMany|insertOne|deleteMany|deleteOne|findOneAndUpdate|create|bulkWrite)$/.test(o)).length;
    return { reads, writes, total: ops.length, ops: [...ops] };
  };
  const [p] = await population(1, { events: 3 });
  const cost = {};
  cost.firstSync3Events = await measure(() => engine.syncConnection(p.id, { force: true }));
  cost.unchangedSync = await measure(() => engine.syncConnection(p.id, { force: true }));
  ota.events(p.path, [{ uid: "NEW@x", start: S.day(40), end: S.day(41) }, ...Array.from({ length: 3 }, (_, k) => ({ uid: `P${seq}-${k}@x`, start: S.day(10 + k * 3), end: S.day(11 + k * 3) }))]);
  cost.changedSyncOneNewEvent = await measure(() => engine.syncConnection(p.id, { force: true }));
  ota.set(p.path, { status: 304, body: "" });
  cost.notModified304 = await measure(() => engine.syncConnection(p.id, { force: true }));
  ota.set(p.path, { status: 500, body: "x" });
  cost.failedFetch = await measure(() => engine.syncConnection(p.id, { force: true }));
  cost.idleSweep = await measure(() => engine.runDue({ reason: "idle", reserveMs: 0 }));
  const conn = await ExternalCalendar.findById(p.id).lean();
  cost.feedGet = await measure(async () => (await fetch(`${(await H.start()).baseUrl}/calendarSync/ics/${conn.secret}.ics`)).text());
  cost.checkDatesNudgeFresh = await measure(() => H.api("GET", `/booking/check-dates/${conn.propertyId}`));
  mongoose.set("debug", false);
  for (const k of Object.keys(cost)) delete cost[k].ops;
  const out = process.env.SYNCGUARD_EVIDENCE_DIR || path.join(__dirname, "..", "..", "..", "tests", "syncguard-evidence");
  if (process.env.SYNCGUARD_EVIDENCE === "1") {
    fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(path.join(out, "cost-per-op.json"), JSON.stringify(cost, null, 2));
  }
  assert.ok(cost.unchangedSync.writes <= 2, `unchanged sync writes ${cost.unchangedSync.writes} (lease + release)`);
  assert.ok(cost.notModified304.writes <= 2);
  assert.ok(cost.unchangedSync.writes < cost.changedSyncOneNewEvent.writes);
  record("cost", cost);
});

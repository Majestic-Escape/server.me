// Cost report for GET /properties/:id/related — what each request costs the
// database and the process, measured (npm run perf:related; not in npm test).
//   per scenario: Mongoose queries, driver commands (incl. getMore), documents
//   and index keys MongoDB examines for Q2 (explain executionStats), documents
//   and BSON bytes returned to Node, ranking time, response bytes, heap delta,
//   latency p50 / p95 (3 rounds × 15 after one warm-up request)
//   scenarios: sparse and dense inventory at 2,000 and 5,000 live listings, a
//   source whose host owns 1,000 stays, an unknown id, 20 concurrent requests
//   baseline: the round-1 implementation (a2b431f, whole-inventory Q2), loaded
//   from git and run in-process on the SAME fixtures for the service-level
//   comparison (same machine, same data, same warm-up)
// Deterministic numbers (commands, documents) are asserted; latency is
// reported, and gated only in related-stays.perf.js. REL_COST_OUT=<file>
// also writes the report as JSON.
const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const mongoose = require("mongoose");
const realConnect = mongoose.connect;
mongoose.connect = function (uri, options) {
  return realConnect.call(this, uri, { ...options, monitorCommands: true });
};
const h = require("../batch-s/setup");

const ROOT = path.resolve(__dirname, "../..");
const KM = (2 * Math.PI * 6371) / 360;
const P = { lat: 15.4909, lng: 73.8278 };
const report = { environment: null, scenarios: [] };

function baselineModule() {
  const src = execFileSync("git", ["show", "a2b431f:services/relatedStays.js"], { cwd: ROOT, encoding: "utf8" });
  const fixed = src.replace(/require\("\.\.\/([^"]+)"\)/g, (_, p) => `require(${JSON.stringify(path.join(ROOT, p).replace(/\\/g, "/"))})`);
  const file = path.join(os.tmpdir(), `relatedStays.baseline.${process.pid}.js`);
  fs.writeFileSync(file, fixed);
  const mod = require(file);
  fs.unlinkSync(file);
  return mod;
}

function pct(sorted, q) {
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * q) - 1)];
}

async function measure(label, fn, { rounds = 3, perRound = 15 } = {}) {
  await fn(); // warm-up
  const times = [];
  const heap0 = process.memoryUsage().heapUsed;
  for (let r = 0; r < rounds; r++) for (let i = 0; i < perRound; i++) {
    const t0 = performance.now();
    await fn();
    times.push(performance.now() - t0);
  }
  times.sort((a, b) => a - b);
  return { label, n: times.length, p50: +pct(times, 0.5).toFixed(1), p95: +pct(times, 0.95).toFixed(1), min: +times[0].toFixed(1), max: +times[times.length - 1].toFixed(1), heapDeltaMb: +((process.memoryUsage().heapUsed - heap0) / 1048576).toFixed(1) };
}

test("cost report: sparse / dense × 2,000 / 5,000, big host portfolio, unknown id, concurrency, baseline", async () => {
  await h.start();
  report.environment = `node ${process.version}, ${os.platform()} ${os.arch()}, ${os.cpus()[0].model.trim()} x${os.cpus().length}, ${Math.round(os.totalmem() / 2 ** 30)} GB, mongodb-memory-server; in-process API`;
  const L = require("../../models/ListingProperty");
  const R = require("../../services/relatedStays");
  const base = baselineModule();
  const { publicListingFilter } = require("../../utils/listingProjection");
  const BSON = mongoose.mongo.BSON;
  const client = mongoose.connection.getClient();
  let cmds = [];
  client.on("commandSucceeded", (e) => {
    if (e.commandName === "find" || e.commandName === "getMore") {
      const batch = (e.reply && e.reply.cursor && (e.reply.cursor.firstBatch || e.reply.cursor.nextBatch)) || [];
      cmds.push({ name: e.commandName, docs: batch.length, bytes: BSON.calculateObjectSize(e.reply) });
    }
  });
  let mq = 0;
  mongoose.set("debug", (coll) => { if (coll === "listingproperties") mq += 1; });
  const HOST = await h.makeUser({ role: "host", firstName: "Costhost", email: "costhost@perf.test" });
  const OTHER = await h.makeUser({ role: "host", firstName: "Costother", email: "costother@perf.test" });
  const src = await h.makeListing(HOST, { title: "Cost source", propertyType: "villa", basePrice: 5000, guests: 4, address: { city: "Panaji", state: "Goa", latitude: P.lat, longitude: P.lng } });
  const bulk = (n, dense, host = OTHER._id, tag = "Bulk") =>
    Array.from({ length: n }, (_, i) => ({
      title: `${tag} ${i}`, host: i % 50 === 0 ? HOST._id : host, hostEmail: "bulk@perf.test", status: "active", propertyType: ["villa", "flat", "cottage"][i % 3],
      basePrice: 1000 + (i % 40) * 250, guests: 1 + (i % 10), photos: [`https://cdn.test/${i}a.jpg`, `https://cdn.test/${i}b.jpg`, `https://cdn.test/${i}c.jpg`], description: "x".repeat(400), amenities: ["wifi", "pool"],
      address: dense
        ? { city: "Panaji", state: "Goa", latitude: P.lat + ((i % 200) - 100) / 100, longitude: P.lng + ((Math.floor(i / 200) % 25) - 12) / 100 }
        : { city: "Far", state: "Far", latitude: 25 + (i % 150) / 20, longitude: 85 + (i % 90) / 20 }, // > 1,000 km away
      createdAt: new Date(Date.now() - i * 1000),
    }));
  const plan = async () => {
    const s = R.summarize(await L.findById(src._id).lean());
    const ex = await L.find(R.poolFilter(s)).select(R.POOL_PROJECTION).lean().explain("executionStats");
    const stages = JSON.stringify(ex.queryPlanner.winningPlan).match(/"stage":"[A-Z_]+"|"indexName":"[^"]+"/g).join(" ");
    return { docsExamined: ex.executionStats.totalDocsExamined, keysExamined: ex.executionStats.totalKeysExamined, returned: ex.executionStats.nReturned, plan: stages };
  };
  const one = async (fn) => {
    cmds = [];
    mq = 0;
    const t0 = performance.now();
    const out = await fn();
    const ms = performance.now() - t0;
    return { out, ms, mongooseQueries: mq, driverCommands: cmds.map((c) => c.name).join(","), docsReturned: cmds.reduce((a, c) => a + c.docs, 0), bytesReturned: cmds.reduce((a, c) => a + c.bytes, 0) };
  };
  const rankTime = async () => {
    const s = R.summarize(await L.findById(src._id).lean());
    const pool = (await L.find(R.poolFilter(s)).select(R.POOL_PROJECTION).lean());
    const t0 = performance.now();
    const sums = pool.map(R.summarize);
    const t1 = performance.now();
    const hr = R.rankHost(s, sums);
    R.rankNearby(s, sums, { exclude: new Set(hr.map((c) => c.id)) });
    return { summarizeMs: +(t1 - t0).toFixed(1), rankMs: +(performance.now() - t1).toFixed(1), poolSize: sums.length };
  };
  const http = async () => {
    const r = await fetch(`${h.baseUrl()}/properties/${src._id}/related`);
    return { status: r.status, bytes: (await r.text()).length };
  };

  for (const [shape, dense] of [["sparse", false], ["dense", true]]) {
    for (const total of [2000, 5000]) {
      await L.deleteMany({ title: /^Bulk / });
      await L.collection.insertMany(bulk(total, dense));
      const p = await plan();
      const cur = await one(() => R.relatedFor(String(src._id)));
      const old = await one(() => base.relatedFor(String(src._id)));
      assert.deepEqual(cur.out.body, old.out.body, `${shape} ${total}: identical rows to the whole-inventory baseline`);
      const res = await http();
      const lat = await measure(`${shape} ${total} HTTP`, http);
      const svcNew = await measure(`${shape} ${total} service (current)`, () => R.relatedFor(String(src._id)));
      const svcOld = await measure(`${shape} ${total} service (baseline a2b431f)`, () => base.relatedFor(String(src._id)));
      const rt = await rankTime();
      report.scenarios.push({ scenario: `${shape} ${total}`, live: total + 1, explainQ2: p, current: { mongooseQueries: cur.mongooseQueries, driverCommands: cur.driverCommands, docsReturned: cur.docsReturned, bytesReturned: cur.bytesReturned }, baseline: { mongooseQueries: old.mongooseQueries, driverCommands: old.driverCommands, docsReturned: old.docsReturned, bytesReturned: old.bytesReturned }, ranking: rt, responseBytes: res.bytes, latency: { http: lat, serviceCurrent: svcNew, serviceBaseline: svcOld } });
      assert.ok(cur.mongooseQueries <= 3, "≤ 3 Mongoose queries");
      assert.ok(!cur.driverCommands.includes("getMore"), `no getMore chain (${cur.driverCommands})`);
      assert.ok(res.bytes < 40000);
      if (shape === "sparse") assert.ok(cur.docsReturned < old.docsReturned, "the box returns fewer documents to Node than the whole-inventory baseline");
    }
  }

  // a host who owns 1,000 stays (all returned by the host branch of Q2)
  await L.deleteMany({ title: /^Bulk / });
  await L.collection.insertMany(bulk(1000, false, HOST._id, "Bulk host"));
  await L.collection.insertMany(bulk(1000, true, OTHER._id, "Bulk other"));
  {
    const cur = await one(() => R.relatedFor(String(src._id)));
    const lat = await measure("host owns 1,000 HTTP", http);
    report.scenarios.push({ scenario: "source host owns 1,000 stays (+1,000 nearby)", explainQ2: await plan(), current: { mongooseQueries: cur.mongooseQueries, driverCommands: cur.driverCommands, docsReturned: cur.docsReturned, bytesReturned: cur.bytesReturned }, latency: { http: lat } });
    assert.equal(cur.out.body.host.length, 12);
    assert.ok(cur.mongooseQueries <= 3);
  }

  // unknown and non-public ids: one indexed read, then stop
  for (const id of ["0123456789abcdef01234567"]) {
    const cur = await one(() => R.relatedFor(id));
    report.scenarios.push({ scenario: "unknown id", current: { mongooseQueries: cur.mongooseQueries, driverCommands: cur.driverCommands, docsReturned: cur.docsReturned } });
    assert.deepEqual([cur.mongooseQueries, cur.driverCommands], [1, "find"]);
  }

  // 20 concurrent requests on the dense 2,000 fixture
  {
    await L.deleteMany({ title: /^Bulk / });
    await L.collection.insertMany(bulk(2000, true));
    await http();
    const t0 = performance.now();
    const each = await Promise.all(Array.from({ length: 20 }, async () => { const t = performance.now(); const r = await http(); return { ms: performance.now() - t, status: r.status }; }));
    const total = performance.now() - t0;
    const ms = each.map((x) => x.ms).sort((a, b) => a - b);
    report.scenarios.push({ scenario: "20 concurrent requests, dense 2,000", wallMs: +total.toFixed(0), perRequest: { p50: +pct(ms, 0.5).toFixed(0), p95: +pct(ms, 0.95).toFixed(0), max: +ms[ms.length - 1].toFixed(0) } });
    assert.ok(each.every((x) => x.status === 200));
  }
  await L.deleteMany({ title: /^Bulk / });
  mongoose.set("debug", false);
  console.log(`[cost] ${report.environment}`);
  for (const s of report.scenarios) console.log(`[cost] ${JSON.stringify(s)}`);
  if (process.env.REL_COST_OUT) fs.writeFileSync(process.env.REL_COST_OUT, JSON.stringify(report, null, 1));
  await h.stop();
});

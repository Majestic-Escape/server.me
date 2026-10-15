// Performance gate for GET /properties/:id/related — run on its own, on an
// idle machine:  npm run perf:related
// Not part of `npm test`: that runs files in parallel processes, and a
// latency budget measured under that load says nothing about the code.
//
// Budget: p95 <= PERF_BUDGET_MS (default 150) at 2,000 and 5,000 live
// listings, payload < 40 KB. Dataset: the worst case for the pool query —
// every bulk listing inside the 250 km box (docs/related-stays.md).
// Method: 3 rounds of 15 requests per size, nearest-rank p95 per round,
// the gate is the MEDIAN of the three round p95s (one noisy round does not
// fail it; a real regression moves all three). The environment is printed.
// Idle check: the whole machine's CPU is sampled for 1.5 s first; above
// PERF_MAX_BUSY (default 35 %) the run is INCONCLUSIVE (it fails with that
// message) instead of reporting a number that measures other programs.
const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");
const h = require("../batch-s/setup");

const BUDGET_MS = Number(process.env.PERF_BUDGET_MS || 150);
const PAYLOAD_MAX = 40000;
const MAX_BUSY = Number(process.env.PERF_MAX_BUSY || 35);

function cpuTimes() {
  return os.cpus().reduce((a, c) => {
    const t = c.times;
    a.idle += t.idle;
    a.total += t.user + t.nice + t.sys + t.idle + t.irq;
    return a;
  }, { idle: 0, total: 0 });
}
async function machineBusyPercent(ms = 1500) {
  const a = cpuTimes();
  await new Promise((r) => setTimeout(r, ms));
  const b = cpuTimes();
  return Math.round(100 * (1 - (b.idle - a.idle) / (b.total - a.total)));
}
const PANAJI = { lat: 15.4909, lng: 73.8278 };
let HOST;
let OTHER;
let src;

async function get(path) {
  const r = await fetch(`${h.baseUrl()}${path}`);
  const text = await r.text();
  return { status: r.status, text, json: JSON.parse(text) };
}

// PERF_PRIORITY=high: a declared controlled condition on a shared machine — this process and the MongoDB it
// started (its own child processes only, never another program's) run at the OS "high" priority class.
async function raisePriority() {
  const pids = [process.pid];
  if (process.platform === "win32") {
    const { execFileSync } = require("node:child_process");
    const out = execFileSync("powershell", ["-NoProfile", "-Command", `(Get-CimInstance Win32_Process -Filter "ParentProcessId=${process.pid}" | Where-Object { $_.Name -like 'mongod*' }).ProcessId`], { encoding: "utf8" });
    pids.push(...out.split(/\s+/).filter(Boolean).map(Number));
  }
  for (const pid of pids) os.setPriority(pid, os.constants.priority.PRIORITY_HIGH);
  return pids.map((pid) => `${pid}:${os.getPriority(pid)}`).join(" ");
}

test.before(async () => {
  await h.start();
  if (process.env.PERF_PRIORITY === "high") console.log(`[perf] priority raised (pid:priority): ${await raisePriority()}`);
  HOST = await h.makeUser({ role: "host", firstName: "Perfhost", email: "perfhost@perf.test" });
  OTHER = await h.makeUser({ role: "host", firstName: "Perfother", email: "perfother@perf.test" });
  src = await h.makeListing(HOST, { title: "Perf source", propertyType: "villa", address: { city: "Panaji", state: "Goa", latitude: PANAJI.lat, longitude: PANAJI.lng } });
  console.log(`[perf] environment: node ${process.version}, ${os.platform()} ${os.arch()}, ${os.cpus()[0].model.trim()} x${os.cpus().length}, ${Math.round(os.totalmem() / 2 ** 30)} GB, mongodb-memory-server (client and API in one process)`);
});
test.after(async () => {
  await h.stop();
});

test(`perf: p95 <= ${BUDGET_MS} ms at 2,000 and 5,000 live listings (median of 3 rounds), payload < 40 KB`, async () => {
  const L = require("../../models/ListingProperty");
  const busy = await machineBusyPercent();
  console.log(`[perf] machine CPU busy before the run: ${busy} % (limit ${MAX_BUSY} %)`);
  assert.ok(busy <= MAX_BUSY, `INCONCLUSIVE: the machine is ${busy} % busy (> ${MAX_BUSY} %) — rerun when idle; a number measured now describes other programs`);
  for (const total of [2000, 5000]) {
    const have = await L.countDocuments({ title: /^Bulk / });
    const docs = [];
    for (let i = have; i < total; i++) {
      docs.push({
        title: `Bulk ${i}`, host: i % 50 === 0 ? HOST._id : OTHER._id, hostEmail: "bulk@perf.test", status: "active",
        propertyType: ["villa", "flat", "cottage"][i % 3], basePrice: 1000 + (i % 40) * 250, guests: 1 + (i % 10),
        photos: [`https://cdn.test/bulk${i}.jpg`], description: "x".repeat(400), amenities: ["wifi", "pool"],
        address: { street: `${i} Bulk Road`, city: "Panaji", state: "Goa", latitude: PANAJI.lat + ((i % 200) - 100) / 100, longitude: PANAJI.lng + (Math.floor(i / 200) % 25 - 12) / 100 },
        createdAt: new Date(Date.now() - i * 1000),
      });
    }
    if (docs.length) await L.collection.insertMany(docs);
    await get(`/properties/${src._id}/related`); // warm-up (connection, plan cache)
    const rounds = [];
    let bytes = 0;
    for (let round = 0; round < 3; round++) {
      const times = [];
      for (let k = 0; k < 15; k++) {
        const t0 = performance.now();
        const r = await get(`/properties/${src._id}/related`);
        times.push(performance.now() - t0);
        bytes = r.text.length;
        assert.equal(r.status, 200);
        assert.equal(r.json.host.length, 12);
        assert.equal(r.json.nearby.length, 8);
      }
      times.sort((a, b) => a - b);
      rounds.push({ p50: times[Math.floor(times.length / 2)], p95: times[Math.ceil(times.length * 0.95) - 1] });
    }
    const p95s = rounds.map((x) => x.p95).sort((a, b) => a - b);
    const gate = p95s[1];
    console.log(`[perf] ${total} live: round p95 ${rounds.map((x) => x.p95.toFixed(0)).join(" / ")} ms, p50 ${rounds.map((x) => x.p50.toFixed(0)).join(" / ")} ms, gate (median p95) ${gate.toFixed(0)} ms vs budget ${BUDGET_MS} ms, payload ${bytes} B`);
    assert.ok(bytes < PAYLOAD_MAX, `payload ${bytes} B`);
    assert.ok(gate <= BUDGET_MS, `${total} live: median-of-rounds p95 ${gate.toFixed(0)} ms exceeds the ${BUDGET_MS} ms budget`);
  }
  await L.deleteMany({ title: /^Bulk / });
});

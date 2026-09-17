// Backfill / reconciliation script: fail-closed behaviour and scale.
const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("child_process");
const path = require("path");
const h = require("./setup");

let U, HOST, uri;
const Booking = () => require("../../models/Booking");
const BookingNight = () => require("../../models/BookingNight");
const Payment = () => require("../../models/Payment");
const SCRIPT = path.join(__dirname, "../../scripts/backfill-booking-nights.js");
const GATE = path.join(__dirname, "../../scripts/booking-gate.js");
const run = (args, env = {}) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", env: { ...process.env, RAZORPAY_MOCK: "1", ...env }, timeout: 120_000 });
const num = (re, txt) => Number((txt.match(re) || [])[1]);
const at = (d) => new Date(`${d}T00:00:00.000Z`);

test.before(async () => {
  uri = (await h.start()).uri;
  U = await h.makeUser();
  HOST = await h.makeUser({ role: "host" });
});
test.after(async () => h.stop());

test("fails closed: no DB_URI, unreachable URI, and the gate script likewise", async () => {
  const env = { ...process.env };
  delete env.DB_URI;
  let out = spawnSync(process.execPath, [SCRIPT], { encoding: "utf8", env: { ...env, RAZORPAY_MOCK: "1", DB_URI: "" } });
  assert.equal(out.status, 1, out.stdout + out.stderr);
  assert.ok(/DB_URI \(or --uri\) is required/.test(out.stderr), out.stderr);
  out = run(["--apply", "--uri=mongodb://127.0.0.1:1/nothing?serverSelectionTimeoutMS=1500&connectTimeoutMS=1500"]);
  assert.equal(out.status, 1, out.stdout + out.stderr);
  assert.ok(/\[backfill\] failed:/.test(out.stderr), out.stderr);
  out = spawnSync(process.execPath, [GATE, "--status"], { encoding: "utf8", env: { ...env, DB_URI: "" } });
  assert.equal(out.status, 1);
  out = spawnSync(process.execPath, [GATE, "--status", `--uri=${uri}`], { encoding: "utf8", env: { ...env } });
  assert.equal(out.status, 0, out.stdout + out.stderr);
  assert.ok(/booking writes paused: false/.test(out.stdout), out.stdout);
});

test("scale + idempotency: 400 legacy bookings (mixed shapes) backfill in one apply, rerun writes nothing, plan stays indexed", async () => {
  const listings = await Promise.all(Array.from({ length: 40 }, () => h.makeListing(HOST)));
  const docs = [];
  for (let i = 0; i < 400; i++) {
    const L = listings[i % listings.length];
    const day = 3000 + Math.floor(i / listings.length) * 7; // disjoint per listing
    const kind = i % 10;
    docs.push({
      userId: U._id, hostId: HOST._id, propertyId: L._id, price: 1, subTotal: 1,
      checkIn: kind === 3 ? new Date(`${h.day(day)}T18:30:00.000Z`) : at(h.day(day)),
      checkOut: kind === 3 ? new Date(`${h.day(day + 2)}T18:30:00.000Z`) : at(h.day(day + 2)),
      status: kind === 7 ? "cancelled" : kind === 8 ? "pending" : "confirmed",
      paymentStatus: kind === 8 ? "unpaid" : "paid",
      action: kind === 3 ? "host" : "user",
      source: kind === 4 ? "ical" : "local",
      // legacy oddities: missing nights/guests, string price, no quote
      ...(kind === 5 ? { nights: undefined, guests: undefined } : {}),
    });
  }
  await Booking().insertMany(docs);
  const t0 = Date.now();
  let out = run([`--uri=${uri}`]);
  assert.equal(out.status, 0, out.stdout + out.stderr);
  const wanted = num(/to insert: (\d+)/, out.stdout);
  assert.equal(num(/conflicting property-nights: (\d+)/, out.stdout), 0);
  assert.ok(wanted >= 320 * 2, `expected ≥640 nights, got ${wanted}: ${out.stdout}`); // 80 % blocking × 2 nights
  out = run([`--uri=${uri}`, "--apply"]);
  assert.equal(out.status, 0, out.stdout + out.stderr);
  assert.equal(num(/inserted: (\d+)/, out.stdout), wanted);
  const elapsed = Date.now() - t0;
  assert.ok(elapsed < 60_000, `two runs took ${elapsed} ms`);
  out = run([`--uri=${uri}`, "--apply"]);
  assert.equal(num(/inserted: (\d+)/, out.stdout), 0, "idempotent");
  assert.equal(num(/stale rows to replace: (\d+)/, out.stdout), 0);
  const mongoose = require("mongoose");
  const e = await mongoose.connection.db.collection("bookingnights").find({ propertyId: listings[0]._id, date: at(h.day(3000)) }).explain("queryPlanner");
  assert.ok(/IXSCAN/.test(JSON.stringify(e.queryPlanner.winningPlan)));
});

test("partially existing indexes: create-index completes the missing ones and reports; a conflict introduced between phases is caught by the next run", async () => {
  const mongoose = require("mongoose");
  const db = mongoose.connection.db;
  // Simulate a half-finished earlier attempt: the bookingnights index exists, the payments partial index does not.
  await Payment().collection.dropIndex("bookingId_1").catch(() => {});
  await BookingNight().collection.createIndex({ propertyId: 1, date: 1 }, { unique: true });
  let out = run([`--uri=${uri}`, "--apply", "--create-index"]);
  assert.equal(out.status, 0, out.stdout + out.stderr);
  const pidx = await db.collection("payments").indexes();
  assert.ok(pidx.some((i) => i.name === "bookingId_1" && i.unique && i.partialFilterExpression), "payments index (re)built");
  const hidx = await db.collection("hostpayouts").indexes();
  assert.ok(hidx.some((i) => i.name === "bookingId_1" && i.unique));
  const bidx = await db.collection("bookings").indexes();
  assert.ok(bidx.some((i) => i.name === "needsAttention_1"));
  // an operator's dry-run says clean, then (old backend still up) a straddling paid booking appears
  const L = await h.makeListing(HOST);
  const a = await Booking().create({ userId: U._id, hostId: HOST._id, propertyId: L._id, price: 1, subTotal: 1, checkIn: at(h.day(4000)), checkOut: at(h.day(4002)), status: "confirmed", paymentStatus: "paid" });
  out = run([`--uri=${uri}`, "--apply"]);
  assert.equal(out.status, 0);
  assert.equal(await BookingNight().countDocuments({ bookingId: a._id }), 2);
  await Booking().create({ userId: U._id, hostId: HOST._id, propertyId: L._id, price: 1, subTotal: 1, checkIn: at(h.day(4001)), checkOut: at(h.day(4003)), status: "confirmed", paymentStatus: "paid" });
  out = run([`--uri=${uri}`, "--apply", "--create-index"]);
  assert.equal(out.status, 2, "refused: a conflict appeared between phases\n" + out.stdout);
  assert.ok(/CONFLICT/.test(out.stdout));
  assert.equal(await BookingNight().countDocuments({ propertyId: L._id }), 3, "a keeps its 2 nights, b gets only its free night");
  assert.equal(String((await BookingNight().findOne({ propertyId: L._id, date: at(h.day(4001)) })).bookingId), String(a._id), "the contested night stays with its existing owner");
  // the unique index already existing does not mask the refusal
  const nidx = await db.collection("bookingnights").indexes();
  assert.ok(nidx.some((i) => i.name === "propertyId_1_date_1" && i.unique));
});

test("gate script round-trip and startup check", async () => {
  const env = { ...process.env, DB_URI: uri };
  let out = spawnSync(process.execPath, [GATE, "--on", "--reason=test"], { encoding: "utf8", env });
  assert.ok(/paused: true\s+\(test\)/.test(out.stdout), out.stdout + out.stderr);
  const { bookingWritesPaused, resetCache } = require("../../services/maintenance");
  resetCache();
  assert.equal(await bookingWritesPaused(), true);
  out = spawnSync(process.execPath, [GATE, "--off"], { encoding: "utf8", env });
  assert.ok(/paused: false/.test(out.stdout), out.stdout);
  resetCache();
  assert.equal(await bookingWritesPaused(), false);
  const { verifyRequiredIndexes } = require("../../services/startupChecks");
  const missing = await verifyRequiredIndexes();
  assert.deepEqual(missing, []);
  await require("../../models/HostPayout").collection.dropIndex("bookingId_1");
  const missing2 = await verifyRequiredIndexes();
  assert.deepEqual(missing2, ["hostpayouts.bookingId_1"]);
  await require("../../models/HostPayout").syncIndexes();
});

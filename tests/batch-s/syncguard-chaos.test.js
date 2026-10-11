// SyncGuard release gate: failure recovery. A fault is injected at a precise
// step, then the system must converge. "Safe" = an extra block for a while is
// acceptable; a reopened occupied night is not.
const { test, before, after } = require("node:test");
const assert = require("node:assert");
const S = require("./syncguard-helpers");
const H = require("./setup");

const ota = new S.FakeOta();
const record = S.evidence("chaos");
let Booking;
let BookingNight;
let ExternalCalendar;
let engine;
let ledger;
let mongoose;

before(async () => {
  await H.start();
  await ota.start();
  mongoose = require("mongoose");
  Booking = require("../../models/Booking");
  BookingNight = require("../../models/BookingNight");
  ExternalCalendar = require("../../models/ExternalCalendar");
  engine = require("../../services/calendarSync/engine");
  ledger = require("../../services/calendarSync/ledger");
});
after(async () => {
  await ota.stop();
  await H.stop();
});

let seq = 0;
const reserved = (uid, a, b) => ({ uid, start: S.day(a), end: S.day(b), summary: "Reserved" });
async function setup(events) {
  const host = await H.makeUser();
  const listing = await H.makeListing(host);
  const token = H.userToken(host);
  const p = `/chaos${++seq}.ics`;
  ota.events(p, events);
  const c = await H.api("POST", `/calendarSync/properties/${listing._id}/connections`, { token, body: { channel: "AIRBNB", url: ota.url(p) } });
  assert.strictEqual(c.status, 201, JSON.stringify(c.body));
  return { host, listing, token, path: p, id: c.body.id };
}
const bookable = async (x, a, b) => (await H.api("POST", "/booking", { token: H.userToken(await H.makeUser()), body: H.bookingBody(x.listing, { checkIn: S.day(a), checkOut: S.day(b) }) })).status;
function once(obj, name, impl) {
  const orig = obj[name];
  let fired = false;
  obj[name] = function patched(...args) {
    if (!fired) {
      fired = true;
      return impl.apply(this, [orig.bind(this), ...args]);
    }
    return orig.apply(this, args);
  };
  return () => {
    obj[name] = orig;
  };
}
const outcomes = [];

test("killed right after the remote fetch (before any write): nothing changes, the next sync converges", async () => {
  const x = await setup([reserved("CH-1@airbnb.com", 30, 32)]);
  ota.events(x.path, [reserved("CH-1@airbnb.com", 30, 32), reserved("CH-2@airbnb.com", 40, 41)]);
  const restore = once(Booking, "find", () => {
    throw new Error("killed after the fetch");
  });
  let r;
  try {
    r = await engine.syncConnection(x.id, { force: true });
  } finally {
    restore();
  }
  assert.notStrictEqual(r.ok, true);
  assert.strictEqual(await Booking.countDocuments({ propertyId: x.listing._id, source: "ical" }), 1, "no half-applied feed");
  assert.strictEqual(await bookable(x, 30, 31), 409);
  const conn = await ExternalCalendar.findById(x.id).lean();
  assert.ok(!conn.sync.leaseUntil || new Date(conn.sync.leaseUntil) <= new Date(), "a failed sync releases its lease");
  await engine.syncConnection(x.id, { force: true });
  assert.strictEqual(await Booking.countDocuments({ propertyId: x.listing._id, source: "ical", status: "confirmed" }), 2);
  assert.strictEqual(await bookable(x, 40, 41), 409);
  outcomes.push("after-fetch: converged");
});

test("killed between the row release and the night release: an extra block (never a hole), removed by the full pass", async () => {
  const x = await setup([reserved("CH-3@airbnb.com", 50, 52)]);
  ota.events(x.path, [{ ...reserved("CH-3@airbnb.com", 50, 52), status: "CANCELLED" }]);
  const restore = once(ledger, "releaseAll", () => {
    throw new Error("killed before freeing the nights");
  });
  try {
    await engine.syncConnection(x.id, { force: true });
  } finally {
    restore();
  }
  const row = await Booking.findOne({ propertyId: x.listing._id, source: "ical" }).lean();
  assert.strictEqual(row.status, "cancelled");
  assert.strictEqual(await BookingNight.countDocuments({ bookingId: row._id }), 2, "nights still held: an extra block");
  assert.strictEqual(await bookable(x, 50, 51), 409, "temporarily over-blocked, never under-blocked");
  await engine.syncConnection(x.id, { force: true, full: true });
  assert.strictEqual(await BookingNight.countDocuments({ bookingId: row._id }), 0, "the full pass removes the leftover");
  assert.strictEqual(await bookable(x, 50, 51), 201);
  outcomes.push("after-row-release: extra block, then converged");
});

test("a database write fails mid-sync (row insert): no partial state, the next sync converges", async () => {
  const x = await setup([]);
  ota.events(x.path, [reserved("CH-4@airbnb.com", 60, 62)]);
  const restore = once(Booking, "create", () => Promise.reject(Object.assign(new Error("write concern error"), { code: 64 })));
  try {
    await engine.syncConnection(x.id, { force: true });
  } finally {
    restore();
  }
  assert.strictEqual(await Booking.countDocuments({ propertyId: x.listing._id, source: "ical" }), 0);
  const conn = await ExternalCalendar.findById(x.id).lean();
  assert.ok(conn.sync.consecutiveFailures >= 1, "the failure is visible");
  // the calendar is now unverified for booking purposes: a guest is refused (fail-closed)
  await ExternalCalendar.updateOne({ _id: x.id }, { $set: { "sync.lastSuccessAt": new Date(Date.now() - 10 * 60_000) } });
  await engine.syncConnection(x.id, { force: true });
  assert.strictEqual(await bookable(x, 60, 61), 409);
  outcomes.push("db-write-fail: converged");
});

test("killed before the lease is released: the next worker takes over once the lease expires (no permanent lock)", async () => {
  const x = await setup([reserved("CH-5@airbnb.com", 70, 71)]);
  ota.events(x.path, [reserved("CH-5@airbnb.com", 70, 71), reserved("CH-6@airbnb.com", 72, 73)]);
  // the worker's final (token-conditional) write never happens
  const restore = once(ExternalCalendar, "findOneAndUpdate", (orig, filter, update, ...rest) => {
    if (filter && filter["sync.leaseToken"] && update && update.$set && update.$set["sync.leaseUntil"] === null) return Promise.reject(new Error("killed before releasing the lease"));
    return orig(filter, update, ...rest);
  });
  try {
    await engine.syncConnection(x.id, { force: true }).catch(() => {});
  } finally {
    restore();
  }
  const blocked = await engine.syncConnection(x.id, { force: true });
  const leased = (await ExternalCalendar.findById(x.id).lean()).sync.leaseUntil;
  if (leased && new Date(leased) > new Date()) {
    assert.strictEqual(blocked.skipped, "not_due_or_busy", "a live lease is respected");
    await ExternalCalendar.updateOne({ _id: x.id }, { $set: { "sync.leaseUntil": new Date(Date.now() - 1000) } });
  }
  const r = await engine.syncConnection(x.id, { force: true });
  assert.ok(r.ok, JSON.stringify(r));
  assert.strictEqual(await bookable(x, 72, 73), 409);
  outcomes.push("before-lease-release: taken over after expiry");
});

test("fencing: a worker frozen past its lease, holding a DIFFERENT (older) feed, applies none of it after a newer worker has run", async () => {
  // X = state the frozen worker started from; Y = what it fetched; Z = newer
  // state applied by the next worker. Y differs from X, so without fencing the
  // frozen worker WOULD reconcile Y over Z (the lease-conditional final write
  // alone cannot undo row writes).
  const E1 = reserved("FX-1@airbnb.com", 30, 32);
  const E2 = reserved("FX-2@airbnb.com", 40, 41);
  const E3 = reserved("FX-3@airbnb.com", 50, 51);
  const x = await setup([E1]);
  let release;
  const gate = new Promise((r) => {
    release = r;
  });
  ota.set(x.path, { body: S.vcal([E1, E2]), gate });
  const frozen = engine.syncConnection(x.id, { force: true });
  await new Promise((r) => setTimeout(r, 80));
  await ExternalCalendar.updateOne({ _id: x.id }, { $set: { "sync.leaseUntil": new Date(Date.now() - 1000) } });
  ota.events(x.path, [E1, E3]);
  const fresh = await engine.syncConnection(x.id, { force: true });
  assert.ok(fresh.ok, JSON.stringify(fresh));
  release();
  const late = await frozen;
  assert.strictEqual(late.code, "LEASE_LOST", JSON.stringify(late));
  const uids = (await Booking.find({ propertyId: x.listing._id, source: "ical" }).lean()).map((r) => `${r.external.uid}:${r.external.state}`).sort();
  assert.deepStrictEqual(uids, ["FX-1@airbnb.com:active", "FX-3@airbnb.com:active"], "the older feed left no trace (no FX-2 row, FX-3 not marked missing)");
  outcomes.push("fencing: older feed discarded");
});

test("the host replaces the calendar URL while a sync of the OLD URL is in flight: the old worker cannot stamp the new calendar as verified", async () => {
  const x = await setup([reserved("OLD-1@airbnb.com", 80, 81)]);
  let release;
  const gate = new Promise((r) => {
    release = r;
  });
  ota.set(x.path, { body: S.vcal([reserved("OLD-1@airbnb.com", 80, 81)]), gate });
  const inflight = engine.syncConnection(x.id, { force: true });
  await new Promise((r) => setTimeout(r, 80));
  const p2 = `/chaos${++seq}.ics`;
  ota.events(p2, [reserved("NEW-1@airbnb.com", 90, 92)]);
  const patch = await H.api("PATCH", `/calendarSync/connections/${x.id}`, { token: x.token, body: { url: ota.url(p2) } });
  assert.strictEqual(patch.status, 200, JSON.stringify(patch.body));
  release();
  const late = await inflight;
  // whatever the old worker did, the NEW calendar's booking must be known and protecting
  const conn = await ExternalCalendar.findById(x.id).lean();
  const newRow = await Booking.findOne({ propertyId: x.listing._id, source: "ical", "external.uid": "NEW-1@airbnb.com" }).lean();
  outcomes.push(`url-change: old worker ${late.code || (late.ok ? "ok" : JSON.stringify(late))}, new row ${newRow ? newRow.status : "missing"}`);
  assert.ok(newRow && newRow.status === "confirmed", `the new calendar's booking is imported right away (old worker: ${JSON.stringify(late)})`);
  assert.strictEqual(await bookable(x, 90, 91), 409, "and protects its nights");
  assert.ok(new Date(conn.sync.nextSyncAt) <= new Date(Date.now() + 20 * 60_000));
  // the old calendar's booking is only released through the normal confirmation (an extra block meanwhile)
  assert.strictEqual(await bookable(x, 80, 81), 409);
});

test("the host disconnects while a sync is in flight: the late worker cannot resurrect the connection", async () => {
  const x = await setup([reserved("DC-1@airbnb.com", 100, 101)]);
  let release;
  const gate = new Promise((r) => {
    release = r;
  });
  ota.set(x.path, { body: S.vcal([reserved("DC-1@airbnb.com", 100, 101), reserved("DC-2@airbnb.com", 102, 103)]), gate });
  const inflight = engine.syncConnection(x.id, { force: true });
  await new Promise((r) => setTimeout(r, 80));
  const d = await H.api("POST", `/calendarSync/connections/${x.id}/disconnect`, { token: x.token, body: { acknowledge: true } });
  assert.strictEqual(d.status, 200, JSON.stringify(d.body));
  release();
  await inflight;
  const conn = await ExternalCalendar.findById(x.id).lean();
  assert.strictEqual(conn.status, "disconnected");
  const rows = await Booking.find({ propertyId: x.listing._id, source: "ical", status: "confirmed" }).lean();
  assert.ok(rows.every((r) => r.external.state === "orphaned"), `kept blocks stay orphaned: ${rows.map((r) => r.external.state)}`);
  assert.strictEqual(await bookable(x, 100, 101), 409, "kept blocks still protect");
});

test("token rotation while an OTA is fetching: the old link dies the moment rotation commits; the new one serves", async () => {
  const x = await setup([reserved("RT-1@airbnb.com", 110, 111)]);
  const old = (await ExternalCalendar.findById(x.id).lean()).secret;
  const [during, rot] = await Promise.all([H.api("GET", `/calendarSync/ics/${old}.ics`, {}), H.api("POST", `/calendarSync/connections/${x.id}/rotate-export`, { token: x.token, body: {} })]);
  assert.ok([200, 404].includes(during.status));
  assert.strictEqual(rot.status, 200);
  assert.strictEqual((await H.api("GET", `/calendarSync/ics/${old}.ics`, {})).status, 404);
  const fresh = (await ExternalCalendar.findById(x.id).lean()).secret;
  assert.strictEqual((await H.api("GET", `/calendarSync/ics/${fresh}.ics`, {})).status, 200);
});

test("a guest aborts the booking request mid-flight: at most an expiring hold is left, and the nights come back", async () => {
  const x = await setup([]);
  const g = await H.makeUser();
  const ac = new AbortController();
  const req = fetch(`${H.baseUrl()}/booking`, { method: "POST", signal: ac.signal, headers: { "content-type": "application/json", authorization: `Bearer ${H.userToken(g)}` }, body: JSON.stringify(H.bookingBody(x.listing, { checkIn: S.day(120), checkOut: S.day(121) })) }).catch((e) => e.name);
  setTimeout(() => ac.abort(), 5);
  await req;
  await new Promise((r) => setTimeout(r, 400));
  const held = await BookingNight.find({ propertyId: x.listing._id }).lean();
  assert.ok(held.every((n) => n.expiresAt), "only an expiring hold can be left behind");
  await BookingNight.updateMany({ propertyId: x.listing._id }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
  assert.strictEqual(await bookable(x, 120, 121), 201, "the night is sellable again once the hold expires");
});

test("the database connection drops and comes back mid-sync: the sync fails visibly and the next one converges", async () => {
  const x = await setup([reserved("DB-1@airbnb.com", 130, 131)]);
  ota.events(x.path, [reserved("DB-1@airbnb.com", 130, 131), reserved("DB-2@airbnb.com", 132, 133)]);
  const uri = mongoose.connection.client.s.url;
  let release;
  const gate = new Promise((r) => {
    release = r;
  });
  ota.set(x.path, { body: S.vcal([reserved("DB-1@airbnb.com", 130, 131), reserved("DB-2@airbnb.com", 132, 133)]), gate });
  const inflight = engine.syncConnection(x.id, { force: true }).catch((e) => ({ error: e.message }));
  await new Promise((r) => setTimeout(r, 60));
  await mongoose.connection.close();
  release();
  const r = await inflight;
  await mongoose.connect(uri);
  outcomes.push(`db-drop: ${JSON.stringify(r).slice(0, 80)}`);
  assert.notStrictEqual(r && r.ok, true, "a sync that lost the database does not report success");
  await ExternalCalendar.updateOne({ _id: x.id }, { $set: { "sync.leaseUntil": new Date(Date.now() - 1000) } });
  const again = await engine.syncConnection(x.id, { force: true });
  assert.ok(again.ok, JSON.stringify(again));
  assert.strictEqual(await bookable(x, 132, 133), 409);
  record("chaos", { outcomes });
});

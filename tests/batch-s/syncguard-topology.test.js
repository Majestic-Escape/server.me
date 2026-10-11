// SyncGuard release gate: loop / echo chaos across whole topologies. Each
// simulated OTA keeps its own reservations, fetches ITS Majestic feed on its
// own refresh cadence and (configurably) re-exports what it imported — with
// Majestic's UID kept, rewritten to its own, or replaced on every fetch; with
// dates exact, merged or split per night; with or without markers. Majestic
// syncs every connection each round (30 simulated minutes). Assertions:
//   * live imported rows stay bounded (no growth);
//   * a destination never receives its own reservations back;
//   * once the real booking is cancelled everything converges to nothing
//     (no immortal phantom created by Majestic);
//   * genuine double-sales stay blocking and are never silently hidden.
const { test, before, after } = require("node:test");
const assert = require("node:assert");
const crypto = require("node:crypto");
const S = require("./syncguard-helpers");
const H = require("./setup");

const ota = new S.FakeOta();
const record = S.evidence("topology");
let Booking;
let BookingNight;
let ExternalCalendar;
let engine;
let inventory;
let exportFeed;
let mongoose;
const LIVE = ["active", "missing", "orphaned"];
const ROUND_MS = 30 * 60_000;

before(async () => {
  await H.start();
  await ota.start();
  mongoose = require("mongoose");
  Booking = require("../../models/Booking");
  BookingNight = require("../../models/BookingNight");
  ExternalCalendar = require("../../models/ExternalCalendar");
  engine = require("../../services/calendarSync/engine");
  inventory = require("../../services/inventory");
  exportFeed = require("../../services/calendarSync/exportFeed");
});
after(async () => {
  await ota.stop();
  await H.stop();
});

const ymd = (s) => s.replace(/-/g, "");
const dayAdd = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

class SimOta {
  constructor(spec) {
    Object.assign(this, { reExport: true, uidMode: "rewrite", dateMode: "exact", marker: false, refreshEvery: 4, offset: 0 }, spec);
    this.own = [];
    this.imported = [];
    this.path = `/sim-${spec.name}-${Math.random().toString(36).slice(2, 8)}.ics`;
  }
  uidFor(ourUid) {
    if (this.uidMode === "preserve") return ourUid;
    if (this.uidMode === "replace") return `${this.name}-${crypto.randomBytes(5).toString("hex")}@${this.name}.sim`;
    return `${this.name}-${crypto.createHash("sha1").update(ourUid).digest("hex").slice(0, 10)}@${this.name}.sim`;
  }
  transform(blocks) {
    let ranges = blocks.map((b) => ({ ...b }));
    if (this.dateMode === "merge") {
      ranges.sort((a, b) => (a.start < b.start ? -1 : 1));
      const out = [];
      for (const r of ranges) {
        const last = out[out.length - 1];
        if (last && r.start <= last.end) last.end = r.end > last.end ? r.end : last.end;
        else out.push({ ...r });
      }
      ranges = out.map((r) => ({ ...r, uid: `${r.start}:${r.end}` }));
    } else if (this.dateMode === "split") {
      const out = [];
      for (const r of ranges) for (let d = r.start; d < r.end; d = dayAdd(d, 1)) out.push({ uid: `${r.uid}#${d}`, start: d, end: dayAdd(d, 1) });
      ranges = out;
    }
    return ranges.map((r) => ({ uid: this.uidFor(r.uid), start: r.start, end: r.end, summary: this.marker ? "Airbnb (Not available)" : undefined }));
  }
  publish() {
    const own = this.own.map((r) => ({ uid: r.uid, start: r.start, end: r.end, summary: this.marker ? "Reserved" : undefined }));
    ota.events(this.path, [...own, ...(this.reExport ? this.transform(this.imported) : [])]);
  }
}

async function topology(specs) {
  const host = await H.makeUser();
  const listing = await H.makeListing(host);
  const token = H.userToken(host);
  const otas = specs.map((s) => new SimOta(s));
  for (const o of otas) {
    o.publish();
    const c = await H.api("POST", `/calendarSync/properties/${listing._id}/connections`, { token, body: { channel: o.channel, url: ota.url(o.path) } });
    assert.strictEqual(c.status, 201, JSON.stringify(c.body));
    o.connId = c.body.id;
    o.secret = (await ExternalCalendar.findById(c.body.id).lean()).secret;
  }
  return { host, listing, token, otas, t0: Date.now(), round: 0 };
}

// The OTA requests its Majestic feed at the simulation's time (the request
// is recorded on the same clock as the syncs). `now` omitted = a plain read
// for the assertions (no request recorded).
async function majesticFeed(o, now) {
  let text;
  if (now) {
    // nudge: false — the simulation drives every sync itself, on its own clock
    text = (await exportFeed.serve(o.secret, { now, userAgent: `${o.name}-sim`, nudge: false })).body || "";
    await ExternalCalendar.updateOne({ _id: o.connId }, { $set: { "export.lastServedAt": now } });
  } else text = exportFeed.render(await exportFeed.feedItems({ row: await ExternalCalendar.findById(o.connId).lean(), now: new Date(), propagation: true }));
  const events = [];
  for (const block of text.split("BEGIN:VEVENT").slice(1)) {
    const uid = (block.match(/^UID:(.+)$/m) || [])[1];
    const s = (block.match(/^DTSTART;VALUE=DATE:(\d{8})$/m) || [])[1];
    const e = (block.match(/^DTEND;VALUE=DATE:(\d{8})$/m) || [])[1];
    if (uid && s && e) events.push({ uid: uid.trim(), start: `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6)}`, end: `${e.slice(0, 4)}-${e.slice(4, 6)}-${e.slice(6)}` });
  }
  return events;
}

async function step(T, rounds = 1) {
  for (let k = 0; k < rounds; k++) {
    T.round += 1;
    const now = new Date(T.t0 + T.round * ROUND_MS);
    for (const o of T.otas) {
      if ((T.round + o.offset) % o.refreshEvery === 0) o.imported = await majesticFeed(o, now);
      o.publish();
    }
    for (const o of T.otas) await engine.syncConnection(o.connId, { force: true, now });
  }
}

async function state(T) {
  const pid = new mongoose.Types.ObjectId(String(T.listing._id));
  const rows = await Booking.find({ propertyId: pid, source: "ical" }).lean();
  const live = rows.filter((r) => r.status === "confirmed" && LIVE.includes(r.external.state));
  const perConn = {};
  for (const o of T.otas) perConn[o.name] = live.filter((r) => String(r.external.connectionId) === o.connId).length;
  const feeds = {};
  for (const o of T.otas) feeds[o.name] = (await majesticFeed(o)).length;
  return { live: live.length, total: rows.length, perConn, feeds, echoes: live.filter((r) => r.external.echo && r.external.echo.suspect).length };
}

// Majestic-native paid booking (created directly: this suite is about loops)
async function nativeBooking(T, a, b) {
  const g = await H.makeUser();
  const cin = new Date(`${S.day(a)}T00:00:00Z`);
  const cout = new Date(`${S.day(b)}T00:00:00Z`);
  const doc = await Booking.create({ userId: g._id, hostId: T.host._id, propertyId: T.listing._id, source: "local", action: "user", checkIn: cin, checkOut: cout, nights: b - a, price: 1, subTotal: 1, currency: "INR", status: "confirmed", paymentStatus: "paid", guests: 1 });
  await BookingNight.insertMany(inventory.nightsBetween(cin, cout).map((date) => ({ propertyId: T.listing._id, date, bookingId: doc._id, kind: "booking", expiresAt: null })));
  return doc;
}
async function cancelNative(T, doc) {
  const now = new Date(T.t0 + T.round * ROUND_MS);
  await Booking.collection.updateOne({ _id: doc._id }, { $set: { status: "cancelled", updatedAt: now } });
  await BookingNight.deleteMany({ bookingId: doc._id });
}
function assertBounded(series, bound, label) {
  const tail = series.slice(-8);
  assert.ok(Math.max(...tail) <= bound, `${label}: live rows ${JSON.stringify(series)} exceed ${bound}`);
  assert.ok(Math.max(...tail) - Math.min(...tail) <= Math.max(1, Math.floor(bound / 2)), `${label}: not settling ${JSON.stringify(tail)}`);
}

test("2-channel Airbnb ↔ Majestic ↔ Agoda, both re-exporting: a Majestic booking echoes but never grows; cancelling it leaves nothing behind", async () => {
  const T = await topology([
    { name: "air", channel: "AIRBNB", marker: true, refreshEvery: 6 },
    { name: "ago", channel: "AGODA", refreshEvery: 4, offset: 1 },
  ]);
  const b = await nativeBooking(T, 60, 63);
  const series = [];
  for (let i = 0; i < 20; i++) {
    await step(T);
    series.push((await state(T)).live);
  }
  const mid = await state(T);
  assertBounded(series, 2, "2-channel");
  assert.deepStrictEqual(mid.feeds, { air: 1, ago: 1 }, "each OTA is told about the Majestic booking once — never about the other's mirror");
  assert.strictEqual(mid.echoes, mid.live, "every imported row is a (blocking) possible echo");
  await cancelNative(T, b);
  for (let i = 0; i < 40; i++) await step(T);
  const end = await state(T);
  assert.deepStrictEqual([end.live, end.feeds], [0, { air: 0, ago: 0 }], `phantoms remain: ${JSON.stringify(end)}`);
  record("two-channel", { series, mid, end });
});

test("3-channel Airbnb / Agoda / Vrbo: a genuine Airbnb booking reaches the others, their copies (merged, split, rewritten) never come back, and its cancellation clears everything", async () => {
  const T = await topology([
    { name: "air", channel: "AIRBNB", marker: true, reExport: true, refreshEvery: 6 },
    { name: "ago", channel: "AGODA", dateMode: "merge", refreshEvery: 4, offset: 1 },
    { name: "vrb", channel: "VRBO", dateMode: "split", refreshEvery: 2, offset: 1 },
  ]);
  T.otas[0].own.push({ uid: "AIR-REAL-1@airbnb.com", start: S.day(70), end: S.day(73) });
  T.otas[0].publish();
  const series = [];
  for (let i = 0; i < 24; i++) {
    await step(T);
    series.push((await state(T)).live);
  }
  const mid = await state(T);
  assertBounded(series, 1 + 1 + 3, "3-channel");
  assert.strictEqual(mid.feeds.air, 0, "Airbnb is never sent its own booking (nor copies of it)");
  assert.strictEqual(mid.feeds.ago, 1);
  assert.strictEqual(mid.feeds.vrb, 1);
  for (let d = 70; d < 73; d++) assert.strictEqual((await H.api("POST", "/booking", { token: H.userToken(await H.makeUser()), body: H.bookingBody(T.listing, { checkIn: S.day(d), checkOut: S.day(d + 1) }) })).status, 409);
  T.otas[0].own = [];
  for (let i = 0; i < 48; i++) await step(T);
  const end = await state(T);
  assert.deepStrictEqual([end.live, end.feeds], [0, { air: 0, ago: 0, vrb: 0 }], `phantoms remain: ${JSON.stringify(end)}`);
  record("three-channel", { series, mid, end });
});

test("5 generic OTAs that ALL re-export everything with their own UIDs: bounded, and full convergence after the source cancels", async () => {
  const T = await topology([0, 1, 2, 3, 4].map((i) => ({ name: `g${i}`, channel: "GENERIC_ICAL", refreshEvery: 2 + (i % 3), offset: i, dateMode: ["exact", "merge", "split", "exact", "merge"][i] })));
  T.otas[2].own.push({ uid: "G2-REAL@g2.sim", start: S.day(80), end: S.day(82) });
  T.otas[2].publish();
  const series = [];
  for (let i = 0; i < 30; i++) {
    await step(T);
    series.push((await state(T)).live);
  }
  const mid = await state(T);
  assertBounded(series, 1 + 4 * 2, "5-channel");
  assert.strictEqual(mid.feeds.g2, 0, "the source never gets its own booking back");
  for (const o of ["g0", "g1", "g3", "g4"]) assert.strictEqual(mid.feeds[o], 1, `${o} told once`);
  T.otas[2].own = [];
  for (let i = 0; i < 60; i++) await step(T);
  const end = await state(T);
  assert.strictEqual(end.live, 0, `phantoms remain: ${JSON.stringify(end)}`);
  assert.ok(Object.values(end.feeds).every((n) => n === 0), JSON.stringify(end.feeds));
  record("five-channel", { series, mid, end });
});

test("UIDs regenerated on EVERY fetch (worst-case OTA): live rows stay bounded and converge after cancellation", async () => {
  const T = await topology([
    { name: "src", channel: "GENERIC_ICAL", reExport: false, refreshEvery: 3 },
    { name: "chaos", channel: "GENERIC_ICAL", uidMode: "replace", refreshEvery: 1 },
  ]);
  T.otas[0].own.push({ uid: "SRC-1@src.sim", start: S.day(90), end: S.day(92) });
  T.otas[0].publish();
  const series = [];
  for (let i = 0; i < 24; i++) {
    await step(T);
    series.push((await state(T)).live);
  }
  // each regenerated copy blocks until its disappearance is confirmed
  // (≥ 3 syncs over ≥ 2 h = 4 rounds), so ~5 copies are live at once
  assertBounded(series, 1 + 6, "uid-replace");
  T.otas[0].own = [];
  // the last regenerated copies vanish together = the whole set → the
  // 12-hour anomaly hold applies; 60 rounds = 30 h covers it
  for (let i = 0; i < 60; i++) await step(T);
  const end = await state(T);
  const stuck = (await Booking.find({ propertyId: T.listing._id, source: "ical", status: "confirmed" }).lean()).map((r) => ({ state: r.external.state, missingSyncs: r.external.missingSyncs, missingMass: r.external.missingMass, since: r.external.missingSince, first: r.external.firstSeenAt, echo: r.external.echo }));
  assert.strictEqual(end.live, 0, JSON.stringify({ end, stuck, round: T.round, simNow: new Date(T.t0 + T.round * ROUND_MS) }));
  record("uid-replace", { series, end, totalRowsCreated: end.total });
});

test("Majestic UIDs preserved by the OTA are dropped as reflections (zero rows); SUMMARY removed changes nothing", async () => {
  const T = await topology([
    { name: "keep", channel: "GENERIC_ICAL", uidMode: "preserve", refreshEvery: 1 },
    { name: "plain", channel: "BOOKING_COM", refreshEvery: 2 },
  ]);
  await nativeBooking(T, 100, 102);
  for (let i = 0; i < 10; i++) await step(T);
  const rows = await Booking.find({ propertyId: T.listing._id, source: "ical", "external.connectionId": new mongoose.Types.ObjectId(T.otas[0].connId) }).lean();
  assert.strictEqual(rows.length, 0, "a reflected Majestic UID never becomes a row");
  const conn = await ExternalCalendar.findById(T.otas[0].connId).lean();
  assert.ok(conn.stats.reflected > 0);
});

test("genuine independent double-sale on two OTAs without markers: both stay blocking and the overlap is visible to the host", async () => {
  const T = await topology([
    { name: "ago", channel: "AGODA", reExport: false, refreshEvery: 4 },
    { name: "bdc", channel: "BOOKING_COM", reExport: false, refreshEvery: 4, offset: 2 },
  ]);
  T.otas[0].own.push({ uid: "AGO-REAL@agoda.sim", start: S.day(110), end: S.day(112) });
  T.otas[0].publish();
  for (let i = 0; i < 6; i++) await step(T); // Booking.com has long been told about the Agoda booking…
  T.otas[1].own.push({ uid: "BDC-REAL@booking.sim", start: S.day(110), end: S.day(112) }); // …and sells the nights anyway
  T.otas[1].publish();
  for (let i = 0; i < 6; i++) await step(T);
  const live = (await Booking.find({ propertyId: T.listing._id, source: "ical", status: "confirmed" }).lean()).filter((r) => LIVE.includes(r.external.state));
  assert.strictEqual(live.length, 2, "both block");
  const list = await H.api("GET", `/calendarSync/properties/${T.listing._id}/connections`, { token: T.token });
  const conns = list.body.data.connections || list.body.data;
  const visible = conns.some((c) => (c.counts.overlaps || 0) + (c.counts.possibleOverlaps || 0) > 0);
  assert.ok(visible, `the double-sale is not visible to the host: ${JSON.stringify(conns.map((c) => c.counts))}`);
  for (let d = 110; d < 112; d++) assert.strictEqual((await H.api("POST", "/booking", { token: H.userToken(await H.makeUser()), body: H.bookingBody(T.listing, { checkIn: S.day(d), checkOut: S.day(d + 1) }) })).status, 409);
});

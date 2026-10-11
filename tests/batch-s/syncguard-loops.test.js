// SyncGuard: reflections, echoes and transitive loops (docs/syncguard.md §4).
// Simulated OTAs really fetch Majestic's feeds over HTTP and re-export what
// they imported, with configurable behaviour (keep our UIDs / rewrite them /
// merge adjacent ranges) — the undocumented worst case for every OTA.
const { test, before, after } = require("node:test");
const assert = require("node:assert");
const S = require("./syncguard-helpers");
const H = require("./setup");

const ota = new S.FakeOta();
const record = S.evidence("loops");
let base;
let engine;
let Booking;
let ExternalCalendar;
let exportFeed;
const { parseIcs } = require("../../services/calendarSync/icsReader");
const T0 = Date.now();
const at = (minutes) => new Date(T0 + minutes * 60_000);

before(async () => {
  base = (await H.start()).baseUrl;
  await ota.start();
  engine = require("../../services/calendarSync/engine");
  Booking = require("../../models/Booking");
  ExternalCalendar = require("../../models/ExternalCalendar");
  exportFeed = require("../../services/calendarSync/exportFeed");
  await Promise.all([require("../../models/ExternalCalendar").syncIndexes(), require("../../models/CalendarSyncLog").syncIndexes()]);
});
after(async () => {
  await ota.stop();
  await H.stop();
});

let seq = 0;
class SimOta {
  constructor(name, channel, { reexport = true, uidMode = "rewrite", merge = false, blockSummary = "Blocked" } = {}) {
    Object.assign(this, { name, channel, reexport, uidMode, merge, blockSummary });
    this.reservations = [];
    this.ingested = [];
    this.path = `/sim-${name}-${++seq}.ics`;
  }
  render() {
    const own = this.reservations.map((r) => ({ ...r, summary: r.summary || "Reserved" }));
    let blocks = this.reexport ? this.ingested.map((b) => ({ ...b })) : [];
    if (this.merge) {
      blocks.sort((a, b) => (a.start < b.start ? -1 : 1));
      const merged = [];
      for (const b of blocks) {
        const last = merged[merged.length - 1];
        if (last && b.start <= last.end) last.end = b.end > last.end ? b.end : last.end;
        else merged.push({ ...b });
      }
      blocks = merged;
    }
    const out = blocks.map((b) => ({
      uid: this.uidMode === "preserve" && !this.merge ? b.uid : `${this.name}-blk-${b.start}-${b.end}@${this.name}.example`,
      start: b.start,
      end: b.end,
      summary: this.blockSummary,
    }));
    return S.vcal([...own, ...out]);
  }
  async attach(x) {
    ota.set(this.path, { body: () => this.render() });
    const r = await H.api("POST", `/calendarSync/properties/${x.listing._id}/connections`, { token: x.token, body: { channel: this.channel, url: ota.url(this.path) } });
    assert.strictEqual(r.status, 201, JSON.stringify(r.body));
    this.id = r.body.id;
    this.secret = r.body.data.connections.find((c) => c.id === r.body.id).export.url.match(/\/ics\/([^/]+)\.ics$/)[1];
    return this;
  }
  // The OTA imports Majestic's feed for it (what it would do every 30 min–3 h)
  // — at the simulated time of the round, so the request is recorded on the
  // same clock as the syncs (an OTA can only reflect what it fetched).
  async ingest(now = new Date()) {
    // nudge: false — the simulation drives every sync itself, on its own clock
    const out = await exportFeed.serve(this.secret, { now, userAgent: `${this.name}-sim`, nudge: false });
    await ExternalCalendar.updateOne({ _id: this.id }, { $set: { "export.lastServedAt": now } });
    this.ingested = parseIcs(out.body).events.map((e) => ({ uid: e.uid, start: e.startDay, end: e.endDay }));
  }
}

async function property() {
  const host = await H.makeUser();
  const listing = await H.makeListing(host);
  return { host, listing, token: H.userToken(host) };
}
async function hostBlock(x, from, to) {
  const r = await H.api("POST", "/booking", { token: x.token, body: { ...H.bookingBody(x.listing, { checkIn: S.day(from), checkOut: S.day(to) }), action: "host" } });
  assert.strictEqual(r.status, 201, JSON.stringify(r.body));
  return r.body.data;
}
async function paid(x, from, to) {
  const g = await H.makeUser();
  const t = H.userToken(g);
  const r = await H.api("POST", "/booking", { token: t, body: H.bookingBody(x.listing, { checkIn: S.day(from), checkOut: S.day(to) }) });
  assert.strictEqual(r.status, 201, JSON.stringify(r.body));
  const o = await H.api("POST", "/payment/create-order", { token: t, body: { bookingId: r.body.data._id, amount: r.body.data.quote.totalPaise, currency: "INR" } });
  const pay = H.razorpay().__registerPayment({ id: `pay_loop_${++seq}`, order_id: o.body.data.id, amount: o.body.data.amount, currency: "INR", status: "captured", method: "upi" });
  const v = await H.api("POST", "/payment/verify-payment", { token: t, body: { razorpay_order_id: o.body.data.id, razorpay_payment_id: pay.id, razorpay_signature: H.signature(o.body.data.id, pay.id) } });
  assert.strictEqual(v.status, 200, JSON.stringify(v.body));
  return r.body.data;
}
async function round(otas, minutes) {
  for (const o of otas) await o.ingest(at(minutes));
  for (const o of otas) await engine.syncConnection(o.id, { force: true, now: at(minutes) });
}
async function liveRows(x) {
  return (await Booking.find({ propertyId: x.listing._id, source: "ical", "external.state": { $in: ["active", "missing", "orphaned"] } }).lean()).map((r) => ({ channel: r.external.channel, from: r.checkIn.toISOString().slice(0, 10), to: r.checkOut.toISOString().slice(0, 10), echo: !!(r.external.echo && r.external.echo.suspect), state: r.external.state, conflict: r.external.conflict && r.external.conflict.at ? r.external.conflict.kind + (r.external.conflict.likelyMirror ? "/mirror" : "") : null }));
}
const feedRanges = async (o) => parseIcs(await (await fetch(`${base}/calendarSync/ics/${o.secret}.ics`)).text()).events.map((e) => `${e.startDay}..${e.endDay}`).sort();

test("true reflection (our UID comes back): dropped, never a block of its own", async () => {
  const x = await property();
  await hostBlock(x, 10, 11);
  const g = await new SimOta("gcal", "GENERIC_ICAL", { uidMode: "preserve" }).attach(x);
  await round([g], 1);
  await round([g], 2);
  assert.deepStrictEqual(await liveRows(x), []);
  const conn = await require("../../models/ExternalCalendar").findById(g.id).lean();
  assert.ok(conn.stats.reflected >= 1, "reflection counted");
  record("true-reflection", { rows: await liveRows(x), reflected: conn.stats.reflected });
});

test("reflection with a rewritten UID (Airbnb marker): possible echo — blocks, not propagated, conflict shown as likely mirror, no alert", async () => {
  const x = await property();
  const m = await paid(x, 20, 22);
  const airbnb = await new SimOta("airbnb", "AIRBNB", { blockSummary: "Airbnb (Not available)" }).attach(x);
  const agoda = await new SimOta("agoda", "AGODA", { reexport: false }).attach(x);
  H.resetEmails();
  await round([airbnb, agoda], 1);
  await round([airbnb, agoda], 2);
  const rows = await liveRows(x);
  assert.deepStrictEqual(rows, [{ channel: "AIRBNB", from: S.day(20), to: S.day(22), echo: true, state: "active", conflict: "paid_booking/mirror" }]);
  assert.deepStrictEqual(await feedRanges(agoda), [`${S.day(20)}..${S.day(22)}`], "Agoda gets the Majestic booking once, not the echo");
  assert.strictEqual((await Booking.findById(m._id).lean()).needsAttention, null, "no alert for a verified-marker mirror");
  assert.strictEqual(H.sentEmails().length, 0);
  record("rewritten-uid-reflection", { rows, agodaFeed: await feedRanges(agoda) });
});

test("reflection with merged dates: still a possible echo (subset rule)", async () => {
  const x = await property();
  await hostBlock(x, 30, 31);
  await hostBlock(x, 31, 33);
  const g = await new SimOta("merger", "GENERIC_ICAL", { merge: true }).attach(x);
  const other = await new SimOta("other", "VRBO", { reexport: false }).attach(x);
  await round([g, other], 1);
  await round([g, other], 2);
  const rows = await liveRows(x);
  assert.deepStrictEqual(rows.map((r) => [r.from, r.to, r.echo]), [[S.day(30), S.day(33), true]]);
  assert.deepStrictEqual(await feedRanges(other), [`${S.day(30)}..${S.day(31)}`, `${S.day(31)}..${S.day(33)}`], "Vrbo gets the two host blocks, not the merged echo");
});

test("genuine OTA double-sale on exactly the Majestic dates is NEVER hidden (Airbnb 'Reserved' and unmarked generic)", async () => {
  const x = await property();
  const m = await paid(x, 40, 42);
  const airbnb = await new SimOta("airbnb2", "AIRBNB", { blockSummary: "Airbnb (Not available)", reexport: false }).attach(x);
  const agoda = await new SimOta("agoda2", "AGODA", { reexport: false }).attach(x);
  await round([airbnb, agoda], 1);
  airbnb.reservations.push({ uid: "R-EXACT@airbnb.com", start: S.day(40), end: S.day(42), summary: "Reserved" });
  H.resetEmails();
  await round([airbnb, agoda], 2);
  let rows = await liveRows(x);
  assert.deepStrictEqual(rows, [{ channel: "AIRBNB", from: S.day(40), to: S.day(42), echo: false, state: "active", conflict: "paid_booking" }]);
  assert.strictEqual((await Booking.findById(m._id).lean()).needsAttention, "ota_conflict");
  assert.ok(H.sentEmails().length >= 1, "host and ops told");
  // Unmarked generic calendar: dates match our export → only a *possible* echo, but the conflict is still raised.
  const y = await property();
  const m2 = await paid(y, 44, 46);
  const gen = await new SimOta("gen2", "GENERIC_ICAL", { reexport: false }).attach(y);
  await round([gen], 3);
  gen.reservations.push({ uid: "GEN-EXACT@other", start: S.day(44), end: S.day(46), summary: "Busy" });
  await round([gen], 4);
  rows = await liveRows(y);
  assert.deepStrictEqual(rows, [{ channel: "GENERIC_ICAL", from: S.day(44), to: S.day(46), echo: true, state: "active", conflict: "paid_booking" }]);
  assert.strictEqual((await Booking.findById(m2._id).lean()).needsAttention, "ota_conflict", "ambiguous ⇒ surfaced, not suppressed");
  record("genuine-exact-overlap", { airbnbRows: await liveRows(x), genericRows: rows });
});

test("genuine OTA booking partially overlapping exported nights: genuine, conflict on the shared night, propagated", async () => {
  const x = await property();
  const m = await paid(x, 50, 52);
  const airbnb = await new SimOta("airbnb3", "AIRBNB", { blockSummary: "Airbnb (Not available)", reexport: false }).attach(x);
  const agoda = await new SimOta("agoda3", "AGODA", { reexport: false }).attach(x);
  airbnb.reservations.push({ uid: "R-PART@airbnb.com", start: S.day(51), end: S.day(53), summary: "Not available" });
  await round([airbnb, agoda], 1);
  const rows = await liveRows(x);
  assert.deepStrictEqual(rows, [{ channel: "AIRBNB", from: S.day(51), to: S.day(53), echo: false, state: "active", conflict: "paid_booking" }]);
  const owners = await S.nightOwners(x.listing._id);
  assert.strictEqual(owners[S.day(52)], "ical:AIRBNB", "the extra night is blocked by the OTA booking");
  assert.strictEqual((await Booking.findById(m._id).lean()).needsAttention, "ota_conflict");
  assert.deepStrictEqual(await feedRanges(agoda), [`${S.day(50)}..${S.day(52)}`, `${S.day(51)}..${S.day(53)}`]);
});

test("three-channel transitive reflection: bounded, no growth, and full convergence after the source cancels", async () => {
  const x = await property();
  const airbnb = await new SimOta("airbnb4", "AIRBNB", { blockSummary: "Airbnb (Not available)" }).attach(x);
  const agoda = await new SimOta("agoda4", "AGODA", { merge: true }).attach(x);
  const vrbo = await new SimOta("vrbo4", "VRBO", { uidMode: "rewrite" }).attach(x);
  const all = [airbnb, agoda, vrbo];
  airbnb.reservations.push({ uid: "R-ORIGIN@airbnb.com", start: S.day(60), end: S.day(62), summary: "Reserved" });
  airbnb.reservations.push({ uid: "R-OTHER@airbnb.com", start: S.day(90), end: S.day(91), summary: "Reserved" });
  const sizes = [];
  for (let i = 1; i <= 6; i++) {
    await round(all, i);
    sizes.push((await liveRows(x)).length);
  }
  assert.deepStrictEqual(sizes.slice(2), [sizes[2], sizes[2], sizes[2], sizes[2]], `no growth once steady (${sizes})`);
  const steady = await liveRows(x);
  assert.strictEqual(steady.filter((r) => !r.echo).length, 2, "only Airbnb's two real bookings are genuine");
  assert.deepStrictEqual(await feedRanges(airbnb), [], "nothing echoes back to Airbnb");
  // The guest cancels on Airbnb. Run rounds every 40 min.
  airbnb.reservations = airbnb.reservations.filter((r) => r.uid !== "R-ORIGIN@airbnb.com");
  const timeline = [];
  let m = 10;
  for (let i = 0; i < 14; i++) {
    await round(all, (m += 40));
    const live = (await liveRows(x)).filter((r) => r.from === S.day(60));
    timeline.push({ minutes: m, rows: live.length });
    if (!live.length) break;
  }
  const final = (await liveRows(x)).filter((r) => r.from === S.day(60) || r.to === S.day(62));
  assert.deepStrictEqual(final, [], `converged: ${JSON.stringify(timeline)}`);
  assert.ok(!(await S.nightOwners(x.listing._id))[S.day(60)], "night reopened on Majestic");
  for (const o of all) await o.ingest();
  assert.ok(all.every((o) => !o.ingested.some((b) => b.start === S.day(60))), "no OTA still receives the cancelled nights");
  assert.ok((await liveRows(x)).some((r) => r.from === S.day(90) && !r.echo), "the unrelated real booking is untouched");
  record("three-channel", { sizes, steady, timeline });
});

test("Majestic booking cancelled → every reflection disappears (no immortal ghost)", async () => {
  const x = await property();
  const block = await hostBlock(x, 70, 72);
  const airbnb = await new SimOta("airbnb5", "AIRBNB", { blockSummary: "Airbnb (Not available)" }).attach(x);
  const agoda = await new SimOta("agoda5", "AGODA", {}).attach(x);
  airbnb.reservations.push({ uid: "KEEP@airbnb.com", start: S.day(95), end: S.day(96), summary: "Reserved" });
  agoda.reservations.push({ uid: "KEEP@agoda", start: S.day(97), end: S.day(98), summary: "Reserved" });
  for (let i = 1; i <= 3; i++) await round([airbnb, agoda], i);
  assert.ok((await liveRows(x)).filter((r) => r.from === S.day(70)).every((r) => r.echo));
  const un = await H.api("POST", `/booking/unblock-dates/${x.listing._id}`, { token: x.token, body: { selectedDate: S.day(70) } });
  assert.strictEqual(un.status, 200, JSON.stringify(un.body));
  assert.ok(block);
  let m = 10;
  for (let i = 0; i < 14; i++) {
    await round([airbnb, agoda], (m += 40));
    if (!(await liveRows(x)).some((r) => r.from === S.day(70))) break;
  }
  assert.deepStrictEqual((await liveRows(x)).filter((r) => r.from === S.day(70)), []);
  assert.ok(!(await S.nightOwners(x.listing._id))[S.day(70)]);
});

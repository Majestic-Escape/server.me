// A9 repair script (scripts/a9/repair-missing-import-nights.js) and detector, test database only:
// what other writers see and do in the interval between the repair moving an expired
// hold's row to the import and moving it back because the hold's booking was paid
// meanwhile. Real API, sync engine and payment-side inventory calls.
const { test, before, after } = require("node:test");
const assert = require("node:assert");
const S = require("./syncguard-helpers");
const H = require("./setup");

const path = require("node:path");
const REPAIR = process.env.A9_REPAIR || path.join(__dirname, "../../scripts/a9/repair-missing-import-nights.js");
const DETECTOR = path.join(__dirname, "../../scripts/a9/find-missing-import-nights.js");
const repair = require(REPAIR);
const ota = new S.FakeOta();
let Booking, BookingNight, engine, mongoose, inv, ledger;

before(async () => {
  await H.start();
  await ota.start();
  mongoose = require("mongoose");
  Booking = require("../../models/Booking");
  BookingNight = require("../../models/BookingNight");
  engine = require("../../services/calendarSync/engine");
  inv = require("../../services/inventory");
  ledger = require("../../services/calendarSync/ledger");
});
after(async () => {
  await ota.stop();
  await H.stop();
});

let seq = 0;
const ev = (uid, from, to) => ({ uid: `${uid}@ota.test`, start: S.day(from), end: S.day(to), summary: "Reserved" });
const N = (d) => new Date(`${S.day(d)}T00:00:00Z`);
async function owner(x, d) {
  const rows = await BookingNight.find({ propertyId: x.listing._id, date: N(d) }).lean();
  assert.ok(rows.length <= 1, "one ledger owner per night");
  return rows[0] ? { owner: String(rows[0].bookingId), expiresAt: rows[0].expiresAt ? rows[0].expiresAt.toISOString() : null } : null;
}
async function searchAndCheckDates(x, d) {
  const s = await H.api("GET", `/properties/search-properties?from=${S.day(d)}&to=${S.day(d + 1)}&limit=50`);
  const cd = await H.api("GET", `/booking/check-dates/${x.listing._id}`);
  return { offered: (s.body.data || []).some((l) => String(l._id) === String(x.listing._id)), taken: cd.body.data.includes(S.day(d)) };
}
const checkout = async (x, d) => { const r = await H.api("POST", "/booking", { token: H.userToken(await H.makeUser()), body: H.bookingBody(x.listing, { checkIn: S.day(d), checkOut: S.day(d + 1) }) }); if (r.status !== 201) console.log(`[checkout refused] ${r.status} ${r.body && r.body.code}`); return r.status; };
const markPaid = (id) => Booking.collection.updateOne({ _id: id }, { $set: { paymentStatus: "paid", status: "confirmed" } });

// The planned state: a live import covers N, but N's row belongs to an unpaid hold whose
// expiry has passed (search shows N free). Returns the import, the hold and its connection.
async function plannedState(d) {
  const host = await H.makeUser();
  const listing = await H.makeListing(host);
  const x = { host, listing, hostToken: H.userToken(host) };
  const p = `/rep-${++seq}.ics`;
  ota.events(p, [ev(`REP-${seq}`, d - 1, d + 2)]);
  const conn = await H.api("POST", `/calendarSync/properties/${listing._id}/connections`, { token: x.hostToken, body: { channel: seq % 2 ? "AIRBNB" : "BOOKING", url: ota.url(p) } });
  assert.strictEqual(conn.status, 201, JSON.stringify(conn.body));
  await engine.syncConnection(conn.body.id, { force: true });
  const imp = await Booking.findOne({ propertyId: listing._id, source: "ical" }).lean();
  await BookingNight.deleteOne({ propertyId: listing._id, date: N(d), bookingId: imp._id }); // the A9 loss
  const hold = new mongoose.Types.ObjectId();
  await Booking.collection.insertOne({ _id: hold, userId: new mongoose.Types.ObjectId(), hostId: host._id, propertyId: listing._id, source: "local", action: "user", checkIn: N(d), checkOut: N(d + 1), status: "pending", paymentStatus: "unpaid", price: 100, subTotal: 100, createdAt: new Date(), updatedAt: new Date() });
  const expiresAt = new Date(Date.now() - 5 * 60_000);
  await BookingNight.create({ propertyId: listing._id, date: N(d), bookingId: hold, kind: "booking", expiresAt });
  return { x, imp, hold, conn: conn.body.id, expiresAt };
}

// Runs plan + apply for this listing's night, pausing right after the move to the import.
async function applyWithPause(s, d, inInterval) {
  const deps = { Booking, BookingNight, inv };
  const p = await repair.plan(deps, new Date());
  p.items = p.items.filter((i) => i.propertyId === String(s.x.listing._id) && i.night === S.day(d));
  assert.strictEqual(p.items.length, 1);
  assert.strictEqual(p.items[0].state, "expired_hold_row");
  const orig = BookingNight.updateOne;
  let seen = null;
  BookingNight.updateOne = async function patched(filter, update, ...rest) {
    const isMove = !seen && filter && String(filter.bookingId) === String(s.hold) && update && update.$set && String(update.$set.bookingId) === String(s.imp._id);
    const res = await orig.call(this, filter, update, ...rest);
    if (isMove) {
      seen = { afterMove: await owner(s.x, d) };
      BookingNight.updateOne = orig; // the interval's own writers run unpatched
      Object.assign(seen, await inInterval());
    }
    return res;
  };
  let results;
  try { results = await repair.applyPlan(deps, p, new Date()); } finally { BookingNight.updateOne = orig; }
  assert.ok(seen, "the pause happened");
  return { seen, outcome: results[0].outcome };
}

test("repair interval: other writers cannot take the night while the import holds it; the paid guest gets it back, permanent", async () => {
  const d = 520;
  const s = await plannedState(d);
  const imp2 = new mongoose.Types.ObjectId(); // a second import on another channel, covering N
  const { seen, outcome } = await applyWithPause(s, d, async () => {
    const view = await searchAndCheckDates(s.x, d);
    const guestCheckout = await checkout(s.x, d);
    await Booking.collection.insertOne({ _id: imp2, propertyId: s.x.listing._id, hostId: s.x.host._id, source: "ical", action: "user", status: "confirmed", checkIn: N(d), checkOut: N(d + 1), createdAt: new Date(), updatedAt: new Date() });
    await ledger.claimNights({ propertyId: s.x.listing._id, bookingId: imp2, nights: [N(d)] });
    const afterOthers = await owner(s.x, d);
    await markPaid(s.hold); // the payment lands in the same interval: the repair must give the row back
    return { view, guestCheckout, afterOthers };
  });
  console.log(`[interval: other writers] ${JSON.stringify({ seen, outcome })}`);
  assert.deepStrictEqual(seen.afterMove, { owner: String(s.imp._id), expiresAt: null }, "moved in place: N never without a row");
  assert.deepStrictEqual([seen.view.offered, seen.view.taken, seen.guestCheckout], [false, true, 409], "during the interval search, check-dates and checkout say taken");
  assert.deepStrictEqual(seen.afterOthers, { owner: String(s.imp._id), expiresAt: null }, "a second import's claim did not take N over");
  assert.strictEqual(outcome, "restored_paid_owner");
  assert.deepStrictEqual(await owner(s.x, d), { owner: String(s.hold), expiresAt: null }, "the paid booking owns N, permanently");
  const after = await searchAndCheckDates(s.x, d);
  assert.strictEqual(after.offered, false, "search does not offer the paid guest's night");
});

test("repair interval: the payment capture runs inside the interval; afterwards search must not offer the paid night", async () => {
  const d = 530;
  const s = await plannedState(d);
  const { seen, outcome } = await applyWithPause(s, d, async () => {
    await markPaid(s.hold);
    // payments.js after "paid": securePermanent makes the booking's nights permanent
    const secured = await inv.securePermanent({ propertyId: s.x.listing._id, bookingId: s.hold, nights: [N(d)] });
    return { secured: { ok: secured.ok, conflicts: (secured.conflicts || []).map((c) => String(c.bookingId)) }, afterCapture: await owner(s.x, d) };
  });
  const row = await owner(s.x, d);
  const after = await searchAndCheckDates(s.x, d);
  console.log(`[interval: payment capture] ${JSON.stringify({ seen, outcome, row, after })}`);
  assert.strictEqual(seen.secured.ok, false, "the capture sees a conflict (it would flag the booking for a person): the import covers N in every order");
  assert.strictEqual(outcome, "restored_paid_owner");
  assert.strictEqual(row.owner, String(s.hold));
  assert.deepStrictEqual([row.expiresAt, after.offered], [null, false], "the paid booking's row is permanent: search does not offer the night");
});

test("repair interval: the import is released inside the interval; the paid guest must not lose the night", async () => {
  const d = 540;
  const s = await plannedState(d);
  const { seen, outcome } = await applyWithPause(s, d, async () => {
    await markPaid(s.hold);
    const rel = await H.api("POST", `/calendarSync/connections/${s.conn}/disconnect`, { token: s.x.hostToken, body: { acknowledge: true, releaseBlocks: true } });
    return { disconnect: rel.status, afterRelease: await owner(s.x, d) };
  });
  const row = await owner(s.x, d);
  const after = await searchAndCheckDates(s.x, d);
  const guestCheckout = await checkout(s.x, d);
  console.log(`[interval: import released] ${JSON.stringify({ seen, outcome, row, after, guestCheckout })}`);
  assert.strictEqual(seen.disconnect, 200);
  assert.strictEqual(outcome, "restored_paid_owner", "the paid booking takes the freed night back");
  assert.deepStrictEqual(row, { owner: String(s.hold), expiresAt: null });
  assert.deepStrictEqual([after.offered, after.taken, guestCheckout], [false, true, 409], "nobody else can buy the paid guest's night");
});

test("two live imports cover the same rowless nights: one finding and one plan item per night (the lowest id); apply claims them with no skips", async () => {
  const d = 560;
  const host = await H.makeUser();
  const listing = await H.makeListing(host);
  const hostToken = H.userToken(host);
  for (const channel of ["AIRBNB", "BOOKING"]) {
    const p = `/rep-two-${++seq}.ics`;
    ota.events(p, [ev(`TWO-${seq}`, d - 1, d + 2)]);
    const conn = await H.api("POST", `/calendarSync/properties/${listing._id}/connections`, { token: hostToken, body: { channel, url: ota.url(p) } });
    assert.strictEqual(conn.status, 201, JSON.stringify(conn.body));
    await engine.syncConnection(conn.body.id, { force: true });
  }
  const imps = await Booking.find({ propertyId: listing._id, source: "ical" }).sort({ _id: 1 }).lean();
  assert.strictEqual(imps.length, 2, "both imports are live and cover the same three nights");
  const nights = [d - 1, d, d + 1];
  await BookingNight.deleteMany({ propertyId: listing._id, date: { $in: nights.map(N) } }); // the A9 loss (data written before the fix)
  const lowest = String(imps[0]._id);

  const { execFileSync } = require("node:child_process");
  const found = JSON.parse(execFileSync(process.execPath, [DETECTOR, "--uri", (await H.start()).uri, "--json"], { encoding: "utf8" })).filter((f) => f.propertyId === String(listing._id));
  assert.deepStrictEqual(found.map((f) => [f.night, f.importId, f.state, f.alsoCoveredBy]), nights.map((n) => [S.day(n), lowest, "no_row", 1]), "the detector reports each night once");

  const deps = { Booking, BookingNight, inv };
  const p = await repair.plan(deps, new Date());
  p.items = p.items.filter((i) => i.propertyId === String(listing._id));
  assert.deepStrictEqual(p.items.map((i) => [i.night, i.importId]), nights.map((n) => [S.day(n), lowest]), "one plan item per night, for the lowest-id import");
  const results = await repair.applyPlan(deps, p, new Date());
  assert.deepStrictEqual(results.map((r) => r.outcome), ["claimed", "claimed", "claimed"], "a clean repair: nothing skipped, so the run exits 0");
  for (const n of nights) {
    const row = await owner({ listing }, n);
    const after = await searchAndCheckDates({ listing }, n);
    assert.deepStrictEqual([row && row.owner, after.offered, after.taken], [lowest, false, true]);
  }
});

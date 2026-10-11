// SyncGuard release gate: repeatable double-booking attacks. Every scenario
// runs several times with random jitter between the competing operations,
// and after EVERY iteration the database is checked against invariants —
// not only HTTP statuses:
//   I1 one ledger owner per night;
//   I2 an unflagged paid Majestic stay owns all its nights permanently;
//   I3 two unflagged paid Majestic stays never share a night;
//   I4 an unflagged paid Majestic stay never shares a night with a live OTA
//      booking unless that conflict is recorded on the import;
//   I5 a captured payment always shows up on its booking.
const { test, before, after } = require("node:test");
const assert = require("node:assert");
const crypto = require("node:crypto");
const S = require("./syncguard-helpers");
const H = require("./setup");

const ota = new S.FakeOta();
const record = S.evidence("races");
let Booking;
let BookingNight;
let Payment;
let ExternalCalendar;
let engine;
let inventory;
let ledger;
let mongoose;
const LIVE = ["active", "missing", "orphaned"];
const ROUNDS = Number(process.env.SYNCGUARD_RACE_ROUNDS || 8);

before(async () => {
  await H.start();
  await ota.start();
  mongoose = require("mongoose");
  Booking = require("../../models/Booking");
  BookingNight = require("../../models/BookingNight");
  Payment = require("../../models/Payment");
  ExternalCalendar = require("../../models/ExternalCalendar");
  engine = require("../../services/calendarSync/engine");
  inventory = require("../../services/inventory");
  ledger = require("../../services/calendarSync/ledger");
});
after(async () => {
  await ota.stop();
  await H.stop();
});

const jitter = () => new Promise((r) => setTimeout(r, Math.floor(Math.random() * 25)));
const day = (d) => new Date(d).toISOString().slice(0, 10);
const tally = {};
const note = (scenario, outcome) => {
  tally[scenario] = tally[scenario] || {};
  tally[scenario][outcome] = (tally[scenario][outcome] || 0) + 1;
};

async function invariants(listingId, label) {
  const pid = new mongoose.Types.ObjectId(String(listingId));
  const [rows, nights] = await Promise.all([Booking.find({ propertyId: pid }).lean(), BookingNight.find({ propertyId: pid }).lean()]);
  const perNight = {};
  for (const n of nights) perNight[day(n.date)] = (perNight[day(n.date)] || 0) + 1;
  for (const [d, c] of Object.entries(perNight)) assert.strictEqual(c, 1, `${label}: I1 night ${d} has ${c} ledger owners`);
  const committed = rows.filter((b) => b.source === "local" && b.action !== "host" && b.paymentStatus === "paid" && !["cancelled", "rejected"].includes(b.status) && !b.needsAttention);
  const imports = rows.filter((b) => ["ical", "ical_parked"].includes(b.source) && b.status === "confirmed" && b.external && LIVE.includes(b.external.state));
  const nightsOf = (b) => inventory.nightsBetween(b.checkIn, b.checkOut).map(day);
  for (const b of committed) {
    for (const d of nightsOf(b)) {
      const owner = nights.find((n) => day(n.date) === d);
      assert.ok(owner && String(owner.bookingId) === String(b._id) && !owner.expiresAt, `${label}: I2 paid stay ${b._id} does not own ${d} permanently`);
    }
  }
  for (let i = 0; i < committed.length; i++) {
    for (let j = i + 1; j < committed.length; j++) {
      const shared = nightsOf(committed[i]).filter((d) => nightsOf(committed[j]).includes(d));
      assert.deepStrictEqual(shared, [], `${label}: I3 two paid stays share ${shared}`);
    }
  }
  for (const b of committed) {
    for (const imp of imports) {
      const shared = nightsOf(b).filter((d) => nightsOf(imp).includes(d));
      if (!shared.length) continue;
      const recorded = imp.external.conflict && (imp.external.conflict.withBookingIds || []).some((id) => String(id) === String(b._id));
      assert.ok(recorded, `${label}: I4 paid stay ${b._id} shares ${shared} with OTA booking ${imp._id} and nothing records it`);
    }
  }
  const pays = await Payment.find({ bookingId: { $in: rows.map((b) => b._id) }, status: "paid" }).lean();
  for (const p of pays) {
    const b = rows.find((r) => String(r._id) === String(p.bookingId));
    assert.ok(b && (b.paymentStatus === "paid" || b.needsAttention), `${label}: I5 payment ${p._id} captured but booking shows ${b && b.paymentStatus}`);
  }
  return { rows: rows.length, nights: nights.length, committed: committed.length, imports: imports.length };
}

let seq = 0;
async function setup({ channel = "AIRBNB", events = [] } = {}) {
  const host = await H.makeUser();
  const listing = await H.makeListing(host);
  const token = H.userToken(host);
  const p = `/race${++seq}.ics`;
  ota.events(p, events);
  const c = await H.api("POST", `/calendarSync/properties/${listing._id}/connections`, { token, body: { channel, url: ota.url(p) } });
  assert.strictEqual(c.status, 201, JSON.stringify(c.body));
  return { host, listing, token, path: p, id: c.body.id };
}
async function guest() {
  const g = await H.makeUser();
  return H.userToken(g);
}
const book = (x, token, a, b) => H.api("POST", "/booking", { token, body: H.bookingBody(x.listing, { checkIn: S.day(a), checkOut: S.day(b) }) });
const order = (token, booking) => H.api("POST", "/payment/create-order", { token, body: { bookingId: booking._id, amount: booking.quote.totalPaise, currency: "INR" } });
let payN = 0;
function pay(token, ord) {
  const p = H.razorpay().__registerPayment({ id: `pay_race_${++payN}_${Date.now()}`, order_id: ord.id, amount: ord.amount, currency: "INR", status: "captured", method: "upi" });
  return { payment: p, verify: () => H.api("POST", "/payment/verify-payment", { token, body: { razorpay_order_id: ord.id, razorpay_payment_id: p.id, razorpay_signature: H.signature(ord.id, p.id) } }) };
}
function webhook(payment) {
  const body = JSON.stringify({ event: "payment.captured", payload: { payment: { entity: payment } } });
  const sig = crypto.createHmac("sha256", process.env.RAZORPAY_WEBHOOK_KEY).update(body).digest("hex");
  return fetch(`${H.baseUrl()}/paymentforpayout/payout/update`, { method: "POST", headers: { "content-type": "application/json", "x-razorpay-signature": sig }, body }).then((r) => r.status);
}
const reserved = (uid, a, b) => ({ uid, start: S.day(a), end: S.day(b), summary: "Reserved" });
const otaBooks = (x, uid, a, b) => ota.events(x.path, [reserved(uid, a, b)]);
const sync = (x, opts = {}) => engine.syncConnection(x.id, { force: true, ...opts });

test("1. two guests book the same nights at the same moment: exactly one hold, one payment", async () => {
  for (let i = 0; i < ROUNDS; i++) {
    const x = await setup();
    const [ta, tb] = [await guest(), await guest()];
    const [a, b] = await Promise.all([jitter().then(() => book(x, ta, 30, 32)), jitter().then(() => book(x, tb, 31, 33))]);
    const won = [a, b].filter((r) => r.status === 201);
    assert.strictEqual(won.length, 1, `round ${i}: ${a.status}/${b.status}`);
    const w = won[0] === a ? { r: a, t: ta } : { r: b, t: tb };
    const o = await order(w.t, w.r.body.data);
    assert.strictEqual(o.status, 200);
    assert.strictEqual((await pay(w.t, o.body.data).verify()).status, 200);
    note("1", `${a.status}/${b.status}`);
    await invariants(x.listing._id, `s1 r${i}`);
  }
});

test("2. a direct booking and an OTA booking of the same nights arrive together: never both committed", async () => {
  for (let i = 0; i < ROUNDS; i++) {
    const x = await setup();
    const t = await guest();
    otaBooks(x, `S2-${i}@airbnb.com`, 40, 42);
    const [b] = await Promise.all([jitter().then(() => book(x, t, 41, 43)), jitter().then(() => sync(x))]);
    let outcome = `booking ${b.status}`;
    if (b.status === 201) {
      const o = await order(t, b.body.data);
      outcome += ` / order ${o.status}`;
      if (o.status === 200) {
        const v = await pay(t, o.body.data).verify();
        outcome += ` / verify ${v.status}`;
      }
    }
    note("2", outcome);
    await invariants(x.listing._id, `s2 r${i}`);
    // the OTA booking is live and its nights unbookable for anyone else
    assert.strictEqual((await book(x, await guest(), 40, 41)).status, 409, `s2 r${i}: OTA night bookable`);
  }
});

test("3+5. an OTA booking lands on an unpaid hold, racing create-order: no money moves for those nights", async () => {
  for (let i = 0; i < ROUNDS; i++) {
    const x = await setup();
    const t = await guest();
    const b = await book(x, t, 50, 52);
    assert.strictEqual(b.status, 201);
    otaBooks(x, `S3-${i}@airbnb.com`, 51, 52);
    const before = H.razorpay().__mock.calls.ordersCreate;
    const [o] = await Promise.all([jitter().then(() => order(t, b.body.data)), jitter().then(() => sync(x))]);
    let outcome = `order ${o.status}`;
    if (o.status === 200) {
      // the order beat the import; the payment must then be flagged, never confirmed
      const v = await pay(t, o.body.data).verify();
      const after = await Booking.findById(b.body.data._id).lean();
      outcome += ` / verify ${v.status} → ${after.status}/${after.needsAttention || "-"}`;
      assert.ok(after.needsAttention === "inventory_conflict" || after.needsAttention === "ota_conflict", `s3 r${i}: paid booking over an OTA night not flagged: ${JSON.stringify([after.status, after.needsAttention])}`);
    } else assert.strictEqual(H.razorpay().__mock.calls.ordersCreate - before, 0, "refused before any gateway order");
    note("3+5", outcome);
    await invariants(x.listing._id, `s3 r${i}`);
  }
});

test("4. an OTA booking arrives for nights already PAID on Majestic: recorded conflict, admin + host told once, nothing reopened", async () => {
  for (let i = 0; i < Math.ceil(ROUNDS / 2); i++) {
    const x = await setup({ channel: "AGODA" });
    const t = await guest();
    const b = await book(x, t, 60, 62);
    const o = await order(t, b.body.data);
    assert.strictEqual((await pay(t, o.body.data).verify()).status, 200);
    H.resetEmails();
    ota.events(x.path, [{ uid: `S4-${i}@agoda.com`, start: S.day(60), end: S.day(62) }]);
    await Promise.all([sync(x), jitter().then(() => sync(x)), jitter().then(() => sync(x, { full: true }))]);
    await sync(x, { full: true });
    const paid = await Booking.findById(b.body.data._id).lean();
    const imp = await Booking.findOne({ propertyId: x.listing._id, source: "ical" }).lean();
    assert.strictEqual(paid.needsAttention, "ota_conflict");
    assert.ok(imp.external.conflict && imp.external.conflict.kind === "paid_booking");
    assert.strictEqual(await BookingNight.countDocuments({ bookingId: paid._id }), 2, "the paid stay keeps its nights");
    const hostMails = H.sentEmails().filter((e) => JSON.stringify(e).includes(x.host.email));
    assert.strictEqual(hostMails.length, 1, `host told exactly once (${hostMails.length})`);
    note("4", "flagged once");
    await invariants(x.listing._id, `s4 r${i}`);
  }
});

test("6+7+8. OTA booking during payment verification, plus duplicate callbacks and webhooks: applied once, never confirmed over an OTA night", async () => {
  for (let i = 0; i < ROUNDS; i++) {
    const x = await setup();
    const t = await guest();
    const b = await book(x, t, 70, 72);
    const o = await order(t, b.body.data);
    assert.strictEqual(o.status, 200);
    const p = pay(t, o.body.data);
    otaBooks(x, `S6-${i}@airbnb.com`, 71, 72);
    const results = await Promise.all([jitter().then(() => p.verify()), jitter().then(() => sync(x)), jitter().then(() => p.verify()), jitter().then(() => webhook(p.payment)), jitter().then(() => webhook(p.payment))]);
    await new Promise((r) => setTimeout(r, 300));
    const after = await Booking.findById(b.body.data._id).lean();
    const payments = await Payment.find({ bookingId: b.body.data._id }).lean();
    assert.strictEqual(payments.filter((x2) => x2.status === "paid").length, 1, `s6 r${i}: payment applied once`);
    assert.strictEqual(after.paymentStatus, "paid");
    const imp = await Booking.findOne({ propertyId: x.listing._id, source: "ical" }).lean();
    // whichever won, the booking is never left confirmed+unflagged over the OTA night
    if (imp && imp.status === "confirmed") assert.ok(after.needsAttention, `s6 r${i}: confirmed over a live OTA night: ${after.status}`);
    note("6+7+8", `${results[0].status}/${results[2].status} → ${after.status}/${after.needsAttention || "-"}`);
    await invariants(x.listing._id, `s6 r${i}`);
  }
});

test("9. an admin date move races an OTA booking of the target nights: never moved onto an OTA night silently", async () => {
  const admin = H.adminToken(await H.makeAdmin());
  const mdy = (o) => {
    const d = new Date(`${S.day(o)}T00:00:00Z`);
    return `${d.getUTCMonth() + 1}/${d.getUTCDate()}/${d.getUTCFullYear()}`;
  };
  for (let i = 0; i < Math.ceil(ROUNDS / 2); i++) {
    const x = await setup();
    const t = await guest();
    const b = await book(x, t, 80, 81);
    const o = await order(t, b.body.data);
    assert.strictEqual((await pay(t, o.body.data).verify()).status, 200);
    otaBooks(x, `S9-${i}@airbnb.com`, 85, 86);
    const move = () => H.api("POST", `/booking/admin-modify?bookingId=${b.body.data._id}&from=${encodeURIComponent(mdy(85))}&to=${encodeURIComponent(mdy(86))}&guest=2&adults=2`, { token: admin });
    // (a) the calendar was last read 10 min ago: the move must re-read it and refuse
    await ExternalCalendar.updateOne({ _id: x.id }, { $set: { "sync.lastSuccessAt": new Date(Date.now() - 10 * 60_000) } });
    const [m] = await Promise.all([jitter().then(move), jitter().then(() => sync(x))]);
    assert.strictEqual(m.status, 409, `s9 r${i}: moved onto an OTA night (${m.status})`);
    // (b) the calendar was read seconds ago and the OTA publishes at that very
    // moment: the move may land before Majestic can know — but never silently
    const y = await setup();
    const t2 = await guest();
    const b2 = await book(y, t2, 80, 81);
    assert.strictEqual((await pay(t2, (await order(t2, b2.body.data)).body.data).verify()).status, 200);
    otaBooks(y, `S9b-${i}@airbnb.com`, 85, 86);
    const move2 = () => H.api("POST", `/booking/admin-modify?bookingId=${b2.body.data._id}&from=${encodeURIComponent(mdy(85))}&to=${encodeURIComponent(mdy(86))}&guest=2&adults=2`, { token: admin });
    const [m2] = await Promise.all([jitter().then(move2), jitter().then(() => sync(y))]);
    await sync(y, { full: true });
    if (m2.status === 200) {
      const moved = await Booking.findById(b2.body.data._id).lean();
      const imp = await Booking.findOne({ propertyId: y.listing._id, source: "ical" }).lean();
      assert.strictEqual(moved.needsAttention, "ota_conflict", `s9b r${i}: moved onto an OTA night without an alert`);
      assert.ok((imp.external.conflict.withBookingIds || []).some((id) => String(id) === String(moved._id)));
    } else assert.strictEqual(m2.status, 409);
    note("9", `stale ${m.status} / fresh ${m2.status}`);
    await invariants(x.listing._id, `s9 r${i}`);
    await invariants(y.listing._id, `s9b r${i}`);
  }
});

test("5b. Pay re-reads a calendar last read 60 s ago: an OTA booking published since is caught before any money moves", async () => {
  for (let i = 0; i < Math.ceil(ROUNDS / 2); i++) {
    const x = await setup();
    const t = await guest();
    const b = await book(x, t, 140, 142);
    assert.strictEqual(b.status, 201);
    // Confirm read the calendar; the guest takes a minute on the payment page
    await ExternalCalendar.updateOne({ _id: x.id }, { $set: { "sync.lastSuccessAt": new Date(Date.now() - 60_000) } });
    otaBooks(x, `S5b-${i}@airbnb.com`, 141, 142); // the OTA sold a night meanwhile
    const before = H.razorpay().__mock.calls.ordersCreate;
    const o = await order(t, b.body.data);
    assert.strictEqual(o.status, 409, `s5b r${i}: ${JSON.stringify(o.body)}`);
    assert.strictEqual(H.razorpay().__mock.calls.ordersCreate - before, 0, "no gateway order");
    note("5b", `order ${o.status} ${o.body.code}`);
    await invariants(x.listing._id, `s5b r${i}`);
  }
});

test("10. the host unblocks a night an OTA booking shares while the OTA syncs: the night stays unavailable", async () => {
  for (let i = 0; i < ROUNDS; i++) {
    const x = await setup();
    const blk = await H.api("POST", "/booking", { token: x.token, body: { ...H.bookingBody(x.listing, { checkIn: S.day(90), checkOut: S.day(91) }), action: "host" } });
    assert.strictEqual(blk.status, 201);
    otaBooks(x, `S10-${i}@airbnb.com`, 90, 91);
    await sync(x);
    await Promise.all([jitter().then(() => H.api("POST", `/booking/unblock-dates/${x.listing._id}`, { token: x.token, body: { selectedDate: S.day(90) } })), jitter().then(() => sync(x))]);
    const r = await book(x, await guest(), 90, 91);
    assert.strictEqual(r.status, 409, `s10 r${i}: shared night became bookable`);
    note("10", "kept");
    await invariants(x.listing._id, `s10 r${i}`);
  }
});

test("11. the OTA cancels while a guest books those nights: the guest gets them only after the release", async () => {
  for (let i = 0; i < ROUNDS; i++) {
    const x = await setup({ events: [reserved(`S11-${i}@airbnb.com`, 100, 102)] });
    ota.events(x.path, [{ ...reserved(`S11-${i}@airbnb.com`, 100, 102), status: "CANCELLED" }]);
    const t = await guest();
    const [b] = await Promise.all([jitter().then(() => book(x, t, 100, 102)), jitter().then(() => sync(x))]);
    const imp = await Booking.findOne({ propertyId: x.listing._id, source: "ical" }).lean();
    note("11", `booking ${b.status} / import ${imp.status}`);
    if (b.status === 201) assert.strictEqual(imp.status, "cancelled", `s11 r${i}: booked while the OTA booking was live`);
    await invariants(x.listing._id, `s11 r${i}`);
  }
});

test("12+15. two workers / duplicated sweeps: every calendar fetched once per pass, no duplicate rows", async () => {
  for (let i = 0; i < Math.ceil(ROUNDS / 2); i++) {
    const xs = [];
    for (let k = 0; k < 4; k++) xs.push(await setup({ events: [reserved(`S12-${i}-${k}@airbnb.com`, 110, 111)] }));
    for (const x of xs) await ExternalCalendar.updateOne({ _id: x.id }, { $set: { "sync.nextSyncAt": new Date(Date.now() - 60_000), "sync.leaseUntil": null } });
    ota.resetHits();
    await Promise.all([engine.runDue({ budgetMs: 20_000, source: "test" }), engine.runDue({ budgetMs: 20_000, source: "test" }), engine.runDue({ budgetMs: 20_000, source: "test" }), sync(xs[0]), sync(xs[0])]);
    for (const x of xs) {
      assert.ok(ota.count(x.path) <= 2, `s12 r${i}: fetched ${ota.count(x.path)} times`);
      assert.strictEqual(await Booking.countDocuments({ propertyId: x.listing._id, source: "ical" }), 1, "no duplicate rows");
      await invariants(x.listing._id, `s12 r${i}`);
    }
    note("12+15", `fetches ${xs.map((x) => ota.count(x.path)).join(",")}`);
  }
});

test("13. a worker that lost its lease mid-fetch can never apply its older response", async () => {
  for (let i = 0; i < Math.ceil(ROUNDS / 2); i++) {
    const x = await setup({ events: [reserved(`S13-${i}@airbnb.com`, 120, 122)] });
    let release;
    const gate = new Promise((r) => {
      release = r;
    });
    // A fetches the OLD feed (booking present) and stalls…
    ota.set(x.path, { body: S.vcal([reserved(`S13-${i}@airbnb.com`, 120, 122)]), gate });
    const stale = sync(x);
    await new Promise((r) => setTimeout(r, 50));
    // …its lease expires, B reads the NEW feed (explicitly cancelled) and applies it
    await ExternalCalendar.updateOne({ _id: x.id }, { $set: { "sync.leaseUntil": new Date(Date.now() - 1000) } });
    ota.events(x.path, [{ ...reserved(`S13-${i}@airbnb.com`, 120, 122), status: "CANCELLED" }]);
    const fresh = await sync(x);
    assert.ok(fresh.ok, JSON.stringify(fresh));
    release();
    const late = await stale;
    assert.strictEqual(late.code, "LEASE_LOST", `s13 r${i}: ${JSON.stringify(late)}`);
    const imp = await Booking.findOne({ propertyId: x.listing._id, source: "ical" }).lean();
    assert.strictEqual(imp.status, "cancelled", "the newer state stands");
    note("13", "LEASE_LOST");
    await invariants(x.listing._id, `s13 r${i}`);
  }
});

test("14. a crash halfway through reconcile (row written, nights not yet claimed): the nights are never bookable, and the next passes converge", async () => {
  for (let i = 0; i < Math.ceil(ROUNDS / 2); i++) {
    const x = await setup();
    otaBooks(x, `S14-${i}@airbnb.com`, 130, 132);
    const orig = ledger.claimNights;
    ledger.claimNights = async () => {
      throw new Error("simulated crash after the row write");
    };
    let r;
    try {
      r = await sync(x);
    } finally {
      ledger.claimNights = orig;
    }
    assert.notStrictEqual(r.ok, true);
    const imp = await Booking.findOne({ propertyId: x.listing._id, source: "ical" }).lean();
    assert.ok(imp && imp.status === "confirmed", "the row exists");
    assert.strictEqual(await BookingNight.countDocuments({ bookingId: imp._id }), 0, "crash left no night rows");
    assert.strictEqual((await book(x, await guest(), 130, 131)).status, 409, `s14 r${i}: bookable after the crash`);
    await sync(x);
    assert.strictEqual((await book(x, await guest(), 131, 132)).status, 409);
    await sync(x, { full: true });
    assert.strictEqual(await BookingNight.countDocuments({ bookingId: imp._id }), 2, "the full pass re-asserts the nights");
    note("14", "converged");
    await invariants(x.listing._id, `s14 r${i}`);
  }
  record("race-tally", { rounds: ROUNDS, tally });
});

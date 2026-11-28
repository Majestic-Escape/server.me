// A9: a night released while a live imported booking still covers it is handed
// to that import, so dated search, /booking/check-dates and checkout agree.
// Real lifecycle through the API and the sync engine: host blocks → an OTA
// booking overlaps (fake iCal feed) → host unblocks / import cancelled.
const { test, before, after } = require("node:test");
const assert = require("node:assert");
const S = require("./syncguard-helpers");
const H = require("./setup");

const ota = new S.FakeOta();
let Booking;
let BookingNight;
let engine;
let mongoose;

before(async () => {
  await H.start();
  await ota.start();
  mongoose = require("mongoose");
  Booking = require("../../models/Booking");
  BookingNight = require("../../models/BookingNight");
  engine = require("../../services/calendarSync/engine");
});
after(async () => {
  await ota.stop();
  await H.stop();
});

let seq = 0;
async function setup() {
  const host = await H.makeUser();
  const listing = await H.makeListing(host);
  return { host, listing, hostToken: H.userToken(host) };
}
async function connect(x, events) {
  const p = `/a9-${++seq}.ics`;
  ota.events(p, events);
  const conn = await H.api("POST", `/calendarSync/properties/${x.listing._id}/connections`, { token: x.hostToken, body: { channel: seq % 2 ? "AIRBNB" : "BOOKING", url: ota.url(p) } });
  assert.strictEqual(conn.status, 201, JSON.stringify(conn.body));
  await engine.syncConnection(conn.body.id, { force: true });
  return { id: conn.body.id, path: p };
}
const ev = (uid, from, to) => ({ uid: `${uid}@ota.test`, start: S.day(from), end: S.day(to), summary: "Reserved" });
async function block(x, from, to) {
  const r = await H.api("POST", "/booking", { token: x.hostToken, body: { ...H.bookingBody(x.listing, { checkIn: S.day(from), checkOut: S.day(to) }), action: "host" } });
  assert.strictEqual(r.status, 201, JSON.stringify(r.body));
  return r.body.data;
}
const unblock = (x, d) => H.api("POST", `/booking/unblock-dates/${x.listing._id}`, { token: x.hostToken, body: { selectedDate: S.day(d) } });
const disconnectAndRelease = (x, connId) => H.api("POST", `/calendarSync/connections/${connId}/disconnect`, { token: x.hostToken, body: { acknowledge: true, releaseBlocks: true } });
async function imports(x) {
  return Booking.find({ propertyId: x.listing._id, source: "ical" }).sort({ _id: 1 }).lean();
}
async function owner(x, d) {
  const rows = await BookingNight.find({ propertyId: x.listing._id, date: new Date(`${S.day(d)}T00:00:00Z`) }).lean();
  assert.ok(rows.length <= 1, "one ledger owner per night");
  return rows[0] ? String(rows[0].bookingId) : null;
}
// The three sources a customer meets, asked about the one night d → d+1.
// Checkout is asked last: a success leaves a hold on the night.
async function sources(x, d) {
  const s = await H.api("GET", `/properties/search-properties?from=${S.day(d)}&to=${S.day(d + 1)}&limit=50`);
  assert.strictEqual(s.status, 200, JSON.stringify(s.body).slice(0, 200));
  const offered = (s.body.data || []).some((l) => String(l._id) === String(x.listing._id));
  const cd = await H.api("GET", `/booking/check-dates/${x.listing._id}`);
  assert.strictEqual(cd.status, 200);
  const taken = cd.body.data.includes(S.day(d));
  const guest = await H.makeUser();
  const co = await H.api("POST", "/booking", { token: H.userToken(guest), body: H.bookingBody(x.listing, { checkIn: S.day(d), checkOut: S.day(d + 1) }) });
  return { offered, taken, checkout: co.status };
}
function agreeTaken(src, label) {
  assert.deepStrictEqual(src, { offered: false, taken: true, checkout: 409 }, `${label}: search, check-dates and checkout all say taken`);
}
function agreeFree(src, label) {
  assert.deepStrictEqual(src, { offered: true, taken: false, checkout: 201 }, `${label}: search, check-dates and checkout all say free`);
}

test("A9 lifecycle: host blocks N → OTA booking covers N → host unblocks N: the import takes the night over; all three sources say taken", async () => {
  const x = await setup();
  const blk = await block(x, 200, 201);
  await connect(x, [ev("A9", 199, 202)]);
  const [imp] = await imports(x);
  assert.strictEqual(imp.status, "confirmed");
  assert.strictEqual(await owner(x, 200), String(blk._id), "before: the block owns N (the import shares it)");
  const un = await unblock(x, 200);
  assert.strictEqual(un.status, 200, JSON.stringify(un.body));
  assert.strictEqual(await owner(x, 200), String(imp._id), "after: the import owns N, handed over in place");
  // the two A9 assertions: search does not offer the night; search agrees with check-dates (and checkout)
  agreeTaken(await sources(x, 200), "A9");
});

test("repeated unblock: the second one finds no block (404) and changes nothing", async () => {
  const x = await setup();
  await block(x, 210, 211);
  await connect(x, [ev("REP", 209, 212)]);
  const [imp] = await imports(x);
  assert.strictEqual((await unblock(x, 210)).status, 200);
  const again = await unblock(x, 210);
  assert.strictEqual(again.status, 404, JSON.stringify(again.body));
  assert.strictEqual(await owner(x, 210), String(imp._id));
  agreeTaken(await sources(x, 210), "repeated unblock");
});

test("no overlap: unblocking a night no import covers frees it, and all three sources say free", async () => {
  const x = await setup();
  await block(x, 220, 221);
  await connect(x, [ev("FAR", 223, 225)]);
  assert.strictEqual((await unblock(x, 220)).status, 200);
  assert.strictEqual(await owner(x, 220), null);
  agreeFree(await sources(x, 220), "no overlap");
});

test("multiple surviving imports: the night passes from import to import and is freed only when the last one goes", async () => {
  const x = await setup();
  await block(x, 230, 231);
  const c1 = await connect(x, [ev("M1", 229, 232)]);
  const c2 = await connect(x, [ev("M2", 230, 233)]);
  const [i1, i2] = await imports(x);
  assert.strictEqual((await unblock(x, 230)).status, 200);
  const first = await owner(x, 230);
  assert.ok([String(i1._id), String(i2._id)].includes(first), "an import owns N");
  // cancel the import that owns N (host confirms it was cancelled on the other site)
  const ownerConn = first === String(i1._id) ? c1 : c2;
  const otherImp = first === String(i1._id) ? i2 : i1;
  const otherConn = ownerConn === c1 ? c2 : c1;
  const d1 = await disconnectAndRelease(x, ownerConn.id);
  assert.strictEqual(d1.status, 200, JSON.stringify(d1.body));
  assert.strictEqual(await owner(x, 230), String(otherImp._id), "the surviving import takes N over");
  agreeTaken(await sources(x, 230), "one import left");
  const d2 = await disconnectAndRelease(x, otherConn.id);
  assert.strictEqual(d2.status, 200, JSON.stringify(d2.body));
  // the checkout probe above left nothing (it was refused); N is now free
  assert.strictEqual(await owner(x, 230), null);
  agreeFree(await sources(x, 230), "no import left");
});

test("import cancellation while the block lives: the block keeps the night; after the unblock it is free", async () => {
  const x = await setup();
  const blk = await block(x, 240, 241);
  const c = await connect(x, [ev("CAN", 239, 242)]);
  const d = await disconnectAndRelease(x, c.id);
  assert.strictEqual(d.status, 200, JSON.stringify(d.body));
  assert.strictEqual(await owner(x, 240), String(blk._id), "the block still owns N");
  agreeTaken(await sources(x, 240), "block alone");
  assert.strictEqual((await unblock(x, 240)).status, 200);
  assert.strictEqual(await owner(x, 240), null);
  agreeFree(await sources(x, 240), "nothing left");
});

test("concurrent sync and unblock (8 rounds, jitter): one owner, the live import; all three sources say taken", async () => {
  for (let i = 0; i < 8; i++) {
    const x = await setup();
    await block(x, 250 + i * 3, 251 + i * 3);
    const c = await connect(x, [ev(`CS${i}`, 249 + i * 3, 252 + i * 3)]);
    const [imp] = await imports(x);
    const jitter = () => new Promise((r) => setTimeout(r, Math.floor(Math.random() * 25)));
    const [un] = await Promise.all([
      (async () => { await jitter(); return unblock(x, 250 + i * 3); })(),
      (async () => { await jitter(); return engine.syncConnection(c.id, { force: true, full: i % 2 === 0 }); })(),
    ]);
    assert.strictEqual(un.status, 200);
    assert.strictEqual(await owner(x, 250 + i * 3), String(imp._id), `round ${i}: the import owns N`);
    agreeTaken(await sources(x, 250 + i * 3), `round ${i}`);
  }
});

// Forces one write order: `during` runs once, at the handoff of the block's night,
//   "before": the heirs were read, the row has not changed owner yet
//   "after":  the row has changed owner, the heir has not been re-checked yet
function hookHandoff(blockId, when, during) {
  const orig = BookingNight.updateOne;
  let fired = false;
  BookingNight.updateOne = async function patched(filter, update, ...rest) {
    const isHandoff = !fired && filter && String(filter.bookingId) === String(blockId) && update && update.$set && update.$set.bookingId;
    if (isHandoff) fired = true;
    if (isHandoff && when === "before") await during();
    const res = await orig.call(this, filter, update, ...rest);
    if (isHandoff && when === "after") await during();
    return res;
  };
  return () => {
    BookingNight.updateOne = orig;
    return fired;
  };
}

for (const [change, when, d] of [["shortened", "before", 360], ["shortened", "after", 370], ["moved", "before", 380], ["moved", "after", 390]]) {
  test(`the import is ${change} (still active) ${when} the handoff write: search, check-dates and checkout agree`, async () => {
    const x = await setup();
    const blk = await block(x, d, d + 1);
    const uid = `CHG-${change}-${when}`;
    const c = await connect(x, [ev(uid, d - 1, d + 2)]);
    const [imp] = await imports(x);
    const next = change === "shortened" ? ev(uid, d - 1, d) : ev(uid, d + 5, d + 8);
    const restore = hookHandoff(blk._id, when, async () => {
      ota.events(c.path, [next]);
      await engine.syncConnection(c.id, { force: true });
    });
    let fired;
    try {
      const un = await unblock(x, d);
      assert.strictEqual(un.status, 200, JSON.stringify(un.body));
    } finally {
      fired = restore();
    }
    assert.ok(fired, "the forced interleaving happened");
    const now = await Booking.findById(imp._id).lean();
    assert.strictEqual(now.status, "confirmed", "the import is still active");
    assert.strictEqual(now.checkIn.toISOString().slice(0, 10), next.start, "with its new dates");
    assert.strictEqual(await owner(x, d), null, "N is not left with an import that no longer covers it");
    agreeFree(await sources(x, d), `${change} ${when}`);
    // the import still blocks the nights it does cover
    agreeTaken(await sources(x, change === "shortened" ? d - 1 : d + 5), `${change} ${when}: the import's own night`);
  });
}

// Forces: the release found no import for N, then a NEW import claims N (it can only
// share it: the block's row still exists), then the release deletes the block's row.
test("a new import claims the shared night after the release found no import and before it deletes the row: all three sources say taken", async () => {
  const x = await setup();
  const d = 460;
  const blk = await block(x, d, d + 1);
  const orig = BookingNight.deleteOne;
  let fired = false;
  BookingNight.deleteOne = async function patched(filter, ...rest) {
    if (!fired && filter && String(filter.bookingId) === String(blk._id)) {
      fired = true;
      await connect(x, [ev("NEW-LATE", d - 1, d + 2)]); // the new import arrives and claims (shares) N
    }
    return orig.call(this, filter, ...rest);
  };
  try {
    const un = await unblock(x, d);
    assert.strictEqual(un.status, 200, JSON.stringify(un.body));
  } finally {
    BookingNight.deleteOne = orig;
  }
  assert.ok(fired, "the forced interleaving happened");
  const [imp] = await imports(x);
  assert.ok(imp && imp.status === "confirmed", "the new import is live");
  assert.strictEqual(await owner(x, d), String(imp._id), "N ends with the new import, never rowless");
  agreeTaken(await sources(x, d), "late import");
});

// DURING the write, not only after it: what a customer's dated search and check-dates
// say while the release is between two writes (no checkout probe: it would write a hold).
async function searchAndCheckDates(x, d) {
  const s = await H.api("GET", `/properties/search-properties?from=${S.day(d)}&to=${S.day(d + 1)}&limit=50`);
  const cd = await H.api("GET", `/booking/check-dates/${x.listing._id}`);
  return { offered: (s.body.data || []).some((l) => String(l._id) === String(x.listing._id)), taken: cd.body.data.includes(S.day(d)), owner: await owner(x, d) };
}

test("during the handoff write: just before and just after the owner changes, search never offers the night", async () => {
  const x = await setup();
  const d = 470;
  const blk = await block(x, d, d + 1);
  await connect(x, [ev("MID-HANDOFF", d - 1, d + 2)]);
  const [imp] = await imports(x);
  const seen = [];
  const orig = BookingNight.updateOne;
  BookingNight.updateOne = async function patched(filter, update, ...rest) {
    const isHandoff = filter && String(filter.bookingId) === String(blk._id) && update && update.$set && update.$set.bookingId;
    if (isHandoff) seen.push({ at: "before the owner change", ...(await searchAndCheckDates(x, d)) });
    const res = await orig.call(this, filter, update, ...rest);
    if (isHandoff) seen.push({ at: "after the owner change", ...(await searchAndCheckDates(x, d)) });
    return res;
  };
  try { assert.strictEqual((await unblock(x, d)).status, 200); } finally { BookingNight.updateOne = orig; }
  console.log(`[mid-write handoff] ${JSON.stringify(seen)}`);
  assert.strictEqual(seen.length, 2, "both pauses happened");
  for (const s of seen) assert.deepStrictEqual([s.offered, s.taken], [false, true], `${s.at}: search must not offer a night the import covers`);
  assert.deepStrictEqual(seen.map((s) => s.owner), [String(blk._id), String(imp._id)]);
});

test("during the late-import race: right after the release's delete, before any reclaim, search never offers the night", async () => {
  const x = await setup();
  const d = 480;
  const blk = await block(x, d, d + 1);
  const orig = BookingNight.deleteOne;
  let mid = null;
  BookingNight.deleteOne = async function patched(filter, ...rest) {
    const ours = !mid && filter && String(filter.bookingId) === String(blk._id);
    if (ours) await connect(x, [ev("MID-LATE", d - 1, d + 2)]); // the new import arrives after the heirs were read
    const res = await orig.call(this, filter, ...rest);
    if (ours) mid = { deleted: res.deletedCount, ...(await searchAndCheckDates(x, d)) };
    return res;
  };
  try { assert.strictEqual((await unblock(x, d)).status, 200); } finally { BookingNight.deleteOne = orig; }
  console.log(`[mid-write late import] right after the delete: ${JSON.stringify(mid)}`);
  assert.ok(mid, "the pause happened");
  assert.deepStrictEqual([mid.offered, mid.taken], [false, true], "between the delete and any reclaim, search must not offer a night the new import covers");
  const [imp] = await imports(x);
  assert.strictEqual(await owner(x, d), String(imp._id));
  agreeTaken(await sources(x, d), "late import, after");
});

// The one order in which the release still deletes while an import covers the night: the
// importer has written its Booking but not yet claimed its nights (it writes booking first,
// nights second). Paused right after the delete, before the release's re-check reclaims it.
test("pause between the release's delete and its reclaim: the import's Booking exists, its night claim has not run yet", async () => {
  const x = await setup();
  const d = 490;
  const blk = await block(x, d, d + 1);
  const ledger = require("../../services/calendarSync/ledger");
  const origClaim = ledger.claimNights;
  const held = [];
  const origDelete = BookingNight.deleteOne;
  let gap = null;
  BookingNight.deleteOne = async function patched(filter, ...rest) {
    const ours = !gap && filter && String(filter.bookingId) === String(blk._id);
    if (ours) {
      ledger.claimNights = async (args) => { held.push(args); return { displacedHolds: [], shared: [], paidConflicts: [] }; };
      try { await connect(x, [ev("GAP", d - 1, d + 2)]); } finally { ledger.claimNights = origClaim; }
    }
    const res = await origDelete.call(this, filter, ...rest);
    if (ours) {
      gap = { deleted: res.deletedCount, ...(await searchAndCheckDates(x, d)) };
      const guest = await H.makeUser();
      const co = await H.api("POST", "/booking", { token: H.userToken(guest), body: H.bookingBody(x.listing, { checkIn: S.day(d), checkOut: S.day(d + 1) }) });
      gap.checkout = co.status;
      gap.ownerAfterCheckout = await owner(x, d);
    }
    return res;
  };
  try { assert.strictEqual((await unblock(x, d)).status, 200); } finally { BookingNight.deleteOne = origDelete; }
  console.log(`[gap between delete and reclaim] ${JSON.stringify(gap)}`);
  assert.strictEqual(held.length, 1, "the importer's night claim was held back");
  const [imp] = await imports(x);
  // Characterises the window that remains: no row, so dated search offers the night;
  // check-dates and checkout read the import's Booking and refuse it (no double sale).
  assert.deepStrictEqual(
    [gap.deleted, gap.offered, gap.taken, gap.owner, gap.checkout, gap.ownerAfterCheckout],
    [1, true, true, null, 409, null],
  );
  // The release's re-check then gives the night to the import, before the importer's own claim runs.
  assert.strictEqual(await owner(x, d), String(imp._id), "the release's re-check reclaimed N for the import");
  for (const a of held) await origClaim(a); // the importer's claim, late: a no-op on N
  assert.strictEqual(await owner(x, d), String(imp._id));
  agreeTaken(await sources(x, d), "after the gap");
});

// Two backend processes on one database: instance A (this process) handles the
// unblocks, instance B (a child process) runs the syncs and the guest checkouts.
test("two backend instances sharing the database: handoff with a sync or a checkout running on the other instance", async () => {
  const { spawn } = require("node:child_process");
  const net = require("node:net");
  const port = await new Promise((r) => { const s = net.createServer().listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => r(p)); }); });
  const child = spawn(process.execPath, ["index.js"], { cwd: require("node:path").join(__dirname, "../.."), env: { ...process.env, PORT: String(port), LISTEN_HOST: "127.0.0.1" }, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (b) => (out += b));
  child.stderr.on("data", (b) => (out += b));
  try {
    const B = `http://127.0.0.1:${port}/api/v1`;
    for (let i = 0; i < 120 && !/Server running/.test(out); i++) await new Promise((r) => setTimeout(r, 500));
    assert.ok(/Server running/.test(out), "instance B started");
    // One database: B was started with A's DB_URI, and that is the database A is connected to.
    const dbName = new URL(process.env.DB_URI.replace(/^mongodb(\+srv)?:/, "http:")).pathname.slice(1);
    assert.strictEqual(mongoose.connection.name, dbName, "instance A is connected to the DB_URI given to B");
    // The ledger's unique (property, night) index exists there and is enforced.
    const idx = await BookingNight.collection.indexes();
    assert.ok(idx.some((i) => i.unique && JSON.stringify(i.key) === JSON.stringify({ propertyId: 1, date: 1 })), "unique propertyId_1_date_1 present");
    for (let i = 0; i < 60 && !/\[startup\] (booking\/payment integrity indexes present|CRITICAL)/.test(out); i++) await new Promise((r) => setTimeout(r, 500));
    assert.ok(/\[startup\] booking\/payment integrity indexes present/.test(out) && !/required unique indexes are missing/.test(out), `instance B's own startup check found the indexes:\n${out.slice(0, 600)}`);
    {
      const pid = new mongoose.Types.ObjectId();
      const date = new Date(`${S.day(450)}T00:00:00Z`);
      await BookingNight.create({ propertyId: pid, date, bookingId: new mongoose.Types.ObjectId(), kind: "block" });
      await assert.rejects(() => BookingNight.create({ propertyId: pid, date, bookingId: new mongoose.Types.ObjectId(), kind: "block" }), (e) => e.code === 11000, "a second owner for one night is refused by the index");
      await BookingNight.deleteMany({ propertyId: pid });
    }
    console.log(`[two-instances] one database "${dbName}"; unique (propertyId, date) present and enforced; instance B startup: integrity indexes present`);
    const apiB = async (method, path, { token, body } = {}) => {
      const res = await fetch(B + path, { method, headers: { "Content-Type": "application/json", Origin: "http://localhost:3000", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
      return { status: res.status, body: await res.json().catch(() => null) };
    };
    const jitter = () => new Promise((r) => setTimeout(r, Math.floor(Math.random() * 30)));
    for (let i = 0; i < 6; i++) {
      const d = 400 + i * 10;
      const x = await setup();
      await block(x, d, d + 1);
      const uid = `TWO-${i}`;
      const c = await connect(x, [ev(uid, d - 1, d + 2)]);
      const [imp] = await imports(x);
      const kind = ["sync-same", "sync-shortened", "checkout"][i % 3];
      if (kind === "sync-shortened") ota.events(c.path, [ev(uid, d - 1, d)]);
      const guest = await H.makeUser();
      const [un, other] = await Promise.all([
        (async () => { await jitter(); return unblock(x, d); })(),
        (async () => {
          await jitter();
          return kind === "checkout"
            ? apiB("POST", "/booking", { token: H.userToken(guest), body: H.bookingBody(x.listing, { checkIn: S.day(d), checkOut: S.day(d + 1) }) })
            : apiB("POST", `/calendarSync/connections/${c.id}/sync`, { token: x.hostToken });
        })(),
      ]);
      assert.strictEqual(un.status, 200, `round ${i}: unblock on A`);
      if (kind === "checkout") assert.strictEqual(other.status, 409, `round ${i}: the checkout on B never gets the night`);
      else assert.ok(other.status < 500, `round ${i}: sync on B answered ${other.status} ${JSON.stringify(other.body)}`);
      const free = kind === "sync-shortened";
      const appliedByB = free ? (await Booking.findById(imp._id).lean()).checkOut.toISOString().slice(0, 10) === S.day(d) : null;
      console.log(`[two-instances] round ${i} ${kind}: unblock on A ${un.status}, ${kind === "checkout" ? "checkout" : "sync"} on B ${other.status}${free ? `, shortened by B's sync: ${appliedByB}` : ""}`);
      if (free) {
        // settle: if the sync on B was refused as too soon, apply the shortened feed here
        for (let k = 0; k < 5 && (await Booking.findById(imp._id).lean()).checkOut.toISOString().slice(0, 10) !== S.day(d); k++) {
          await new Promise((r) => setTimeout(r, 300));
          await engine.syncConnection(c.id, { force: true });
        }
        assert.strictEqual(await owner(x, d), null, `round ${i}: N freed once the import no longer covers it`);
      } else {
        assert.strictEqual(await owner(x, d), String(imp._id), `round ${i}: the import owns N`);
      }
      // instance B gives the same answers (asked before the checkout probe, which may leave a hold)
      const sB = await apiB("GET", `/properties/search-properties?from=${S.day(d)}&to=${S.day(d + 1)}&limit=50`);
      const cdB = await apiB("GET", `/booking/check-dates/${x.listing._id}`);
      assert.strictEqual((sB.body.data || []).some((l) => String(l._id) === String(x.listing._id)), free, `round ${i}: search on B`);
      assert.strictEqual(cdB.body.data.includes(S.day(d)), !free, `round ${i}: check-dates on B`);
      if (free) agreeFree(await sources(x, d), `round ${i} (${kind}) on A`);
      else agreeTaken(await sources(x, d), `round ${i} (${kind}) on A`);
    }
  } finally {
    child.kill();
  }
});

// A paid Majestic booking whose own Airbnb mirror (possible echo) shares its nights.
async function bookingWithItsEcho(d) {
  const x = await setup();
  const ExternalCalendar = require("../../models/ExternalCalendar");
  const guest = await H.makeUser();
  const gid = new mongoose.Types.ObjectId();
  const cin = new Date(`${S.day(d)}T00:00:00Z`);
  const cout = new Date(`${S.day(d + 2)}T00:00:00Z`);
  await Booking.create({ _id: gid, userId: guest._id, hostId: x.host._id, propertyId: x.listing._id, source: "local", action: "user", checkIn: cin, checkOut: cout, nights: 2, price: 100, subTotal: 100, currency: "INR", status: "confirmed", paymentStatus: "paid", guests: 2 });
  const inventory = require("../../services/inventory");
  await BookingNight.insertMany(inventory.nightsBetween(cin, cout).map((date) => ({ propertyId: x.listing._id, date, bookingId: gid, kind: "booking", expiresAt: null })));
  const c = await connect(x, []);
  await ExternalCalendar.updateOne({ _id: c.id }, { $set: { "export.lastServedAt": new Date() } });
  ota.events(c.path, [{ uid: `bbbbbbbbbbbb-${d}0123456789abcdef0123456789abcd@airbnb.com`, start: S.day(d), end: S.day(d + 2), summary: "Airbnb (Not available)" }]);
  await engine.syncConnection(c.id, { force: true });
  const [mirror] = await imports(x);
  assert.strictEqual(mirror.external.echo.suspect, true, "the import is recognised as this booking's mirror");
  return { x, gid, mirror, inventory, cin };
}

test("echo rule kept: a live booking's own mirror does not take its nights when it is moved", async () => {
  const { x, gid, inventory } = await bookingWithItsEcho(330);
  await inventory.releaseNights(gid);
  const d = (n) => new Date(`${S.day(n)}T00:00:00Z`);
  const moved = await inventory.reserveNights({ propertyId: x.listing._id, nights: [d(330), d(331), d(332)], bookingId: gid, kind: "booking" });
  assert.strictEqual(moved.ok, true, "admin move by +1 night still works");
});

test("echo after cancellation: the mirror takes the cancelled booking's nights; all three sources say taken", async () => {
  const { x, gid, mirror, inventory } = await bookingWithItsEcho(340);
  await Booking.updateOne({ _id: gid }, { $set: { status: "cancelled" } });
  await inventory.releaseNights(gid);
  assert.strictEqual(await owner(x, 340), String(mirror._id));
  agreeTaken(await sources(x, 340), "mirror of a cancelled booking");
});

test("concurrent checkout and unblock (8 rounds, jitter): the guest is always refused; the import owns the night", async () => {
  for (let i = 0; i < 8; i++) {
    const x = await setup();
    const d = 280 + i * 3;
    await block(x, d, d + 1);
    await connect(x, [ev(`CB${i}`, d - 1, d + 2)]);
    const [imp] = await imports(x);
    const guest = await H.makeUser();
    const jitter = () => new Promise((r) => setTimeout(r, Math.floor(Math.random() * 25)));
    const [un, co] = await Promise.all([
      (async () => { await jitter(); return unblock(x, d); })(),
      (async () => { await jitter(); return H.api("POST", "/booking", { token: H.userToken(guest), body: H.bookingBody(x.listing, { checkIn: S.day(d), checkOut: S.day(d + 1) }) }); })(),
    ]);
    assert.strictEqual(un.status, 200);
    assert.strictEqual(co.status, 409, `round ${i}: the guest must never get the night (${co.status})`);
    assert.strictEqual(await owner(x, d), String(imp._id), `round ${i}: the import owns N`);
  }
});

// ---- Independent review (2026-11-27): one test per finding --------------------------------
const NIGHT = (d) => new Date(`${S.day(d)}T00:00:00Z`);
const mdy = (o) => { const t = NIGHT(o); return `${t.getUTCMonth() + 1}/${t.getUTCDate()}/${t.getUTCFullYear()}`; };
async function paidStay(x, from, to) {
  const id = new mongoose.Types.ObjectId();
  const guest = await H.makeUser();
  await Booking.collection.insertOne({ _id: id, userId: guest._id, hostId: x.host._id, propertyId: x.listing._id, source: "local", action: "user", checkIn: NIGHT(from), checkOut: NIGHT(to), nights: to - from, status: "confirmed", paymentStatus: "paid", price: 100, subTotal: 100, guests: 2, adults: 2, createdAt: new Date(), updatedAt: new Date() });
  for (let d = from; d < to; d++) await BookingNight.create({ propertyId: x.listing._id, date: NIGHT(d), bookingId: id, kind: "booking", expiresAt: null });
  return id;
}
async function rawImport(x, from, to, status = "confirmed") {
  const id = new mongoose.Types.ObjectId();
  await Booking.collection.insertOne({ _id: id, propertyId: x.listing._id, hostId: x.host._id, source: "ical", action: "user", status, paymentStatus: "paid", external: { state: status === "cancelled" ? "released" : "active" }, checkIn: NIGHT(from), checkOut: NIGHT(to), createdAt: new Date(), updatedAt: new Date() });
  return id;
}
const adminMove = async (id, from, to) => H.api("POST", `/booking/admin-modify?bookingId=${id}&from=${encodeURIComponent(mdy(from))}&to=${encodeURIComponent(mdy(to))}&guest=2&adults=2`, { token: H.adminToken(await H.makeAdmin()) });

test("review 1: a FAILED admin move gives back the shared night its release handed to an import; a successful one hands it over", async () => {
  const x = await setup();
  const d = 610;
  const B = await paidStay(x, d, d + 2);
  await connect(x, [ev("REV1", d + 1, d + 2)]); // a real OTA booking shares d+1 with the paid stay (a paid conflict)
  const [imp] = await imports(x);
  assert.strictEqual(await owner(x, d + 1), String(B), "the paid stay owns d+1; the import shares it");
  await block(x, d + 5, d + 6); // the move target is taken
  const failed = await adminMove(B, d + 5, d + 6);
  assert.strictEqual(failed.status, 409, JSON.stringify(failed.body).slice(0, 200));
  assert.deepStrictEqual([await owner(x, d), await owner(x, d + 1)], [String(B), String(B)], "the move did not happen: the paid stay keeps both nights");
  const ok = await adminMove(B, d + 8, d + 9);
  assert.strictEqual(ok.status, 200, JSON.stringify(ok.body).slice(0, 200));
  assert.deepStrictEqual([await owner(x, d), await owner(x, d + 1), await owner(x, d + 8)], [null, String(imp._id), String(B)], "the move happened: d freed, d+1 handed to the import, d+8 taken");
});

test("review 2: a live hold that gives up its night to an import (secureHold) hands it over, never leaves it rowless", async () => {
  const x = await setup();
  const d = 620;
  const hold = new mongoose.Types.ObjectId();
  await Booking.collection.insertOne({ _id: hold, userId: (await H.makeUser())._id, hostId: x.host._id, propertyId: x.listing._id, source: "local", action: "user", checkIn: NIGHT(d), checkOut: NIGHT(d + 1), status: "pending", paymentStatus: "unpaid", price: 100, subTotal: 100, createdAt: new Date(), updatedAt: new Date() });
  await BookingNight.create({ propertyId: x.listing._id, date: NIGHT(d), bookingId: hold, kind: "booking", expiresAt: new Date(Date.now() + 10 * 60_000) });
  const imp = await rawImport(x, d, d + 1); // lost the displacement race: covers d, owns no row
  const r = await require("../../services/inventory").secureHold({ propertyId: x.listing._id, bookingId: hold, nights: [NIGHT(d)] });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(await owner(x, d), String(imp), "the night goes to the import, not to nobody");
  const v = await searchAndCheckDates(x, d);
  assert.deepStrictEqual([v.offered, v.taken], [false, true]);
});

test("review 3a: an import never takes over the night of a block being created (its rows exist, its document not yet)", async () => {
  const x = await setup();
  const d = 630;
  const inFlight = new mongoose.Types.ObjectId();
  await BookingNight.create({ propertyId: x.listing._id, date: NIGHT(d), bookingId: inFlight, kind: "block", expiresAt: null });
  const imp = await rawImport(x, d, d + 1);
  await require("../../services/calendarSync/ledger").claimNights({ propertyId: x.listing._id, bookingId: imp, nights: [NIGHT(d)] });
  assert.strictEqual(await owner(x, d), String(inFlight));
});

test("review 3b: an import never takes over a paid booking's new night while its admin move is being written; the conflict is reported", async () => {
  const x = await setup();
  const d = 640;
  const B = await paidStay(x, d, d + 1); // document still on the old night d
  await BookingNight.create({ propertyId: x.listing._id, date: NIGHT(d + 3), bookingId: B, kind: "booking", expiresAt: null }); // the move's new night, written first
  const imp = await rawImport(x, d + 3, d + 4);
  const res = await require("../../services/calendarSync/ledger").claimNights({ propertyId: x.listing._id, bookingId: imp, nights: [NIGHT(d + 3)] });
  assert.strictEqual(await owner(x, d + 3), String(B), "the paid booking keeps the night");
  assert.ok(res.paidConflicts.some((c) => c.bookingId === String(B)), "the double sale is reported as a paid conflict");
});

test("review 4: an import cancelled while its claim ran (disconnect holds no sync lease) does not keep the night", async () => {
  const x = await setup();
  const d = 650;
  const imp = await rawImport(x, d, d + 1, "cancelled");
  await require("../../services/calendarSync/ledger").claimNights({ propertyId: x.listing._id, bookingId: imp, nights: [NIGHT(d)] });
  assert.strictEqual(await owner(x, d), null);
  const v = await searchAndCheckDates(x, d);
  assert.deepStrictEqual([v.offered, v.taken], [true, false], "free everywhere");
});

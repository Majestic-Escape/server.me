// SyncGuard migration: preflight (read-only), apply (idempotent), index
// creation (refuses on conflicts), legacy feed URLs, rollback with the REAL
// pre-SyncGuard sync code (git show origin/dev:controllers/calendarsyncController.js).
const { test, before, after } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const S = require("./syncguard-helpers");
const H = require("./setup");

const ota = new S.FakeOta();
const record = S.evidence("migrate");
let base;
let M;
let ExternalCalendar;
let Booking;
let BookingNight;
let mongoose;
const OLD = path.join(__dirname, "..", "..", "controllers", ".old-calendarsync.test-tmp.js");

before(async () => {
  base = (await H.start()).baseUrl;
  await ota.start();
  mongoose = require("mongoose");
  M = require("../../scripts/syncguard-migrate");
  ExternalCalendar = require("../../models/ExternalCalendar");
  Booking = require("../../models/Booking");
  BookingNight = require("../../models/BookingNight");
  // The pre-SyncGuard controller, verbatim from origin/dev, for the rollback proof.
  fs.writeFileSync(OLD, execFileSync("git", ["show", "1e8448f:controllers/calendarsyncController.js"], { cwd: path.join(__dirname, "..", ".."), encoding: "utf8" }));
  // Start from a database as production has it BEFORE the migration: the
  // harness creates the SyncGuard indexes, so drop them here.
  for (const name of ["secret_1", "canonical_legacy_export", "one_active_url_per_listing", "kind_1_status_1_sync.nextSyncAt_1", "propertyId_1_kind_1"]) await ExternalCalendar.collection.dropIndex(name).catch(() => {});
  await Booking.collection.dropIndex("external_connection_key").catch(() => {});
});
after(async () => {
  try {
    fs.unlinkSync(OLD);
  } catch {
    /* already gone */
  }
  await ota.stop();
  await H.stop();
});

async function dbFingerprint() {
  const cols = ["externalcalendars", "bookings", "bookingnights"];
  const out = {};
  for (const c of cols) out[c] = JSON.stringify(await mongoose.connection.db.collection(c).find({}).sort({ _id: 1 }).toArray());
  return out;
}
const legacyRow = (o) => ({ price: 0, subTotal: 0, status: "confirmed", paymentStatus: "paid", action: "user", source: "ical", createdAt: new Date(), updatedAt: new Date(), ...o });

test("preflight is read-only, apply repairs the dirty shapes deterministically, a rerun changes nothing", async () => {
  const hostA = await H.makeUser();
  const wrongHost = await H.makeUser();
  const P1 = await H.makeListing(hostA);
  const P2 = await H.makeListing(hostA);
  const P3 = await H.makeListing(hostA);
  const ec = ExternalCalendar.collection;
  // P1: three legacy export rows (page-mount duplicates), two import rows with the same Airbnb URL
  for (const s of ["1".repeat(32), "2".repeat(32), "3".repeat(32)]) await ec.insertOne({ propertyId: P1._id, kind: "export", secret: s, __v: 0 });
  ota.events("/mig-p1.ics", [{ uid: "M1@airbnb.com", start: S.day(10), end: S.day(12) }]);
  await ec.insertOne({ propertyId: P1._id, kind: "import", url: ota.url("/mig-p1.ics"), lastFetched: new Date(), __v: 0 });
  await ec.insertOne({ propertyId: P1._id, kind: "import", url: ota.url("/mig-p1.ics"), __v: 0 });
  await Booking.collection.insertMany([
    legacyRow({ userId: wrongHost._id, hostId: wrongHost._id, propertyId: P1._id, sourceId: "M1@airbnb.com", checkIn: new Date(`${S.day(10)}T12:00:00Z`), checkOut: new Date(`${S.day(12)}T12:00:00Z`) }),
    legacyRow({ userId: hostA._id, hostId: hostA._id, propertyId: P1._id, sourceId: "M1@airbnb.com", checkIn: new Date(`${S.day(10)}T12:00:00Z`), checkOut: new Date(`${S.day(11)}T12:00:00Z`) }), // duplicate UID
    legacyRow({ userId: hostA._id, hostId: hostA._id, propertyId: P1._id, sourceId: "OLD@airbnb.com", status: "cancelled", checkIn: new Date(`${S.day(1)}T12:00:00Z`), checkOut: new Date(`${S.day(2)}T12:00:00Z`) }),
  ]);
  // P2: an http:// legacy URL (will be refused → BROKEN + host alert); P3: imported rows without any connection
  await ec.insertOne({ propertyId: P2._id, kind: "import", url: "http://legacy.example.com/cal.ics", __v: 0 });
  await Booking.collection.insertOne(legacyRow({ userId: hostA._id, hostId: hostA._id, propertyId: P3._id, sourceId: "U1@x", checkIn: new Date(`${S.day(20)}T00:00:00Z`), checkOut: new Date(`${S.day(21)}T00:00:00Z`) }));
  // an import whose listing was deleted
  await ec.insertOne({ propertyId: new mongoose.Types.ObjectId(), kind: "import", url: "https://www.airbnb.com/calendar/ical/9.ics", __v: 0 });

  const fp0 = await dbFingerprint();
  const pre = await M.preflight();
  assert.deepStrictEqual(await dbFingerprint(), fp0, "preflight wrote nothing");
  assert.strictEqual(pre.externalcalendars.duplicateImportGroups, 1);
  assert.strictEqual(pre.externalcalendars.importsOfDeletedListings, 1);
  assert.strictEqual(pre.externalcalendars.importsWithUrlsThatWillFail, 3, "http:// + the two P1 rows carrying the loopback test URL");
  assert.strictEqual(pre.bookings.wrongHostRows, 1);
  assert.strictEqual(pre.bookings.legacyDuplicateUidGroups, 1);
  assert.strictEqual(pre.bookings.unownedLegacyFutureBlocking, 1);
  assert.strictEqual(pre.legacyFeeds.propertiesWithDuplicates, 1);
  assert.ok(pre.plan.humanDecisionsNeeded.some((h) => /no calendar connection/.test(h)));

  const first = await M.apply({ log: () => {} });
  assert.strictEqual(first.duplicatesDisconnected, 1);
  assert.strictEqual(first.listingGone, 1);
  assert.strictEqual(first.canonicalSet, 1);
  assert.strictEqual(first.hostRepaired, 1);
  const p1conns = await ExternalCalendar.find({ propertyId: P1._id, kind: "import" }).sort({ _id: 1 }).lean();
  assert.deepStrictEqual(p1conns.map((c) => [c.status, c.channel === "GENERIC_ICAL" || c.channel === "AIRBNB", !!c.urlHash, !!c.secret]), [["active", true, true, true], ["disconnected", true, true, false]]);
  const rows = await Booking.find({ propertyId: P1._id }).sort({ _id: 1 }).lean();
  assert.ok(rows.every((b) => String(b.hostId) === String(hostA._id)), "D3 repaired");
  assert.deepStrictEqual(rows.map((b) => b.external.key), ["M1@airbnb.com", `M1@airbnb.com#legacy-${rows[1]._id}`, "OLD@airbnb.com"], "duplicate UID kept under its own key");
  assert.strictEqual((await Booking.findOne({ propertyId: P3._id }).lean()).external, undefined, "unowned rows untouched (human decision)");

  const fp1 = await dbFingerprint();
  const second = await M.apply({ log: () => {} });
  assert.deepStrictEqual(Object.values(second).filter((n) => n), [], "second apply is a no-op");
  assert.deepStrictEqual(await dbFingerprint(), fp1);
  const post = await M.preflight();
  assert.strictEqual(post.plan.willRepair, 0);
  record("apply", { preflight: pre, firstApply: first, secondApply: second, postflight: post.plan });
});

test("index creation refuses while conflicts remain, then succeeds; every legacy feed URL still serves", async () => {
  const P = await H.makeListing(await H.makeUser());
  // a deliberate conflict: two rows sharing one feed secret
  await ExternalCalendar.collection.insertMany([{ propertyId: P._id, kind: "export", secret: "dupdupdupdupdupdupdupdupdupdupdu" }, { propertyId: P._id, kind: "export", secret: "dupdupdupdupdupdupdupdupdupdupdu" }]);
  const refused = await M.createIndexes({ log: () => {} });
  assert.strictEqual(refused.created, false);
  assert.strictEqual(refused.conflicts.duplicateSecrets, 1);
  assert.ok(!(await ExternalCalendar.collection.indexes()).some((i) => i.name === "secret_1"), "nothing half-created");
  await ExternalCalendar.collection.deleteOne({ propertyId: P._id, kind: "export" }); // a human resolves it
  const ok = await M.createIndexes({ log: () => {} });
  assert.strictEqual(ok.created, true);
  const names = (await ExternalCalendar.collection.indexes()).map((i) => i.name);
  for (const n of ["secret_1", "canonical_legacy_export", "one_active_url_per_listing", "kind_1_status_1_sync.nextSyncAt_1"]) assert.ok(names.includes(n), n);
  assert.ok((await Booking.collection.indexes()).some((i) => i.name === "external_connection_key" && i.unique));
  const again = await M.createIndexes({ log: () => {} });
  assert.strictEqual(again.created, true, "idempotent");
  for (const s of ["1".repeat(32), "2".repeat(32), "3".repeat(32)]) assert.strictEqual((await fetch(`${base}/calendarSync/ics/${s}.ics`)).status, 200, `legacy URL ${s[0]} serves`);
});

test("apply is safe when the indexes already exist and new dirty legacy rows appeared (rollout overlap)", async () => {
  const P = await H.makeListing(await H.makeUser());
  // Indexes exist now (previous test); the old backend wrote two legacy rows for one URL.
  await ExternalCalendar.collection.insertMany([
    { propertyId: P._id, kind: "import", url: "https://www.airbnb.co.in/calendar/ical/77.ics?s=x", __v: 0 },
    { propertyId: P._id, kind: "import", url: "https://www.airbnb.co.in/calendar/ical/77.ics?s=x", __v: 0 },
  ]);
  const r = await M.apply({ log: () => {} });
  assert.ok(r.duplicatesDisconnected >= 1);
  const rows = await ExternalCalendar.find({ propertyId: P._id }).sort({ _id: 1 }).lean();
  assert.deepStrictEqual(rows.map((c) => c.status), ["active", "disconnected"]);
  const again = await M.createIndexes({ log: () => {} });
  assert.strictEqual(again.created, true);
});

test("rollback: the REAL pre-SyncGuard sync would reopen dates of a multi-calendar listing; --rollback-prepare prevents it; undo restores", async () => {
  process.env.SYNC_ALLOW_HTTP = "1";
  const old = require(OLD);
  const callOld = async (propertyId, url) => {
    const res = { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
    await old.saveCalendarUrl({ body: { propertyId: String(propertyId), url, kind: "import" } }, res);
    return res;
  };
  async function multiCalendarListing(tag) {
    const host = await H.makeUser();
    const listing = await H.makeListing(host);
    const token = H.userToken(host);
    ota.events(`/rb-${tag}-air.ics`, [{ uid: `RA-${tag}@airbnb.com`, start: S.day(40), end: S.day(41) }]);
    ota.events(`/rb-${tag}-vrbo.ics`, [{ uid: `RV-${tag}@vrbo`, start: S.day(44), end: S.day(45) }]);
    for (const [channel, p] of [["AIRBNB", `/rb-${tag}-air.ics`], ["VRBO", `/rb-${tag}-vrbo.ics`]]) {
      const r = await H.api("POST", `/calendarSync/properties/${listing._id}/connections`, { token, body: { channel, url: ota.url(p) } });
      assert.strictEqual(r.status, 201);
    }
    return { listing, airUrl: ota.url(`/rb-${tag}-air.ics`) };
  }
  // Without preparation: the old code sees one calendar per listing and cancels the others' bookings.
  const hazard = await multiCalendarListing("hazard");
  await callOld(hazard.listing._id, hazard.airUrl);
  const hazardRows = await Booking.find({ propertyId: hazard.listing._id, source: "ical" }).lean();
  const reopened = hazardRows.filter((b) => b.status === "cancelled").length;
  assert.ok(reopened >= 1, "the old code reopens dates on a multi-calendar listing (the hazard is real)");
  // With preparation the same call leaves every block intact.
  const safe = await multiCalendarListing("safe");
  const nightsById = async () => (await BookingNight.find({ propertyId: safe.listing._id }).sort({ date: 1 }).lean()).map((n) => `${n.date.toISOString().slice(0, 10)}=${n.bookingId}`);
  const before = await nightsById();
  const prep = await M.rollbackPrepare({ log: () => {} });
  assert.ok(prep.parkedConnections >= 1 && prep.parkedRows >= 1);
  await callOld(safe.listing._id, safe.airUrl);
  const safeRows = await Booking.find({ propertyId: safe.listing._id }).lean();
  assert.ok(safeRows.every((b) => b.status === "confirmed"), JSON.stringify(safeRows.map((b) => [b.source, b.status])));
  assert.deepStrictEqual(await nightsById(), before, "no night reopened — same owners, same nights");
  // availability readers ignore `source`: a parked row still blocks a direct booking
  const g = await H.makeUser();
  const tryIt = await H.api("POST", "/booking", { token: H.userToken(g), body: H.bookingBody(safe.listing, { checkIn: S.day(44), checkOut: S.day(45) }) });
  assert.strictEqual(tryIt.status, 409);
  const undo = await M.rollbackUndo({ log: () => {} });
  assert.ok(undo.rows >= 1);
  assert.strictEqual(await Booking.countDocuments({ source: "ical_parked" }), 0);
  assert.strictEqual(await ExternalCalendar.countDocuments({ kind: "import_parked" }), 0);
  record("rollback", { hazardReopened: reopened, prepare: prep, undo });
});

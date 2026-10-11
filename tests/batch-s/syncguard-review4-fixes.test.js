// SyncGuard: regressions for the FOURTH adversarial pass (re-review of the
// R1–R8 fixes; docs/syncguard.md §24). Each test reproduces the reviewer's
// verified experiment and asserts the fixed behaviour.
const { test, before, after } = require("node:test");
const assert = require("node:assert");
const S = require("./syncguard-helpers");
const H = require("./setup");

const ota = new S.FakeOta();
let Booking;
let ExternalCalendar;
let engine;
let mongoose;

before(async () => {
  await H.start();
  await ota.start();
  mongoose = require("mongoose");
  Booking = require("../../models/Booking");
  ExternalCalendar = require("../../models/ExternalCalendar");
  engine = require("../../services/calendarSync/engine");
});
after(async () => {
  await ota.stop();
  await H.stop();
});

let seq = 0;
const reserved = (uid, a, b) => ({ uid, start: S.day(a), end: S.day(b), summary: "Reserved" });
async function setup(channel, events) {
  const h = await H.makeUser();
  const listing = await H.makeListing(h);
  const token = H.userToken(h);
  const p = `/r4-${++seq}.ics`;
  ota.events(p, events);
  const c = await H.api("POST", `/calendarSync/properties/${listing._id}/connections`, { token, body: { channel, url: ota.url(p) } });
  assert.strictEqual(c.status, 201, JSON.stringify(c.body));
  return { host: h, listing, token, path: p, id: c.body.id };
}
const book = async (x, a, b) => H.api("POST", "/booking", { token: H.userToken(await H.makeUser()), body: H.bookingBody(x.listing, { checkIn: S.day(a), checkOut: S.day(b) }) });
const legacySave = (x, url) => H.api("POST", "/calendarSync/saveCalendar", { token: x.token, body: { propertyId: String(x.listing._id), kind: "import", url } });
const feed = async (secret) => (await fetch(`${H.baseUrl()}/calendarSync/ics/${secret}.ics`, { headers: { "user-agent": "Airbnb Calendar Fetcher/1.0" } })).status;
// the link has said "not found" for hours (what looksReset requires)
const markReset = (id, hours = 7) => ExternalCalendar.updateOne({ _id: id }, { $set: { "sync.consecutiveFailures": 3, "sync.lastErrorCode": "NOT_FOUND", "sync.lastSuccessAt": new Date(Date.now() - hours * 3600_000) } });
async function paidBooking(x, a, b) {
  const t = H.userToken(await H.makeUser());
  const r = await H.api("POST", "/booking", { token: t, body: H.bookingBody(x.listing, { checkIn: S.day(a), checkOut: S.day(b) }) });
  assert.strictEqual(r.status, 201, JSON.stringify(r.body));
  const o = await H.api("POST", "/payment/create-order", { token: t, body: { bookingId: r.body.data._id, amount: r.body.data.quote.totalPaise, currency: "INR" } });
  assert.strictEqual(o.status, 200, JSON.stringify(o.body));
  const pay = H.razorpay().__registerPayment({ id: `pay_r4_${Date.now()}_${++seq}`, order_id: o.body.data.id, amount: o.body.data.amount, currency: "INR", status: "captured", method: "upi" });
  await H.api("POST", "/payment/verify-payment", { token: t, body: { razorpay_order_id: o.body.data.id, razorpay_payment_id: pay.id, razorpay_signature: H.signature(o.body.data.id, pay.id) } });
  return r.body.data;
}

test("X1: 403s, even persistent ones, never make a link 'reset' — the legacy save adds the new link beside it and the old one's nights stay blocked", async (t) => {
  const channels = require("../../services/calendarSync/channels");
  t.mock.method(channels, "inferChannel", () => "AIRBNB");
  const x = await setup("AIRBNB", [reserved("X1@airbnb.com", 50, 53)]);
  ota.set(x.path, { status: 403, body: "" });
  for (let i = 0; i < 3; i++) await engine.syncConnection(x.id, { force: true });
  assert.strictEqual((await ExternalCalendar.findById(x.id).lean()).sync.lastErrorCode, "AUTH_REFUSED");
  // persistently refused (3 failures, nothing good for 7 h): still never a "reset"
  await ExternalCalendar.updateOne({ _id: x.id }, { $set: { "sync.lastSuccessAt": new Date(Date.now() - 7 * 3600_000) } });
  ota.events(x.path, [reserved("X1@airbnb.com", 50, 53)]); // the bot wall lifts
  // a link that even shows the same stay: only the 403 rule keeps it from replacing
  const other = `/r4-${++seq}.ics`;
  ota.events(other, [reserved("X1@airbnb.com", 50, 53)]);
  const save = await legacySave(x, ota.url(other));
  assert.doesNotMatch(String(save.body.message), /replaced/i);
  assert.strictEqual((await ExternalCalendar.findById(x.id).lean()).url, ota.url(x.path));
  await ExternalCalendar.updateMany({ propertyId: x.listing._id }, { $set: { "sync.lastSuccessAt": new Date() } });
  assert.strictEqual((await book(x, 50, 53)).status, 409);
});

test("X1b: a link 'not found' for hours is replaced only by a link of the SAME listing (it still shows one of its stays)", async (t) => {
  const channels = require("../../services/calendarSync/channels");
  t.mock.method(channels, "inferChannel", () => "AIRBNB");
  const x = await setup("AIRBNB", [reserved("X1B-A@airbnb.com", 50, 53), reserved("X1B-B@airbnb.com", 60, 61)]);
  ota.set(x.path, { status: 404, body: "" });
  await markReset(x.id);
  // another listing's link: added beside, nothing replaced
  const other = `/r4-${++seq}.ics`;
  ota.events(other, [reserved("OTHER-X1B@airbnb.com", 80, 81)]);
  const s1 = await legacySave(x, ota.url(other));
  assert.doesNotMatch(String(s1.body.message), /replaced/i);
  assert.strictEqual((await ExternalCalendar.findById(x.id).lean()).url, ota.url(x.path));
  // the same listing's fresh link (shows one of the stays): replaced
  const fresh = `/r4-${++seq}.ics`;
  ota.events(fresh, [reserved("X1B-B@airbnb.com", 60, 61)]);
  const s2 = await legacySave(x, ota.url(fresh));
  assert.match(s2.body.message, /replaced/i);
  assert.strictEqual((await ExternalCalendar.findById(x.id).lean()).url, ota.url(fresh));
  const a = await Booking.findOne({ "external.connectionId": new mongoose.Types.ObjectId(x.id), "external.uid": "X1B-A@airbnb.com" }).lean();
  assert.strictEqual(a.external.hostHold, true, "the stay the new link does not show waits for the host");
  const b = await Booking.findOne({ "external.connectionId": new mongoose.Types.ObjectId(x.id), "external.uid": "X1B-B@airbnb.com" }).lean();
  assert.notStrictEqual(b.external.hostHold, true);
});

test("X2: the replace path is rate limited and a failed replace changes nothing", async (t) => {
  const channels = require("../../services/calendarSync/channels");
  t.mock.method(channels, "inferChannel", () => "AIRBNB");
  const x = await setup("AIRBNB", [reserved("X2@airbnb.com", 50, 53)]);
  ota.set(x.path, { status: 404, body: "" });
  await markReset(x.id);
  const bad = `/r4-${++seq}.ics`;
  ota.set(bad, { status: 404, body: "" });
  const before = ota.count(bad);
  const codes = [];
  for (let i = 0; i < 24; i++) codes.push((await legacySave(x, ota.url(bad))).body.code);
  assert.ok(codes.includes("TOO_MANY_ATTEMPTS"), codes.join(","));
  assert.ok(ota.count(bad) - before <= 20, `${ota.count(bad) - before} fetches`);
  const row = await Booking.findOne({ "external.connectionId": new mongoose.Types.ObjectId(x.id) }).lean();
  assert.notStrictEqual(row.external.hostHold, true, "nothing held: the link was never replaced");
  assert.ok((row.external.rev || 0) < 5, `rev ${row.external.rev}`);
});

test("X3: one OTA sale over two paid bookings — each reaches the admin queue once; resolving one never re-opens it", async () => {
  const x = await setup("AGODA", []);
  const p1 = await paidBooking(x, 50, 51);
  const p2 = await paidBooking(x, 51, 52);
  await Booking.updateOne({ _id: p1._id }, { $set: { needsAttention: "amount_mismatch", "notifications.attentionAt": new Date() } });
  ota.events(x.path, [{ uid: "X3@agoda.com", start: S.day(50), end: S.day(52) }]);
  await engine.syncConnection(x.id, { force: true });
  assert.strictEqual((await Booking.findById(p2._id).lean()).needsAttention, "ota_conflict");
  const admin = H.adminToken(await H.makeAdmin());
  await H.api("PATCH", "/booking/admin/attention/resolve", { token: admin, body: { bookingId: String(p2._id), resolution: "keep" } });
  H.resetEmails();
  for (let d = 1; d <= 3; d++) {
    await engine.syncConnection(x.id, { force: true, full: true, now: new Date(Date.now() + d * 86_400_000) });
    assert.strictEqual((await Booking.findById(p2._id).lean()).needsAttention, null, `P2 not re-opened (pass ${d})`);
  }
  assert.strictEqual(H.sentEmails().length, 0);
  // P1's other item is closed: P1 now reaches the queue
  await H.api("PATCH", "/booking/admin/attention/resolve", { token: admin, body: { bookingId: String(p1._id), resolution: "dismiss" } });
  await engine.syncConnection(x.id, { force: true, full: true, now: new Date(Date.now() + 4 * 86_400_000) });
  assert.strictEqual((await Booking.findById(p1._id).lean()).needsAttention, "ota_conflict");
  const imp = await Booking.findOne({ propertyId: x.listing._id, source: "ical" }).lean();
  assert.ok(imp.external.conflict.adminFlaggedAt);
  assert.strictEqual(imp.external.conflict.adminFlaggedFor.length, 2);
});

test("X5: a 'Stop link' landing while the same calendar is being reconnected is never undone", async () => {
  const x = await setup("AIRBNB", [reserved("X5@airbnb.com", 20, 22)]);
  const s1 = (await ExternalCalendar.findById(x.id).lean()).secret;
  await H.api("POST", `/calendarSync/connections/${x.id}/disconnect`, { token: x.token, body: { acknowledge: true } });
  const orig = ExternalCalendar.updateOne;
  let injected = false;
  ExternalCalendar.updateOne = function patched(filter, update, ...rest) {
    if (!injected && filter && filter.status === "disconnected" && update && update.$set && update.$set.status === "active") {
      injected = true;
      return orig.call(this, { _id: filter._id, kind: "import", status: "disconnected", secret: { $type: "string" } }, { $unset: { secret: "" }, $set: { "export.stoppedAt": new Date() } }).then(() => orig.call(this, filter, update, ...rest));
    }
    return orig.call(this, filter, update, ...rest);
  };
  let re;
  try {
    re = await H.api("POST", `/calendarSync/properties/${x.listing._id}/connections`, { token: x.token, body: { channel: "AIRBNB", url: ota.url(x.path) } });
  } finally {
    ExternalCalendar.updateOne = orig;
  }
  assert.ok(injected);
  assert.strictEqual(re.body.reconnected, true, JSON.stringify(re.body));
  const c = await ExternalCalendar.findById(x.id).lean();
  assert.notStrictEqual(c.secret, s1, "the stopped link stays stopped");
  assert.strictEqual(await feed(s1), 404);
  // stopping twice is harmless
  await H.api("POST", `/calendarSync/connections/${x.id}/disconnect`, { token: x.token, body: { acknowledge: true } });
  assert.strictEqual((await H.api("POST", `/calendarSync/connections/${x.id}/stop-export`, { token: x.token })).status, 200);
  assert.strictEqual((await H.api("POST", `/calendarSync/connections/${x.id}/stop-export`, { token: x.token })).status, 200);
});

test("X4: --apply never marks a conflict still owed to the admin queue as flagged", async () => {
  const { apply } = require("../../scripts/syncguard-migrate");
  const x = await setup("AGODA", []);
  const b = await paidBooking(x, 70, 72);
  await Booking.updateOne({ _id: b._id }, { $set: { needsAttention: "amount_mismatch", "notifications.attentionAt": new Date() } });
  ota.events(x.path, [{ uid: "X4@agoda.com", start: S.day(70), end: S.day(72) }]);
  await engine.syncConnection(x.id, { force: true });
  const imp0 = await Booking.findOne({ propertyId: x.listing._id, source: "ical" }).lean();
  assert.ok(imp0.external.conflict.notifiedAt && !imp0.external.conflict.adminFlaggedAt, "host told, admin flag owed");
  await apply({ log: () => {} });
  assert.ok(!(await Booking.findById(imp0._id).lean()).external.conflict.adminFlaggedAt, "still owed after --apply");
  const admin = H.adminToken(await H.makeAdmin());
  await H.api("PATCH", "/booking/admin/attention/resolve", { token: admin, body: { bookingId: String(b._id), resolution: "dismiss" } });
  await engine.syncConnection(x.id, { force: true, now: new Date(Date.now() + 20 * 60_000) });
  assert.strictEqual((await Booking.findById(b._id).lean()).needsAttention, "ota_conflict");
});

test("X6: an owed admin flag is retried by the next ordinary poll — even when the OTA answers 304", async () => {
  const x = await setup("AGODA", []);
  const b = await paidBooking(x, 90, 92);
  await Booking.updateOne({ _id: b._id }, { $set: { needsAttention: "amount_mismatch", "notifications.attentionAt": new Date() } });
  const body = S.vcal([{ uid: "X6@agoda.com", start: S.day(90), end: S.day(92) }]);
  let conditional = 0;
  ota.set(x.path, {
    handler: (req, res) => {
      if (req.headers["if-none-match"] === '"x6"') {
        conditional += 1;
        res.writeHead(304);
        return res.end();
      }
      res.writeHead(200, { "content-type": "text/calendar", etag: '"x6"' });
      res.end(body);
    },
  });
  await engine.syncConnection(x.id, { force: true });
  assert.ok((await ExternalCalendar.findById(x.id).lean()).sync.pendingFlags >= 1);
  const admin = H.adminToken(await H.makeAdmin());
  await H.api("PATCH", "/booking/admin/attention/resolve", { token: admin, body: { bookingId: String(b._id), resolution: "dismiss" } });
  await engine.syncConnection(x.id, { force: true, now: new Date(Date.now() + 20 * 60_000) });
  assert.strictEqual(conditional, 0, "no conditional request while a flag is owed");
  assert.strictEqual((await Booking.findById(b._id).lean()).needsAttention, "ota_conflict");
  assert.strictEqual((await ExternalCalendar.findById(x.id).lean()).sync.pendingFlags, 0);
  await engine.syncConnection(x.id, { force: true, now: new Date(Date.now() + 40 * 60_000) });
  assert.strictEqual(conditional, 1, "conditional requests resume once nothing is owed");
});

test("F1: a dead link that never showed anything is never replaced by another link — bookings stay refused", async (t) => {
  const channels = require("../../services/calendarSync/channels");
  t.mock.method(channels, "inferChannel", () => "AIRBNB");
  const x = await setup("AIRBNB", []);
  ota.set(x.path, { status: 404, body: "" });
  await markReset(x.id);
  const other = `/r4-${++seq}.ics`;
  ota.events(other, [reserved("OTHER-F1@airbnb.com", 80, 81)]);
  const save = await legacySave(x, ota.url(other));
  assert.doesNotMatch(String(save.body.message), /replaced/i);
  assert.strictEqual((await ExternalCalendar.findById(x.id).lean()).url, ota.url(x.path), "the dead link stays");
  const r = await book(x, 30, 31);
  assert.deepStrictEqual([r.status, r.body.code], [409, "AVAILABILITY_UNVERIFIED"]);
});

test("F3: pendingFlags never stays stuck — a cancelled booking or a stay that is over owes nothing", async () => {
  const BookingNight = require("../../models/BookingNight");
  const x = await setup("AGODA", []);
  const p1 = await paidBooking(x, 50, 51);
  const p2 = await paidBooking(x, 51, 52);
  await Booking.updateOne({ _id: p2._id }, { $set: { needsAttention: "amount_mismatch", "notifications.attentionAt": new Date() } });
  ota.events(x.path, [{ uid: "F3@agoda.com", start: S.day(50), end: S.day(52) }]);
  await engine.syncConnection(x.id, { force: true });
  assert.strictEqual((await Booking.findById(p1._id).lean()).needsAttention, "ota_conflict");
  assert.ok((await ExternalCalendar.findById(x.id).lean()).sync.pendingFlags >= 1, "P2 owed");
  // P2 is cancelled and refunded: its nights are released, nothing is owed for it
  await Booking.updateOne({ _id: p2._id }, { $set: { status: "cancelled", needsAttention: null, "notifications.attentionAt": null } });
  await BookingNight.deleteMany({ bookingId: new mongoose.Types.ObjectId(p2._id) });
  await engine.syncConnection(x.id, { force: true, now: new Date(Date.now() + 20 * 60_000) });
  assert.strictEqual((await ExternalCalendar.findById(x.id).lean()).sync.pendingFlags, 0);
  // a stay that is over owes nothing either (it cannot be re-checked)
  const y = await setup("AGODA", []);
  const q = await paidBooking(y, 3, 4);
  await Booking.updateOne({ _id: q._id }, { $set: { needsAttention: "amount_mismatch", "notifications.attentionAt": new Date() } });
  ota.events(y.path, [{ uid: "F3b@agoda.com", start: S.day(3), end: S.day(4) }]);
  await engine.syncConnection(y.id, { force: true });
  assert.ok((await ExternalCalendar.findById(y.id).lean()).sync.pendingFlags >= 1);
  ota.events(y.path, []);
  await engine.syncConnection(y.id, { force: true, now: new Date(Date.now() + 10 * 86_400_000) });
  assert.strictEqual((await ExternalCalendar.findById(y.id).lean()).sync.pendingFlags, 0);
});

test("F4: a stay the old link already dropped is held, not released, when the link is replaced", async (t) => {
  const channels = require("../../services/calendarSync/channels");
  t.mock.method(channels, "inferChannel", () => "AIRBNB");
  const x = await setup("AIRBNB", [reserved("F4-A@airbnb.com", 50, 53), reserved("F4-B@airbnb.com", 60, 61)]);
  // A disappears from the old link (2 syncs over > 2 h: one more and it would be released)
  ota.events(x.path, [reserved("F4-B@airbnb.com", 60, 61)]);
  const t0 = Date.now();
  // (in the past: the replacement below runs at the real time)
  for (const h of [-5, -3]) await engine.syncConnection(x.id, { force: true, now: new Date(t0 + h * 3600_000) });
  const a0 = await Booking.findOne({ "external.connectionId": new mongoose.Types.ObjectId(x.id), "external.uid": "F4-A@airbnb.com" }).lean();
  assert.strictEqual(a0.external.state, "missing");
  ota.set(x.path, { status: 404, body: "" });
  await markReset(x.id);
  const fresh = `/r4-${++seq}.ics`;
  ota.events(fresh, [reserved("F4-B@airbnb.com", 60, 61)]);
  assert.match((await legacySave(x, ota.url(fresh))).body.message, /replaced/i);
  const a = await Booking.findById(a0._id).lean();
  assert.strictEqual(a.status, "confirmed", "not released by the new link's first sync");
  assert.strictEqual(a.external.hostHold, true);
});

test("G1: if holding the old link's stays fails, the link is not switched — a retry then replaces it with the hold in place", async (t) => {
  const channels = require("../../services/calendarSync/channels");
  t.mock.method(channels, "inferChannel", () => "AIRBNB");
  const x = await setup("AIRBNB", [reserved("G1-A@airbnb.com", 50, 53), reserved("G1-B@airbnb.com", 60, 61)]);
  ota.set(x.path, { status: 404, body: "" });
  await markReset(x.id);
  const fresh = `/r4-${++seq}.ics`;
  ota.events(fresh, [reserved("G1-B@airbnb.com", 60, 61)]);
  const orig = Booking.updateMany;
  let thrown = false;
  Booking.updateMany = function patched(filter, update, ...rest) {
    if (!thrown && update && update.$set && update.$set["external.hostHold"] === true) {
      thrown = true;
      return Promise.reject(new Error("transient database error"));
    }
    return orig.call(this, filter, update, ...rest);
  };
  let first;
  try {
    first = await legacySave(x, ota.url(fresh));
  } finally {
    Booking.updateMany = orig;
  }
  assert.ok(thrown);
  assert.notStrictEqual(first.body.success, true, JSON.stringify(first.body));
  assert.strictEqual((await ExternalCalendar.findById(x.id).lean()).url, ota.url(x.path), "not switched without the hold");
  const retry = await legacySave(x, ota.url(fresh));
  assert.match(retry.body.message, /replaced/i);
  const a = await Booking.findOne({ "external.connectionId": new mongoose.Types.ObjectId(x.id), "external.uid": "G1-A@airbnb.com" }).lean();
  assert.strictEqual(a.external.hostHold, true);
  assert.strictEqual(a.status, "confirmed");
});

test("G2: a possible echo of a stay that is over no longer counts as pending work (polls go back to conditional)", async () => {
  const x = await setup("AGODA", []);
  await paidBooking(x, 3, 5);
  await ExternalCalendar.updateOne({ _id: x.id }, { $set: { "export.lastServedAt": new Date() } }); // Agoda fetched the booking
  ota.events(x.path, [{ uid: "G2@agoda.com", start: S.day(3), end: S.day(5) }]); // and mirrors it back
  await engine.syncConnection(x.id, { force: true });
  const row = await Booking.findOne({ propertyId: x.listing._id, source: "ical" }).lean();
  assert.strictEqual(row.external.echo && row.external.echo.suspect, true, "a possible echo");
  assert.ok((await ExternalCalendar.findById(x.id).lean()).sync.pendingEchoes >= 1);
  ota.events(x.path, []); // the stay is over; Agoda drops it
  await engine.syncConnection(x.id, { force: true, now: new Date(Date.now() + 10 * 86_400_000) });
  assert.strictEqual((await ExternalCalendar.findById(x.id).lean()).sync.pendingEchoes, 0);
});

test("G3: a UID the dead link showed only long ago (released > 90 days) is no proof of the same listing", async (t) => {
  const channels = require("../../services/calendarSync/channels");
  t.mock.method(channels, "inferChannel", () => "AIRBNB");
  const x = await setup("AIRBNB", []);
  await Booking.collection.insertOne({
    propertyId: x.listing._id,
    hostId: x.host._id,
    userId: x.host._id,
    source: "ical",
    action: "host",
    status: "cancelled",
    checkIn: new Date(Date.now() - 400 * 86_400_000),
    checkOut: new Date(Date.now() - 398 * 86_400_000),
    external: { connectionId: new mongoose.Types.ObjectId(x.id), key: "OLD-G3@airbnb.com", uid: "OLD-G3@airbnb.com", state: "removed", releasedAt: new Date(Date.now() - 395 * 86_400_000), rev: 1 },
    createdAt: new Date(Date.now() - 410 * 86_400_000),
    updatedAt: new Date(Date.now() - 395 * 86_400_000),
  });
  ota.set(x.path, { status: 404, body: "" });
  await markReset(x.id);
  const other = `/r4-${++seq}.ics`;
  ota.events(other, [reserved("OLD-G3@airbnb.com", 80, 81)]);
  const save = await legacySave(x, ota.url(other));
  assert.doesNotMatch(String(save.body.message), /replaced/i);
  assert.strictEqual((await ExternalCalendar.findById(x.id).lean()).url, ota.url(x.path));
});

test("G1b: a failed switch undoes only the holds it set — holds from an earlier replacement stay", async (t) => {
  const channels = require("../../services/calendarSync/channels");
  t.mock.method(channels, "inferChannel", () => "AIRBNB");
  const x = await setup("AIRBNB", [reserved("G1B-A@airbnb.com", 50, 53), reserved("G1B-B@airbnb.com", 60, 61), reserved("G1B-C@airbnb.com", 70, 71)]);
  // A was held by an earlier replacement
  await Booking.updateOne({ "external.connectionId": new mongoose.Types.ObjectId(x.id), "external.uid": "G1B-A@airbnb.com" }, { $set: { "external.hostHold": true } });
  ota.set(x.path, { status: 404, body: "" });
  await markReset(x.id);
  const fresh = `/r4-${++seq}.ics`;
  ota.events(fresh, [reserved("G1B-B@airbnb.com", 60, 61)]);
  // the URL switch itself fails (another connection already uses the new link)
  const connections = require("../../services/calendarSync/connections");
  const orig = ExternalCalendar.updateOne;
  let failed = false;
  ExternalCalendar.updateOne = function patched(filter, update, ...rest) {
    if (!failed && update && update.$set && update.$set.urlHash) {
      failed = true;
      return Promise.reject(Object.assign(new Error("dup"), { code: 11000 }));
    }
    return orig.call(this, filter, update, ...rest);
  };
  try {
    await legacySave(x, ota.url(fresh));
  } finally {
    ExternalCalendar.updateOne = orig;
  }
  assert.ok(failed && connections);
  const rows = Object.fromEntries((await Booking.find({ "external.connectionId": new mongoose.Types.ObjectId(x.id) }).lean()).map((r) => [r.external.uid, r.external.hostHold === true]));
  assert.deepStrictEqual(rows, { "G1B-A@airbnb.com": true, "G1B-B@airbnb.com": false, "G1B-C@airbnb.com": false }, "only C's new hold was undone");
});

test("N1: a background refresh triggered by a feed request stamps what it imports with the time it actually ran", async () => {
  const exportFeed = require("../../services/calendarSync/exportFeed");
  const x = await setup("AIRBNB", []);
  const b = await (async () => {
    const p = `/r4-${++seq}.ics`;
    ota.events(p, []);
    const c = await H.api("POST", `/calendarSync/properties/${x.listing._id}/connections`, { token: x.token, body: { channel: "VRBO", url: ota.url(p) } });
    return { path: p, id: c.body.id };
  })();
  // the other calendar is due for a nudge, and gets a new booking
  await ExternalCalendar.updateOne({ _id: b.id }, { $set: { "sync.lastSuccessAt": new Date(Date.now() - 3600_000) } });
  ota.events(b.path, [{ uid: "N1@vrbo.com", start: S.day(40), end: S.day(42) }]);
  const secret = (await ExternalCalendar.findById(x.id).lean()).secret;
  const requestAt = new Date(Date.now() - 10 * 60_000); // a request whose handling was delayed
  await exportFeed.serve(secret, { now: requestAt, userAgent: "Airbnb Calendar Fetcher/1.0" });
  let row = null;
  for (let i = 0; i < 50 && !row; i++) {
    await new Promise((r) => setTimeout(r, 100));
    row = await Booking.findOne({ "external.connectionId": new mongoose.Types.ObjectId(b.id) }).lean();
  }
  assert.ok(row, "the nudge imported the new booking");
  assert.ok(new Date(row.external.firstSeenAt).getTime() > requestAt.getTime() + 5 * 60_000, `firstSeenAt ${row.external.firstSeenAt} is the request time`);
});

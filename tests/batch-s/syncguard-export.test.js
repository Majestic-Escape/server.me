// SyncGuard: Majestic → OTA feeds (docs/syncguard.md §4).
const { test, before, after } = require("node:test");
const assert = require("node:assert");
const S = require("./syncguard-helpers");
const H = require("./setup");

const ota = new S.FakeOta();
const record = S.evidence("export");
let Booking;
let ExternalCalendar;
let OpsFlag;
let base;

before(async () => {
  const started = await H.start();
  base = started.baseUrl;
  await ota.start();
  Booking = require("../../models/Booking");
  ExternalCalendar = require("../../models/ExternalCalendar");
  OpsFlag = require("../../models/OpsFlag");
  await Promise.all([ExternalCalendar.syncIndexes(), require("../../models/CalendarSyncLog").syncIndexes()]);
});
after(async () => {
  await ota.stop();
  await H.stop();
});

const feed = (secret, headers = {}) => fetch(`${base}/calendarSync/ics/${secret}.ics`, { headers });
const secretOf = (url) => url.match(/\/ics\/([^/]+)\.ics$/)[1];
const { parseIcs } = require("../../services/calendarSync/icsReader");
const evs = (text) => parseIcs(text).events.map((e) => `${e.startDay}..${e.endDay}`).sort();

let seq = 0;
async function property() {
  const host = await H.makeUser({ firstName: "Hostname", lastName: "Secretlast" });
  const listing = await H.makeListing(host);
  return { host, listing, token: H.userToken(host) };
}
async function connect(x, channel, events) {
  const p = `/exp${++seq}.ics`;
  ota.events(p, events);
  const r = await H.api("POST", `/calendarSync/properties/${x.listing._id}/connections`, { token: x.token, body: { channel, url: ota.url(p) } });
  assert.strictEqual(r.status, 201, JSON.stringify(r.body));
  const c = r.body.data.connections.find((k) => k.id === r.body.id);
  return { id: r.body.id, path: p, secret: secretOf(c.export.url) };
}
async function paidGuestBooking(listing, from, to) {
  const guest = await H.makeUser({ firstName: "Guestfirst", lastName: "Guestlast" });
  const t = H.userToken(guest);
  const r = await H.api("POST", "/booking", { token: t, body: H.bookingBody(listing, { checkIn: S.day(from), checkOut: S.day(to), guestData: { adults: [{ name: "Priya Secretname", age: 30 }], children: [] } }) });
  assert.strictEqual(r.status, 201, JSON.stringify(r.body));
  const o = await H.api("POST", "/payment/create-order", { token: t, body: { bookingId: r.body.data._id, amount: r.body.data.quote.totalPaise, currency: "INR" } });
  const pay = H.razorpay().__registerPayment({ id: `pay_exp_${++seq}`, order_id: o.body.data.id, amount: o.body.data.amount, currency: "INR", status: "captured", method: "upi" });
  const v = await H.api("POST", "/payment/verify-payment", { token: t, body: { razorpay_order_id: o.body.data.id, razorpay_payment_id: pay.id, razorpay_signature: H.signature(o.body.data.id, pay.id) } });
  assert.strictEqual(v.status, 200, JSON.stringify(v.body));
  return r.body.data;
}

test("the export is fixed: valid ICS, MIME, all-day exclusive DTEND, privacy-minimal, ETag/304", async () => {
  const x = await property();
  const paid = await paidGuestBooking(x.listing, 10, 12);
  await H.api("POST", "/booking", { token: x.token, body: { ...H.bookingBody(x.listing, { checkIn: S.day(20), checkOut: S.day(21) }), action: "host" } });
  const holdGuest = await H.makeUser();
  await H.api("POST", "/booking", { token: H.userToken(holdGuest), body: H.bookingBody(x.listing, { checkIn: S.day(30), checkOut: S.day(31) }) }); // unpaid hold
  const cancelled = await paidGuestBooking(x.listing, 40, 41);
  await Booking.updateOne({ _id: cancelled._id }, { $set: { status: "cancelled" } });
  const legacy = await H.api("POST", "/calendarSync/saveCalendar", { token: x.token, body: { propertyId: String(x.listing._id), kind: "export" } });
  assert.strictEqual(legacy.status, 200);
  const res = await feed(legacy.body.secret);
  const text = await res.text();
  assert.strictEqual(res.status, 200);
  assert.match(res.headers.get("content-type"), /^text\/calendar; charset=utf-8/);
  assert.match(res.headers.get("cache-control"), /no-cache/);
  assert.ok(res.headers.get("etag"));
  assert.strictEqual(res.headers.get("x-robots-tag"), "noindex, nofollow");
  assert.deepStrictEqual(evs(text), [`${S.day(10)}..${S.day(12)}`, `${S.day(20)}..${S.day(21)}`], "paid booking + host block; no hold, no cancelled");
  assert.match(text, new RegExp(`DTSTART;VALUE=DATE:${S.day(10).replace(/-/g, "")}`));
  assert.match(text, new RegExp(`DTEND;VALUE=DATE:${S.day(12).replace(/-/g, "")}`), "exclusive checkout day");
  for (const leak of ["Priya", "Secretname", "Guestfirst", "Hostname", "Secretlast", String(paid._id), String(x.listing._id), "DESCRIPTION", "Booking "]) assert.ok(!text.includes(leak), `feed must not contain ${leak}`);
  assert.ok(text.split("\r\n").filter((l) => l.startsWith("UID:")).every((l) => /^UID:me-[a-z0-9]{26}@sync\.majesticescape\.in$/.test(l)), "opaque UIDs in Majestic's namespace");
  assert.ok(text.split("\r\n").filter((l) => l.startsWith("SUMMARY:")).every((l) => l === "SUMMARY:Not available"));
  const again = await feed(legacy.body.secret, { "if-none-match": res.headers.get("etag") });
  assert.strictEqual(again.status, 304, "unchanged state → 304 (deterministic body)");
  // round trip through an independent parser too
  const nodeIcal = require("node-ical").sync.parseICS(text);
  assert.strictEqual(Object.values(nodeIcal).filter((v) => v.type === "VEVENT").length, 2);
  record("legacy-export", { status: res.status, headers: { ct: res.headers.get("content-type"), cc: res.headers.get("cache-control"), etag: res.headers.get("etag") }, body: text });
});

test("legacy duplicate export rows keep working; saveCalendar returns the oldest; concurrent first visits create one row", async () => {
  const x = await property();
  const secrets = ["a".repeat(32), "b".repeat(32), "c".repeat(32)];
  for (const s of secrets) await ExternalCalendar.collection.insertOne({ propertyId: x.listing._id, kind: "export", secret: s, __v: 0 });
  for (const s of secrets) assert.strictEqual((await feed(s)).status, 200, `legacy secret ${s[0]} still served`);
  const r = await H.api("POST", "/calendarSync/saveCalendar", { token: x.token, body: { propertyId: String(x.listing._id), kind: "export" } });
  assert.strictEqual(r.body.secret, secrets[0]);
  assert.strictEqual(r.body.message, "Export calendar already exists");
  const y = await property();
  const rs = await Promise.all([1, 2, 3, 4].map(() => H.api("POST", "/calendarSync/saveCalendar", { token: y.token, body: { propertyId: String(y.listing._id), kind: "export" } })));
  assert.strictEqual(new Set(rs.map((q) => q.body.secret)).size, 1, "one secret for concurrent first visits (D7 fixed)");
  assert.strictEqual(await ExternalCalendar.countDocuments({ propertyId: y.listing._id, kind: "export" }), 1);
});

test("destination feeds: each OTA gets everyone else's bookings, never its own", async () => {
  const x = await property();
  await paidGuestBooking(x.listing, 5, 6);
  const airbnb = await connect(x, "AIRBNB", [{ uid: "AB-1@airbnb.com", start: S.day(10), end: S.day(11), summary: "Reserved" }]);
  const agoda = await connect(x, "AGODA", [{ uid: "AG-1@agoda.com", start: S.day(14), end: S.day(15) }]);
  const generic = await connect(x, "GENERIC_ICAL", [{ uid: "G-1@other", start: S.day(18), end: S.day(19) }]);
  const get = async (c) => evs(await (await feed(c.secret)).text());
  const [fa, fg, fx] = [await get(airbnb), await get(agoda), await get(generic)];
  const M = `${S.day(5)}..${S.day(6)}`;
  const A = `${S.day(10)}..${S.day(11)}`;
  const G = `${S.day(14)}..${S.day(15)}`;
  const X = `${S.day(18)}..${S.day(19)}`;
  assert.deepStrictEqual(fa, [M, G, X], "Airbnb feed excludes the Airbnb event");
  assert.deepStrictEqual(fg, [M, A, X], "Agoda feed excludes the Agoda event");
  assert.deepStrictEqual(fx, [M, A, G], "generic feed excludes its own event");
  // propagation kill switch: Majestic-native only
  await OpsFlag.updateOne({ _id: "calendar_propagation_off" }, { $set: { enabled: true } }, { upsert: true });
  require("../../services/calendarSync/flags").resetCache();
  assert.deepStrictEqual(await get(airbnb), [M]);
  await OpsFlag.updateOne({ _id: "calendar_propagation_off" }, { $set: { enabled: false } });
  require("../../services/calendarSync/flags").resetCache();
  record("destination-feeds", { airbnb: fa, agoda: fg, generic: fx });
});

test("hammering a public feed never fans out: outbound OTA fetches stay bounded", async () => {
  const x = await property();
  const airbnb = await connect(x, "AIRBNB", []);
  const agoda = await connect(x, "AGODA", [{ uid: "AG-9@agoda.com", start: S.day(14), end: S.day(15) }]);
  // make Agoda look 20 min old so the first feed request nudges it once
  await ExternalCalendar.updateOne({ _id: agoda.id }, { $set: { "sync.lastSuccessAt": new Date(Date.now() - 20 * 60_000) } });
  ota.resetHits();
  // A very slow OTA (8 s): if a feed waited for it, the slowest feed would
  // take ≥ 8 s; machine load alone cannot get there.
  ota.set(agoda.path, { body: S.vcal([{ uid: "AG-9@agoda.com", start: S.day(14), end: S.day(15) }]), delayMs: 8000 });
  const t = Date.now();
  const results = await Promise.all(Array.from({ length: 60 }, () => feed(airbnb.secret).then(async (r) => ({ status: r.status, ms: Date.now() - t, body: await r.text() }))));
  const slowest = Math.max(...results.map((r) => r.ms));
  assert.ok(results.every((r) => r.status === 200));
  assert.ok(slowest < 7000, `feeds answer without waiting for the slow OTA (slowest ${slowest} ms)`);
  await new Promise((r) => setTimeout(r, 9000)); // the one background refresh completes
  for (let i = 0; i < 40; i++) assert.strictEqual((await feed(airbnb.secret)).status, 200);
  assert.ok(ota.count(agoda.path) <= 1, `Agoda fetched ${ota.count(agoda.path)} times for 100 feed requests`);
  assert.strictEqual(ota.count(airbnb.path), 0, "the destination's own source is never fetched by its feed");
  record("hammer", { requests: 100, agodaFetches: ota.count(agoda.path), airbnbFetches: ota.count(airbnb.path), slowestMs: slowest });
});

test("rotation kills the old token immediately; disconnecting the IMPORT keeps the OTA's link alive; junk tokens 404", async () => {
  const x = await property();
  const c = await connect(x, "AIRBNB", []);
  assert.strictEqual((await feed(c.secret)).status, 200);
  const rot = await H.api("POST", `/calendarSync/connections/${c.id}/rotate-export`, { token: x.token });
  assert.strictEqual(rot.status, 200);
  const fresh = secretOf(rot.body.data.connections[0].export.url);
  assert.notStrictEqual(fresh, c.secret);
  assert.strictEqual((await feed(c.secret)).status, 404, "old token dead at once (an OTA still polling it gets 404)");
  assert.strictEqual((await feed(fresh)).status, 200);
  const dis = await H.api("POST", `/calendarSync/connections/${c.id}/disconnect`, { token: x.token, body: { acknowledge: true } });
  assert.strictEqual(dis.status, 200);
  // Only the inbound side stops: the OTA must keep seeing Majestic's
  // bookings, or it would sell those nights again (release gate, M4).
  const after = await feed(fresh);
  assert.strictEqual(after.status, 200, "the OTA's Majestic link keeps working after the import is disconnected");
  for (const junk of ["x", "..%2F..%2Fetc", "a".repeat(300), "%00"]) assert.strictEqual((await feed(junk)).status, 404, junk);
});

test("a revoked legacy feed stops working", async () => {
  const x = await property();
  const r = await H.api("POST", "/calendarSync/saveCalendar", { token: x.token, body: { propertyId: String(x.listing._id), kind: "export" } });
  assert.strictEqual((await feed(r.body.secret)).status, 200);
  const rev = await H.api("POST", `/calendarSync/properties/${x.listing._id}/legacy-feed/revoke`, { token: x.token });
  assert.strictEqual(rev.status, 200);
  assert.strictEqual((await feed(r.body.secret)).status, 404);
});

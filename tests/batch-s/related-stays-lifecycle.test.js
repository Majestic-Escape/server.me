// Related stays — lifecycle through the REAL endpoints, ranking edges and
// privacy (docs/related-stays.md; requirement IDs from
// tests/pw-final/evidence/related-stays-matrix.md in brackets):
//   host row counts 0 / 1 / 12 / >12 and every tie-breaker [H4, H5, H8]
//   exact coordinates never decide membership or order [N2]
//   invalid / missing / (0,0) / string coordinates [N3]; band edges [N6];
//   invalid numbers [N8]; prefilter ≡ whole inventory at the antimeridian
//   and at high latitude [N13]
//   host delist of the source, of a shown sibling, of a shown candidate, of a
//   sibling outside the 12; reactivation; resubmission and edits while
//   processing; ban / unban; admin delist + refused host relist; deletion;
//   reassignment of a sibling and of the source; a candidate moving across
//   25 / 250 km; every transition purges the `listings` tag [L1–L13]
//   fresh secret missing / wrong / valid; recursive allow-list; masking of
//   street, address lines, phone and e-mail in titles incl. a number split
//   across title and description; signed-in callers get the anonymous answer
//   [S2, S4–S6, S10]
const test = require("node:test");
const assert = require("node:assert/strict");
const h = require("./setup");

const R = () => require("../../services/relatedStays");
const L = () => require("../../models/ListingProperty");
const changed = () => require("../../services/listingChanged");
const { approximateLocation } = require("../../utils/sanitizeResponse");
const { distanceKm } = require("../../utils/places");

const KM = (2 * Math.PI * 6371) / 360;
const S = (id, over = {}) => ({ id, host: "H", type: "villa", price: 1000, guests: 4, rating: null, reviews: 0, created: 0, point: { lat: 15, lng: 74 }, ...over });
const at = (km) => ({ lat: 15 + km / KM, lng: 74 });

// ---------------------------------------------------------------------------
// pure ranking edges
test("[H5] host row tie-breakers: rating → review count → newer → _id; rating without reviews counts as unrated", () => {
  const src = S("src", { host: "me" });
  const c = (id, rating, reviews, created) => S(id, { host: "me", rating, reviews, created });
  const pool = [
    c("e-unrated-new", null, 0, 9e12),
    c("a-high", 4.9, 1, 0),
    c("b-mid-many", 4.5, 100, 0),
    c("c-mid-few-new", 4.5, 3, 2e12),
    c("d-mid-few-old", 4.5, 3, 1e12),
    c("f-tie-2", 4.5, 3, 1e12),
    c("g-rating-no-reviews", 5, 0, 9e12),
    c("h-unrated-old", null, 0, 1),
  ];
  const ids = R().rankHost(src, pool).map((x) => x.id);
  assert.deepEqual(ids, ["a-high", "b-mid-many", "c-mid-few-new", "d-mid-few-old", "f-tie-2", "e-unrated-new", "g-rating-no-reviews", "h-unrated-old"]);
});

test("[N6] band edges: 5 / 10 / 15 / 20 km near bands and 50 / 75 km wide bands start a new band (similarity reorders only inside a band)", () => {
  const src = S("src", { host: "me" });
  const plain = { host: "x", type: "tent", price: 99999, guests: 30 };
  for (const edge of [5, 10, 15, 20]) {
    const pool = [S("inner-plain", { ...plain, point: at(edge - 0.01) }), S("edge-match", { host: "x", point: at(edge) })];
    assert.deepEqual(R().rankNearby(src, pool).items.map((x) => x.c.id), ["inner-plain", "edge-match"], `edge ${edge} km`);
  }
  // [20, 25] is one band: a closer plain stay at 20 comes after a similar one at 25
  const last = [S("p20", { ...plain, point: at(20) }), S("m25", { host: "x", point: at(25) })];
  assert.deepEqual(R().rankNearby(src, last).items.map((x) => x.c.id), ["m25", "p20"]);
  for (const edge of [50, 75, 100]) {
    const pool = [S("inner-plain", { ...plain, point: at(edge - 0.01) }), S("edge-match", { host: "x", point: at(edge) })];
    assert.deepEqual(R().rankNearby(src, pool).items.map((x) => x.c.id), ["inner-plain", "edge-match"], `wide edge ${edge} km`);
    const inside = [S("inner-plain", { ...plain, point: at(edge - 20) }), S("inner-match", { host: "x", point: at(edge - 5) })];
    assert.deepEqual(R().rankNearby(src, inside).items.map((x) => x.c.id), ["inner-match", "inner-plain"], `same wide band below ${edge}`);
  }
});

test("[N8] invalid numbers never match (summarize + similarity)", () => {
  const r = R();
  for (const bad of [0, -5, NaN, Infinity, -Infinity, "abc", "", null, undefined, {}, [], true]) {
    const s = r.summarize({ _id: "x", basePrice: bad, guests: bad, averageRating: bad, reviewCount: bad, propertyType: bad });
    // a 0-star rating is a real value; everything else here is not a usable rating
    assert.deepEqual([s.price, s.guests, s.rating, s.reviews, s.type], [null, null, bad === 0 ? 0 : null, 0, typeof bad === "string" && bad.trim() ? bad.trim().toLowerCase() : null], `value ${String(bad)}`);
  }
  assert.deepEqual([r.summarize({ _id: "x", averageRating: 5.01 }).rating, r.summarize({ _id: "x", averageRating: 5 }).rating], [null, 5], "ratings above 5 are not ratings");
  // a corrupt negative rating with reviews must not sort below unrated stays
  const host = R().rankHost(S("s", { host: "me" }), [S("neg", { host: "me", rating: R().summarize({ _id: "y", averageRating: -5 }).rating, reviews: 3 }), S("unrated", { host: "me" })]);
  assert.equal(host[0].id, "neg", "a negative rating is treated as missing (key −1), tie broken by reviews");
  assert.deepEqual([r.summarize({ _id: "x", basePrice: "1500" }).price, r.summarize({ _id: "x", guests: " 3 " }).guests], [1500, 3], "numeric strings (legacy rows) are read as numbers");
  assert.equal(r.summarize({ _id: "x", propertyType: "   " }).type, null);
  const src = S("s", { type: null, price: null, guests: null });
  assert.equal(r.similarity(src, S("c", { type: null, price: null, guests: null })), 0, "missing never matches missing");
});

test("[N3] invalid coordinates: (0,0), out of range, missing, NaN → no public point, never nearby; a source without one has no nearby row", () => {
  const r = R();
  for (const [lat, lng] of [[0, 0], [95, 10], [10, 190], [null, 10], [10, undefined], [NaN, 1], ["15.5", "74.1"]]) {
    assert.equal(r.publicPoint({ _id: "6a0000000000000000000001", address: { latitude: lat, longitude: lng } }), null, `${lat},${lng}`);
  }
  assert.ok(r.publicPoint({ _id: "6a0000000000000000000001", address: { latitude: 15.5, longitude: 74.1 } }));
});

// ---------------------------------------------------------------------------
// API fixtures
const P = { lat: 12.9716, lng: 77.5946 }; // Bengaluru — this file's own neighbourhood
const addr = (kmNorth, kmEast = 0, over = {}) => ({
  street: "4 Quiet Orchard Road", city: "Bengaluru", district: "Bengaluru Urban", state: "Karnataka",
  latitude: P.lat + kmNorth / KM, longitude: P.lng + kmEast / (KM * Math.cos((P.lat * Math.PI) / 180)), ...over,
});
let ADMIN;
let A;
let B;
let rec;
const tok = (u) => h.userToken(u);
async function rel(id, headers = {}, qs = "") {
  const r = await fetch(`${h.baseUrl()}/properties/${id}/related${qs}`, { headers });
  const text = await r.text();
  const json = JSON.parse(text);
  return { status: r.status, json, text, cache: r.headers.get("cache-control"), cdn: r.headers.get("cdn-cache-control"), tag: r.headers.get("vercel-cache-tag"),
    hostIds: (json.host || []).map((c) => String(c._id)), nearIds: (json.nearby || []).map((c) => String(c._id)) };
}
const purged = (id) => rec.calls.some((c) => c.tags.includes("listings") && c.tags.includes(`listing:${id}`));

test.before(async () => {
  await h.start();
  rec = { calls: [] };
  changed().__setMock(rec);
  ADMIN = h.adminToken(await h.makeAdmin());
  A = await h.makeUser({ role: "host", firstName: "Anaya", email: "anaya@lifecycle.test" });
  B = await h.makeUser({ role: "host", firstName: "Bharat", email: "bharat@lifecycle.test" });
});
test.after(async () => {
  R().__setTestHooks(null);
  await h.stop();
});

test("[H4, H8] host row with 0, 1, 12 and 14 siblings; the overflow stays in nearby, never twice", async () => {
  const solo = await h.makeUser({ role: "host", firstName: "Solo", email: "solo@lifecycle.test" });
  const far = (n) => addr(0, 0, { latitude: -20 - n, longitude: 30 }); // somewhere with no neighbours
  const s0 = await h.makeListing(solo, { title: "Solo 0", address: far(1) });
  let r = await rel(s0._id);
  assert.deepEqual([r.hostIds.length, r.json.sourceHostId], [0, String(solo._id)], "0 siblings: empty host row, host id still sent");
  const s1 = await h.makeListing(solo, { title: "Solo 1", address: far(30) });
  r = await rel(s0._id);
  assert.deepEqual(r.hostIds, [String(s1._id)], "1 sibling");
  const more = [];
  for (let i = 0; i < 11; i++) more.push(await h.makeListing(solo, { title: `Solo m${i}`, address: far(60 + i) }));
  r = await rel(s0._id);
  assert.equal(r.hostIds.length, 12, "exactly 12 siblings → all 12");
  const extra = [await h.makeListing(solo, { title: "Solo x1", address: addr(0, 0, { latitude: -21.01, longitude: 30 }) }), await h.makeListing(solo, { title: "Solo x2", address: addr(0, 0, { latitude: -21.02, longitude: 30 }) })];
  r = await rel(s0._id);
  assert.equal(r.hostIds.length, 12, "14 siblings → 12");
  const shown = new Set(r.hostIds);
  const overflow = [s1, ...more, ...extra].map((l) => String(l._id)).filter((id) => !shown.has(id));
  assert.equal(overflow.length, 2);
  // the two not shown are the newest-unrated tie-break losers; the near ones (x1, x2, ~1–2 km away) are in nearby
  for (const id of overflow) {
    const inNearby = r.nearIds.includes(id);
    const isNear = extra.some((l) => String(l._id) === id);
    if (isNear) assert.ok(inNearby, "same-host overflow stay is eligible for nearby");
  }
  assert.equal(new Set([...r.hostIds, ...r.nearIds]).size, r.hostIds.length + r.nearIds.length, "never twice");
  await L().deleteMany({ host: solo._id });
});

test("[N2] exact coordinates never decide membership or order: the row equals an independent ranking of the PUBLIC points", async () => {
  const src = await h.makeListing(A, { title: "Exact src", propertyType: "villa", basePrice: 5000, guests: 4, address: addr(-300, 0) });
  const base = { lat: src.address.latitude, lng: src.address.longitude };
  const cands = [];
  // 48 stays with EXACT distances 24.4 … 25.6 km on many bearings: the approximation (150–350 m) moves some across 25 km
  for (let i = 0; i < 48; i++) {
    const km = 24.4 + (i % 24) * 0.05;
    const t = (i * 7.5 * Math.PI) / 180;
    cands.push(await h.makeListing(B, { title: `Edge ${i}`, propertyType: "villa", basePrice: 5000, guests: 4,
      address: { city: "Edge", state: "Edge", latitude: base.lat + (km / KM) * Math.cos(t), longitude: base.lng + (km / (KM * Math.cos((base.lat * Math.PI) / 180))) * Math.sin(t) } }));
  }
  const sp = approximateLocation(String(src._id), base.lat, base.lng);
  const rows = cands.map((l) => {
    const exactD = distanceKm(base, { lat: l.address.latitude, lng: l.address.longitude });
    const p = approximateLocation(String(l._id), l.address.latitude, l.address.longitude);
    return { id: String(l._id), exactD, pubD: distanceKm({ lat: sp.latitude, lng: sp.longitude }, { lat: p.latitude, lng: p.longitude }) };
  });
  const flips = rows.filter((x) => (x.exactD <= 25) !== (x.pubD <= 25));
  assert.ok(flips.length >= 3, `the fixture must contain stays that the approximation moves across 25 km (got ${flips.length})`);
  // independent expectation (same type / price / guests → similarity ties): near ring by public distance, band 4 = [20,25], then distance, then id
  const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const expectPublic = rows.filter((x) => x.pubD <= 25 + 1e-9).sort((a, b) => a.pubD - b.pubD || byId(a, b)).slice(0, 8).map((x) => x.id);
  const expectExact = rows.filter((x) => x.exactD <= 25 + 1e-9).sort((a, b) => a.exactD - b.exactD || byId(a, b)).slice(0, 8).map((x) => x.id);
  const r = await rel(src._id);
  assert.deepEqual(r.nearIds, expectPublic, "the API row is the public-point ranking");
  assert.notDeepEqual(expectPublic, expectExact, "and the exact-point ranking would differ — the test can tell them apart");
  for (const c of r.json.nearby) assert.ok(c.distanceKm <= 25, "only public distances ≤ 25 km shown in a near row");
  await L().deleteMany({ _id: { $in: [src._id, ...cands.map((c) => c._id)] } });
});

test("[N3] stored coordinates that are (0,0), out of range, missing or strings never enter nearby; the request never fails", async () => {
  const src = await h.makeListing(A, { title: "Coord src", address: addr(500, 0) });
  const good = await h.makeListing(B, { title: "Coord good", address: addr(501, 0) });
  const coll = L().collection;
  const bad = [];
  for (const [i, a] of [[1, { latitude: 0, longitude: 0 }], [2, { latitude: 95, longitude: 10 }], [3, { city: "No point" }], [4, { latitude: String(P.lat + 501 / KM), longitude: String(P.lng) }]].entries()) {
    const ins = await coll.insertOne({ title: `Coord bad ${i}`, host: B._id, hostEmail: B.email, status: "active", address: a, createdAt: new Date() });
    bad.push(ins.insertedId);
  }
  const r = await rel(src._id);
  assert.equal(r.status, 200);
  assert.ok(r.nearIds.includes(String(good._id)));
  for (const id of bad) assert.ok(!r.nearIds.includes(String(id)) && !r.hostIds.includes(String(id)), `bad ${id}`);
  // a SOURCE without a valid point: host row only
  const nopoint = await coll.insertOne({ title: "Coord nopoint src", host: A._id, hostEmail: A.email, status: "active", address: { latitude: 0, longitude: 0 }, createdAt: new Date() });
  const r2 = await rel(nopoint.insertedId);
  assert.deepEqual([r2.status, r2.nearIds.length], [200, 0]);
  assert.ok(r2.hostIds.length > 0, "host row still offered");
  await L().deleteMany({ _id: { $in: [src._id, good._id, nopoint.insertedId, ...bad] } });
});

test("[N13] prefilter ≡ whole-inventory ranking at the antimeridian, at 80° and 86° latitude", async () => {
  const r = R();
  const { publicListingFilter } = require("../../utils/listingProjection");
  let seed = 4242;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  for (const [label, c] of [["antimeridian", { lat: -17.7, lng: 179.85 }], ["lat 80", { lat: 80, lng: 20 }], ["lat 86", { lat: 86, lng: -40 }]]) {
    const docs = [];
    for (let i = 0; i < 120; i++) {
      const km = rnd() * 400;
      const t = rnd() * 2 * Math.PI;
      let lng = c.lng + (km / (KM * Math.cos((c.lat * Math.PI) / 180))) * Math.sin(t);
      if (lng > 180) lng -= 360;
      if (lng < -180) lng += 360;
      const lat = Math.max(-89.9, Math.min(89.9, c.lat + (km / KM) * Math.cos(t)));
      docs.push({ title: `Geo ${label} ${i}`, host: rnd() < 0.2 ? A._id : B._id, hostEmail: "geo@lifecycle.test", status: "active", propertyType: rnd() < 0.5 ? "villa" : "flat", basePrice: 1000 + Math.floor(rnd() * 5000), guests: 1 + (i % 6), address: { city: "Geo", latitude: lat, longitude: lng }, createdAt: new Date(Date.now() - i * 1000) });
    }
    const ins = await L().collection.insertMany(docs);
    const src = await h.makeListing(A, { title: `Geo src ${label}`, address: { city: "Geo", latitude: c.lat, longitude: c.lng } });
    try {
      const res = await rel(src._id);
      const full = (await L().find(publicListingFilter()).select(r.POOL_PROJECTION).lean()).map(r.summarize);
      const me = full.find((x) => x.id === String(src._id));
      const hostRow = r.rankHost(me, full);
      const near = r.rankNearby(me, full, { exclude: new Set(hostRow.map((x) => x.id)) });
      assert.deepEqual(res.hostIds, hostRow.map((x) => x.id), `${label}: host row`);
      assert.deepEqual(res.nearIds, near.items.map((x) => x.c.id), `${label}: nearby row`);
      assert.ok(res.nearIds.length > 0, `${label}: the fixture has neighbours`);
    } finally {
      await L().deleteMany({ _id: { $in: [src._id, ...Object.values(ins.insertedIds)] } });
    }
  }
});

// ---------------------------------------------------------------------------
// lifecycle through the real endpoints
test("[L1–L13] delist / reactivate / resubmit / ban / admin delist / delete / reassign / move — rows follow, every change purges", async () => {
  const aT = tok(A);
  let bT = tok(B);
  const mk = (owner, title, km, over = {}) => h.makeListing(owner, { title, propertyType: "villa", basePrice: 5000, guests: 4, address: addr(km, 0), ...over });
  const src = await mk(A, "Life source", 0, { averageRating: 4.9, reviewCount: 10 });
  const sib = [];
  // 14 siblings; ratings make the first 12 deterministic; the last two are unrated and close by (nearby overflow)
  for (let i = 0; i < 14; i++) sib.push(await mk(A, `Life sib ${i}`, 1 + i * 0.5, i < 12 ? { averageRating: 5 - i * 0.1, reviewCount: 5 } : {}));
  const cand = [];
  for (let i = 0; i < 6; i++) cand.push(await mk(B, `Life cand ${i}`, 2 + i, { propertyType: "flat" }));
  const id = (l) => String(l._id);
  let r = await rel(src._id);
  assert.deepEqual(r.hostIds, sib.slice(0, 12).map(id), "initial host row");
  assert.ok(id(sib[12]) && r.nearIds.includes(id(sib[12])) && r.nearIds.includes(id(sib[13])), "overflow siblings in nearby");
  assert.ok(r.nearIds.includes(id(cand[0])));

  // L2: host delists a sibling shown in the host row
  rec.calls.length = 0;
  assert.equal((await h.api("PATCH", `/properties/host/delist/${sib[0]._id}`, { token: aT })).status, 200);
  assert.ok(purged(id(sib[0])), "delist purges listings + listing:<id>");
  r = await rel(src._id);
  assert.ok(!r.hostIds.includes(id(sib[0])) && !r.nearIds.includes(id(sib[0])));
  assert.equal(r.hostIds.length, 12, "the next sibling moves up");
  // L5: reactivation brings it back
  rec.calls.length = 0;
  assert.equal((await h.api("PATCH", `/properties/host/reactivate/${sib[0]._id}`, { token: aT })).status, 200);
  assert.ok(purged(id(sib[0])));
  r = await rel(src._id);
  assert.equal(r.hostIds[0], id(sib[0]));

  // L4: a sibling outside the 12 (shown in nearby as overflow) is delisted
  const before12 = r.hostIds.slice();
  assert.equal((await h.api("PATCH", `/properties/host/delist/${sib[13]._id}`, { token: aT })).status, 200);
  r = await rel(src._id);
  assert.deepEqual(r.hostIds, before12, "host row unchanged");
  assert.ok(!r.nearIds.includes(id(sib[13])), "gone from nearby too");

  // L3: the other host delists a candidate shown in nearby; relists it
  assert.equal((await h.api("PATCH", `/properties/host/delist/${cand[0]._id}`, { token: bT })).status, 200);
  r = await rel(src._id);
  assert.ok(!r.nearIds.includes(id(cand[0])));
  assert.equal((await h.api("PATCH", `/properties/host/reactivate/${cand[0]._id}`, { token: bT })).status, 200);
  r = await rel(src._id);
  assert.ok(r.nearIds.includes(id(cand[0])));

  // L6: resubmission active → processing hides it; an edit while processing is never public; approval publishes it
  rec.calls.length = 0;
  let w = await h.api("PUT", `/properties/update-listing-property/${sib[1]._id}`, { token: aT, body: { status: "processing" } });
  assert.equal(w.status, 200, JSON.stringify(w.body));
  assert.ok(purged(id(sib[1])), "resubmission purges");
  w = await h.api("PUT", `/properties/update-listing-property/${sib[1]._id}`, { token: aT, body: { title: "Unreviewed draft title zq" } });
  assert.equal(w.status, 200, JSON.stringify(w.body));
  r = await rel(src._id);
  assert.ok(!r.hostIds.includes(id(sib[1])) && !r.text.includes("Unreviewed draft title zq"));
  assert.equal((await h.api("PATCH", `/properties/admin/approve/${sib[1]._id}`, { token: ADMIN })).status, 200);
  r = await rel(src._id);
  assert.ok(r.hostIds.includes(id(sib[1])) && r.text.includes("Unreviewed draft title zq"), "approved content appears only after approval");

  // L8: admin delist; the host may not relist it
  assert.equal((await h.api("PATCH", `/properties/admin/delist/${sib[2]._id}`, { token: ADMIN })).status, 200);
  // the API answers an admin-delisted relist with 200 + listing:"adminDelist" (a client contract) — refused all the same
  const refused = await h.api("PATCH", `/properties/host/reactivate/${sib[2]._id}`, { token: aT });
  assert.deepEqual([refused.status, refused.body.listing], [200, "adminDelist"]);
  assert.deepEqual([(await L().findById(sib[2]._id).lean()).status, (await L().findById(sib[2]._id).lean()).delist], ["inactive", "admin"], "still delisted");
  r = await rel(src._id);
  assert.ok(!r.hostIds.includes(id(sib[2])) && !r.nearIds.includes(id(sib[2])));

  // L7: ban / unban of the other host
  rec.calls.length = 0;
  assert.equal((await h.api("PATCH", `/guests/ban/${B._id}`, { token: ADMIN, body: { active: true } })).status, 200);
  assert.ok(cand.some((c) => purged(id(c))), "ban purges the host's listings");
  r = await rel(src._id);
  assert.ok(cand.every((c) => !r.nearIds.includes(id(c))), "a banned host's stays leave nearby");
  assert.equal((await h.api("PATCH", `/guests/ban/${B._id}`, { token: ADMIN, body: { active: false } })).status, 200);
  r = await rel(src._id);
  assert.ok(r.nearIds.includes(id(cand[0])), "unban restores them");
  bT = tok(await require("../../models/User").findById(B._id)); // the ban revoked the old session

  // L9: deletion — a live listing cannot be deleted through the API; a row removed by data operations simply disappears
  const del = await h.api("DELETE", `/properties/host/${cand[1]._id}`, { token: bT });
  assert.ok([404, 409, 403].includes(del.status), `live delete refused (${del.status})`);
  await L().deleteOne({ _id: cand[1]._id });
  r = await rel(src._id);
  assert.equal(r.status, 200);
  assert.ok(!r.nearIds.includes(id(cand[1])));

  // L10: reassignment of a sibling to the other host → leaves A's host row (now a nearby candidate)
  rec.calls.length = 0;
  w = await h.api("PUT", `/prop-listing/${sib[3]._id}`, { token: ADMIN, body: { host: String(B._id), hostEmail: B.email } });
  assert.equal(w.status, 200, JSON.stringify(w.body));
  assert.ok(purged(id(sib[3])), "reassignment purges");
  r = await rel(src._id);
  assert.ok(!r.hostIds.includes(id(sib[3])), "no longer attributed to Anaya");

  // L11: a candidate moves beyond 250 km and back (admin edit of the address)
  w = await h.api("PUT", `/properties/admin-update-property/${cand[2]._id}`, { token: ADMIN, body: { address: addr(400, 0) } });
  assert.equal(w.status, 200, JSON.stringify(w.body));
  r = await rel(src._id);
  assert.ok(!r.nearIds.includes(id(cand[2])), "moved beyond 250 km");
  await h.api("PUT", `/properties/admin-update-property/${cand[2]._id}`, { token: ADMIN, body: { address: addr(4, 0) } });
  r = await rel(src._id);
  assert.ok(r.nearIds.includes(id(cand[2])), "moved back");

  // L10b: the SOURCE is reassigned → its host row becomes the new host's stays; sourceHostId says so
  w = await h.api("PUT", `/prop-listing/${src._id}`, { token: ADMIN, body: { host: String(B._id), hostEmail: B.email } });
  assert.equal(w.status, 200, JSON.stringify(w.body));
  r = await rel(src._id);
  assert.equal(r.json.sourceHostId, String(B._id));
  const bIds = new Set((await L().find({ host: B._id, status: "active" }).select("_id").lean()).map((x) => String(x._id)));
  assert.ok(r.hostIds.length > 0 && r.hostIds.every((x) => bIds.has(x)), "only the new host's stays in the host row");
  await h.api("PUT", `/prop-listing/${src._id}`, { token: ADMIN, body: { host: String(A._id), hostEmail: A.email } });

  // L1: the host delists the SOURCE → unavailable, never cached; relist → normal and cacheable
  rec.calls.length = 0;
  assert.equal((await h.api("PATCH", `/properties/host/delist/${src._id}`, { token: aT })).status, 200);
  assert.ok(purged(id(src)));
  r = await rel(src._id);
  assert.deepEqual([r.json.unavailable, r.hostIds.length, r.nearIds.length, r.cdn, r.tag], [true, 0, 0, null, null]);
  assert.match(r.cache || "", /no-store/);
  assert.equal((await h.api("PATCH", `/properties/host/reactivate/${src._id}`, { token: aT })).status, 200);
  r = await rel(src._id);
  assert.deepEqual([r.json.unavailable, r.hostIds.length > 0, /s-maxage=300/.test(r.cdn || ""), r.tag], [undefined, true, true, "listings"]);

  await L().deleteMany({ _id: { $in: [src, ...sib, ...cand].map((l) => l._id) } });
});

// ---------------------------------------------------------------------------
// privacy
test("[S2] fresh bypass: no secret / wrong secret → 400 before any DB work; right secret → 200 no-store; a secret without ?fresh changes nothing", async () => {
  const l = await h.makeListing(A, { title: "Fresh src", address: addr(900, 0) });
  const mongoose = require("mongoose");
  const ops = [];
  mongoose.set("debug", (coll, method) => ops.push(`${coll}.${method}`));
  const none = await rel(l._id, {}, "?fresh=1");
  const wrong = await rel(l._id, { "x-catalogue-fresh": "not-the-secret" }, "?fresh=1");
  mongoose.set("debug", false);
  assert.deepEqual([none.status, wrong.status], [400, 400]);
  assert.equal(ops.filter((o) => o.startsWith("listingproperties.")).length, 0, "refused before any listing read");
  const right = await rel(l._id, { "x-catalogue-fresh": "test-fresh-secret" }, "?fresh=1");
  assert.deepEqual([right.status, right.cdn, right.tag], [200, null, null]);
  assert.match(right.cache || "", /no-store/);
  const plainWithSecret = await rel(String(l._id), { "x-catalogue-fresh": "test-fresh-secret" });
  assert.match(plainWithSecret.cdn || "", /s-maxage=300/, "the header alone is not a bypass");
  await L().deleteOne({ _id: l._id });
});

test("[S4–S6, S10] recursive allow-list; street / line / phone / e-mail in titles masked, also when split across title and description; signed-in callers get the anonymous answer", async () => {
  const src = await h.makeListing(A, { title: "Mask src", address: addr(1200, 0) });
  const coll = L().collection;
  const leaky = [
    { title: "Stay at 77 Banyan Crescent Road", address: { street: "77 Banyan Crescent Road" } },
    { title: "Near Flat 9B Kestrel Block", line1: "Flat 9B Kestrel Block" },
    { title: "Call 9876543210 for deals" },
    { title: "Write to owner.private@example.com" },
    { title: "Ring 98765", description: "43210 for the best rate" }, // a number split across fields
  ];
  const ids = [];
  for (const [i, x] of leaky.entries()) {
    const ins = await coll.insertOne({
      host: B._id, hostEmail: "leak-host@lifecycle.test", status: "active", propertyType: "villa", basePrice: 3000, guests: 2,
      photos: ["https://cdn.test/a.jpg", "https://cdn.test/b.jpg"], kycStatus: "verified", bankDetails: { account: "000123456789" },
      registrationNumber: "REG-SECRET-1", ban: false, delist: "host", embedding: [0.1, 0.2], customRules: ["secret rule text"],
      line2: "Second line secret", description: "secret description", ...x,
      address: { city: "Mask", district: "Mask", state: "Mask", pincode: "560099", latitude: P.lat + (1200 + 1 + i) / KM, longitude: P.lng, street: "Private Street 1", ...(x.address || {}) },
      createdAt: new Date(),
    });
    ids.push(ins.insertedId);
  }
  const r = await rel(src._id);
  assert.equal(r.nearIds.length, leaky.length, "all fixture stays shown");
  // recursive key allow-list
  const allowed = {
    "": ["host", "nearby", "nearbyScope", "sourceHostId", "unavailable"],
    card: ["_id", "title", "propertyType", "photos", "address", "basePrice", "guests", "bedrooms", "averageRating", "reviewCount", "distanceKm"],
    address: ["city", "district", "state", "latitude", "longitude"],
  };
  for (const k of Object.keys(r.json)) assert.ok(allowed[""].includes(k), `top-level ${k}`);
  for (const c of [...r.json.host, ...r.json.nearby]) {
    for (const [k, v] of Object.entries(c)) {
      assert.ok(allowed.card.includes(k), `card key ${k}`);
      if (k === "address") for (const ak of Object.keys(v)) assert.ok(allowed.address.includes(ak), `address key ${ak}`);
      if (k === "photos") assert.ok(Array.isArray(v) && v.length <= 1 && v.every((p) => typeof p === "string"), "photos: one string");
      if (!["address", "photos"].includes(k)) assert.ok(v === null || ["string", "number"].includes(typeof v), `${k} is a scalar`);
    }
  }
  for (const secret of ["Banyan Crescent", "Kestrel", "9876543210", "owner.private@example.com", "98765", "43210", "Private Street", "Second line", "560099", "REG-SECRET", "000123456789", "verified", "secret rule", "secret description", "leak-host@", "kycStatus", "bankDetails", "embedding", "delist", "\"ban\""]) {
    assert.ok(!r.text.includes(secret), `leaked ${secret}`);
  }
  // signed-in callers (owner, admin) get exactly the anonymous answer — nothing personalised in a shared cache
  const asOwner = await rel(src._id, { Authorization: `Bearer ${tok(A)}` });
  const asAdmin = await rel(src._id, { Authorization: `Bearer ${ADMIN}` });
  assert.equal(asOwner.text, r.text);
  assert.equal(asAdmin.text, r.text);
  assert.deepEqual([asOwner.cdn, asAdmin.cdn], [r.cdn, r.cdn]);
  await L().deleteMany({ _id: { $in: [src._id, ...ids] } });
});

// ---------------------------------------------------------------------------
// round-3 adversarial review findings (kept as regression tests)
test("[review #1] a contact number split between the title and a custom rule or a safety-feature description is masked on the card", async () => {
  const src = await h.makeListing(A, { title: "Split src", address: addr(2000, 0) });
  const coll = L().collection;
  const ins = await coll.insertMany([
    { title: "Ring 98765", customRules: ["43210 for the best rate"], host: B._id, hostEmail: "s@lifecycle.test", status: "active", address: { city: "S", latitude: P.lat + 2001 / KM, longitude: P.lng }, createdAt: new Date() },
    { title: "Dial 91234", safetyFeatures: { smokeAlarm: { available: true, description: "56789 any time" } }, host: B._id, hostEmail: "s@lifecycle.test", status: "active", address: { city: "S", latitude: P.lat + 2002 / KM, longitude: P.lng }, createdAt: new Date() },
  ]);
  const r = await rel(src._id);
  assert.equal(r.nearIds.length, 2, "both shown");
  for (const frag of ["98765", "91234"]) assert.ok(!r.text.includes(frag), `card title leaks the first half of a split number (${frag})`);
  for (const k of ["customRules", "safetyFeatures"]) assert.ok(!r.text.includes(k), `${k} never emitted`);
  await L().deleteMany({ _id: { $in: [src._id, ...Object.values(ins.insertedIds)] } });
});

test("[review #3] non-canonical (upper-case) ids are refused before any database work — no cache-busting variants", async () => {
  const l = await h.makeListing(A, { title: "Case src", address: addr(2100, 0) });
  const mongoose = require("mongoose");
  const ops = [];
  mongoose.set("debug", (coll, method) => ops.push(`${coll}.${method}`));
  const upper = String(l._id).toUpperCase();
  const r = await fetch(`${h.baseUrl()}/properties/${upper}/related`);
  mongoose.set("debug", false);
  assert.equal(r.status, 400);
  assert.equal(r.headers.get("cdn-cache-control"), null);
  assert.equal(ops.filter((o) => o.startsWith("listingproperties.")).length, 0);
  assert.equal((await rel(l._id)).status, 200, "the canonical id still works");
  await L().deleteOne({ _id: l._id });
});

test("[review #2] a race (fail-closed) answer is a 503 + no-store, so no cache layer keeps it; a non-public source stays a 200", async () => {
  const src = await h.makeListing(A, { title: "Race503 src", address: addr(2200, 0) });
  const sib = await h.makeListing(A, { title: "Race503 sib", address: addr(2201, 0) });
  R().__setTestHooks({ afterPool: async () => { await L().updateOne({ _id: src._id }, { $set: { "address.latitude": P.lat + 2300 / KM } }); } });
  let r;
  try { r = await fetch(`${h.baseUrl()}/properties/${src._id}/related`); } finally { R().__setTestHooks(null); }
  const j = await r.json();
  assert.equal(r.status, 503, "transient: retryable, never stored by Next's data cache or the edge");
  assert.match(r.headers.get("cache-control") || "", /no-store/);
  assert.equal(r.headers.get("cdn-cache-control"), null);
  assert.deepEqual([j.unavailable, j.host.length, j.nearby.length], [true, 0, 0]);
  await L().updateOne({ _id: src._id }, { $set: { status: "inactive", delist: "host" } });
  const np = await rel(src._id);
  assert.deepEqual([np.status, np.json.unavailable], [200, true], "non-public: a definite answer, still no-store");
  await L().deleteMany({ _id: { $in: [src._id, sib._id] } });
});

test("[review #4] every listing query carries a server-side time limit (an abandoned scan cannot run unbounded)", async () => {
  const mongoose = require("mongoose");
  const src = await h.makeListing(A, { title: "MaxTime src", address: addr(2400, 0) });
  await h.makeListing(A, { title: "MaxTime sib", address: addr(2401, 0) });
  const client = mongoose.connection.getClient();
  const finds = [];
  const on = (e) => { if (e.commandName === "find" && e.command.find === "listingproperties") finds.push(e.command.maxTimeMS); };
  // monitorCommands is only on in this file if the connection was opened with it: fall back to the query options
  const origExec = mongoose.Query.prototype.exec;
  const seen = [];
  mongoose.Query.prototype.exec = function (...a) { if (this.model && this.model.modelName === "ListingProperty") seen.push(this.getOptions().maxTimeMS); return origExec.apply(this, a); };
  client.on("commandStarted", on);
  try { await R().relatedFor(String(src._id)); } finally { mongoose.Query.prototype.exec = origExec; client.off("commandStarted", on); }
  // source, first band (short here: one sibling) → the full box, cards: 4 — every one time-limited
  assert.equal(seen.length, 4, `four listing queries (${seen.length})`);
  assert.ok(seen.every((t) => typeof t === "number" && t > 0 && t <= 5000), `maxTimeMS on every query: ${JSON.stringify(seen)}`);
  await L().deleteMany({ title: /^MaxTime/ });
});

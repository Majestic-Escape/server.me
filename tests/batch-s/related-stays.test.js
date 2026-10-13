// "More stays hosted by …" / "Similar stays nearby" (services/relatedStays.js,
// GET /properties/:id/related, docs/related-stays.md):
//   pure ranking — golden boundaries (25 / 250 km, ±35 % price, ±2 guests,
//   5 km bands), host ordering, scope, seeded randomized invariants
//   API — input, public inventory only, card allow-list + masking + public
//   points, caching headers, ≤ 3 queries, races between the scan and the
//   card read, budgets at 2,000 / 5,000 live listings
const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const h = require("./setup");
const R = () => require("../../services/relatedStays");
const ListingProperty = () => require("../../models/ListingProperty");

const KM_PER_DEG_LAT = (2 * Math.PI * 6371) / 360; // the haversine's own scale
const S = (id, over = {}) => ({ id, host: "H", type: "villa", price: 1000, guests: 4, rating: null, reviews: 0, created: 0, point: { lat: 15, lng: 74 }, ...over });
const at = (km) => ({ lat: 15 + km / KM_PER_DEG_LAT, lng: 74 });

// ---------------------------------------------------------------------------
test("ranking: ring boundaries are inclusive (25 km near, 250 km wide, nothing beyond)", () => {
  const src = S("src");
  const pool = [S("a", { host: "x", point: at(25) }), S("b", { host: "x", point: at(25.01) }), S("c", { host: "x", point: at(250) }), S("d", { host: "x", point: at(250.05) })];
  const r = R().rankNearby(src, pool);
  const ids = r.items.map((x) => x.c.id);
  assert.deepEqual(ids, ["a", "b", "c"], "≤250 km in, 250.05 out; near before wide");
  assert.equal(r.scope, "mixed");
});

test("ranking: similarity counts valid values only, inclusive ±35 % / ±2", () => {
  const sim = R().similarity;
  const src = S("s", { price: 1000, guests: 4, type: "villa" });
  assert.equal(sim(src, S("c", { price: 650, guests: 6, type: "villa" })), 3, "0.65× / +2 / same type");
  const norm = R().summarize({ _id: "x", propertyType: " Villa ", basePrice: "1350", guests: 0, averageRating: NaN, reviewCount: -3 });
  assert.deepEqual([norm.type, norm.price, norm.guests, norm.rating, norm.reviews], ["villa", 1350, null, null, 0], "summaries normalise type, drop invalid numbers");
  assert.equal(sim(src, S("c", { price: 1350, guests: 2, type: "villa" })), 3, "1.35× / −2");
  assert.equal(sim(src, S("c", { price: 649, guests: 7, type: "flat" })), 0);
  assert.equal(sim(src, S("c", { price: 1351, guests: 1, type: null })), 0);
  assert.equal(sim(S("s", { price: null, guests: null, type: null }), S("c", { price: null, guests: null, type: null })), 0, "missing never matches missing");
  assert.equal(sim(S("s", { price: 0 }), S("c", { price: 0 })) >= 0, true);
});

test("ranking: distance first in 5 km bands; similarity only reorders inside a band", () => {
  const src = S("src", { host: "me" });
  const pool = [
    S("near-plain", { host: "x", point: at(0.1), type: "tent", price: 99999, guests: 20 }),
    S("band0-match", { host: "x", point: at(4.9) }),
    S("band1-match", { host: "x", point: at(5.1) }),
    S("band1-plain", { host: "x", point: at(5.0), type: "tent", price: 99999, guests: 20 }),
  ];
  const ids = R().rankNearby(src, pool).items.map((x) => x.c.id);
  assert.deepEqual(ids, ["band0-match", "near-plain", "band1-match", "band1-plain"]);
});

test("ranking: the wide ring is added only when fewer than 4 stays are within 25 km", () => {
  const src = S("src", { host: "me" });
  for (let n = 0; n <= 5; n++) {
    const pool = [];
    for (let i = 0; i < n; i++) pool.push(S(`n${i}`, { host: "x", point: at(1 + i) }));
    pool.push(S("w1", { host: "x", point: at(100) }));
    const r = R().rankNearby(src, pool);
    const hasWide = r.items.some((x) => x.c.id === "w1");
    assert.equal(hasWide, n < 4, `near=${n}`);
    assert.equal(r.scope, n === 0 ? "wide" : n < 4 ? "mixed" : "near", `scope near=${n}`);
  }
  assert.equal(R().rankNearby(src, []).scope, null);
  assert.deepEqual(R().rankNearby(S("p", { point: null }), [S("q", { host: "x" })]).items, [], "source without a point: no nearby row");
});

test("ranking: host row — same host only, rated first, deterministic, capped at 12, source excluded", () => {
  const src = S("src", { host: "me" });
  const pool = [src];
  for (let i = 0; i < 15; i++) pool.push(S(`h${String(i).padStart(2, "0")}`, { host: "me", reviews: i % 3, rating: i % 3 ? 3 + (i % 2) : null, created: i }));
  pool.push(S("other", { host: "you", reviews: 99, rating: 5 }));
  pool.push(S("nohost", { host: null, reviews: 99, rating: 5 }));
  const row = R().rankHost(src, pool);
  assert.equal(row.length, 12);
  assert.ok(row.every((c) => c.host === "me" && c.id !== "src"));
  const keys = row.map((c) => (c.reviews > 0 ? c.rating : -1));
  for (let i = 1; i < keys.length; i++) assert.ok(keys[i - 1] >= keys[i], "rated / higher first");
  assert.deepEqual(R().rankHost(src, [...pool].reverse()).map((c) => c.id), row.map((c) => c.id), "order independent of input order");
  assert.deepEqual(R().rankHost(S("x", { host: null }), pool), [], "a source without a host has no host row");
});

test("ranking: seeded randomized invariants (bounded, deterministic, no self / duplicate, rings, non-mutating)", () => {
  let seed = 20261013;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  for (let round = 0; round < 300; round++) {
    const roundSeed = seed;
    const src = S("src", { host: "me", price: rnd() < 0.2 ? null : 500 + rnd() * 9000, guests: rnd() < 0.2 ? null : 1 + Math.floor(rnd() * 10) });
    const pool = [src];
    const n = Math.floor(rnd() * 60);
    for (let i = 0; i < n; i++) {
      pool.push(S(`c${i}`, {
        host: rnd() < 0.3 ? "me" : rnd() < 0.1 ? null : `h${Math.floor(rnd() * 5)}`,
        type: ["villa", "flat", null, "Villa"][Math.floor(rnd() * 4)],
        price: rnd() < 0.2 ? null : 300 + rnd() * 12000,
        guests: rnd() < 0.2 ? null : Math.floor(rnd() * 12),
        reviews: Math.floor(rnd() * 4),
        rating: rnd() < 0.3 ? null : rnd() * 5,
        created: Math.floor(rnd() * 1e6),
        point: rnd() < 0.1 ? null : at(rnd() * 400),
      }));
    }
    const frozen = JSON.stringify(pool);
    const hostRow = R().rankHost(src, pool);
    const hostIds = new Set(hostRow.map((c) => c.id));
    const near = R().rankNearby(src, pool, { exclude: hostIds });
    const msg = `seed ${roundSeed}`;
    assert.equal(JSON.stringify(pool), frozen, `input mutated (${msg})`);
    assert.ok(hostRow.length <= 12 && near.items.length <= 8, msg);
    const all = [...hostRow.map((c) => c.id), ...near.items.map((x) => x.c.id)];
    assert.equal(new Set(all).size, all.length, `duplicate across rows (${msg})`);
    assert.ok(!all.includes("src"), msg);
    let seenWide = false;
    for (const { d } of near.items) {
      assert.ok(Number.isFinite(d) && d <= 250 + 1e-6, `distance (${msg})`);
      if (d > 25 + 1e-6) seenWide = true;
      else assert.ok(!seenWide, `near after wide (${msg})`);
    }
    const shuffled = [...pool].sort(() => rnd() - 0.5);
    assert.deepEqual(R().rankNearby(src, shuffled, { exclude: hostIds }).items.map((x) => x.c.id), near.items.map((x) => x.c.id), `not deterministic (${msg})`);
  }
});

test("prefilter: the box is a superset of the 250 km ring of PUBLIC points; poles / antimeridian scan everything", () => {
  const { OFFSET_MAX_M } = require("../../utils/sanitizeResponse");
  const r = R();
  assert.ok(r.PREFILTER_MARGIN_KM * 1000 > OFFSET_MAX_M, "margin beyond the largest approximation offset");
  const box = (src) => r.poolFilter(src).$or.find((c) => c["address.latitude"]);
  // every exact point within 250 km + offset of the source's public point lies inside the box
  for (const lat of [-60, -10, 0, 15.49, 34.15, 60]) {
    const src = S("s", { host: null, point: { lat, lng: 74 } });
    const b = box(src);
    const reach = 250 + OFFSET_MAX_M / 1000;
    for (let bearing = 0; bearing < 360; bearing += 5) {
      const t = (bearing * Math.PI) / 180;
      const δ = reach / 6371;
      const φ1 = (lat * Math.PI) / 180;
      const φ2 = Math.asin(Math.sin(φ1) * Math.cos(δ) + Math.cos(φ1) * Math.sin(δ) * Math.cos(t));
      const λ2 = (74 * Math.PI) / 180 + Math.atan2(Math.sin(t) * Math.sin(δ) * Math.cos(φ1), Math.cos(δ) - Math.sin(φ1) * Math.sin(φ2));
      const p = { lat: (φ2 * 180) / Math.PI, lng: (λ2 * 180) / Math.PI };
      assert.ok(p.lat >= b["address.latitude"].$gte && p.lat <= b["address.latitude"].$lte, `lat ${lat} bearing ${bearing}`);
      assert.ok(p.lng >= b["address.longitude"].$gte && p.lng <= b["address.longitude"].$lte, `lng ${lat} bearing ${bearing}`);
    }
  }
  const all = JSON.stringify(require("../../utils/listingProjection").publicListingFilter());
  assert.equal(JSON.stringify(r.poolFilter(S("s", { point: { lat: 86, lng: 10 } }))), all, "near a pole: whole inventory");
  assert.equal(JSON.stringify(r.poolFilter(S("s", { point: { lat: 10, lng: 179.5 } }))), all, "across the antimeridian: whole inventory");
  assert.equal(r.poolFilter(S("s", { host: null, point: null })), null, "nothing to relate");
  const hostOnly = r.poolFilter(S("s", { host: "h1", point: null }));
  assert.deepEqual(hostOnly.$or, [{ host: "h1" }], "no point: the host's stays only");
});

// --- API --------------------------------------------------------------------
let HOST, OTHER, src;
const PANAJI = { lat: 15.4909, lng: 73.8278 };
const addr = (km, n, over = {}) => ({ street: `${n} Copper Lantern Road`, city: "Panaji", district: "North Goa", state: "Goa", latitude: PANAJI.lat + km / KM_PER_DEG_LAT, longitude: PANAJI.lng, ...over });
async function raw(path, headers = {}) {
  const r = await fetch(`${h.baseUrl()}${path}`, { headers });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  return { status: r.status, json, text, h: r.headers };
}

test.before(async () => {
  await h.start();
  HOST = await h.makeUser({ role: "host", firstName: "Relhost", email: "relhost@related.test" });
  OTHER = await h.makeUser({ role: "host", firstName: "Relother", email: "relother@related.test" });
  src = await h.makeListing(HOST, { title: "Source villa", propertyType: "villa", address: addr(0, 1), photos: ["https://cdn.test/s1.jpg", "https://cdn.test/s2.jpg"], description: "Source text" });
});
test.after(async () => {
  R().__setTestHooks(null);
  await h.stop();
});

test("API: input is validated before any database work", async () => {
  assert.equal((await raw("/properties/not-an-id/related")).status, 404);
  for (const qs of ["?x=1", "?fresh=2", "?fresh=1&fresh=1", "?fresh[$ne]=1", "?limit=50"]) {
    assert.equal((await raw(`/properties/${src._id}/related${qs}`)).status, 400, qs);
  }
  assert.equal((await raw(`/properties/${src._id}/related?fresh=1`)).status, 400, "fresh without the site secret");
  const ok = await raw(`/properties/${src._id}/related?fresh=1`, { "x-catalogue-fresh": "test-fresh-secret" });
  assert.equal(ok.status, 200);
  assert.equal(ok.h.get("cache-control"), "no-store", "the bypass is never cached");
});

test("API: unknown / non-public source → empty rows, no-store, one indexed read", async () => {
  const hidden = [
    await h.makeListing(HOST, { status: "processing", address: addr(1, 2) }),
    await h.makeListing(HOST, { status: "inactive", delist: "host", address: addr(1, 3) }),
    await h.makeListing(HOST, { status: "active", ban: true, address: addr(1, 4) }),
  ];
  for (const id of ["0123456789abcdef01234567", ...hidden.map((l) => String(l._id))]) {
    const ops = [];
    mongoose.set("debug", (coll, method) => ops.push(`${coll}.${method}`));
    const r = await raw(`/properties/${id}/related`);
    mongoose.set("debug", false);
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { host: [], nearby: [], nearbyScope: null, sourceHostId: null, unavailable: true });
    assert.match(r.h.get("cache-control") || "", /no-store/);
    assert.equal(r.h.get("cdn-cache-control"), null);
    assert.equal(r.h.get("vercel-cache-tag"), null);
    assert.deepEqual(ops.filter((o) => o.startsWith("listingproperties.")), ["listingproperties.findOne"], `one read for ${id}`);
  }
  await ListingProperty().deleteMany({ _id: { $in: hidden.map((l) => l._id) } });
});

test("API: rows — public inventory only, host row then nearby, no duplicates, allow-listed cards", async () => {
  const mk = (owner, km, n, over = {}) => h.makeListing(owner, { title: `Rel ${n}`, propertyType: "villa", address: addr(km, n), photos: [`https://cdn.test/${n}a.jpg`, `https://cdn.test/${n}b.jpg`], description: `secret description ${n}`, line1: "Flat 9", ...over });
  const sib = [];
  for (let i = 0; i < 13; i++) sib.push(await mk(HOST, 2 + i, 100 + i, { averageRating: i % 5, reviewCount: i % 3 }));
  const near = [await mk(OTHER, 3, 200), await mk(OTHER, 8, 201), await mk(OTHER, 12, 202, { title: "Stay at 202 Copper Lantern Road" })];
  const hiddenOther = [
    await mk(OTHER, 1, 300, { status: "processing" }),
    await mk(OTHER, 1, 301, { status: "inactive" }),
    await mk(OTHER, 1, 302, { status: "active", ban: true }),
  ];
  const far = await mk(OTHER, 400, 400);
  const r = await raw(`/properties/${src._id}/related`);
  assert.equal(r.status, 200);
  const { host, nearby, nearbyScope, sourceHostId } = r.json;
  assert.equal(sourceHostId, String(HOST._id));
  assert.equal(host.length, 12, "host row capped at 12");
  const hostIds = new Set(sib.map((l) => String(l._id)));
  assert.ok(host.every((c) => hostIds.has(String(c._id))), "host row: the source's host only");
  const nearbyIds = nearby.map((c) => String(c._id));
  for (const l of near) assert.ok(nearbyIds.includes(String(l._id)), "nearby includes the other host's near stays");
  for (const l of [...hiddenOther, far, src]) assert.ok(!nearbyIds.includes(String(l._id)) && !host.some((c) => String(c._id) === String(l._id)), `excluded ${l.title}`);
  const all = [...host, ...nearby].map((c) => String(c._id));
  assert.equal(new Set(all).size, all.length, "no card twice");
  assert.equal(nearbyScope, "near");
  const ALLOWED = new Set(["_id", "title", "propertyType", "photos", "address", "basePrice", "guests", "bedrooms", "averageRating", "reviewCount", "distanceKm"]);
  const { approximateLocation } = require("../../utils/sanitizeResponse");
  for (const c of [...host, ...nearby]) {
    for (const k of Object.keys(c)) assert.ok(ALLOWED.has(k), `card key ${k}`);
    for (const k of Object.keys(c.address)) assert.ok(["city", "district", "state", "latitude", "longitude"].includes(k), `address key ${k}`);
    assert.equal(c.photos.length, 1, "first photo only");
    const docAddr = (await ListingProperty().findById(c._id).lean()).address;
    const approx = approximateLocation(String(c._id), docAddr.latitude, docAddr.longitude);
    assert.deepEqual([c.address.latitude, c.address.longitude], [approx.latitude, approx.longitude], "public (approximate) point only");
  }
  const text = r.text;
  for (const leak of ["Copper Lantern", "Flat 9", "secret description", "hostEmail", "street", "line1"]) assert.ok(!text.includes(leak), `leaked ${leak}`);
  assert.ok(!/"host":\s*[{"]/.test(text), "no host object / id on a card (only the row key and sourceHostId)");
  assert.equal(r.json.unavailable, undefined, "a real answer carries no unavailable flag");
  // the distance shown agrees with the points shown (both public)
  const { distanceKm } = require("../../utils/places");
  const sp = approximateLocation(String(src._id), src.address.latitude, src.address.longitude);
  for (const c of nearby) {
    const d = distanceKm({ lat: sp.latitude, lng: sp.longitude }, { lat: c.address.latitude, lng: c.address.longitude });
    assert.ok(Math.abs(d - c.distanceKm) <= 0.051, `distance ${c.distanceKm} vs points ${d}`);
  }
  // caching: a public source is edge-cached under the listings tag
  assert.match(r.h.get("cdn-cache-control") || "", /s-maxage=300/);
  assert.equal(r.h.get("vercel-cache-tag"), "listings");
  await ListingProperty().deleteMany({ _id: { $in: [...sib, ...near, ...hiddenOther, far].map((l) => l._id) } });
});

test("API: a public source with nothing related → empty rows, still cacheable", async () => {
  const lone = await h.makeListing(await h.makeUser({ role: "host", firstName: "Lone", email: "lone@related.test" }), { address: addr(0, 9, { latitude: -33.86, longitude: 151.2 }) });
  const r = await raw(`/properties/${lone._id}/related`);
  assert.deepEqual([r.json.host, r.json.nearby, r.json.nearbyScope], [[], [], null]);
  assert.match(r.h.get("cdn-cache-control") || "", /s-maxage=300/);
  await ListingProperty().deleteOne({ _id: lone._id });
});

test("API: a response-filter failure after the cache headers were stamped → 500, no-store, no CDN / tag", async () => {
  const svc = R();
  const real = svc.relatedFor;
  svc.relatedFor = async () => {
    const body = { host: [], nearby: [], nearbyScope: null, sourceHostId: null };
    body.loop = body; // the PII walk refuses cycles
    return { body, cacheable: true };
  };
  try {
    const r = await raw(`/properties/${src._id}/related`);
    assert.equal(r.status, 500);
    assert.equal(r.json.code, "RESPONSE_FILTER_ERROR");
    assert.equal(r.h.get("cache-control"), "no-store");
    assert.equal(r.h.get("cdn-cache-control"), null);
    assert.equal(r.h.get("vercel-cache-tag"), null);
  } finally {
    svc.relatedFor = real;
  }
});

test("API: a database failure → 500 without cache headers or internals", async () => {
  const svc = R();
  const real = svc.relatedFor;
  svc.relatedFor = async () => { throw new Error("MongoServerSelectionError: secret-host:27017"); };
  try {
    const r = await raw(`/properties/${src._id}/related`);
    assert.equal(r.status, 500);
    assert.ok(!r.text.includes("secret-host"));
    assert.equal(r.h.get("cdn-cache-control"), null);
    assert.equal(r.h.get("vercel-cache-tag"), null);
  } finally {
    svc.relatedFor = real;
  }
});

test("API: at most 3 listing queries per request", async () => {
  const extra = [await h.makeListing(HOST, { address: addr(2, 500) }), await h.makeListing(OTHER, { address: addr(4, 501) })];
  const ops = [];
  mongoose.set("debug", (coll, method) => ops.push(`${coll}.${method}`));
  const r = await raw(`/properties/${src._id}/related`);
  mongoose.set("debug", false);
  assert.equal(r.status, 200);
  const lp = ops.filter((o) => o.startsWith("listingproperties."));
  assert.ok(lp.length <= 3, lp.join(", "));
  assert.equal(ops.filter((o) => !o.startsWith("listingproperties.")).length, 0, `no other collection: ${ops.join(", ")}`);
  await ListingProperty().deleteMany({ _id: { $in: extra.map((l) => l._id) } });
});

test("API: races between the pool scan and the card read", async () => {
  const sib = await h.makeListing(HOST, { title: "Race sibling", address: addr(3, 600) });
  const other = await h.makeListing(OTHER, { title: "Race near", address: addr(5, 601) });
  const run = async (mutate) => {
    let once = false;
    R().__setTestHooks({ afterPool: async () => { if (!once) { once = true; await mutate(); } } });
    try { return await raw(`/properties/${src._id}/related`); } finally { R().__setTestHooks(null); }
  };
  // the source is delisted between the reads → fail closed, not cached
  let r = await run(() => ListingProperty().updateOne({ _id: src._id }, { $set: { status: "inactive", delist: "host" } }));
  assert.deepEqual([r.json.host.length, r.json.nearby.length, r.json.sourceHostId, r.json.unavailable], [0, 0, null, true]);
  assert.equal(r.h.get("cdn-cache-control"), null);
  await ListingProperty().updateOne({ _id: src._id }, { $set: { status: "active" }, $unset: { delist: 1 } });
  // the source changes host → fail closed (no other host's cards under this host's name)
  r = await run(() => ListingProperty().updateOne({ _id: src._id }, { $set: { host: OTHER._id } }));
  assert.equal(r.json.host.length + r.json.nearby.length, 0);
  assert.equal(r.json.unavailable, true, "a fail-closed answer says so (the site must not keep it)");
  assert.equal(r.h.get("cdn-cache-control"), null);
  await ListingProperty().updateOne({ _id: src._id }, { $set: { host: HOST._id } });
  // the source moves → fail closed
  r = await run(() => ListingProperty().updateOne({ _id: src._id }, { $set: { "address.latitude": 20 } }));
  assert.equal(r.json.host.length + r.json.nearby.length, 0);
  assert.equal(r.json.unavailable, true);
  await ListingProperty().updateOne({ _id: src._id }, { $set: { "address.latitude": PANAJI.lat } });
  // a candidate is delisted → dropped, no refill
  r = await run(() => ListingProperty().updateOne({ _id: other._id }, { $set: { status: "inactive" } }));
  assert.ok(!r.json.nearby.some((c) => String(c._id) === String(other._id)));
  assert.ok(r.json.host.some((c) => String(c._id) === String(sib._id)), "the rest stays");
  await ListingProperty().updateOne({ _id: other._id }, { $set: { status: "active" } });
  // a candidate moves beyond 250 km → dropped
  r = await run(() => ListingProperty().updateOne({ _id: other._id }, { $set: { "address.latitude": PANAJI.lat + 5 } }));
  assert.ok(!r.json.nearby.some((c) => String(c._id) === String(other._id)));
  await ListingProperty().updateOne({ _id: other._id }, { $set: { "address.latitude": addr(5, 601).latitude } });
  // a host-row card is reassigned to another host → it leaves the host row
  r = await run(() => ListingProperty().updateOne({ _id: sib._id }, { $set: { host: OTHER._id } }));
  assert.ok(!r.json.host.some((c) => String(c._id) === String(sib._id)), "no longer this host's");
  assert.ok(!r.json.nearby.some((c) => String(c._id) === String(sib._id)), "and not refilled into nearby");
  await ListingProperty().deleteMany({ _id: { $in: [sib._id, other._id] } });
});

test("prefilter: API rows equal a full-inventory ranking (seeded, incl. 249–252 km edges)", async () => {
  const L = ListingProperty();
  const hostX = await h.makeUser({ role: "host", firstName: "Eqx", email: "eqx@related.test" });
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const docs = [];
  const C = { lat: 22.5, lng: 80 };
  for (let i = 0; i < 400; i++) {
    const km = i < 40 ? 249 + rnd() * 3 : 300 + rnd() * 300; // only a band straddling 250 km is in reach
    const t = rnd() * 2 * Math.PI;
    docs.push({
      title: `Eq ${i}`, host: rnd() < 0.1 ? hostX._id : OTHER._id, hostEmail: "eq@related.test", status: rnd() < 0.9 ? "active" : "processing",
      propertyType: ["villa", "flat"][i % 2], basePrice: 1000 + Math.floor(rnd() * 8000), guests: 1 + (i % 8),
      address: { city: "Eqcity", state: "Eqstate", latitude: C.lat + (km / KM_PER_DEG_LAT) * Math.cos(t), longitude: C.lng + (km / (KM_PER_DEG_LAT * Math.cos((C.lat * Math.PI) / 180))) * Math.sin(t) },
      createdAt: new Date(Date.now() - i * 1000),
    });
  }
  const ins = await L.collection.insertMany(docs);
  const ids = Object.values(ins.insertedIds);
  const srcs = [await h.makeListing(hostX, { title: "Eq source", address: { city: "Eqcity", state: "Eqstate", latitude: C.lat, longitude: C.lng } })];
  const r = R();
  const { publicListingFilter } = require("../../utils/listingProjection");
  try {
    for (const s of srcs) {
      const res = await raw(`/properties/${s._id}/related`);
      const full = (await L.find(publicListingFilter()).select(r.POOL_PROJECTION).lean()).map(r.summarize);
      const me = full.find((c) => c.id === String(s._id));
      const hostRow = r.rankHost(me, full);
      const near = r.rankNearby(me, full, { exclude: new Set(hostRow.map((c) => c.id)) });
      assert.deepEqual(res.json.host.map((c) => String(c._id)), hostRow.map((c) => c.id), "host row");
      assert.deepEqual(res.json.nearby.map((c) => String(c._id)), near.items.map((x) => x.c.id), "nearby row");
      assert.equal(res.json.nearbyScope, near.scope);
      assert.ok(res.json.nearby.length >= 4 && res.json.nearby.every((c) => c.distanceKm >= 245 && c.distanceKm <= 250.05), `the 250 km edge decided the row: ${res.json.nearby.map((c) => c.distanceKm)}`);
    }
  } finally {
    await L.deleteMany({ _id: { $in: [...ids, ...srcs.map((x) => x._id)] } });
  }
});

test("budget: 2,000 and 5,000 live listings — latency, payload, memory (measured)", async () => {
  const L = ListingProperty();
  for (const total of [2000, 5000]) {
    const have = await L.countDocuments({ title: /^Bulk / });
    const docs = [];
    for (let i = have; i < total; i++) {
      docs.push({
        title: `Bulk ${i}`, host: i % 50 === 0 ? HOST._id : OTHER._id, hostEmail: "bulk@related.test", status: "active",
        propertyType: ["villa", "flat", "cottage"][i % 3], basePrice: 1000 + (i % 40) * 250, guests: 1 + (i % 10),
        photos: [`https://cdn.test/bulk${i}.jpg`], description: "x".repeat(400), amenities: ["wifi", "pool"],
        address: { street: `${i} Bulk Road`, city: "Panaji", state: "Goa", latitude: PANAJI.lat + ((i % 200) - 100) / 100, longitude: PANAJI.lng + (Math.floor(i / 200) % 25 - 12) / 100 },
        createdAt: new Date(Date.now() - i * 1000),
      });
    }
    if (docs.length) await L.collection.insertMany(docs);
    const times = [];
    let bytes = 0;
    const heap0 = process.memoryUsage().heapUsed;
    for (let k = 0; k < 15; k++) {
      const t0 = performance.now();
      const r = await raw(`/properties/${src._id}/related`);
      times.push(performance.now() - t0);
      bytes = r.text.length;
      assert.equal(r.status, 200);
      assert.equal(r.json.host.length, 12);
      assert.equal(r.json.nearby.length, 8);
    }
    times.sort((a, b) => a - b);
    const p95 = times[Math.ceil(times.length * 0.95) - 1]; // nearest rank
    const heapMb = (process.memoryUsage().heapUsed - heap0) / 1048576;
    console.log(`[budget] ${total} live: p50 ${times[Math.floor(times.length / 2)].toFixed(0)} ms, p95 ${p95.toFixed(0)} ms, payload ${bytes} B, heap Δ ${heapMb.toFixed(1)} MB`);
    assert.ok(bytes < 40000, `payload ${bytes} B`);
    assert.ok(p95 < 2000, `p95 ${p95.toFixed(0)} ms (target 150 ms locally — see the [budget] line)`);
  }
  await L.deleteMany({ title: /^Bulk / });
});

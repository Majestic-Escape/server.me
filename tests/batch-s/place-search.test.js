// Place-aware search (docs/place-search.md): a place means exactly the stays
// in it — by geography first, text second — with the nearest stays (and the
// reason) only when the whole filtered place is empty; every other filter
// survives the fallback; pages are deterministic; distances come from the
// public approximate points only; hostile parameters are refused; old
// clients keep working; the whole search stays within 3 database operations.
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const mongoose = require("mongoose");
const h = require("./setup");

const ListingProperty = () => require("../../models/ListingProperty");
const BookingNight = () => require("../../models/BookingNight");
const places = () => require("../../utils/places");
const placeText = () => require("../../utils/placeText");
const placeSearch = () => require("../../services/placeSearch");
const { approximateLocation } = require("../../utils/sanitizeResponse");

const PANAJI = "gn:1260607";
let HOST;
const L = {}; // title -> listing

const ops = [];
function startCounting() {
  ops.length = 0;
  mongoose.set("debug", (collection, method) => ops.push(`${collection}.${method}`));
}
function stopCounting() {
  mongoose.set("debug", false);
  return ops.slice();
}
async function raw(p) {
  const res = await fetch(`${h.baseUrl()}${p}`);
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: res.status, headers: Object.fromEntries(res.headers.entries()), text, json };
}
const q = (params) => raw(`/properties/search-properties?${new URLSearchParams(params)}`);
const titles = (r) => r.json.data.map((c) => c.title);
const sorted = (a) => [...a].sort();

const addr = (city, district, lat, lng, state = "Goa") => ({ city, district, state, pincode: "403001", country: "India - IN", latitude: lat, longitude: lng, street: "Private street 1" });

test.before(async () => {
  await h.start();
  HOST = await h.makeUser({ role: "host", firstName: "Place", lastName: "Host" });
  const mk = async (title, address, extra = {}) => {
    L[title] = await h.makeListing(HOST, { title, address, guests: 4, beds: 2, bedrooms: 1, bathrooms: 1, amenities: ["wifi"], ...extra });
    await new Promise((r) => setTimeout(r, 3)); // distinct createdAt → deterministic newest-first
  };
  await mk("Panaji Loft", addr("Panaji", "Altinho", 15.4985, 73.829), { amenities: ["wifi", "pool"], beds: 3 });
  await mk("Caranzalem Flat", addr("Goa", "Caranzalem", 15.4665, 73.8105), { beds: 1 });
  await mk("Porvorim House", addr("Porvorim", "Alto Porvorim", 15.533, 73.818));
  await mk("Mandrem Villa", addr("Goa", "Mandrem", 15.662, 73.716));
  await mk("Arpora Apt A", addr("Arpora", "Arpora", 15.57, 73.77));
  await mk("Arpora Apt B", addr("Arpora", "Arpora", 15.5702, 73.7703), { guests: 20 });
  await mk("Bouta Waddo Villa", addr("Goa", "Bouta Waddo", 15.595, 73.765));
  await mk("Seraulim Apt", addr("Seraulim", "Colva ", 15.285, 73.94));
  await mk("Canaguinim Hotel", addr("Canaguinim", "Canaguinim", 15.11, 73.93));
  await mk("Lucknow House", addr("Lucknow", "Jankipuram", 26.91, 80.98, "Uttar Pradesh"));
  await mk("Calangute Cottage", { city: "Calangute", district: "", state: "Goa", latitude: null, longitude: null });
  await mk("Zero Point Stay", addr("Calangute", "", 0, 0)); // the classic unset pair: text only
  await mk("Inactive Vasco", addr("Vasco", "Vasco", 15.396, 73.816), { status: "inactive" });
  await mk("Draft Panaji", addr("Panaji", "Panaji", 15.4957, 73.8262), { status: "incomplete" });
  await mk("Review Panaji", addr("Panaji", "Panaji", 15.4957, 73.8262), { status: "processing" });
});
test.after(async () => h.stop());

// ---------------------------------------------------------------------------
test("strict: a place returns exactly its stays — aliases, case, spaces, typos, geography over messy text", async () => {
  for (const location of ["Panaji", "panjim", "PANJIM ", "Pangim", "Panají", "panaji, goa", "Panjim beach"]) {
    const r = await q({ location });
    assert.equal(r.status, 200, location);
    assert.equal(r.json.search.mode, "place", location);
    assert.equal(r.json.search.place.id, PANAJI, location);
    assert.equal(r.json.search.place.name, "Panaji");
    assert.equal(r.json.search.place.label, "North Goa, Goa");
    // Caranzalem (Panaji neighbourhood, same taluka, "Goa" as its city) is in;
    // Porvorim — 4 km away but across the river in Bardez — is not.
    assert.deepEqual(sorted(titles(r)), ["Caranzalem Flat", "Panaji Loft"], location);
    assert.equal(r.json.search.corrected, false, location);
  }
  const typo = await q({ location: "panjm" });
  assert.equal(typo.json.search.place.id, PANAJI);
  assert.equal(typo.json.search.corrected, true, "a corrected typo says so");
  assert.equal(typo.json.search.query, "panjm", "the typed text is echoed for 'showing results for'");

  const expect = {
    mandrem: ["Mandrem Villa"], // city "Goa", district "Mandrem"
    assagao: ["Bouta Waddo Villa"], // city "Goa", uninformative district → settlements within 1.5 km
    verla: ["Bouta Waddo Villa"], // (the nearest one, 0.6 km)
    margao: ["Seraulim Apt"], // 2 km from Margao's centre, same taluka: inside a 88k town's radius
    arpora: ["Arpora Apt A", "Arpora Apt B"],
    seraulim: ["Seraulim Apt"], // not in the gazetteer: a live place
    colva: ["Seraulim Apt"], // named by its district text
    canaguinim: ["Canaguinim Hotel"],
    calangute: ["Calangute Cottage", "Zero Point Stay"], // no / (0,0) coordinates: text still counts
    lucknow: ["Lucknow House"],
    "north goa": ["Arpora Apt A", "Arpora Apt B", "Bouta Waddo Villa", "Calangute Cottage", "Caranzalem Flat", "Mandrem Villa", "Panaji Loft", "Porvorim House", "Zero Point Stay"],
    "south goa": ["Canaguinim Hotel", "Seraulim Apt"],
    bardez: ["Arpora Apt A", "Arpora Apt B", "Bouta Waddo Villa", "Calangute Cottage", "Porvorim House", "Zero Point Stay"],
    pernem: ["Mandrem Villa"],
    "uttar pradesh": ["Lucknow House"],
  };
  for (const [location, want] of Object.entries(expect)) {
    const r = await q({ location });
    assert.equal(r.json.search.mode, "place", location);
    assert.deepEqual(sorted(titles(r)), want, location);
  }
  const goa = await q({ location: "goa", limit: "50" });
  assert.equal(goa.json.search.place.type, "state");
  assert.equal(goa.json.pagination.totalCount, 11, "every active Goa stay, nothing else");
  for (const r of [goa, await q({ location: "vasco" }), await q({})]) {
    for (const t of ["Inactive Vasco", "Draft Panaji", "Review Panaji"]) assert.ok(!titles(r).includes(t), `${t} never public`);
  }
});

// ---------------------------------------------------------------------------
test("nearby: only when the whole filtered place is empty; reason is exact; order by distance from the public points; never another filter broken", async () => {
  const vasco = await q({ location: "vasco", limit: "50" });
  assert.equal(vasco.json.search.mode, "nearby");
  assert.equal(vasco.json.search.reason, "no_inventory", "Vasco has no active stays at all");
  assert.equal(vasco.json.search.place.name, "Vasco da Gama");
  const d = vasco.json.data.map((c) => c.distanceKm);
  assert.ok(d.length >= 8 && d.every((x) => typeof x === "number" && Math.round(x * 10) / 10 === x), "numeric, 0.1 km");
  assert.deepEqual(d, [...d].sort((a, b) => a - b), "nearest first");
  assert.equal(vasco.json.search.nearestKm, d[0]);
  assert.equal(titles(vasco)[0], "Caranzalem Flat");
  for (const t of ["Lucknow House", "Calangute Cottage", "Zero Point Stay", "Inactive Vasco"]) assert.ok(!titles(vasco).includes(t), `${t}: beyond 250 km / no usable point / inactive`);
  // privacy: every distance is measured from the approximate point the card shows
  const centre = places().placeById("gn:1253367");
  for (const c of vasco.json.data) {
    const pub = places().distanceKm(centre, { lat: c.address.latitude, lng: c.address.longitude });
    assert.ok(Math.abs(pub - c.distanceKm) <= 0.06, `${c.title}: ${c.distanceKm} vs public ${pub}`);
    const exact = L[c.title].address;
    assert.ok(!(c.address.latitude === exact.latitude && c.address.longitude === exact.longitude), "exact point never leaves");
  }
  assert.ok(!vasco.text.includes("Private street"), "street never in search");

  const baga = await q({ location: "baga" });
  assert.equal(baga.json.search.mode, "nearby");
  assert.ok(titles(baga)[0].startsWith("Arpora Apt"), "Baga's nearest stays are Arpora's");

  // dates: Panaji has stays, all booked → reason "dates", Panaji's own stays excluded
  const night = new Date(Date.UTC(2027, 5, 10));
  await BookingNight().create([
    { propertyId: L["Panaji Loft"]._id, date: night, bookingId: new mongoose.Types.ObjectId(), kind: "booking", expiresAt: null },
    { propertyId: L["Caranzalem Flat"]._id, date: night, bookingId: new mongoose.Types.ObjectId(), kind: "block", expiresAt: null },
  ]);
  const booked = await q({ location: "panaji", from: "2027-06-10", to: "2027-06-11" });
  assert.equal(booked.json.search.mode, "nearby");
  assert.equal(booked.json.search.reason, "dates");
  assert.ok(!titles(booked).includes("Panaji Loft") && !titles(booked).includes("Caranzalem Flat"));
  assert.equal(titles(booked)[0], "Porvorim House");
  // older site builds sent the browser's local midnight (IST → previous UTC day): same nights
  const legacy = await q({ location: "panaji", from: "2027-06-09T18:30:00.000Z", to: "2027-06-10T18:30:00.000Z" });
  assert.deepEqual(titles(legacy), titles(booked), "IST-midnight ISO dates check the calendar nights");
  const free = await q({ location: "panaji", from: "2027-06-11", to: "2027-06-12" });
  assert.equal(free.json.search.mode, "place");
  const reversed = await q({ location: "panaji", from: "2027-06-11", to: "2027-06-10" });
  assert.equal(reversed.json.search.mode, "place", "to ≤ from: dates ignored as before");

  // filters: no Panaji stay fits 20 guests → reason "filters"; nearby keeps the filter
  const big = await q({ location: "panaji", guests: "20" });
  assert.equal(big.json.search.mode, "nearby");
  assert.equal(big.json.search.reason, "filters");
  assert.deepEqual(titles(big), ["Arpora Apt B"], "nearby results still sleep 20");
  const bigDates = await q({ location: "panaji", guests: "20", from: "2027-06-10", to: "2027-06-11", propertyType: "", minPrice: "1000", maxPrice: "20000" });
  assert.deepEqual(titles(bigDates), ["Arpora Apt B"], "dates + guests + price all survive the fallback");
  const none = await q({ location: "panaji", guests: "99" });
  assert.equal(none.json.search.mode, "nearby");
  assert.deepEqual(none.json.data, []);
  assert.equal(none.json.search.nearestKm, null);

  // a later page past the end never switches mode
  const p3 = await q({ location: "panaji", limit: "1", page: "3" });
  assert.equal(p3.json.search.mode, "place");
  assert.deepEqual(p3.json.data, []);
  assert.equal(p3.json.pagination.totalCount, 2);
});

// ---------------------------------------------------------------------------
test("pages: deterministic, complete, no duplicates — newest first in a place, distance then newest when nearby", async () => {
  for (const params of [{ location: "goa" }, { location: "vasco" }, { lat: "15.57", lng: "73.77" }, {}]) {
    const full = await q({ ...params, limit: "50" });
    const seen = [];
    for (let page = 1; page <= Math.ceil(full.json.pagination.totalCount / 3); page++) {
      const r = await q({ ...params, limit: "3", page: String(page) });
      seen.push(...titles(r));
    }
    assert.deepEqual(seen, titles(full), JSON.stringify(params));
    assert.equal(new Set(seen).size, seen.length, "no duplicates across pages");
    assert.deepEqual(titles(await q({ ...params, limit: "50" })), titles(full), "repeatable");
  }
  const goa = await q({ location: "goa", limit: "50" });
  const created = goa.json.data.map((c) => new Date(c.createdAt).getTime());
  assert.deepEqual(created, [...created].sort((a, b) => b - a), "newest first");
});

// ---------------------------------------------------------------------------
test("precedence: placeId > near-me > text; unknown ids fall back; the heading is the server's canonical place", async () => {
  const both = await q({ placeId: PANAJI, location: "vasco" });
  assert.equal(both.json.search.place.id, PANAJI, "the chosen suggestion wins over stale text");
  assert.deepEqual(sorted(titles(both)), ["Caranzalem Flat", "Panaji Loft"]);
  const withPoint = await q({ placeId: PANAJI, lat: "26.91", lng: "80.98" });
  assert.equal(withPoint.json.search.mode, "place");
  const stale = await q({ placeId: "gn:999999999", location: "panjim" });
  assert.equal(stale.json.search.place.id, PANAJI, "unknown id → the text");
  const live = await q({ placeId: "l:goa:seraulim" });
  assert.deepEqual(titles(live), ["Seraulim Apt"]);
  assert.equal(live.json.search.place.name, "Seraulim");
  const goneLive = await q({ placeId: "l:goa:no-such-village" });
  assert.equal(goneLive.json.search.mode, "text");
  assert.deepEqual(goneLive.json.data, []);
  const pointBeatsText = await q({ lat: "15.57", lng: "73.77", location: "lucknow" });
  assert.equal(pointBeatsText.json.search.mode, "near");
});

// ---------------------------------------------------------------------------
test("near me: nearest first within 250 km; coordinates re-rounded to ~1 km server-side", async () => {
  const r = await q({ lat: "15.57", lng: "73.77" });
  assert.equal(r.json.search.mode, "near");
  assert.ok(titles(r)[0].startsWith("Arpora Apt"));
  assert.ok(!titles(r).includes("Lucknow House"));
  const precise = await q({ lat: "15.56789123", lng: "73.77012345" });
  assert.deepEqual(titles(precise), titles(r), "the server never uses more than 2 decimals");
  assert.deepEqual(precise.json.data.map((c) => c.distanceKm), r.json.data.map((c) => c.distanceKm));
});

// ---------------------------------------------------------------------------
test("hostile parameters: never operators, never 500, bounded work", async () => {
  const bad = [
    "location[]=goa",
    "location[$ne]=x",
    "location=goa&location=panaji",
    "placeId[$gt]=",
    "placeId=gn:123;drop",
    "placeId=" + "g".repeat(100),
    "lat=15.5",
    "lng=73.8",
    "lat=NaN&lng=73",
    "lat=Infinity&lng=73",
    "lat=91&lng=73",
    "lat=15&lng=181",
    "lat=1e2&lng=73",
    "guests=abc",
    "guests=-1",
    "guests[$gt]=0",
    "beds=2.5",
    "minPrice=1e999",
    "maxPrice=-5",
    "from=2026-02-30&to=2026-03-02",
    "from=nope&to=2027-01-01",
    "amenities[$in]=wifi",
    "location=" + "x".repeat(201),
    "propertyType=" + "v".repeat(51),
  ];
  for (const qs of bad) {
    const r = await raw(`/properties/search-properties?${qs}`);
    assert.equal(r.status, 400, qs);
    assert.equal(r.json.code, "INVALID_SEARCH_PARAM", qs);
    assert.ok(!r.headers["cdn-cache-control"], `${qs}: a 400 is never edge-cached`);
  }
  for (const location of [".*", "^Pan", "(a+)+$", "\\", "<img src=x onerror=alert(1)>", "'; db.dropDatabase(); '", "‮goa", "‮‮", "🙂", "a".repeat(200)]) {
    const t0 = Date.now();
    const r = await q({ location });
    assert.equal(r.status, 200, location);
    assert.ok(Date.now() - t0 < 2000, "bounded");
    assert.equal(r.headers["content-type"].split(";")[0], "application/json");
    assert.equal(r.json.search.query, location.trim(), "echoed as data, never interpreted");
  }
  assert.deepEqual(titles(await q({ location: ".*" })), [], "regex text is literal");
  const clamped = await q({ page: "-5", limit: "999999" });
  assert.equal(clamped.status, 200);
  assert.ok(clamped.json.data.length <= 50);
  assert.equal((await q({ location: "null" })).json.search.mode, "all", "'null' from old clients means unset");
});

// ---------------------------------------------------------------------------
test("filters: rooms are 'at least', amenities are 'all of'; site arrays and mobile comma lists both work", async () => {
  const beds = await q({ location: "north goa", beds: "3" });
  assert.deepEqual(titles(beds), ["Panaji Loft"]);
  const bedsAll = await q({ location: "north goa", beds: "2", limit: "50" });
  assert.ok(!titles(bedsAll).includes("Caranzalem Flat") && titles(bedsAll).includes("Panaji Loft"), "≥ 2");
  const mobile = await q({ location: "north goa", amenities: "wifi,pool" });
  assert.deepEqual(titles(mobile), ["Panaji Loft"]);
  const site = await raw("/properties/search-properties?location=north%20goa&amenities%5B%5D=wifi&amenities%5B%5D=pool");
  assert.deepEqual(titles(site), ["Panaji Loft"]);
  const onlyMax = await q({ location: "goa", maxPrice: "100", limit: "50" });
  assert.equal(onlyMax.json.search.mode, "nearby", "a lone max price applies (it used to be ignored)");
});

// ---------------------------------------------------------------------------
test("countstays and the suggestion index use the same rules; the index carries no coordinates or listing ids", async () => {
  const c = await raw("/properties/countstays?city=Panjim,Margao,Mandrem,Bardez,Unknownville,Calangute,North Goa");
  assert.deepEqual(c.json.data, [
    { city: "panjim", count: 2 },
    { city: "margao", count: 1 },
    { city: "mandrem", count: 1 },
    { city: "bardez", count: 6 },
    { city: "unknownville", count: 0 },
    { city: "calangute", count: 2 },
    { city: "north goa", count: 9 },
  ]);

  startCounting();
  const idx = await raw("/places/index");
  const idxOps = stopCounting();
  assert.equal(idx.status, 200);
  assert.ok(idxOps.length <= 1, idxOps.join(", "));
  assert.equal(idx.headers["cdn-cache-control"], "public, s-maxage=300, stale-while-revalidate=120");
  assert.equal(idx.headers["vercel-cache-tag"], "listings", "purged with every listing change");
  const { version, labels, rows } = idx.json;
  assert.equal(version, 1);
  const row = (id) => rows.find((r) => r[0] === id);
  assert.deepEqual(row(PANAJI).slice(0, 6), [PANAJI, "Panaji", "c", labels.indexOf("North Goa, Goa"), "Panjim|Pangim|Ponnje", 2]);
  assert.equal(row("st:goa")[5], 11);
  assert.equal(row("l:goa:seraulim")[5], 1);
  assert.equal(row("l:goa:seraulim")[2], "l");
  assert.ok(!/\b[0-9a-f]{24}\b/.test(idx.text), "no listing ids");
  assert.ok(!/\d{1,2}\.\d{3,}/.test(idx.text), "no coordinates");
  const gz = zlib.gzipSync(idx.text).length;
  console.log(`[size] places index: ${rows.length} rows, ${(idx.text.length / 1024).toFixed(0)} KB raw, ${(gz / 1024).toFixed(1)} KB gzip`);
  assert.ok(gz < 60 * 1024, `index ${gz} bytes gzip`);

  // an address edit is reflected on the next read (no stale classification)
  await ListingProperty().updateOne({ _id: L["Mandrem Villa"]._id }, { $set: { "address.city": "Panaji", "address.district": "", "address.latitude": 15.497, "address.longitude": 73.827 } });
  assert.equal((await q({ location: "panaji" })).json.pagination.totalCount, 3);
  assert.equal((await q({ location: "mandrem" })).json.search.mode, "nearby");
  await ListingProperty().updateOne({ _id: L["Mandrem Villa"]._id }, { $set: { "address.city": "Goa", "address.district": "Mandrem", "address.latitude": 15.662, "address.longitude": 73.716 } });
});

// ---------------------------------------------------------------------------
test("cost: ≤ 3 ops in every mode (with dates), ≤ 2 without; the edge caches date-less searches only", async () => {
  const cases = [
    [{ location: "panaji", from: "2027-06-10", to: "2027-06-11" }, 3],
    [{ location: "vasco", from: "2027-06-10", to: "2027-06-11", guests: "20" }, 3],
    [{ lat: "15.57", lng: "73.77", from: "2027-06-10", to: "2027-06-11" }, 3],
    [{ location: "Ledgerville", from: "2027-06-10", to: "2027-06-11" }, 3],
    [{ location: "panaji" }, 2],
    [{ location: "vasco" }, 2],
    [{ placeId: PANAJI, limit: "1", page: "9" }, 1],
  ];
  for (const [params, max] of cases) {
    startCounting();
    const r = await q(params);
    const got = stopCounting();
    assert.equal(r.status, 200);
    assert.ok(got.length <= max, `${JSON.stringify(params)}: ${got.join(", ")}`);
  }
  const cached = await q({ location: "vasco" });
  assert.equal(cached.headers["cdn-cache-control"], "public, s-maxage=300, stale-while-revalidate=120");
  const dated = await q({ location: "vasco", from: "2027-06-10", to: "2027-06-11" });
  assert.equal(dated.headers["cdn-cache-control"], undefined);
});

// ---------------------------------------------------------------------------
test("resolver: exact, qualified, generic words, typos only when unambiguous; normalisation pinned for the site", () => {
  const P = places();
  const name = (s, opts) => {
    const r = P.resolveQuery(s, opts);
    return r && r.place ? `${r.place.n}|${r.place.t}${r.corrected ? "*" : ""}` : r && r.suggestions ? "?" : null;
  };
  const cases = {
    goa: "Goa|state",
    "north goa": "North Goa|district",
    bardez: "Bardez|taluka",
    canacona: "Canacona|taluka",
    "old goa": "Old Goa|village",
    "vasco da gama": "Vasco da Gama|city",
    vascodagama: "Vasco da Gama|city",
    madgaon: "Margao|town",
    "margão": "Margao|town",
    "colva, goa": "Colva|town",
    "colva goa": "Colva|town",
    "candolim beach": "Candolim|town",
    "near baga": "Baga|village",
    bombay: "Mumbai|city",
    coorg: "Kodagu|district",
    manali: "Manali|town",
    "narendra nagar": "Narendranagar|village",
    vasko: "Vasco da Gama|city*",
    goaa: "Goa|state*",
    calangut: "Calangute|town*",
    pan: null,
    xyz: null,
    "e.g.": null,
    "": null,
  };
  for (const [input, want] of Object.entries(cases)) assert.equal(name(input), want, input);
  assert.equal(P.parentLabel(P.resolveQuery("manali").place), "Kulu, Himachal Pradesh", "the curated destination, not the Chennai suburb");
  assert.ok(P.resolveQuery("aurangabad").alternatives.length >= 1, "namesakes offered");

  const fixture = path.join(__dirname, "fixtures", "place-normalize-vectors.json");
  const sha = crypto.createHash("sha256").update(fs.readFileSync(fixture)).digest("hex");
  // Pinned: the customer site asserts the same file (user.website
  // src/lib/places/__fixtures__). Change both or neither.
  assert.equal(sha, "e1bc35da8ac20d7f4c5604a0bd5707e7f452a44df48907c0ced8ea52cbd9c7d2");
  for (const v of JSON.parse(fs.readFileSync(fixture, "utf8")).vectors) {
    assert.equal(placeText().normalizePlaceText(v.input), v.normalized, JSON.stringify(v.input));
    assert.equal(placeText().compactKey(v.normalized), v.compact);
  }
});

// ---------------------------------------------------------------------------
test("performance: resolution p95, classification and planning at 3,000 listings", () => {
  const P = places();
  P.placeById("warm");
  const queries = ["panjim", "panjm", "vasko", "calangut", "north goa", "colva goa", "candolim beach", "mumbai", "xyzzy", "manali", "kodaikanal", "dharamsala", "Ledgerville"];
  const times = [];
  for (let i = 0; i < 20; i++) {
    for (const s of queries) {
      const t = process.hrtime.bigint();
      P.resolveQuery(s);
      times.push(Number(process.hrtime.bigint() - t) / 1e6);
    }
  }
  times.sort((a, b) => a - b);
  const p50 = times[Math.floor(times.length * 0.5)];
  const p95 = times[Math.floor(times.length * 0.95)];
  console.log(`[perf] resolveQuery p50 ${p50.toFixed(2)} ms, p95 ${p95.toFixed(2)} ms`);
  assert.ok(p95 < 10, `p95 ${p95}`);

  const S = placeSearch();
  S._resetMemo();
  const docs = Array.from({ length: 3000 }, (_, i) => ({
    _id: new mongoose.Types.ObjectId(),
    createdAt: new Date(Date.now() - i * 1000),
    address: { city: ["Panaji", "Goa", "Arpora", "Seraulim", "Lucknow"][i % 5], district: ["Mandrem", "", "Colva"][i % 3], state: i % 5 === 4 ? "Uttar Pradesh" : "Goa", latitude: 15 + (i % 100) / 100, longitude: 73.7 + (i % 50) / 100 },
  }));
  let t = Date.now();
  const inv = docs.map(S.classify);
  const classifyMs = Date.now() - t;
  t = Date.now();
  const live = S.livePlaces(inv);
  const counts = S.countPlaces(inv, live);
  const openIds = new Set(inv.map((c) => c.id));
  const scope = S.resolveScope({ location: "vasco" }, { live, stays: (id) => counts.get(id) || 0, inv });
  const planned = S.plan(scope, { inv, openIds, booked: new Set() });
  const planMs = Date.now() - t;
  t = Date.now();
  inv.length = 0;
  docs.map(S.classify); // memoised
  const warmMs = Date.now() - t;
  console.log(`[perf] 3000 listings: classify ${classifyMs} ms cold / ${warmMs} ms warm, counts+resolve+plan ${planMs} ms, ${planned.rows.length} rows`);
  assert.ok(classifyMs < 1500 && warmMs < 300 && planMs < 1500);
});

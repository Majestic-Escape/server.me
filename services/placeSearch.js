// Place-aware stay search (docs/place-search.md).
//
// Listings are placed by geography first and text second: the host wizard's
// coordinates come from Google Places and are reliable, while the free-text
// city / district fields are not ("Goa" as a city, a taluka as a city,
// neighbourhoods and typos as the district). Every listing is classified
// into { state, district, taluka, localities } and a search for a place
// returns exactly the listings in it; when there are none the nearest ones
// are returned instead, with the reason.
//
// Privacy: every distance is measured from the listing's PUBLIC approximate
// point (utils/sanitizeResponse approximateLocation, 150–350 m off the true
// point), so neither ranking nor the rounded distances reveal more than the
// stay page already shows. The exact coordinates never influence output.
//
// Pure functions only — the controller does the (≤ 3) database operations.
const places = require("../utils/places");
const { normalizePlaceText, compactKey } = require("../utils/placeText");
const { approximateLocation } = require("../utils/sanitizeResponse");
const { escapeRegex } = require("../utils/listingProjection");
const { boundedEditDistance } = require("../utils/placeText");
const { maskContactInfo } = require("../utils/contactModeration");
const { extractPropertyType, typeWords, CONNECTORS } = require("../utils/propertyTypes");

// What one active listing contributes to search: location fields, plus the
// title / type / amenities for keyword search ("Dev Bhoomi Retreat").
const CITY_POP = 100000;
const LOCATION_PROJECTION = {
  _id: 1,
  createdAt: 1,
  "address.city": 1,
  "address.district": 1,
  "address.state": 1,
  "address.pincode": 1,
  "address.latitude": 1,
  "address.longitude": 1,
  title: 1,
  propertyType: 1,
  amenities: 1,
};
const NEARBY_MAX_KM = 250; // nearest-stays fallback / near-me cut-off
const BIG_TOWN_POP = 50000; // towns whose radius also claims neighbourhoods
const OFFSET_TOLERANCE_KM = 0.35; // max privacy offset: a stay never drops out of its town
const LOCALITY_INFER_KM = 5; // uninformative text → nearest settlement within this
const LOCALITY_SHARED_KM = 1.5; // …and every other settlement this close (a ward between two villages)
const ADMIN_INFER_KM = 60; // district / state from the nearest settlement within this
const MEMO_MAX = 5000;

// Words a host types into "city" that are not a place of their own.
const NOT_A_PLACE = new Set(["north", "south", "east", "west", "central", "centre", "center", "beach", "hill", "hills", "market", "road", "sector", "phase", "near", "test", "na", "none", "city", "town", "village", "india"]);

const memo = new Map();

function looksLikePlaceName(raw) {
  const s = String(raw || "").trim();
  if (s.length < 3 || s.length > 40) return false;
  if (!/^[\p{L}][\p{L} .'-]*$/u.test(s)) return false; // letters only: no digits, @, links
  if (s.split(/\s+/).length > 5) return false;
  const norm = normalizePlaceText(s);
  if (norm.replace(/ /g, "").length < 3 || NOT_A_PLACE.has(norm)) return false;
  return true;
}

function slugOf(norm) {
  return norm.replace(/ /g, "-");
}

function liveId(stateId, norm) {
  return `l:${stateId ? stateId.slice(3) : "in"}:${slugOf(norm)}`;
}

function pickNearest(cands, point) {
  if (cands.length === 1 || !point) {
    return [...cands].sort((a, b) => (b.p || 0) - (a.p || 0) || (a.id < b.id ? -1 : 1))[0];
  }
  let best = null;
  for (const p of cands) {
    if (!Number.isFinite(p.lat)) continue;
    const d = places.distanceKm(point, p);
    if (!best || d < best.d) best = { d, p };
  }
  return best ? best.p : cands[0];
}

/**
 * { id, createdAt, point|null (approximate), stateId, districtId, talukaId,
 *   localities:Set, liveName|null, raw:{city,district,state} }
 */
function classify(doc) {
  const id = String(doc._id);
  const a = doc.address || {};
  const lat = a.latitude;
  const lng = a.longitude;
  const key = `${id}|${a.city}|${a.district}|${a.state}|${a.pincode}|${lat}|${lng}|${doc.title}|${doc.propertyType}|${Array.isArray(doc.amenities) ? doc.amenities.join(",") : ""}`;
  const hit = memo.get(key);
  if (hit) return { ...hit, createdAt: doc.createdAt };

  let point = null;
  if (places.validPoint(lat, lng)) {
    const approx = approximateLocation(id, lat, lng);
    point = { lat: approx.latitude, lng: approx.longitude };
  }
  let stateId = places.stateFromText(a.state);
  let districtId = null;
  let talukaId = null;
  let liveName = null;
  let wardKey = null;
  const localities = new Set();
  for (const field of ["city", "district"]) {
    const text = a[field];
    const norm = normalizePlaceText(text);
    if (!norm) continue;
    const cands = places.lookupExact(norm, { stateId });
    // A name that is both a taluka / district and a small same-named village
    // ("Bardez") means the area, as it does in search; the stay is then
    // placed by its point like any other area-only address.
    const admin = cands.some((p) => p.t === "district" || p.t === "taluka");
    const locs = cands.filter((p) => places.isLocality(p) && (!admin || (p.p || 0) >= CITY_POP));
    if (locs.length) {
      localities.add(pickNearest(locs, point).id);
      continue;
    }
    if (!cands.length && field === "district" && looksLikePlaceName(text)) wardKey = norm; // "Bouta Waddo"
    const district = cands.find((p) => p.t === "district");
    const taluka = cands.find((p) => p.t === "taluka");
    const state = cands.find((p) => p.t === "state");
    if (district) districtId = districtId || district.id;
    if (taluka) talukaId = talukaId || taluka.id;
    if (state && !stateId) stateId = state.id;
    // An unknown real-looking city name becomes a live place, so a stay in a
    // village the gazetteer lacks is findable the moment it goes live.
    if (!cands.length && field === "city" && looksLikePlaceName(text)) liveName = String(text).trim();
  }
  const textLocalities = [...localities];
  if (point) {
    const admin = places.nearestSettlement(point, { stateId, maxKm: ADMIN_INFER_KM });
    if (admin) {
      stateId = stateId || admin.place.s;
      districtId = districtId || admin.place.d || null;
      talukaId = talukaId || admin.place.k || null;
    }
    if (!localities.size && !liveName) {
      const near = places.nearestSettlement(point, { stateId, maxKm: LOCALITY_INFER_KM });
      if (near) {
        localities.add(near.place.id);
        for (const p of places.localitiesNear(point, LOCALITY_SHARED_KM, (x) => x.t !== "live" && (!stateId || x.s === stateId))) localities.add(p.id);
      }
    }
  }
  for (const lid of localities) {
    const p = places.placeById(lid);
    if (!p) continue;
    stateId = stateId || p.s || null;
    districtId = districtId || p.d || null;
    talukaId = talukaId || p.k || null;
  }
  if (liveName) {
    const lid = liveId(stateId, normalizePlaceText(liveName));
    localities.add(lid);
    textLocalities.push(lid);
  }
  const cls = { id, point, stateId, districtId, talukaId, localities, textLocalities, wardKey, liveName, raw: { city: a.city, district: a.district, state: a.state, pincode: a.pincode } };
  Object.assign(cls, keywordFields(doc, cls));
  if (memo.size >= MEMO_MAX) memo.clear();
  memo.set(key, cls);
  return { ...cls, createdAt: doc.createdAt };
}

// Words a listing can be found by. The title is taken as the public card
// shows it (contact details masked) and tokens with 3+ digits are dropped,
// so a phone number (or half of one) hidden in a title can never be found
// by searching for it.
function keywordFields(doc, cls) {
  const title = maskContactInfo(String(doc.title || "").slice(0, 200));
  const titleNorm = normalizePlaceText(title);
  const titleTokens = titleNorm.split(" ").filter((t) => t && !/\d{3,}/.test(t));
  const words = new Set(titleTokens);
  const add = (text) => {
    for (const t of normalizePlaceText(text).split(" ")) if (t && !/\d{3,}/.test(t)) words.add(t);
  };
  for (const w of typeWords(doc.propertyType)) words.add(w);
  add(cls.raw.city);
  add(cls.raw.district);
  add(cls.raw.state);
  for (const id of [...cls.localities, cls.talukaId, cls.districtId, cls.stateId]) placeWords(id, add);
  if (cls.liveName) add(cls.liveName);
  if (Array.isArray(doc.amenities)) for (const x of doc.amenities.slice(0, 60)) add(String(x).replace(/_/g, " "));
  const titleNormKept = titleTokens.join(" ");
  return { titleNorm: titleNormKept, titleCompact: titleNormKept.replace(/ /g, ""), titleTokens, words, propertyType: String(doc.propertyType || "").toLowerCase() };
}

function placeWords(id, add) {
  const p = id && places.placeById(id);
  if (!p) return;
  add(p.n);
  for (const alias of p.a || []) add(alias);
}

// What was typed, as keyword tokens: connectors ("in", "stay") and single
// characters dropped, at most 8.
function keywordTokens(norm) {
  return String(norm || "").split(" ").filter((t) => t.length >= 2 && !CONNECTORS.has(t)).slice(0, 8);
}

// Every token must match a word of the listing (as a prefix, so partial
// typing works; or one typo in a title word of 5+ letters). Best first:
// 0 the phrase is in the title, 1 every token is in the title, 2 mixed
// (title / type / location / amenities), 3 no title word at all.
function keywordScore(c, tokens, phrase) {
  if (!tokens.length) return -1;
  let inTitle = 0;
  for (const q of tokens) {
    let titleHit = c.titleTokens.some((w) => w.startsWith(q));
    if (!titleHit && q.length >= 5) {
      titleHit =
        c.titleCompact.includes(q) || // words typed together: "devbhoomi"
        c.titleTokens.some((w) => w[0] === q[0] && Math.abs(w.length - q.length) <= 1 && boundedEditDistance(q, w, 1) <= 1);
    }
    if (titleHit) {
      inTitle++;
      continue;
    }
    let hit = false;
    for (const w of c.words) {
      if (w.startsWith(q)) {
        hit = true;
        break;
      }
    }
    if (!hit) return -1;
  }
  if (phrase && c.titleNorm.includes(phrase)) return 0;
  if (inTitle === tokens.length) return 1;
  return inTitle ? 2 : 3;
}

/**
 * Classify every active listing, then link wards: an area name the
 * gazetteer lacks ("Bouta Waddo") that another listing in the same state
 * pairs with a real village ("Assagao") belongs to that village too — so a
 * stay saved as city "Goa", district "Bouta Waddo" is found under Assagao.
 */
function classifyAll(docs) {
  const inv = docs.map(classify);
  const wards = new Map(); // "<state>|<ward>" -> Set of locality ids named in text
  for (const c of inv) {
    if (!c.wardKey || !c.textLocalities.length) continue;
    const k = `${c.stateId}|${c.wardKey}`;
    if (!wards.has(k)) wards.set(k, new Set());
    for (const id of c.textLocalities) wards.get(k).add(id);
  }
  if (!wards.size) return inv;
  return inv.map((c) => {
    if (!c.wardKey || c.textLocalities.length) return c;
    const linked = wards.get(`${c.stateId}|${c.wardKey}`);
    if (!linked) return c;
    const words = new Set(c.words);
    for (const id of linked) placeWords(id, (text) => normalizePlaceText(text).split(" ").forEach((t) => t && words.add(t)));
    return { ...c, localities: new Set([...c.localities, ...linked]), words };
  });
}

/** Live places (unknown villages named by active listings) with centroids. */
function livePlaces(classes) {
  const byId = new Map();
  for (const c of classes) {
    if (!c.liveName) continue;
    const norm = normalizePlaceText(c.liveName);
    const id = liveId(c.stateId, norm);
    let p = byId.get(id);
    if (!p) {
      p = { id, n: c.liveName, t: "live", s: c.stateId || undefined, d: c.districtId || undefined, k: c.talukaId || undefined, keys: [compactKey(norm)], sumLat: 0, sumLng: 0, pts: 0 };
      byId.set(id, p);
    }
    if (c.point) {
      p.sumLat += c.point.lat;
      p.sumLng += c.point.lng;
      p.pts += 1;
    }
  }
  for (const p of byId.values()) {
    if (p.pts) {
      p.lat = Math.round((p.sumLat / p.pts) * 1e4) / 1e4;
      p.lng = Math.round((p.sumLng / p.pts) * 1e4) / 1e4;
    }
    delete p.sumLat;
    delete p.sumLng;
    delete p.pts;
  }
  return byId;
}

function bigTownClaims(place, cls) {
  if (!cls.point || !Number.isFinite(place.lat) || (place.p || 0) < BIG_TOWN_POP) return false;
  // same taluka (Goa) or district: Porvorim, across the river, is not Panaji
  if (place.k && cls.talukaId && place.k !== cls.talukaId) return false;
  if (!place.k && place.d && cls.districtId && place.d !== cls.districtId) return false;
  return places.distanceKm(cls.point, place) <= place.r + OFFSET_TOLERANCE_KM;
}

function inPlace(cls, place) {
  switch (place.t) {
    case "state":
      return cls.stateId === place.id;
    case "district":
      return cls.districtId === place.id;
    case "taluka":
      return cls.talukaId === place.id;
    default:
      return cls.localities.has(place.id) || bigTownClaims(place, cls);
  }
}

/** Active-listing count per place id (static + live), same rules as inPlace. */
function countPlaces(classes, live) {
  const counts = new Map();
  const inc = (id) => id && counts.set(id, (counts.get(id) || 0) + 1);
  for (const c of classes) {
    const ids = new Set([c.stateId, c.districtId, c.talukaId, ...c.localities]);
    for (const p of places.localitiesNear(c.point, 25 + OFFSET_TOLERANCE_KM, (x) => (x.p || 0) >= BIG_TOWN_POP)) {
      if (bigTownClaims(p, c)) ids.add(p.id);
    }
    for (const id of ids) inc(id);
  }
  for (const id of live.keys()) if (!counts.has(id)) counts.set(id, 0);
  return counts;
}

/**
 * Turn the request into a scope.
 *   placeId (authoritative) > lat,lng ("near me") > location text > everything.
 * An unknown placeId (renamed village, stale link) falls back to the text.
 */
function resolveScope({ placeId, point, location, explicitType = false }, { live, stays, inv = [] }) {
  const extra = [...live.values()];
  // "stays within 50 km" — breaks typo ties towards where the stays are
  const nearStock = (p) => Number.isFinite(p.lat) && inv.some((c) => c.point && places.distanceKm(c.point, p) <= 50);
  if (placeId) {
    const p = places.placeById(placeId) || live.get(placeId);
    if (p) return { kind: "place", place: p, corrected: false, alternatives: [] };
    if (placeId.startsWith("l:") && !location) {
      return { kind: "text", query: placeId.split(":").slice(2).join(" ").replace(/-/g, " ") };
    }
  }
  if (point) return { kind: "near", point };
  if (location) {
    const opts = { extra, stays, nearStock };
    // 1. a place, exactly ("panjim", "North Goa", "Colva, Goa")
    const exact = places.resolveQuery(location, { ...opts, fuzzy: false });
    if (exact && exact.place) return { kind: "place", place: exact.place, corrected: false, alternatives: exact.alternatives || [] };
    // 2. a property type and a place ("tent in dharamshala", "north goa villas", "villas")
    const norm = normalizePlaceText(location);
    const typed = explicitType ? null : extractPropertyType(norm);
    if (typed && !typed.rest) return { kind: "all", propertyType: typed.type };
    if (typed) {
      const r = places.resolveQuery(typed.rest, { ...opts, fuzzy: false });
      if (r && r.place) return { kind: "place", place: r.place, propertyType: typed.type, corrected: false, alternatives: r.alternatives || [] };
    }
    // 3. a stay by its name or words ("Dev Bhoomi Retreat", "classic tent", "pool villa goa")
    const tokens = keywordTokens(norm);
    const phrase = tokens.join(" ");
    if (tokens.length && inv.some((c) => keywordScore(c, tokens, phrase) >= 0)) return { kind: "keyword", query: location, tokens, phrase };
    // 4. a typo in a place, with or without a type ("villa in morjm", "panjm")
    if (typed) {
      const r = places.resolveQuery(typed.rest, opts);
      if (r && r.place) return { kind: "place", place: r.place, propertyType: typed.type, corrected: r.corrected, alternatives: r.alternatives || [] };
    }
    const r = places.resolveQuery(location, opts);
    if (r && r.place) return { kind: "place", place: r.place, corrected: r.corrected, alternatives: r.alternatives || [] };
    return {
      kind: "text",
      query: location,
      suggestions: r && r.suggestions ? r.suggestions : null,
      suggest: () => places.suggestFor(location, { extra, stays, nearStock }),
    };
  }
  return { kind: "all" };
}

function newestFirst(a, b) {
  const ta = a.createdAt ? new Date(a.createdAt).getTime() : 0;
  const tb = b.createdAt ? new Date(b.createdAt).getTime() : 0;
  if (ta !== tb) return tb - ta;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0; // _id desc, like the old sort
}

function byDistance(origin, rows) {
  return rows
    .filter((c) => c.point)
    .map((c) => ({ c, d: places.distanceKm(origin, c.point) }))
    .filter((x) => x.d <= NEARBY_MAX_KM)
    .sort((x, y) => x.d - y.d || newestFirst(x.c, y.c))
    .map((x) => ({ ...x.c, distanceKm: Math.round(x.d * 10) / 10 }));
}

function publicLive(p) {
  if (!p || p.t !== "live") return places.publicPlace(p);
  const parts = [];
  if (p.d) {
    const d = places.placeById(p.d);
    if (d) parts.push(d.n);
  }
  if (p.s) {
    const s = places.placeById(p.s);
    if (s) parts.push(s.n);
  }
  return { id: p.id, name: p.n, type: "town", label: parts.join(", ") };
}

/**
 * The ordered result list for a scope.
 *   inv      classified active listings (every one, regardless of filters)
 *   openIds  ids passing the non-date filters
 *   booked   ids unavailable for the requested nights
 * Returns { rows, search } — rows carry distanceKm in nearby / near mode.
 * The nearby fallback happens only when the WHOLE filtered in-place set is
 * empty (never because a later page is), and keeps every other filter.
 */
function plan(scope, { inv, openIds, booked }) {
  // a type named in the text ("villas in goa") filters like the type chip
  const typeOk = scope.propertyType ? (c) => c.propertyType === scope.propertyType : () => true;
  const open = (c) => openIds.has(c.id) && typeOk(c);
  const available = (c) => open(c) && !booked.has(c.id);
  const meta = { mode: scope.kind, query: null, place: null, propertyType: scope.propertyType || null, corrected: false, alternatives: [], reason: null, nearestKm: null, suggestions: [] };
  if (scope.kind === "keyword") {
    meta.mode = "text";
    meta.query = scope.query;
    const scored = [];
    for (const c of inv) {
      const s = keywordScore(c, scope.tokens, scope.phrase);
      if (s >= 0) scored.push([c, s]);
    }
    const rows = scored.filter(([c]) => available(c)).sort((x, y) => x[1] - y[1] || newestFirst(x[0], y[0])).map(([c]) => c);
    if (!rows.length) meta.reason = scored.some(([c]) => openIds.has(c.id)) ? "dates" : "filters";
    return { rows, search: meta };
  }
  if (scope.kind === "all") {
    return { rows: inv.filter(available).sort(newestFirst), search: meta };
  }
  if (scope.kind === "text") {
    meta.query = scope.query;
    // a 6-digit PIN code matches the listing PIN; anything else is the
    // legacy literal substring match on city / district / state
    const compactQuery = scope.query.replace(/\s+/g, "");
    const pin = /^\d{6}$/.test(compactQuery) ? compactQuery : null; // "403001" or "403 001"
    const rx = new RegExp(escapeRegex(scope.query), "i");
    const test = (v) => typeof v === "string" && rx.test(v);
    const match = pin ? (c) => String(c.raw.pincode || "").trim() === pin : (c) => test(c.raw.city) || test(c.raw.district) || test(c.raw.state);
    const rows = inv.filter((c) => available(c) && match(c)).sort(newestFirst);
    if (!rows.length) meta.suggestions = (scope.suggestions || (scope.suggest ? scope.suggest() : [])).map(publicLive);
    return { rows, search: meta };
  }
  if (scope.kind === "near") {
    meta.mode = "near";
    const rows = byDistance(scope.point, inv.filter(available));
    meta.nearestKm = rows.length ? rows[0].distanceKm : null;
    return { rows, search: meta };
  }
  // place
  const place = scope.place;
  meta.place = publicLive(place);
  meta.corrected = !!scope.corrected;
  meta.alternatives = (scope.alternatives || []).map(publicLive);
  const inside = inv.filter((c) => inPlace(c, place));
  const rows = inside.filter(available).sort(newestFirst);
  if (rows.length) return { rows, search: { ...meta, mode: "place" } };
  meta.mode = "nearby";
  meta.reason = !inside.length ? "no_inventory" : !inside.some((c) => open(c)) ? "filters" : "dates";
  const origin = Number.isFinite(place.lat) && Number.isFinite(place.lng) ? { lat: place.lat, lng: place.lng } : null;
  const near = origin ? byDistance(origin, inv.filter((c) => available(c) && !inPlace(c, place))) : [];
  meta.nearestKm = near.length ? near[0].distanceKm : null;
  return { rows: near, search: meta };
}

// Compact suggestion index for the customer site (GET /places/index):
//   rows: [id, name, type, labelIndex, "alias|alias", stays, populationK]
//   type: s state, d district, k taluka, c city, t town, v village, a area,
//         b beach, i island, l live (a village named only by listings)
// Only names, parents and counts — no coordinates, no listing ids.
const TYPE_CODE = { state: "s", district: "d", taluka: "k", city: "c", town: "t", village: "v", area: "a", beach: "b", island: "i", live: "l" };
const CLIENT_ALIASES = 3;

function clientIndex(counts, live) {
  const labels = [];
  const labelIdx = new Map();
  const label = (s) => {
    if (!labelIdx.has(s)) {
      labelIdx.set(s, labels.length);
      labels.push(s);
    }
    return labelIdx.get(s);
  };
  const rows = [];
  const push = (p, lbl) => {
    rows.push([p.id, p.n, TYPE_CODE[p.t] || "t", label(lbl), (p.a || []).slice(0, CLIENT_ALIASES).join("|"), counts.get(p.id) || 0, Math.round((p.p || 0) / 1000)]);
  };
  for (const p of places.allPlaces().values()) {
    const shown = p.t === "state" || p.t === "district" || p.t === "taluka" || p.v || counts.get(p.id) > 0;
    if (shown) push(p, places.parentLabel(p));
  }
  for (const p of live.values()) push(p, publicLive(p).label);
  return { version: 1, labels, rows };
}

module.exports = {
  LOCATION_PROJECTION,
  clientIndex,
  NEARBY_MAX_KM,
  OFFSET_TOLERANCE_KM,
  classify,
  classifyAll,
  keywordTokens,
  keywordScore,
  livePlaces,
  countPlaces,
  inPlace,
  resolveScope,
  plan,
  publicLive,
  looksLikePlaceName,
  _resetMemo: () => memo.clear(),
};

// Place gazetteer: states, districts, Goa talukas and localities (cities,
// towns, villages, beaches) of India, built from GeoNames by
// scripts/build-places.js into data/places/places.json.
//
// Loaded with a static require (so the Vercel bundle always contains it) and
// indexed lazily on first use — nothing here touches the database. Place ids
// are stable across rebuilds: st:<slug> for states, gn:<geonameid> otherwise;
// retired ids map through `redirects`. Live places derived from listings
// (l:<state>:<slug>, see services/placeSearch.js) are merged in by callers.
const { normalizePlaceText, compactKey, boundedEditDistance, fuzzyBudget } = require("./placeText");

const LOCALITY_TYPES = new Set(["city", "town", "village", "area", "beach", "island", "live"]);
const GRID = 0.25; // degrees per spatial-index cell (~27 km)
const CITY_POP = 100000;
// Words people add around a place name: "candolim beach", "near baga".
const GENERIC_WORDS = new Set(["beach", "beaches", "city", "town", "village", "district", "taluka", "area", "near", "in", "the"]);

let idx = null;

function data() {
  return require("../data/places/places.json");
}

function build() {
  const d = data();
  const byId = new Map();
  const byKey = new Map(); // normalised name/alias -> [place]
  const byCompact = new Map(); // compact key -> [place]
  const grid = new Map(); // "i,j" -> [locality]
  const keysByLen = new Map(); // key length -> [[compactKey, place]] for fuzzy scans
  const add = (map, k, p) => {
    if (!k) return;
    const list = map.get(k);
    if (!list) map.set(k, [p]);
    else if (!list.includes(p)) list.push(p);
  };
  const all = [...d.states.map((s) => ({ ...s, t: "state" })), ...d.places];
  for (const p of all) {
    byId.set(p.id, p);
    p._nk = compactKey(normalizePlaceText(p.n));
    const names = [p.n, ...(p.a || [])];
    const seen = new Set();
    for (const name of names) {
      const k = normalizePlaceText(name);
      const c = compactKey(k);
      add(byKey, k, p);
      add(byCompact, c, p);
      if (c && !seen.has(c)) {
        seen.add(c);
        if (!keysByLen.has(c.length)) keysByLen.set(c.length, []);
        keysByLen.get(c.length).push([c, p]);
      }
    }
    if (LOCALITY_TYPES.has(p.t) && Number.isFinite(p.lat) && Number.isFinite(p.lng)) {
      const cell = `${Math.floor(p.lat / GRID)},${Math.floor(p.lng / GRID)}`;
      if (!grid.has(cell)) grid.set(cell, []);
      grid.get(cell).push(p);
    }
  }
  return { version: d.version, redirects: d.redirects || {}, byId, byKey, byCompact, grid, keysByLen, states: d.states };
}

function index() {
  if (!idx) idx = build();
  return idx;
}

function isLocality(p) {
  return !!p && LOCALITY_TYPES.has(p.t);
}

function placeById(id) {
  if (typeof id !== "string" || id.length > 80) return null;
  const i = index();
  const target = i.redirects[id] || id;
  return i.byId.get(target) || null;
}

function validPoint(lat, lng) {
  if (typeof lat !== "number" || typeof lng !== "number") return false;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return false;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return false;
  if (lat === 0 && lng === 0) return false; // the classic "unset" pair
  return true;
}

function distanceKm(a, b) {
  const R = 6371;
  const toRad = (x) => (x * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Places whose name or alias equals the text (normalised, then space-free). */
function lookupExact(text, { stateId = null, extra = null } = {}) {
  const k = normalizePlaceText(text);
  if (!k) return [];
  const i = index();
  let list = [...new Set([...(i.byKey.get(k) || []), ...(i.byCompact.get(compactKey(k)) || [])])];
  if (extra) {
    const c = compactKey(k);
    const more = extra.filter((p) => p.keys.includes(c));
    if (more.length) list = [...list, ...more];
  }
  if (stateId) list = list.filter((p) => p.id === stateId || p.s === stateId);
  return list;
}

/** The state a listing's (dropdown) state text names, or null. */
function stateFromText(text) {
  const hit = lookupExact(text).find((p) => p.t === "state");
  return hit ? hit.id : null;
}

/** Nearest locality to a point within maxKm (same state first when given). */
function nearestSettlement(point, { stateId = null, maxKm = 5 } = {}) {
  if (!point || !validPoint(point.lat, point.lng)) return null;
  const i = index();
  const span = Math.ceil(maxKm / 27) + 1;
  const ci = Math.floor(point.lat / GRID);
  const cj = Math.floor(point.lng / GRID);
  let best = null;
  let bestAny = null;
  for (let di = -span; di <= span; di++) {
    for (let dj = -span; dj <= span; dj++) {
      const cell = i.grid.get(`${ci + di},${cj + dj}`);
      if (!cell) continue;
      for (const p of cell) {
        const d = distanceKm(point, p);
        if (d > maxKm) continue;
        if (!bestAny || d < bestAny.km) bestAny = { place: p, km: d };
        if (stateId && p.s !== stateId) continue;
        if (!best || d < best.km) best = { place: p, km: d };
      }
    }
  }
  return best || (stateId ? null : bestAny);
}

/** Localities within maxKm of a point that pass `keep` (grid scan). */
function localitiesNear(point, maxKm, keep = () => true) {
  if (!point || !validPoint(point.lat, point.lng)) return [];
  const i = index();
  const span = Math.ceil(maxKm / 27) + 1;
  const ci = Math.floor(point.lat / GRID);
  const cj = Math.floor(point.lng / GRID);
  const out = [];
  for (let di = -span; di <= span; di++) {
    for (let dj = -span; dj <= span; dj++) {
      const cell = i.grid.get(`${ci + di},${cj + dj}`);
      if (!cell) continue;
      for (const p of cell) if (keep(p) && distanceKm(point, p) <= maxKm) out.push(p);
    }
  }
  return out;
}

function stateName(id) {
  const p = placeById(id);
  return p ? p.n : "";
}

/** "North Goa, Goa" for a locality, "Goa" for a district, "" for a state. */
function parentLabel(p) {
  if (!p || p.t === "state") return "";
  const parts = [];
  if (p.t !== "district" && p.d) {
    const d = placeById(p.d);
    if (d) parts.push(d.n);
  }
  if (p.s) parts.push(stateName(p.s));
  return parts.join(", ");
}

function publicPlace(p) {
  if (!p) return null;
  return { id: p.id, name: p.n, type: p.t, label: parentLabel(p) };
}

// How strongly a candidate claims a query, best first:
//   a state ("goa"); then a place whose own name matches over one that only
//   has it as an alias ("Old Goa" the town, not an alias of Goa Velha); then
//   a city of 100k+ ("Pune"), then a district / taluka ("Canacona", "Bardez":
//   the area a traveller means), then smaller localities; then places with
//   stays, near stays, curated destinations ("Manali" in Himachal, not the
//   Chennai suburb), population; the id keeps it deterministic.
function claimKey(p, query, ctx) {
  const tier = p.t === "state" ? 0 : isLocality(p) && (p.p || 0) >= CITY_POP ? 1 : p.t === "district" || p.t === "taluka" ? 2 : 3;
  return [
    p.t === "state" ? 0 : 1,
    query && p._nk && p._nk === query ? 0 : 1,
    tier,
    ctx.stays && ctx.stays(p.id) > 0 ? 0 : 1,
    ctx.nearStock && ctx.nearStock(p) ? 0 : 1,
    p.fav ? 0 : 1,
    -(p.p || 0),
    p.id,
  ];
}

function compareKeys(a, b) {
  for (let i = 0; i < a.length; i++) {
    if (a[i] < b[i]) return -1;
    if (a[i] > b[i]) return 1;
  }
  return 0;
}

function ranked(cands, query, ctx) {
  const uniq = [...new Map(cands.map((p) => [p.id, p])).values()];
  const keyed = uniq.map((p) => [claimKey(p, query, ctx), p]);
  keyed.sort((x, y) => compareKeys(x[0], y[0]));
  return keyed.map((x) => x[1]);
}

function isAncestor(qualifier, p) {
  return qualifier.id === p.s || qualifier.id === p.d || qualifier.id === p.k;
}

function stripGeneric(norm) {
  const t = norm.split(" ");
  while (t.length > 1 && GENERIC_WORDS.has(t[0])) t.shift();
  while (t.length > 1 && GENERIC_WORDS.has(t[t.length - 1])) t.pop();
  return t.join(" ");
}

function fuzzyHits(c, budget, extra) {
  const i = index();
  const best = new Map(); // place id -> [distance, place]
  let bestD = budget + 1;
  const scan = (key, p) => {
    const d = boundedEditDistance(c, key, budget);
    if (d > budget) return;
    const prev = best.get(p.id);
    if (!prev || d < prev[0]) best.set(p.id, [d, p]);
    if (d < bestD) bestD = d;
  };
  for (let len = c.length - budget; len <= c.length + budget; len++) {
    for (const [key, p] of i.keysByLen.get(len) || []) scan(key, p);
  }
  for (const p of extra) for (const key of p.keys) if (Math.abs(key.length - c.length) <= budget) scan(key, p);
  return { bestD, hits: [...best.values()] };
}

/**
 * Resolve what someone typed to one place.
 *   exact name/alias (authoritative) → { place, alternatives (namesakes), corrected:false }
 *   "Colva, Goa" / "Colva Goa"        → the Colva inside Goa
 *   "candolim beach", "near baga"     → Candolim, Baga
 *   a close typo ("panjm", "vasko")   → { place, corrected:true } when one
 *                                       candidate clearly wins
 *   an ambiguous typo                 → { place:null, suggestions:[…] }
 *   nothing                           → null
 * `extra` are live places ({ id, n, t:"live", s, keys:[compact…] }),
 * `stays(id)` the active-listing count, `nearStock(place)` whether stays
 * exist near it — both only break ties between otherwise equal candidates.
 */
function resolveQuery(text, { extra = [], stays = null, nearStock = null } = {}) {
  const norm = normalizePlaceText(text);
  if (!norm) return null;
  const ctx = { stays, nearStock };
  for (const p of extra) if (!p._nk) p._nk = compactKey(normalizePlaceText(p.n));
  const pick = (cands, query, corrected) => {
    const order = ranked(cands, query, ctx);
    const place = order[0];
    const alternatives = order.slice(1).filter((p) => p._nk === place._nk).slice(0, 3);
    return { place, alternatives, corrected };
  };

  const c = compactKey(norm);
  const exact = lookupExact(norm, { extra });
  if (exact.length) return pick(exact, c, false);
  const stripped = stripGeneric(norm);
  if (stripped !== norm) {
    const again = lookupExact(stripped, { extra });
    if (again.length) return pick(again, compactKey(stripped), false);
  }

  // Parent-qualified: "colva, goa", "colva goa", "colva north goa".
  const commaParts = String(text).split(",").map(normalizePlaceText).filter(Boolean);
  const tries = [];
  if (commaParts.length > 1) tries.push([commaParts[0], commaParts.slice(1)]);
  const tokens = stripped.split(" ");
  for (let k = Math.min(3, tokens.length - 1); k >= 1; k--) {
    tries.push([tokens.slice(0, tokens.length - k).join(" "), [tokens.slice(tokens.length - k).join(" ")]]);
  }
  for (const [head, quals] of tries) {
    const qualifiers = quals.flatMap((q) => lookupExact(q).filter((p) => p.t === "state" || p.t === "district" || p.t === "taluka"));
    if (!qualifiers.length) continue;
    const h = stripGeneric(head);
    const heads = lookupExact(h, { extra }).filter((p) => qualifiers.some((q) => isAncestor(q, p)));
    if (heads.length) return pick(heads, compactKey(h), false);
  }

  // Typo tolerance: the best candidate within the edit budget, only when it
  // clearly wins (a single place, or one with stays / near stays / curated
  // where the others have none, or ten times the population).
  const sc = compactKey(stripped);
  const budget = fuzzyBudget(sc.length);
  if (!budget) return null;
  const { bestD, hits } = fuzzyHits(sc, budget, extra);
  const top = hits.filter(([d]) => d === bestD).map(([, p]) => p);
  if (!top.length) return null;
  if (top.length === 1) return pick(top, null, true);
  const order = ranked(top, null, ctx);
  const [a, b] = order;
  const ka = claimKey(a, null, ctx);
  const kb = claimKey(b, null, ctx);
  const signal = (k) => k.slice(3, 6).join(""); // stays, near stays, curated
  const prominent = ka[2] <= 1 && ka[2] < kb[2]; // a state or 100k+ city over a lesser place
  const clearWinner = prominent || signal(ka) < signal(kb) || ((a.p || 0) >= 5000 && (a.p || 0) >= 10 * (b.p || 0));
  if (clearWinner) return pick(order, null, true);
  return { place: null, alternatives: [], corrected: false, suggestions: order.slice(0, 3) };
}

/** Close names for a query that resolved to nothing (for "did you mean"). */
function suggestFor(text, { extra = [], stays = null, nearStock = null, limit = 3 } = {}) {
  const c = compactKey(stripGeneric(normalizePlaceText(text)));
  if (c.length < 3) return [];
  const budget = Math.max(1, fuzzyBudget(c.length));
  const { hits } = fuzzyHits(c, budget, extra);
  const ctx = { stays, nearStock };
  hits.sort((x, y) => x[0] - y[0] || compareKeys(claimKey(x[1], null, ctx), claimKey(y[1], null, ctx)));
  return hits.slice(0, limit).map(([, p]) => p);
}

function allPlaces() {
  return index().byId;
}

module.exports = {
  LOCALITY_TYPES,
  isLocality,
  placeById,
  validPoint,
  distanceKm,
  lookupExact,
  stateFromText,
  nearestSettlement,
  localitiesNear,
  parentLabel,
  publicPlace,
  resolveQuery,
  suggestFor,
  allPlaces,
  version: () => index().version,
  _reset: () => {
    idx = null;
  },
};

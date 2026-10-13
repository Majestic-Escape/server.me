// "More stays hosted by …" and "Similar stays nearby" for a stay page
// (docs/related-stays.md). Public listings only (utils/listingProjection.js
// publicListingFilter), public data only: every distance is measured between
// APPROXIMATE public points (the same ones the cards show) — a listing's exact
// location never influences what is returned or in which order.
//
// relatedFor(id) runs at most three listing queries:
//   Q1  the source, by _id (indexed) — a source that is not public ends here
//   Q2  the ranking pool, minimal projection: the source host's public stays
//       plus the public stays inside a box around the source's PUBLIC point
//       that reaches past 250 km by more than the approximation offset — a
//       superset of everything the nearby ring can keep, so the result is
//       still a function of the public points alone (poolFilter)
//   Q3  the picked cards plus the source again, with the card projection and
//       the masking context — skipped when nothing was picked
// Between Q2 and Q3 a listing may change. Q3 re-checks everything it shows:
// the source must still be public with the same host and public point (else
// fail closed — no rows), every card must still be public, host-row cards
// must still belong to the source's host, distances are recomputed from the
// emitted points and the ranking runs again on what is left. Rows can only
// shrink (no refill query); they may not be the global optimum after a
// concurrent change.
const ListingProperty = require("../models/ListingProperty");
const { validPoint, distanceKm } = require("../utils/places");
const { approximateLocation, sanitizeProperty, OFFSET_MAX_M } = require("../utils/sanitizeResponse");
const { CARD_MASK_CONTEXT, publicListingFilter } = require("../utils/listingProjection");

const HOST_LIMIT = 12;
const NEARBY_LIMIT = 8;
const NEAR_KM = 25;
const WIDE_KM = 250; // = the search's nearest-stays cut-off (services/placeSearch.js)
const MIN_NEAR = 4; // fewer near stays than this → the wide ring is appended
const NEAR_BAND_KM = 5;
const WIDE_BAND_KM = 25;
const PRICE_TOLERANCE = 0.35;
const GUESTS_TOLERANCE = 2;
const EPS = 1e-9;
const POOL_BATCH = 20000;
// server-side limit for each listing query: a request the caller has given up
// on (site: 2.5 s server render, 5 s per browser attempt) cannot keep a scan
// running unbounded; exceeding it is a 500, never cached
const QUERY_MAX_MS = 3000;
const KM_PER_DEG = (2 * Math.PI * 6371) / 360; // the sphere of utils/places.js distanceKm
// beyond the largest approximation offset, plus float slack
const PREFILTER_MARGIN_KM = OFFSET_MAX_M / 1000 + 0.65;

// The card read (Q3): what cardOf emits plus every input of the masking —
// maskListingText reads title + description + customRules + safety-feature
// descriptions as ONE text (a number split across them is masked), and the
// exact address lines (CARD_MASK_CONTEXT, selected next to it). Only the
// cardOf allow-list leaves the server; the rest is masking context.
const CARD_READ = "title description customRules safetyFeatures propertyType basePrice guests bedrooms averageRating reviewCount createdAt host address.city address.district address.state address.latitude address.longitude";

// The ranking pool: exactly the fields ranking reads (no titles, amenities…).
const POOL_PROJECTION = {
  _id: 1,
  host: 1,
  createdAt: 1,
  propertyType: 1,
  basePrice: 1,
  guests: 1,
  averageRating: 1,
  reviewCount: 1,
  "address.latitude": 1,
  "address.longitude": 1,
};

// --- pure helpers (no I/O, never mutate their input) -------------------------

const idOf = (v) => (v === null || v === undefined ? null : String(v && v._id !== undefined ? v._id : v));
const finitePositive = (x) => {
  const n = typeof x === "string" && x.trim() !== "" ? Number(x) : x;
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? n : null;
};
const normType = (t) => (typeof t === "string" && t.trim() ? t.trim().toLowerCase() : null);
const timeOf = (d) => {
  const t = d ? new Date(d).getTime() : NaN;
  return Number.isFinite(t) ? t : 0;
};

/** The public (approximate) point of a listing document, or null. */
function publicPoint(doc) {
  const a = (doc && doc.address) || {};
  if (!validPoint(a.latitude, a.longitude)) return null;
  const p = approximateLocation(idOf(doc._id), a.latitude, a.longitude);
  return validPoint(p.latitude, p.longitude) ? { lat: p.latitude, lng: p.longitude } : null;
}

/** What ranking reads of a listing. `point` is the PUBLIC point. */
function summarize(doc) {
  return {
    id: idOf(doc._id),
    host: idOf(doc.host),
    type: normType(doc.propertyType),
    price: finitePositive(doc.basePrice),
    guests: finitePositive(doc.guests),
    // a star rating is 0–5; anything else (legacy / corrupt rows) ranks as unrated
    rating: typeof doc.averageRating === "number" && Number.isFinite(doc.averageRating) && doc.averageRating >= 0 && doc.averageRating <= 5 ? doc.averageRating : null,
    reviews: typeof doc.reviewCount === "number" && Number.isFinite(doc.reviewCount) && doc.reviewCount > 0 ? doc.reviewCount : 0,
    created: timeOf(doc.createdAt),
    point: publicPoint(doc),
  };
}

/** 0–3: same type, price within ±35 % of the source's, guests within ±2 — valid values only. */
function similarity(src, c) {
  let s = 0;
  if (src.type && c.type && src.type === c.type) s += 1;
  if (src.price && c.price) {
    const ratio = c.price / src.price;
    if (ratio >= 1 - PRICE_TOLERANCE - EPS && ratio <= 1 + PRICE_TOLERANCE + EPS) s += 1;
  }
  if (src.guests && c.guests && Math.abs(c.guests - src.guests) <= GUESTS_TOLERANCE + EPS) s += 1;
  return s;
}

/** "near" (all ≤ 25 km), "wide" (none), "mixed", or null for no items. */
function scopeOf(distances) {
  if (!distances.length) return null;
  const nNear = distances.filter((d) => d <= NEAR_KM + EPS).length;
  return nNear === distances.length ? "near" : nNear === 0 ? "wide" : "mixed";
}

const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** The source host's other public stays, best first. */
function rankHost(src, pool, limit = HOST_LIMIT) {
  if (!src.host) return [];
  const ratingKey = (c) => (c.reviews > 0 && c.rating !== null ? c.rating : -1);
  return pool
    .filter((c) => c.id !== src.id && c.host && c.host === src.host)
    .sort((a, b) => ratingKey(b) - ratingKey(a) || b.reviews - a.reviews || b.created - a.created || byId(a, b))
    .slice(0, limit);
}

/**
 * Nearby public stays: nearest first in 5 km bands within 25 km (the more
 * similar first inside a band), then — only when fewer than 4 are that near —
 * the next ones up to 250 km in 25 km bands.
 * @returns {{ items: Array<{ c, d }>, scope: "near"|"mixed"|"wide"|null }}
 */
function rankNearby(src, pool, { exclude = new Set(), limit = NEARBY_LIMIT } = {}) {
  if (!src.point) return { items: [], scope: null };
  const near = [];
  const wide = [];
  for (const c of pool) {
    if (c.id === src.id || exclude.has(c.id) || !c.point) continue;
    const d = distanceKm(src.point, c.point);
    if (!Number.isFinite(d)) continue;
    // EPS: a stay exactly on a band edge (5 km, 50 km …) belongs to the next
    // band whatever the haversine's last-bit rounding (≈1e-13 km)
    if (d <= NEAR_KM + EPS) near.push({ c, d, band: Math.min(4, Math.floor((d + EPS) / NEAR_BAND_KM)), sim: similarity(src, c) });
    else if (d <= WIDE_KM + EPS) wide.push({ c, d, band: Math.max(0, Math.floor((d - NEAR_KM + EPS) / WIDE_BAND_KM)), sim: similarity(src, c) });
  }
  const order = (a, b) => a.band - b.band || b.sim - a.sim || a.d - b.d || byId(a.c, b.c);
  near.sort(order);
  wide.sort(order);
  const items = near.slice(0, limit);
  if (near.length < MIN_NEAR) items.push(...wide.slice(0, limit - items.length));
  return { items: items.map(({ c, d }) => ({ c, d })), scope: scopeOf(items.map((x) => x.d)) };
}

/** The public card a row shows (allow-list; the doc was masked with its full context). */
function cardOf(sanitized, distance) {
  const a = sanitized.address || {};
  const address = {};
  for (const k of ["city", "district", "state"]) if (a[k] !== undefined) address[k] = a[k];
  if (validPoint(a.latitude, a.longitude)) {
    address.latitude = a.latitude;
    address.longitude = a.longitude;
  }
  const out = {
    _id: sanitized._id,
    title: sanitized.title,
    propertyType: sanitized.propertyType,
    photos: Array.isArray(sanitized.photos) && sanitized.photos.length ? [sanitized.photos[0]] : [],
    address,
    basePrice: sanitized.basePrice,
    guests: sanitized.guests,
    bedrooms: sanitized.bedrooms,
    averageRating: sanitized.averageRating,
    reviewCount: sanitized.reviewCount,
  };
  if (distance !== undefined) out.distanceKm = Math.round(distance * 10) / 10;
  for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
  return out;
}

/**
 * The Q2 filter for a source summary, or null when nothing can be related
 * (no host and no public point). The box is on the stored (exact) points:
 * a stay whose public point is within 250 km of the source's public point
 * has its exact point within 250 km + OFFSET_MAX_M of it — inside the box
 * (latitude span exact along a meridian; longitude span sized at the box's
 * most poleward latitude). Near a pole or across the antimeridian the box
 * is not a plain range: then the whole public inventory is the pool.
 */
function poolFilter(src) {
  const or = [];
  if (src.host) or.push({ host: src.host });
  if (src.point) {
    const reach = WIDE_KM + PREFILTER_MARGIN_KM;
    const dLat = reach / KM_PER_DEG;
    const lat0 = src.point.lat - dLat;
    const lat1 = src.point.lat + dLat;
    const edge = Math.max(Math.abs(lat0), Math.abs(lat1));
    if (edge >= 85) return publicListingFilter();
    const dLng = reach / (KM_PER_DEG * Math.cos((edge * Math.PI) / 180));
    const lng0 = src.point.lng - dLng;
    const lng1 = src.point.lng + dLng;
    if (lng0 < -180 || lng1 > 180) return publicListingFilter();
    or.push({ "address.latitude": { $gte: lat0, $lte: lat1 }, "address.longitude": { $gte: lng0, $lte: lng1 } });
  }
  if (!or.length) return null;
  return publicListingFilter({ $or: or });
}

// --- orchestration -----------------------------------------------------------

let hooks = {};
function __setTestHooks(h) {
  hooks = h || {};
}

const EMPTY = (sourceHostId = null) => ({ host: [], nearby: [], nearbyScope: null, sourceHostId });
// No rows because no answer could be given (the source is not public, or
// it changed while the rows were built): never cached, and the site must
// not keep it as "this stay has nothing related" (lib/related-stays.ts).
const UNAVAILABLE = () => ({ ...EMPTY(), unavailable: true });
// status: 200 for a definite answer (incl. "the source is not public"); 503
// when the rows could not be built consistently (a race) — transient, so no
// cache layer (edge, Next's data cache, the browser's query cache) keeps it.

/**
 * @param {string} id listing id (already validated)
 * @returns {Promise<{ body: Object, cacheable: boolean }>}
 *   cacheable = the source was public and the rows were built from a
 *   consistent read (a public source with empty rows is cacheable too).
 */
async function relatedFor(id) {
  const srcDoc = await ListingProperty.findOne(publicListingFilter({ _id: id })).select(POOL_PROJECTION).maxTimeMS(QUERY_MAX_MS).lean();
  if (!srcDoc) return { body: UNAVAILABLE(), cacheable: false, status: 200 };
  const src = summarize(srcDoc);
  const filter = poolFilter(src);
  if (!filter) return { body: EMPTY(src.host), cacheable: true, status: 200 };
  // batchSize: the default 101 + 1,000-per-getMore turns a dense box into a
  // chain of round trips; 10 fields per document, so one batch is ~1.5 MB
  // for 5,000 listings (the server caps a batch at 16 MB and then continues)
  const pool = (await ListingProperty.find(filter).select(POOL_PROJECTION).batchSize(POOL_BATCH).maxTimeMS(QUERY_MAX_MS).lean()).map(summarize);
  if (typeof hooks.afterPool === "function") await hooks.afterPool({ id });

  const hostPicked = rankHost(src, pool);
  const hostIds = new Set(hostPicked.map((c) => c.id));
  const nearPicked = rankNearby(src, pool, { exclude: hostIds }).items;
  const picked = [...hostIds, ...nearPicked.map((x) => x.c.id)];
  if (!picked.length) return { body: EMPTY(src.host), cacheable: true, status: 200 };

  const docs = await ListingProperty.find(publicListingFilter({ _id: { $in: [...picked, src.id] } }))
    .select(CARD_READ)
    .select(CARD_MASK_CONTEXT)
    .select({ photos: { $slice: 1 } }) // a card shows one photo
    .maxTimeMS(QUERY_MAX_MS)
    .lean();
  // Re-check the source against Q1: still public, same host, same public point.
  const again = docs.find((d) => idOf(d._id) === src.id);
  const src2 = again ? summarize(again) : null;
  const samePoint = (a, b) => (!a && !b) || (a && b && a.lat === b.lat && a.lng === b.lng);
  if (!src2 || src2.host !== src.host || !samePoint(src2.point, src.point)) return { body: UNAVAILABLE(), cacheable: false, status: 503 };

  // Rank again on what is left; the summaries are built from the same
  // documents (and the same public points) the cards are emitted from.
  const pickedSet = new Set(picked);
  const final = docs.filter((d) => idOf(d._id) !== src.id && pickedSet.has(idOf(d._id)));
  const sums = final.map(summarize);
  const byIdDoc = new Map(final.map((d) => [idOf(d._id), d]));
  const hostRow = rankHost(src2, sums.filter((c) => hostIds.has(c.id)));
  const hostRowIds = new Set(hostRow.map((c) => c.id));
  const { items } = rankNearby(src2, sums.filter((c) => !hostIds.has(c.id)), { exclude: hostRowIds });

  // Ranked nearby items always have a valid public point (rankNearby skips
  // the rest) — the one cardOf emits, so distance and shown point agree.
  const card = (c, d) => cardOf(sanitizeProperty(byIdDoc.get(c.id)), d);
  const host = hostRow.map((c) => card(c));
  const nearby = items.map(({ c, d }) => card(c, d));
  // the scope describes the rows actually shown (raw distances, not rounded)
  const nearbyScope = scopeOf(items.map((x) => x.d));
  return { body: { host, nearby, nearbyScope, sourceHostId: src.host }, cacheable: true, status: 200 };
}

module.exports = {
  relatedFor,
  // pure parts, exported for tests
  summarize,
  publicPoint,
  similarity,
  rankHost,
  rankNearby,
  cardOf,
  scopeOf,
  poolFilter,
  POOL_PROJECTION,
  CARD_READ,
  QUERY_MAX_MS,
  PREFILTER_MARGIN_KM,
  HOST_LIMIT,
  NEARBY_LIMIT,
  NEAR_KM,
  WIDE_KM,
  MIN_NEAR,
  __setTestHooks,
};

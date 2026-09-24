// Parses and validates GET /properties/search-properties. Every scalar must
// arrive once, as a string (`?location[]=x`, `?location[$ne]=x` and repeated
// params are refused, so nothing a client sends can become a Mongo
// operator), numbers must be numbers, and the non-date filters come out as a
// typed $match for the aggregate (which, unlike find(), does not cast).
const places = require("./places");
const { escapeRegex } = require("./listingProjection");

const DAY_MS = 24 * 60 * 60 * 1000;
const SCALARS = ["location", "placeId", "lat", "lng", "from", "to", "guests", "propertyType", "minPrice", "maxPrice", "placeType", "beds", "bedrooms", "bathrooms", "checkinType", "bookingType", "pets", "page", "limit"];
const PLACE_ID = /^(st|gn|l):[a-z0-9][a-z0-9:-]{0,79}$/;
const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
const MAX_AMENITIES = 30;

class SearchParamError extends Error {
  constructor(param, message) {
    super(`${param} ${message}`);
    this.param = param;
  }
}

function refuseSearchParam(res, error) {
  return res.status(400).json({
    success: false,
    code: "INVALID_SEARCH_PARAM",
    param: error.param,
    error: error.message,
    message: error.message,
    statusCode: 400,
  });
}

// "", "null" and "undefined" (what older clients send for unset values) mean unset.
function text(q, name) {
  const v = q[name];
  if (v === undefined) return "";
  const t = v.trim();
  return t === "null" || t === "undefined" ? "" : t;
}

function count(q, name, { decimals = false } = {}) {
  const v = text(q, name);
  if (!v) return null;
  const ok = decimals ? /^\d{1,3}(\.\d{1,2})?$/.test(v) : /^\d{1,3}$/.test(v);
  if (!ok) throw new SearchParamError(name, "must be a number");
  return Number(v);
}

function amount(q, name) {
  const v = text(q, name);
  if (!v) return null;
  if (!/^\d{1,9}(\.\d{1,2})?$/.test(v)) throw new SearchParamError(name, "must be an amount");
  return Number(v);
}

/**
 * A search date → the UTC midnight of the calendar day meant.
 *   "2026-10-10"                → 2026-10-10 (calendar-checked: no 2026-02-30)
 *   "2026-10-09T18:30:00.000Z"  → 2026-10-10: older site builds sent the
 *     browser's LOCAL midnight as ISO; for India that is the previous UTC day,
 *     which checked the wrong nights. Rounding to the nearest UTC midnight
 *     recovers the calendar day for every offset between −12 h and +12 h.
 */
function searchDay(value, name) {
  const m = DATE_ONLY.exec(value);
  if (m) {
    const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
    if (d.getUTCFullYear() !== Number(m[1]) || d.getUTCMonth() !== Number(m[2]) - 1 || d.getUTCDate() !== Number(m[3])) {
      throw new SearchParamError(name, "is not a real date");
    }
    return d;
  }
  if (value.length > 40) throw new SearchParamError(name, "is not a date");
  const t = new Date(value).getTime();
  if (!Number.isFinite(t)) throw new SearchParamError(name, "is not a date");
  return new Date(Math.round(t / DAY_MS) * DAY_MS);
}

function amenityList(q) {
  const v = q.amenities;
  if (v === undefined || v === "") return [];
  // the site sends amenities[]=a&amenities[]=b, the mobile app "a,b"
  const raw = Array.isArray(v) ? v : typeof v === "string" ? v.split(",") : null;
  if (!raw || raw.some((x) => typeof x !== "string")) throw new SearchParamError("amenities", "must be a list of names");
  const list = [...new Set(raw.map((x) => x.trim()).filter(Boolean))];
  if (list.length > MAX_AMENITIES || list.some((x) => x.length > 50)) throw new SearchParamError("amenities", "is too long");
  return list;
}

function parseSearchQuery(q) {
  for (const name of SCALARS) {
    if (q[name] !== undefined && typeof q[name] !== "string") throw new SearchParamError(name, "must be a single value");
  }
  const location = text(q, "location");
  if (location.length > 200) throw new SearchParamError("location", "is too long");
  const placeId = text(q, "placeId");
  if (placeId && !PLACE_ID.test(placeId)) throw new SearchParamError("placeId", "is not a place id");

  let point = null;
  const latS = text(q, "lat");
  const lngS = text(q, "lng");
  if (latS || lngS) {
    if (!latS || !lngS) throw new SearchParamError(latS ? "lng" : "lat", "is required with the other coordinate");
    if (!/^-?\d{1,3}(\.\d+)?$/.test(latS) || !/^-?\d{1,3}(\.\d+)?$/.test(lngS)) throw new SearchParamError("lat", "must be a number");
    const lat = Number(latS);
    const lng = Number(lngS);
    if (!places.validPoint(lat, lng)) throw new SearchParamError("lat", "is out of range");
    // ~1 km: the client already rounds; never trust it to have done so
    point = { lat: Math.round(lat * 100) / 100, lng: Math.round(lng * 100) / 100 };
  }

  const fromS = text(q, "from");
  const toS = text(q, "to");
  let nightFrom = null;
  let nightTo = null;
  if (fromS && toS) {
    nightFrom = searchDay(fromS, "from");
    nightTo = searchDay(toS, "to");
  }

  const guests = count(q, "guests");
  const beds = count(q, "beds");
  const bedrooms = count(q, "bedrooms");
  const bathrooms = count(q, "bathrooms", { decimals: true });
  const minPrice = amount(q, "minPrice");
  const maxPrice = amount(q, "maxPrice");
  const propertyType = text(q, "propertyType");
  if (propertyType.length > 50) throw new SearchParamError("propertyType", "is too long");
  const placeType = text(q, "placeType");
  const amenities = amenityList(q);

  // Non-date filters, typed for $match. Room counts and amenities follow the
  // Airbnb convention: "at least N" and "has all of these".
  const filter = {};
  if (placeType) {
    const pt = placeType.toLowerCase();
    filter.placeType = pt === "entire_place" ? "entire" : pt === "room" ? "room" : { $in: ["entire", "room"] };
  }
  if (minPrice !== null || maxPrice !== null) {
    filter.basePrice = {};
    if (minPrice !== null) filter.basePrice.$gte = minPrice;
    if (maxPrice !== null) filter.basePrice.$lte = maxPrice;
  }
  if (beds) filter.beds = { $gte: beds };
  if (bedrooms) filter.bedrooms = { $gte: bedrooms };
  if (bathrooms) filter.bathrooms = { $gte: bathrooms };
  if (guests) filter.guests = { $gte: guests };
  if (text(q, "bookingType")) filter["bookingType.instantBook"] = true;
  if (text(q, "checkinType")) filter.occupancy = "self-check-in";
  if (text(q, "pets")) filter.selectedRules = "no_pets"; // the site's "No pets" chip
  if (amenities.length) filter.amenities = { $all: amenities };
  if (propertyType) filter.propertyType = { $regex: new RegExp(escapeRegex(propertyType), "i") };

  return { location, placeId, point, from: fromS, to: toS, nightFrom, nightTo, filter };
}

module.exports = { parseSearchQuery, refuseSearchParam, SearchParamError, searchDay };

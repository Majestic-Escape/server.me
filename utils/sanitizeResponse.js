/**
 * Response sanitisation — what a user or host may learn about the OTHER
 * party, and about a listing before booking.
 *
 * Policy (contact lock-down, 2026-09-20): a counterpart is identified by first
 * name only and never by any contact detail; a listing's exact location
 * (street, registration number, precise coordinates) is revealed only to the
 * guest of a confirmed, paid booking; public free text (about, listing text,
 * review content) is masked against contact information and against the
 * listing's own exact address on every read, so legacy content cannot expose
 * anything the write-time moderation now refuses.
 *
 * Every non-admin response also passes through middleware/piiResponseFilter.js
 * (defence in depth); the projections below are the primary control.
 */
const crypto = require("crypto");
const { maskContactInfo, maskContactInfoParts, buildAddressTokens, isAcceptableName } = require("./contactModeration");

// What the counterpart / the public may see of a user (allow-list).
const PUBLIC_USER_FIELDS = [
  "_id",
  "id",
  "firstName",
  "profilePicture",
  "about",
  "languages",
  "averageRating",
  "reviewCount",
  "avgPropertyRating",
  "propertyReviewCount",
  "createdAt",
];

// Never returned to anyone but an admin — not even to the user themselves.
const SECRET_USER_FIELDS = ["otp", "otpRetries", "lockUntil", "tokenVersion", "password", "__v"];

// What a user may see of their OWN record (allow-list; every User schema
// path is classified here or in SECRET_USER_FIELDS — tests/batch-s/pii.test.js
// fails when a new schema field is added without a decision).
const SELF_USER_FIELDS = [
  ...PUBLIC_USER_FIELDS,
  "lastName",
  "email",
  "phoneNumber",
  "countryCode",
  "dob",
  "gender",
  "bio",
  "role",
  "hostOffer",
  "address",
  "verification",
  "preferences",
  "status",
  "bank",
  "kyc",
  "isVerified",
  "wishlist",
  "bookings",
  "properties",
  "updatedAt",
  "fullName",
];

// Legacy names kept for the existing call sites.
const SAFE_HOST_FIELDS = PUBLIC_USER_FIELDS;
const SAFE_HOST_SELECT = PUBLIC_USER_FIELDS.join(" ");
const PUBLIC_USER_SELECT = SAFE_HOST_SELECT;
const SELF_USER_SELECT = "-" + SECRET_USER_FIELDS.join(" -");

// Fields to remove from property responses to prevent contact info leakage
const SENSITIVE_PROPERTY_FIELDS = [
  "hostEmail",
  "validRegistrationNo",
  "bankDetails",
  // Chat-widget vector fields: excluded at the model, stripped again here.
  "embedding",
  "embeddingUpdatedAt",
  "embeddingVersion",
];

// Exact location: street, registration number and the precise point are for
// the confirmed guest only; city/district/state/pincode stay public.
const SENSITIVE_ADDRESS_FIELDS = ["street", "registrationNumber"];
const PRIVATE_LISTING_FIELDS = ["line1", "line2"];

// Admin / owner workflow state that no public or guest reader needs: the
// host's KYC stage on the listing, the moderation ban flag and Mongoose's
// version counter.
const INTERNAL_LISTING_FIELDS = ["kycStatus", "ban", "__v"];

// Never returned to anyone through a listing response: the chat-widget
// vectors (large, and excluded at the model).
const VECTOR_LISTING_FIELDS = ["embedding", "embeddingUpdatedAt", "embeddingVersion"];

// Fields to remove from host object to prevent PII leakage (deny-list kept
// for the legacy sanitizeHost callers; toPublicUser is the allow-list).
const SENSITIVE_HOST_FIELDS = [
  "email",
  "phoneNumber",
  "countryCode",
  "address",
  "dob",
  "otp",
  "otpRetries",
  "lockUntil",
  "tokenVersion",
  "password",
  "verification",
  "preferences",
  "bookings",
  "wishlist",
  "status",
  "bank",
  "kyc",
  "gender",
  "bio",
  "role",
  "hostOffer",
  "updatedAt",
  "lastName",
  "isVerified",
];

// Public free text of a listing, masked together as one resource so a
// fragment split across fields cannot survive.
const LISTING_TEXT_FIELDS = ["title", "description"];

function plain(obj) {
  if (!obj) return obj;
  if (typeof obj.toObject === "function") return obj.toObject({ virtuals: true });
  return { ...obj };
}

function isObjectId(v) {
  return v && typeof v === "object" && typeof v.toHexString === "function";
}

function idString(v) {
  if (!v) return null;
  if (typeof v === "string") return v;
  if (isObjectId(v)) return v.toHexString();
  if (typeof v === "object" && v._id) return idString(v._id);
  return String(v);
}

/** A legacy first name that fails the name policy degrades to its leading letters, else the fallback. */
function publicFirstName(name, fallback) {
  if (typeof name !== "string" || !name.trim()) return fallback;
  if (isAcceptableName(name)) return name.trim();
  const letters = name.match(/^\p{L}[\p{L} .'\-]{0,49}/u);
  const candidate = letters ? letters[0].trim() : "";
  return candidate && isAcceptableName(candidate) ? candidate : fallback;
}

/**
 * The public projection of a user record: allow-listed fields, first name
 * only, free text masked (contact information and — when the user's listing
 * addresses are supplied — their exact addresses).
 * @param {Object} user
 * @param {{ fallbackName?: string, addressTokens?: Array }} [opts]
 */
function toPublicUser(user, opts = {}) {
  if (!user) return user;
  const src = plain(user);
  const out = {};
  for (const field of PUBLIC_USER_FIELDS) {
    if (src[field] !== undefined) out[field] = src[field];
  }
  if (out.firstName !== undefined) out.firstName = publicFirstName(out.firstName, opts.fallbackName || "");
  const detect = opts.addressTokens && opts.addressTokens.length ? { address: opts.addressTokens } : {};
  if (typeof out.about === "string") out.about = maskContactInfo(out.about, detect);
  if (Array.isArray(out.languages)) {
    const masked = maskContactInfoParts(out.languages.map((l) => String(l)), detect);
    out.languages = masked;
  }
  return out;
}

/** The user's own record: everything but the secrets. */
function toSelfUser(user) {
  if (!user) return user;
  const src = plain(user);
  const out = {};
  for (const field of SELF_USER_FIELDS) {
    if (src[field] !== undefined) out[field] = src[field];
  }
  return out;
}

// ---------------------------------------------------------------------------
// Approximate public location (Airbnb / OTA model)
// ---------------------------------------------------------------------------

const EARTH_METRES_PER_DEG_LAT = 111_320;
const OFFSET_MIN_M = 150;
const OFFSET_MAX_M = 350;

let locationKeyCache = null;
/**
 * Key for the location offset: LOCATION_MASK_SECRET when configured, else a
 * domain-separated derivation from JWT_SECRET (never the JWT key itself).
 * Rotating either moves every public point; the key never leaves the server.
 */
function locationKey() {
  if (locationKeyCache) return locationKeyCache;
  const explicit = process.env.LOCATION_MASK_SECRET;
  if (explicit) locationKeyCache = Buffer.from(explicit, "utf8");
  else locationKeyCache = crypto.createHmac("sha256", process.env.JWT_SECRET || "").update("majestic-location-mask-v1").digest();
  return locationKeyCache;
}
function resetLocationKeyCache() {
  locationKeyCache = null;
}

/**
 * A stable approximate point for a listing: the true point moved 150–350 m in
 * a direction and by a distance derived from HMAC(key, listingId), rounded
 * to 4 decimals. Not recoverable from the listing id and the public point
 * without the server key.
 */
function approximateLocation(listingId, latitude, longitude) {
  if (typeof latitude !== "number" || typeof longitude !== "number" || !Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    return { latitude, longitude };
  }
  const mac = crypto.createHmac("sha256", locationKey()).update(String(listingId || "")).digest();
  const bearing = (mac.readUInt32BE(0) / 0x100000000) * 2 * Math.PI;
  const distance = OFFSET_MIN_M + (mac.readUInt32BE(4) / 0x100000000) * (OFFSET_MAX_M - OFFSET_MIN_M);
  const dLat = (distance * Math.cos(bearing)) / EARTH_METRES_PER_DEG_LAT;
  const metresPerDegLng = EARTH_METRES_PER_DEG_LAT * Math.cos((latitude * Math.PI) / 180) || EARTH_METRES_PER_DEG_LAT;
  const dLng = (distance * Math.sin(bearing)) / metresPerDegLng;
  const round = (x) => Math.round(x * 1e4) / 1e4;
  return { latitude: round(latitude + dLat), longitude: round(longitude + dLng) };
}

/**
 * Sanitize property address for the public: no street / registration number,
 * approximate coordinates.
 * @param {Object} address
 * @param {string} [listingId] seeds the approximate point
 */
function sanitizeAddress(address, listingId) {
  if (!address) return address;
  const addrObj = { ...address };
  SENSITIVE_ADDRESS_FIELDS.forEach((field) => {
    delete addrObj[field];
  });
  if (typeof addrObj.latitude === "number" || typeof addrObj.longitude === "number") {
    const approx = approximateLocation(listingId, addrObj.latitude, addrObj.longitude);
    addrObj.latitude = approx.latitude;
    addrObj.longitude = approx.longitude;
  }
  return addrObj;
}

/**
 * Sanitize a host object by removing sensitive fields (legacy deny-list API;
 * prefer toPublicUser).
 */
function sanitizeHost(host) {
  if (!host) return host;
  const hostObj = plain(host);
  SENSITIVE_HOST_FIELDS.forEach((field) => {
    delete hostObj[field];
  });
  if (hostObj.firstName !== undefined) hostObj.firstName = publicFirstName(hostObj.firstName, "");
  if (typeof hostObj.about === "string") hostObj.about = maskContactInfo(hostObj.about);
  if (Array.isArray(hostObj.languages)) hostObj.languages = maskContactInfoParts(hostObj.languages.map((l) => String(l)));
  return hostObj;
}

/**
 * Sanitize embedded host object (for Property model with embedded host data)
 */
function sanitizeEmbeddedHost(host) {
  if (!host) return host;
  const hostObj = { ...host };
  if (hostObj.contact) {
    hostObj.contact = { ...hostObj.contact };
    delete hostObj.contact.phone;
    delete hostObj.contact.email;
    if (Object.keys(hostObj.contact).length === 0) delete hostObj.contact;
  }
  delete hostObj.lastName;
  return hostObj;
}

/** The exact-address tokens of a listing (for masking its public text). */
function listingAddressTokens(listing) {
  if (!listing) return null;
  const src = plain(listing);
  const addr = src.address || {};
  return buildAddressTokens({ street: addr.street, line1: src.line1, line2: src.line2, city: addr.city, district: addr.district, state: addr.state });
}

/**
 * Mask a listing's public free text in place: title + description + custom
 * rules + safety-feature descriptions are one resource (fragments split
 * across them are masked), against contact information and the listing's
 * own exact address.
 */
function maskListingText(propObj, addressTokens) {
  const detect = addressTokens && (addressTokens.numbers.length || addressTokens.grams.length) ? { address: addressTokens } : {};
  const keys = [];
  const parts = [];
  for (const key of LISTING_TEXT_FIELDS) {
    if (typeof propObj[key] === "string") {
      keys.push({ kind: "field", key });
      parts.push(propObj[key]);
    }
  }
  if (Array.isArray(propObj.customRules)) {
    propObj.customRules.forEach((rule, i) => {
      if (typeof rule === "string") {
        keys.push({ kind: "rule", i });
        parts.push(rule);
      }
    });
  }
  if (propObj.safetyFeatures && typeof propObj.safetyFeatures === "object") {
    for (const [name, feature] of Object.entries(propObj.safetyFeatures)) {
      if (feature && typeof feature === "object" && typeof feature.description === "string") {
        keys.push({ kind: "safety", name });
        parts.push(feature.description);
      }
    }
  }
  if (!parts.length) return propObj;
  const masked = maskContactInfoParts(parts, detect);
  keys.forEach((k, i) => {
    if (masked[i] === parts[i]) return;
    if (k.kind === "field") propObj[k.key] = masked[i];
    else if (k.kind === "rule") propObj.customRules[k.i] = masked[i];
    else propObj.safetyFeatures[k.name] = { ...propObj.safetyFeatures[k.name], description: masked[i] };
  });
  return propObj;
}

/**
 * Sanitize a property object for the public: owner-only fields removed,
 * approximate location, public text masked, nested host reduced to its
 * public projection.
 */
function sanitizeProperty(property) {
  if (!property) return property;
  const propObj = plain(property);
  const addressTokens = listingAddressTokens(propObj);
  SENSITIVE_PROPERTY_FIELDS.forEach((field) => {
    delete propObj[field];
  });
  PRIVATE_LISTING_FIELDS.forEach((field) => {
    delete propObj[field];
  });
  INTERNAL_LISTING_FIELDS.forEach((field) => {
    delete propObj[field];
  });
  if (propObj.address && typeof propObj.address === "object") {
    propObj.address = sanitizeAddress(propObj.address, idString(propObj._id || propObj.id));
  }
  if (propObj.customRules && Array.isArray(propObj.customRules)) propObj.customRules = [...propObj.customRules];
  if (propObj.safetyFeatures && typeof propObj.safetyFeatures === "object") propObj.safetyFeatures = { ...propObj.safetyFeatures };
  maskListingText(propObj, addressTokens);
  if (propObj.host && typeof propObj.host === "object" && !isObjectId(propObj.host)) {
    if (propObj.host.contact) {
      propObj.host = sanitizeEmbeddedHost(propObj.host);
    } else {
      propObj.host = toPublicUser(propObj.host, { addressTokens: addressTokens ? [addressTokens] : [] });
    }
  }
  return propObj;
}

function sanitizeProperties(properties) {
  if (!Array.isArray(properties)) return properties;
  return properties.map(sanitizeProperty);
}

/**
 * A listing as the guest of a confirmed, paid booking sees it: exact
 * address, but never the owner's email / registration / bank flags.
 */
function sanitizePropertyForBookedGuest(property) {
  if (!property) return property;
  const propObj = plain(property);
  SENSITIVE_PROPERTY_FIELDS.forEach((field) => {
    delete propObj[field];
  });
  INTERNAL_LISTING_FIELDS.forEach((field) => {
    delete propObj[field];
  });
  if (propObj.address && typeof propObj.address === "object") {
    propObj.address = { ...propObj.address };
    delete propObj.address.registrationNumber;
  }
  if (propObj.host && typeof propObj.host === "object" && !isObjectId(propObj.host)) {
    propObj.host = propObj.host.contact ? sanitizeEmbeddedHost(propObj.host) : toPublicUser(propObj.host);
  }
  return propObj;
}

/**
 * A listing as its own host (or an admin) reads it for editing: the stored
 * address exactly as entered (street, registration number, precise point),
 * the owner-only flags (hostEmail, kycStatus, bankDetails, ban) and the text
 * as stored. The host wizard PUTs this object back, so it must be the truth —
 * the public view (approximate point, no street) written back through the
 * wizard would move the listing and erase its street. Vectors never leave.
 */
function sanitizePropertyForOwner(property) {
  if (!property) return property;
  const propObj = plain(property);
  VECTOR_LISTING_FIELDS.forEach((field) => {
    delete propObj[field];
  });
  if (propObj.host && typeof propObj.host === "object" && !isObjectId(propObj.host)) {
    propObj.host = propObj.host.contact ? sanitizeEmbeddedHost(propObj.host) : toPublicUser(propObj.host);
  }
  return propObj;
}

module.exports = {
  toPublicUser,
  toSelfUser,
  publicFirstName,
  sanitizeHost,
  sanitizeEmbeddedHost,
  sanitizeProperty,
  sanitizeProperties,
  sanitizePropertyForBookedGuest,
  sanitizePropertyForOwner,
  sanitizeAddress,
  approximateLocation,
  resetLocationKeyCache,
  listingAddressTokens,
  maskListingText,
  PUBLIC_USER_FIELDS,
  PUBLIC_USER_SELECT,
  SELF_USER_FIELDS,
  SELF_USER_SELECT,
  SECRET_USER_FIELDS,
  SAFE_HOST_SELECT,
  SAFE_HOST_FIELDS,
  SENSITIVE_PROPERTY_FIELDS,
  SENSITIVE_HOST_FIELDS,
  SENSITIVE_ADDRESS_FIELDS,
  PRIVATE_LISTING_FIELDS,
  INTERNAL_LISTING_FIELDS,
};

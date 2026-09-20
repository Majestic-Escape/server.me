// Write-time contact policy for public text (contact lock-down).
//
// Anything a host or guest publishes to the other side — profile `about` and
// `languages`, listing title / description / custom rules / safety notes,
// review text, and names — must not carry contact details (phone, email,
// UPI, link, social handle, off-platform payment or direct-booking phrases)
// nor the listing's own exact address. The check runs on the RESULTING
// resource (existing document merged with the patch, all public fields
// together), so a number split across title and description, or across two
// saves, is refused like any other. It applies to every writer, admins
// included: admin visibility is not a licence to publish contact data.
//
// Refusal: 422 CONTACT_INFO_NOT_ALLOWED with the offending fields, so a form
// can keep the text and highlight what to remove.
const { detectContactInParts, buildAddressTokens, isAcceptableName } = require("./contactModeration");

const CONTACT_INFO_NOT_ALLOWED = "CONTACT_INFO_NOT_ALLOWED";
const REASON = "Contact details aren't allowed here. For your safety, keep communication and payments on Majestic Escape. Remove phone numbers, email addresses, social handles, links, direct-payment details or the exact address and try again.";

/**
 * @param {Array<{ field: string, text: string }>} parts public text of one resource
 * @param {{ addressTokens?: object|object[] }} [opts]
 * @returns {{ ok: boolean, kinds: string[], fields: string[] }}
 */
function checkPublicText(parts, opts = {}) {
  const usable = parts.filter((p) => typeof p.text === "string" && p.text.trim() !== "");
  if (!usable.length) return { ok: true, kinds: [], fields: [] };
  const detectOpts = {};
  if (opts.addressTokens) {
    const list = Array.isArray(opts.addressTokens) ? opts.addressTokens : [opts.addressTokens];
    const meaningful = list.filter((t) => t && ((t.numbers && t.numbers.length) || (t.grams && t.grams.length)));
    if (meaningful.length) detectOpts.address = meaningful;
  }
  const res = detectContactInParts(
    usable.map((p) => p.text),
    detectOpts
  );
  if (res.status !== "blocked") return { ok: true, kinds: res.kinds, fields: [] };
  const blockingKinds = new Set(res.hits.filter((h) => h.pattern !== "CONTACT_INTENT").map((h) => h.pattern));
  const fields = [...new Set(res.hits.filter((h) => h.pattern !== "CONTACT_INTENT").map((h) => usable[h.part].field))];
  return { ok: false, kinds: [...blockingKinds], fields };
}

/** Send the standard 422 for a failed checkPublicText result. */
function refusePublicText(res, result) {
  return res.status(422).json({
    success: false,
    code: CONTACT_INFO_NOT_ALLOWED,
    message: REASON,
    statusCode: 422,
    kinds: result.kinds,
    fields: result.fields,
  });
}

/** Address tokens of a listing document (or plain object). */
function addressTokensOf(listing) {
  if (!listing) return null;
  const src = typeof listing.toObject === "function" ? listing.toObject() : listing;
  const addr = src.address || {};
  return buildAddressTokens({ street: addr.street, line1: src.line1, line2: src.line2, city: addr.city, district: addr.district, state: addr.state });
}

/** The public text parts of a listing (merged document). */
function listingTextParts(doc) {
  const parts = [];
  if (typeof doc.title === "string") parts.push({ field: "title", text: doc.title });
  if (typeof doc.description === "string") parts.push({ field: "description", text: doc.description });
  if (Array.isArray(doc.customRules)) doc.customRules.forEach((r, i) => typeof r === "string" && parts.push({ field: `customRules[${i}]`, text: r }));
  if (doc.safetyFeatures && typeof doc.safetyFeatures === "object") {
    for (const [name, f] of Object.entries(doc.safetyFeatures)) {
      if (f && typeof f === "object" && typeof f.description === "string") parts.push({ field: `safetyFeatures.${name}.description`, text: f.description });
    }
  }
  return parts;
}

/** Name policy shared by registration, the become-host flow and the admin rename. */
function nameProblem(value, label) {
  if (value === undefined || value === null || value === "") return null;
  return isAcceptableName(value) ? null : `${label} may not contain numbers, contact details, links or social handles`;
}

module.exports = { checkPublicText, refusePublicText, addressTokensOf, listingTextParts, nameProblem, CONTACT_INFO_NOT_ALLOWED, REASON };

const LISTING_TEXT_SELECT = "title description customRules safetyFeatures address line1 line2 photos";

/**
 * Check a listing write on its resulting document: `existing` (may be null
 * for a create) merged with `patch`.
 */
function checkListingWrite(existing, patch) {
  const base = existing ? (typeof existing.toObject === "function" ? existing.toObject() : existing) : {};
  const body = patch && typeof patch === "object" ? patch : {};
  const merged = { ...base, ...body };
  if (body.address && typeof body.address === "object") merged.address = { ...(base.address || {}), ...body.address };
  return checkPublicText(listingTextParts(merged), { addressTokens: addressTokensOf(merged) });
}

module.exports.checkListingWrite = checkListingWrite;
module.exports.LISTING_TEXT_SELECT = LISTING_TEXT_SELECT;

// ---------------------------------------------------------------------------
// Public image references (contact lock-down). Every public image must be an
// object of our bucket: those go through services/imageSanitizer.js (no EXIF
// GPS, no QR codes) or the legacy image script. A foreign URL would bypass the
// sanitiser and let a third-party host see every viewer's address. Only
// entries that are NEW for the resource are judged, so a legacy reference
// never blocks an unrelated edit.
// ---------------------------------------------------------------------------
const storage = require("../services/storage");
const IMAGE_NOT_ALLOWED = "IMAGE_NOT_ALLOWED";

function isOurImageUrl(url) {
  return typeof url === "string" && storage.keyFromUrl(url) !== null;
}

/**
 * @param {Object|null} existing stored resource (listing or user), if any
 * @param {Object} patch request body
 * @param {Array<{ field: string, list?: boolean }>} fields image fields to judge
 */
function checkImageRefs(existing, patch, fields) {
  const base = existing ? (typeof existing.toObject === "function" ? existing.toObject() : existing) : {};
  const body = patch && typeof patch === "object" ? patch : {};
  const bad = [];
  for (const { field, list } of fields) {
    if (body[field] === undefined || body[field] === null || body[field] === "") continue;
    const incoming = list ? (Array.isArray(body[field]) ? body[field] : [body[field]]) : [body[field]];
    const present = new Set(list ? (Array.isArray(base[field]) ? base[field] : []) : base[field] ? [base[field]] : []);
    if (incoming.some((u) => !present.has(u) && !isOurImageUrl(u))) bad.push(field);
  }
  return { ok: bad.length === 0, fields: bad };
}

const checkListingImages = (existing, patch) => checkImageRefs(existing, patch, [{ field: "photos", list: true }]);
const checkProfileImage = (existing, patch) => checkImageRefs(existing, patch, [{ field: "profilePicture" }]);

function refuseImages(res, result) {
  return res.status(422).json({
    success: false,
    code: IMAGE_NOT_ALLOWED,
    message: "Images must be uploaded through the site — links to images hosted elsewhere are not allowed",
    statusCode: 422,
    fields: result.fields,
  });
}

module.exports.checkImageRefs = checkImageRefs;
module.exports.checkListingImages = checkListingImages;
module.exports.checkProfileImage = checkProfileImage;
module.exports.refuseImages = refuseImages;
module.exports.isOurImageUrl = isOurImageUrl;
module.exports.IMAGE_NOT_ALLOWED = IMAGE_NOT_ALLOWED;

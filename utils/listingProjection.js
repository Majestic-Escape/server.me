// Batch P — what a listing *card* needs. The public list endpoints (home,
// search) select exactly this instead of whole documents: without a
// projection a page of 16 listings weighed 674 KB, 93% of it the chat
// widget's embedding vectors, and the rest carried rules, safety features
// and host/bank flags no card reads.
//
// The list is deliberately generous: every field the customer site's card
// (stay-property-card.jsx), the filter page and the mobile prototype's card
// and category chips read, plus the small descriptive fields a future card
// might want. Never add hostEmail, address.street/registrationNumber,
// validRegistrationNo, bankDetails, kycStatus, ban/delist or the vector.
const CARD_FIELDS = [
  "title",
  "propertyType",
  "placeType",
  "basePrice",
  "photos",
  "address.city",
  "address.state",
  "address.district",
  "address.country",
  "address.pincode",
  "address.latitude",
  "address.longitude",
  "badge",
  "averageRating",
  "reviewCount",
  "bookingType",
  "cancellationType",
  "description",
  "amenities",
  "guests",
  "bedrooms",
  "beds",
  "bathrooms",
  "checkinTime",
  "checkoutTime",
  "discounts",
  "occupancy",
  "selectedRules",
  "status",
  "createdAt",
];

const CARD_PROJECTION = CARD_FIELDS.join(" ");

// Largest page any public list will serve; the site asks for 16, the mobile
// prototype for 12. Unbounded limits were an amplification vector.
const MAX_PAGE_SIZE = 50;

function pageParams(query, defaultLimit = 16) {
  const page = Math.max(parseInt(query.page, 10) || 1, 1);
  const requested = parseInt(query.limit, 10) || defaultLimit;
  const limit = Math.min(Math.max(requested, 1), MAX_PAGE_SIZE);
  return { page, limit, skip: (page - 1) * limit };
}

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Masking context for a card: sanitizeProperty masks a listing's public text
// against its OWN exact address (street, line1, line2). The card projection
// leaves those fields out, so a title quoting the street went out unmasked.
// Select this next to CARD_PROJECTION — .select(CARD_PROJECTION)
// .select(CARD_MASK_CONTEXT) — wherever the cards are sanitized;
// sanitizeProperty strips the three fields again before anything is sent.
// Never merge it into CARD_FIELDS (a projection without a sanitizer would
// then emit the exact address).
const CARD_MASK_CONTEXT = { "address.street": 1, line1: 1, line2: 1 };

// What "publicly visible" means for a listing, everywhere it is read for the
// public (catalogue, search, places, related stays, the detail and calendar
// read policy): live AND not under a moderation ban. The ban flow already
// takes listings out of "active" (services/listingPublish.js); the ban check
// is defence in depth against an inconsistent row.
// A fresh object per call: query casting must never share a nested operator.
function publicListingFilter(extra) {
  return { status: "active", ban: { $ne: true }, ...(extra || {}) };
}
function isPublicListing(listing) {
  return !!listing && listing.status === "active" && listing.ban !== true;
}

module.exports = { CARD_FIELDS, CARD_PROJECTION, CARD_MASK_CONTEXT, publicListingFilter, isPublicListing, MAX_PAGE_SIZE, pageParams, escapeRegex };

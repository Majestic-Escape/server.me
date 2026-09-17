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

module.exports = { CARD_FIELDS, CARD_PROJECTION, MAX_PAGE_SIZE, pageParams, escapeRegex };

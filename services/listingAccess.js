// Who may read what of ONE listing (docs/listing-visibility.md).
//
// A public listing (active, not banned) reads exactly as before for everyone.
// A listing that is not public — a draft, a listing in review, delisted or
// under a moderation ban — keeps its full detail for:
//   owner        the listing's host
//   admin        an ACTIVE admin (authz.isAdmin refuses a deactivated one)
//   bookedGuest  a user with a confirmed, paid guest booking of it (any time;
//                imported calendar rows and host blocks do not count) — who
//                still gets only the operational view, never draft text
// and everyone else gets the narrow stub (utils/sanitizeResponse.js).
//
// The resolver does the I/O (one indexed Booking read, only on the rare
// non-public + signed-in + not owner/admin path); the views are pure.
const Booking = require("../models/Booking");
const authz = require("../middleware/authz");
const { isPublicListing } = require("../utils/listingProjection");
const { sanitizeProperty, listingStubView, bookedGuestListingView } = require("../utils/sanitizeResponse");

const PAID_GUEST_BOOKING = { status: "confirmed", paymentStatus: "paid", source: { $ne: "ical" }, action: { $ne: "host" } };

/** The caller's latest confirmed, paid guest booking of the listing (or null). */
async function paidGuestBooking(actor, listingId) {
  if (!actor || actor.kind !== "user" || !actor.id) return null;
  return Booking.findOne({ userId: actor.id, propertyId: listingId, ...PAID_GUEST_BOOKING })
    .sort({ checkIn: -1, _id: -1 })
    .select("listingSnapshot")
    .lean();
}

/**
 * @param {Object} listing needs _id, status, ban, host
 * @param {Object|null} actor authz actor (null = anonymous)
 * @returns {Promise<{ access: "owner"|"admin"|"bookedGuest"|"public", booking?: Object }>}
 */
async function resolveListingAccess(listing, actor) {
  if (authz.isAdmin(actor)) return { access: "admin" };
  if (authz.isListingHost(actor, listing)) return { access: "owner" };
  if (isPublicListing(listing)) return { access: "public" };
  const booking = await paidGuestBooking(actor, listing._id);
  if (booking) return { access: "bookedGuest", booking };
  return { access: "public" };
}

/**
 * What a caller who is NOT the owner / an admin reads of a listing that is
 * not public: the booked guest's operational view, or the stub.
 * @param {Object} listing full document (masking needs it)
 * @param {{ access: string, booking?: Object }} resolved resolveListingAccess result
 */
function nonPublicView(listing, { access, booking } = {}) {
  const view = sanitizeProperty(listing);
  return access === "bookedGuest" ? bookedGuestListingView(view, booking && booking.listingSnapshot) : listingStubView(view);
}

module.exports = { resolveListingAccess, nonPublicView, paidGuestBooking, PAID_GUEST_BOOKING };

// Who may read what of ONE listing (docs/listing-visibility.md).
//
// A public listing (active, not banned) reads exactly as before for everyone.
// A listing that is not public — a draft, a listing in review, delisted or
// under a moderation ban — keeps its full detail for:
//   owner        the listing's host
//   admin        an ACTIVE admin (authz.isAdmin refuses a deactivated one)
//   bookedGuest  a user with a confirmed, paid guest booking of it (any time;
//                utils/bookingEntitlement.js) — who gets a narrow view
//                without draft text or trip facts (those come per booking)
// and everyone else gets the narrow stub (utils/sanitizeResponse.js).
//
// The resolver does the I/O (one indexed Booking read, only on the rare
// non-public + signed-in + not owner/admin path); the views are pure.
const Booking = require("../models/Booking");
const User = require("../models/User");
const authz = require("../middleware/authz");
const { isPublicListing } = require("../utils/listingProjection");
const { paidGuestBookingFilter } = require("../utils/bookingEntitlement");
const { sanitizeProperty, listingStubView, bookedGuestListingView } = require("../utils/sanitizeResponse");


/** Whether the caller holds a confirmed, paid guest booking of the listing. */
async function paidGuestBooking(actor, listingId) {
  if (!actor || actor.kind !== "user" || !actor.id) return null;
  return Booking.exists(paidGuestBookingFilter({ userId: actor.id, propertyId: listingId }));
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
function nonPublicView(listing, { access } = {}) {
  const view = sanitizeProperty(listing);
  // The listing-level view carries no trip facts (hours, rules, terms): a
  // guest may have several bookings with different ones — those come with
  // each booking (utils/bookingView.js), never from "the latest" here.
  return access === "bookedGuest" ? bookedGuestListingView(view, null, { tripFacts: false }) : listingStubView(view);
}

/**
 * "The listings of host X" for an owner-scoped read (a host's own portfolio,
 * an admin looking at one host). Ownership is the listing's `host` id — the
 * account — never an e-mail: hostEmail is a copy that can go stale (a
 * listing reassigned to another host must leave the old owner's lists), and an
 * e-mail address is not proof of ownership (an account's address can change and
 * a later account can take the old one). A user's own read is by account id
 * only; legacy rows without a host id are reachable by e-mail only for an
 * ADMIN looking a host up (legacyByEmail) until an admin binds them.
 * @param {{ hostId?: string|null, email?: string|null, legacyByEmail?: boolean }} who
 * @returns {Object} a Mongo filter (matches nothing when neither is given)
 */
function ownedListingsFilter({ hostId, email, legacyByEmail = false }) {
  const or = [];
  if (hostId) or.push({ host: hostId });
  const e = legacyByEmail && typeof email === "string" ? email.trim() : "";
  if (e) or.push({ host: null, hostEmail: { $in: [...new Set([e, e.toLowerCase()])] } });
  return or.length ? { $or: or } : { _id: null };
}

/** The host account behind an e-mail (admin reads by e-mail), or null. */
async function hostIdForEmail(email) {
  const e = typeof email === "string" ? email.trim().toLowerCase() : "";
  if (!e) return null;
  const u = await User.findOne({ email: e }).select("_id").lean();
  return u ? String(u._id) : null;
}

module.exports = { resolveListingAccess, nonPublicView, ownedListingsFilter, hostIdForEmail, paidGuestBooking };

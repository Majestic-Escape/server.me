// What a booking looks like to the caller (contact lock-down):
//  - the counterpart (guest ↔ host) is the public user projection — first
//    name, photo, ratings — never email / phone / address / last name;
//  - the caller's own record keeps its own details minus secrets;
//  - the listing's exact location (street, lines, precise point) is revealed
//    to the guest only for a confirmed, paid guest booking
//    (utils/bookingEntitlement.js — the same rule as the listing detail
//    route); the listing's CURRENT host owns it — a former host keeps their
//    booking record, not the new owner's listing;
//  - payment customer details are never returned to users;
//  - an admin sees the document unchanged.
// Shapes are otherwise identical to before, so existing consumers keep working.
const authz = require("../middleware/authz");
const { toPublicUser, toSelfUser, sanitizeProperty, sanitizePropertyForBookedGuest, bookedGuestListingView, listingStubView, SENSITIVE_PROPERTY_FIELDS } = require("./sanitizeResponse");
const { isPublicListing } = require("./listingProjection");
const { isPaidGuestBooking } = require("./bookingEntitlement");

function plain(v) {
  if (!v) return v;
  return typeof v.toObject === "function" ? v.toObject({ virtuals: true }) : v;
}
function isPopulated(v) {
  return v && typeof v === "object" && typeof v.toHexString !== "function" && (v.firstName !== undefined || v.email !== undefined || v.title !== undefined || v.address !== undefined || v.orderId !== undefined || v.amount !== undefined);
}
function idOf(v) {
  if (!v) return null;
  if (typeof v === "string") return v;
  if (typeof v.toHexString === "function") return v.toHexString();
  if (v._id) return idOf(v._id);
  return String(v);
}

/** True when the guest may see the exact location: a confirmed, paid guest booking. */
function exactLocationForGuest(booking) {
  return isPaidGuestBooking(booking);
}

function listingForHost(listing) {
  const obj = plain(listing);
  if (!obj || typeof obj !== "object") return obj;
  const out = { ...obj };
  // the host's own listing: nothing to hide but the model's vector fields
  for (const f of ["embedding", "embeddingUpdatedAt", "embeddingVersion"]) delete out[f];
  return out;
}

/**
 * @param {Object} booking Mongoose document or plain object (populated or not)
 * @param {Object|null} actor from authz.resolveActor
 */
function bookingForActor(booking, actor) {
  if (!booking) return booking;
  if (authz.isAdmin(actor)) return booking;
  const b = plain(booking);
  const out = { ...b };
  const selfId = actor && actor.id ? String(actor.id) : null;
  const isGuest = !!selfId && idOf(b.userId) === selfId;
  const isHost = !!selfId && idOf(b.hostId) === selfId;

  if (isPopulated(b.userId)) out.userId = isGuest ? toSelfUser(b.userId) : toPublicUser(b.userId, { fallbackName: "Guest" });
  if (isPopulated(b.hostId)) out.hostId = isHost ? toSelfUser(b.hostId) : toPublicUser(b.hostId, { fallbackName: "Host" });
  if (isPopulated(b.propertyId)) {
    const listing = plain(b.propertyId);
    // The booking's host role covers the booking record; the listing itself
    // is owned by its CURRENT host (a listing may have been reassigned since).
    if (isHost && idOf(listing.host) === selfId) out.propertyId = listingForHost(b.propertyId);
    else {
      const paidGuest = isGuest && exactLocationForGuest(b);
      const view = paidGuest ? sanitizePropertyForBookedGuest(b.propertyId) : sanitizeProperty(b.propertyId);
      // A listing that is no longer public (delisted, in review again,
      // banned): a confirmed, paid guest keeps the operational facts of THIS
      // booking (its snapshot, its cancellation terms) — never the host's
      // current, possibly unpublished, listing text; anyone else (another
      // booking state, a former host) the stub (docs/listing-visibility.md).
      // A populate that did not select "status" carries only the few fields
      // it selected and is left as it was.
      const hidden = listing && listing.status !== undefined && !isPublicListing(listing);
      if (!hidden) out.propertyId = view;
      else if (paidGuest) out.propertyId = bookedGuestListingView(view, b);
      else out.propertyId = listingStubView(sanitizeProperty(b.propertyId));
    }
  }
  if (isPopulated(b.payment)) {
    const p = plain(b.payment);
    out.payment = { ...p };
    delete out.payment.customerDetails;
  }
  return out;
}

function bookingsForActor(bookings, actor) {
  if (!Array.isArray(bookings)) return bookings;
  return bookings.map((b) => bookingForActor(b, actor));
}

module.exports = { bookingForActor, bookingsForActor, exactLocationForGuest, SENSITIVE_PROPERTY_FIELDS };

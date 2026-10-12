// What a booking entitles its guest to read about the listing — ONE rule for
// every read path (the listing detail policy in services/listingAccess.js and
// the booking responses in utils/bookingView.js), so the two can never drift:
// a real guest booking (made by a guest on Majestic Escape, not an imported
// calendar row and not a host's own date block) that is confirmed and paid.
// Such a guest may read the exact location of the stay and, if the listing is
// no longer public, the operational facts of their booking.
function isPaidGuestBooking(b) {
  return !!b && b.status === "confirmed" && b.paymentStatus === "paid" && b.source !== "ical" && b.action !== "host";
}

// The same rule as a Mongo filter (a fresh object per call).
function paidGuestBookingFilter(extra) {
  return { status: "confirmed", paymentStatus: "paid", source: { $ne: "ical" }, action: { $ne: "host" }, ...(extra || {}) };
}

// A booking's recorded cancellation terms in the listing's shape
// ({ strict | moderate | flexible: true }) — the policy refunds are computed
// from, whatever the listing says today.
function cancellationTypeOf(policy) {
  if (!["strict", "moderate", "flexible"].includes(policy)) return undefined;
  return { strict: policy === "strict", moderate: policy === "moderate", flexible: policy === "flexible" };
}

module.exports = { isPaidGuestBooking, paidGuestBookingFilter, cancellationTypeOf };

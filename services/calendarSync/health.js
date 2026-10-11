// Connection health — always DERIVED from timestamps at read time, never a
// stored flag, so a connection can't keep showing green after it stops
// syncing (docs/syncguard.md §5, brief §19).
const STALE_AFTER_MS = (Number(process.env.SYNC_STALE_AFTER_MINUTES) || 180) * 60_000; // Airbnb itself refreshes every 3 h
const OUTBOUND_QUIET_MS = 12 * 3600_000;

const MESSAGES = {
  INVALID_URL: "The calendar link isn't valid. Copy it again from the other website.",
  HTTPS_REQUIRED: "Use the secure (https://) calendar link.",
  PRIVATE_ADDRESS: "The calendar link must point to a public website.",
  DNS_FAILED: "We couldn't find the calendar's website. Check the link.",
  CONNECTION_FAILED: "We couldn't connect to the calendar's website. We'll retry automatically.",
  TLS_ERROR: "The calendar website's secure connection couldn't be verified.",
  TIMEOUT: "The calendar website took too long to answer. We'll retry automatically.",
  NOT_FOUND: "The calendar link no longer works (not found). The link may have been reset — copy a fresh one.",
  AUTH_REFUSED: "The calendar website refused access. The link may have been reset — copy a fresh one.",
  RATE_LIMITED: "The calendar website asked us to slow down. We'll retry later.",
  UPSTREAM_ERROR: "The calendar website is having problems. We'll retry automatically.",
  HTTP_ERROR: "The calendar website answered with an error. We'll retry automatically.",
  NOT_ICALENDAR: "The link opens a web page, not a calendar. Copy the calendar (.ics) link instead.",
  TRUNCATED: "The calendar arrived incomplete. We'll retry automatically.",
  MALFORMED: "The calendar couldn't be read. We kept your current blocked dates.",
  TOO_LARGE: "The calendar is too large to import.",
  BODY_TOO_LARGE: "The calendar is too large to import.",
  TOO_MANY_EVENTS: "The calendar has more events than a single stay can have. Check that it's the right calendar.",
  TOO_MANY_OCCURRENCES: "The calendar's repeating events are too complex to import.",
  UNSUPPORTED_ENCODING: "The calendar website sent the calendar in a format we can't read.",
  TOO_MANY_REDIRECTS: "The calendar link redirects too many times.",
  BAD_REDIRECT: "The calendar link redirects to an invalid address.",
  BAD_RESPONSE: "The calendar response couldn't be read. We'll retry automatically.",
  LISTING_GONE: "This listing no longer exists.",
  INTERNAL: "Something went wrong on our side. We'll retry automatically.",
};
const PERMANENT = new Set(["INVALID_URL", "HTTPS_REQUIRED", "PRIVATE_ADDRESS", "NOT_FOUND", "AUTH_REFUSED", "NOT_ICALENDAR", "TOO_LARGE", "BODY_TOO_LARGE", "TOO_MANY_EVENTS", "TOO_MANY_OCCURRENCES", "UNSUPPORTED_ENCODING", "TOO_MANY_REDIRECTS", "BAD_REDIRECT", "LISTING_GONE"]);

function message(code) {
  return MESSAGES[code] || MESSAGES.INTERNAL;
}

// counts: { conflicts, overlaps } (paid-booking conflicts / overlaps with
// another connected site's bookings, of this connection)
function inbound(conn, counts = {}, now = new Date()) {
  if (conn.status === "disconnected") return { state: "DISCONNECTED" };
  const s = conn.sync || {};
  if (!s.lastAttemptAt && !s.lastSuccessAt && !conn.lastFetched) return { state: "PENDING", reason: "Waiting for the first sync" };
  const failures = s.consecutiveFailures || 0;
  const lastOk = s.lastSuccessAt ? new Date(s.lastSuccessAt).getTime() : null;
  if (failures >= 5 || (failures >= 2 && PERMANENT.has(s.lastErrorCode))) return { state: "BROKEN", reason: message(s.lastErrorCode) };
  if (!lastOk || now.getTime() - lastOk > STALE_AFTER_MS) {
    return { state: "STALE", reason: lastOk ? "Bookings from this calendar may be out of date" : message(s.lastErrorCode) };
  }
  if (s.anomaly === "MASS_DISAPPEARANCE") return { state: "NEEDS_ATTENTION", reason: "Most upcoming bookings suddenly disappeared from this calendar. We're keeping those dates blocked until it's confirmed." };
  if (counts.conflicts) return { state: "NEEDS_ATTENTION", reason: "A booking here overlaps a Majestic booking. Our team has been alerted." };
  if (counts.overlaps) return { state: "NEEDS_ATTENTION", reason: "A booking here overlaps one on another connected site. Check both sites — one guest may need to be moved." };
  if (failures >= 1) return { state: "DEGRADED", reason: message(s.lastErrorCode) };
  const partial = partialReason(s.warnings);
  if (partial) return { state: "PARTIAL", reason: partial };
  return { state: "HEALTHY" };
}

// The calendar was read, but some entries only partly (icsReader stats):
// the host must know which dates Majestic may not be blocking.
const WARNING_TEXT = {
  unsupportedRule: "some repeating entries use a pattern Majestic can't follow (only their first date is blocked)",
  invalid: "some entries have dates Majestic can't read (those dates are not blocked)",
  unknownTz: "some entries use a time zone Majestic doesn't recognise (they were read in India time)",
  tooManyExceptions: "some repeating entries list too many exceptions (all their dates are blocked)",
};
function partialReason(warnings) {
  const parts = (warnings || []).map((w) => WARNING_TEXT[w]).filter(Boolean);
  if (!parts.length) return null;
  return `This calendar was read, but ${parts.join("; ")}. Please check those dates and block them on Majestic if needed.`;
}

// What can actually be verified about Majestic → OTA: only that someone
// fetched the feed, never that the host saved it in the OTA.
function outbound(conn, now = new Date()) {
  // A disconnected import's link keeps serving (until the host stops it).
  if (!conn.secret) return { state: "NOT_SET_UP" };
  const ex = conn.export || {};
  if (!ex.lastServedAt) return { state: ex.hostConfirmedAt ? "WAITING" : "NOT_CONFIRMED" };
  if (now.getTime() - new Date(ex.lastServedAt).getTime() > OUTBOUND_QUIET_MS) return { state: "QUIET" };
  // Anything can request a link (a chat preview, a browser): only a
  // requester that identifies as a calendar service counts as "in use".
  if (!ex.lastServedAgent || ex.lastServedAgent === "Other") return { state: "OPENED" };
  return { state: "ACTIVE" };
}

module.exports = { inbound, outbound, message, PERMANENT, STALE_AFTER_MS, OUTBOUND_QUIET_MS };

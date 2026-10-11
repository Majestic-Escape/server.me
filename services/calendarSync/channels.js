// Provider registry for SyncGuard (docs/syncguard.md).
//
// Every provider is synchronised through the same generic iCal code; this
// file only carries what differs between them: how to recognise a URL,
// what their SUMMARY markers mean (a *hint* — nothing depends on it except
// echo eligibility, see reconcile.js), and the host-facing setup guide. The
// host UI renders the guide from GET /calendarSync/properties/:id/connections,
// so wording changes need no frontend release.
//
// Refresh intervals are quoted from each provider's own help pages
// (researched 2026-10-03, see docs/syncguard.md §9); they are what the OTA
// does with *our* feed and are shown to hosts as expectations, not promises.

const CHANNEL_IDS = ["AIRBNB", "BOOKING_COM", "AGODA", "VRBO", "MAKE_MY_TRIP", "GOIBIBO", "GENERIC_ICAL"];

const CHANNELS = {
  AIRBNB: {
    id: "AIRBNB",
    label: "Airbnb",
    hosts: [/(^|\.)airbnb\.[a-z]{2,3}(\.[a-z]{2})?$/],
    // Observed on real Airbnb feeds: blocked nights are exported as
    // "Airbnb (Not available)". Reservations are reported (third-party
    // sources only) as "Reserved"; nothing else depends on that.
    blockSummaries: [/^airbnb \(not available\)$/i, /^not available$/i],
    reservedSummaries: [/^reserved$/i],
    // Observed in real Airbnb feeds (docs §9): blocked nights carry this
    // marker. Only a VERIFIED marker may narrow decisions (echo eligibility,
    // alert severity); every other provider's markers are display hints.
    blockMarkerVerified: true,
    icalDocumented: true,
    refresh: "Airbnb checks connected calendars about every 3 hours",
    helpUrl: "https://www.airbnb.com/help/article/99",
    importSteps: [
      "In Airbnb, open the listing's Calendar, then its availability settings and choose “Connect calendars” (or “Connect to another website”).",
      "Copy the Airbnb calendar link — it ends in .ics.",
      "Paste it below and choose Test & connect.",
    ],
    exportSteps: [
      "In the same Airbnb screen, choose to import or connect another calendar.",
      "Paste your Majestic link, give it a name such as “Majestic Escape”, and save.",
    ],
  },
  BOOKING_COM: {
    id: "BOOKING_COM",
    label: "Booking.com",
    hosts: [/(^|\.)booking\.com$/],
    blockSummaries: [/not available/i, /^closed/i],
    reservedSummaries: [],
    icalDocumented: true,
    refresh: "Booking.com imports connected calendars about every 2 hours",
    helpUrl: "https://partner.booking.com/en-us/help/rates-availability/extranet-calendar/how-synchronize-your-calendars-across-channels",
    note: "Booking.com offers calendar sync only for room types with a single unit, and not when you use a channel manager.",
    importSteps: [
      "In the Booking.com extranet open Rates & Availability → Sync calendars.",
      "Export the room's calendar and copy the link (ends in .ics).",
      "Paste it below and choose Test & connect.",
    ],
    exportSteps: [
      "In the same Sync calendars screen, choose to import a calendar.",
      "Paste your Majestic link, name it “Majestic Escape”, and save.",
    ],
  },
  AGODA: {
    id: "AGODA",
    label: "Agoda",
    hosts: [/(^|\.)agoda\.(com|net)$/],
    blockSummaries: [/not available/i, /blocked/i],
    reservedSummaries: [],
    icalDocumented: true,
    refresh: "Agoda refreshes connected calendars several times a day",
    helpUrl: "https://partnerhub.agoda.com/how-do-i-connect-my-agoda-calendar-with-other-websites/",
    note: "Agoda calendar sync works for room types with one room.",
    importSteps: [
      "In Agoda's partner portal open the calendar and choose to connect calendars.",
      "Use “Copy calendar link” to copy Agoda's link.",
      "Paste it below and choose Test & connect.",
    ],
    exportSteps: [
      "In the same screen, add an “Other website link”.",
      "Paste your Majestic link and save.",
    ],
  },
  VRBO: {
    id: "VRBO",
    label: "Vrbo",
    hosts: [/(^|\.)vrbo\.com$/, /(^|\.)homeaway\.[a-z.]+$/],
    blockSummaries: [/blocked/i, /not available/i],
    reservedSummaries: [/^reserved/i],
    icalDocumented: true,
    refresh: "Vrbo syncs connected calendars about every 30 minutes",
    helpUrl: "https://help.vrbo.com/articles/How-do-I-import-my-iCal-or-Google-calendar",
    note: "Vrbo accepts up to five calendars per property and syncs the next 365 days. Do not export tentative bookings to Majestic.",
    importSteps: [
      "In Vrbo open Calendar → Import/Export.",
      "Export the reservation calendar and copy the link.",
      "Paste it below and choose Test & connect.",
    ],
    exportSteps: [
      "In the same Import/Export screen, choose Import calendar.",
      "Paste your Majestic link, name it “Majestic Escape”, and save.",
    ],
  },
  MAKE_MY_TRIP: {
    id: "MAKE_MY_TRIP",
    label: "MakeMyTrip",
    hosts: [/(^|\.)makemytrip\.com$/, /(^|\.)go-mmt\.com$/],
    blockSummaries: [],
    reservedSummaries: [],
    icalDocumented: false,
    refresh: "MakeMyTrip does not publish a calendar refresh interval",
    helpUrl: null,
    note: "MakeMyTrip does not document iCal calendar sync; it normally syncs through channel managers. Connect it here only if your extranet gives you an .ics link.",
    importSteps: [
      "If the MakeMyTrip extranet shows a calendar (.ics) link, copy it.",
      "Paste it below and choose Test & connect.",
    ],
    exportSteps: ["If MakeMyTrip lets you import an external calendar, paste your Majestic link there."],
  },
  GOIBIBO: {
    id: "GOIBIBO",
    label: "Goibibo",
    hosts: [/(^|\.)goibibo\.com$/],
    blockSummaries: [],
    reservedSummaries: [],
    icalDocumented: false,
    refresh: "Goibibo does not publish a calendar refresh interval",
    helpUrl: null,
    note: "Goibibo (part of MakeMyTrip) does not document iCal calendar sync. Connect it here only if your extranet gives you an .ics link.",
    importSteps: [
      "If the Goibibo extranet shows a calendar (.ics) link, copy it.",
      "Paste it below and choose Test & connect.",
    ],
    exportSteps: ["If Goibibo lets you import an external calendar, paste your Majestic link there."],
  },
  GENERIC_ICAL: {
    id: "GENERIC_ICAL",
    label: "Other calendar (iCal)",
    hosts: [],
    blockSummaries: [],
    reservedSummaries: [],
    icalDocumented: true,
    refresh: "Other calendars refresh on their own schedule",
    helpUrl: null,
    importSteps: [
      "Copy the calendar's export link (an https:// or webcal:// address, usually ending in .ics).",
      "Paste it below and choose Test & connect.",
    ],
    exportSteps: ["Paste your Majestic link wherever that platform lets you import or subscribe to a calendar."],
  },
};

function isChannel(id) {
  return CHANNEL_IDS.includes(id);
}

// Infers the provider from the URL host; GENERIC_ICAL when unknown.
function inferChannel(rawUrl) {
  let host = "";
  try {
    host = new URL(String(rawUrl).replace(/^webcals?:\/\//i, "https://")).hostname.toLowerCase();
  } catch {
    return "GENERIC_ICAL";
  }
  for (const id of CHANNEL_IDS) {
    if (CHANNELS[id].hosts.some((re) => re.test(host))) return id;
  }
  return "GENERIC_ICAL";
}

// "reserved" | "blocked" | "unknown" — a display/eligibility hint only.
function classifySummary(channel, summary) {
  const c = CHANNELS[channel] || CHANNELS.GENERIC_ICAL;
  const s = String(summary || "").trim();
  if (!s) return "unknown";
  if (c.reservedSummaries.some((re) => re.test(s))) return "reserved";
  if (c.blockSummaries.some((re) => re.test(s))) return "blocked";
  return "unknown";
}

// Whether the provider's marker for blocked (non-reservation) nights has
// been verified on real feeds. Only then may a decision rely on it.
function hasVerifiedBlockMarker(channel) {
  const c = CHANNELS[channel];
  return !!(c && c.blockMarkerVerified && c.blockSummaries.length);
}

// What the host UI needs (no regexes).
function publicProviders() {
  return CHANNEL_IDS.map((id) => {
    const c = CHANNELS[id];
    return {
      id,
      label: c.label,
      icalDocumented: c.icalDocumented,
      refresh: c.refresh,
      helpUrl: c.helpUrl,
      note: c.note || null,
      importSteps: c.importSteps,
      exportSteps: c.exportSteps,
    };
  });
}

function label(channel) {
  return (CHANNELS[channel] || CHANNELS.GENERIC_ICAL).label;
}

module.exports = { CHANNEL_IDS, CHANNELS, isChannel, inferChannel, classifySummary, hasVerifiedBlockMarker, publicProviders, label };

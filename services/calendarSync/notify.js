// Host e-mails for SyncGuard, through the existing generic host
// notification template (utils/sendEmail.js#sendHostNotification). Callers
// claim exactly-once flags before calling; these only send.
const User = require("../../models/User");
const emailer = require("../../utils/sendEmail");
const { label } = require("./channels");

async function hostContact(listing) {
  const user = listing.host ? await User.findById(listing.host).select("firstName email").lean() : null;
  const email = (user && user.email) || listing.hostEmail;
  return email ? { email, firstName: (user && user.firstName) || "there" } : null;
}

function niceDays(nights) {
  return (nights || []).slice(0, 6).join(", ") + ((nights || []).length > 6 ? ` and ${nights.length - 6} more` : "");
}

// possible: the dates match what Majestic sends to that OTA, so it may only
// be the OTA mirroring the Majestic booking — but that is not proof.
async function conflict({ listing, channel, nights, possible = false }) {
  const to = await hostContact(listing);
  if (!to) return;
  const where = `“${listing.title || "your stay"}”`;
  const text = possible
    ? `${label(channel)} shows ${niceDays(nights)} as unavailable for ${where}, and a guest has booked those nights on Majestic Escape. ` +
      `This is often just ${label(channel)} mirroring the Majestic booking — please open ${label(channel)} and check there is no second guest on those dates. Our team has been alerted too.`
    : `${label(channel)} now shows a booking on ${niceDays(nights)} for ${where}, but a guest has already booked those nights on Majestic Escape. ` +
      `Please check ${label(channel)} and contact us so one of the guests can be moved. Our team has been alerted too.`;
  await emailer.sendHostNotification(to.email, to.firstName, text);
}

// Two connected sites report the same nights and neither looks like a copy
// of the other: possibly one of them sold the nights twice. Majestic keeps
// them blocked either way; only the host can check which booking is real.
async function overlap({ listing, channel, otherChannels = [], nights }) {
  const to = await hostContact(listing);
  if (!to) return;
  const others = otherChannels.length ? otherChannels.map(label).join(" and ") : "another connected site";
  await emailer.sendHostNotification(
    to.email,
    to.firstName,
    `${label(channel)} shows ${niceDays(nights)} as booked or unavailable for “${listing.title || "your stay"}”, and ${others} shows the same nights as booked or unavailable too. ` +
      `If both are real bookings, one guest has to be moved — please check both sites. Majestic Escape keeps these nights blocked either way.`,
  );
}

async function broken({ listing, channel, message }) {
  const to = await hostContact(listing);
  if (!to) return;
  await emailer.sendHostNotification(
    to.email,
    to.firstName,
    `We can't read your ${label(channel)} calendar for “${listing.title || "your stay"}”: ${message} ` +
      `Until it works again Majestic Escape cannot see bookings you take on ${label(channel)}. Open Calendar → Calendar sync in your host dashboard to fix or remove it.`,
  );
}

// The whole calendar suddenly emptied (docs §3): dates stay blocked; the
// host should look before the automatic 12-hour release.
async function anomaly({ listing, channel }) {
  const to = await hostContact(listing);
  if (!to) return;
  await emailer.sendHostNotification(
    to.email,
    to.firstName,
    `Your ${label(channel)} calendar for “${listing.title || "your stay"}” suddenly shows no upcoming bookings. To be safe, Majestic Escape keeps those dates blocked for at least 12 hours. ` +
      `If the bookings really were cancelled you can release the dates now under Calendar → Calendar sync; if they were not, please check the ${label(channel)} calendar link.`,
  );
}

module.exports = { conflict, overlap, broken, anomaly };

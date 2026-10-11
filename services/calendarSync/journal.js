// Structured logs + the transitions journal (models/CalendarSyncLog.js).
//
// Console lines are single-line JSON tagged "syncguard" (searchable in the
// Vercel log view). Journal writes are best effort: losing a log line must
// never fail a sync. Neither carries URLs, tokens, guest names or raw UIDs.
const CalendarSyncLog = require("../../models/CalendarSyncLog");
const { shortHash } = require("./util");

function log(event, fields = {}, level = "info") {
  const line = JSON.stringify({ tag: "syncguard", event, ...fields });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else if (process.env.NEXT_PUBLIC_ENV !== "test" || process.env.SYNC_LOG_IN_TESTS === "1") console.log(line);
}

// entries: [{ type, propertyId, connectionId?, bookingId?, channel?, uid?, startDay?, endDay?, actorId?, details? }]
async function record(entries) {
  const docs = entries.filter(Boolean).map((e) => ({
    at: e.at || new Date(),
    propertyId: e.propertyId,
    connectionId: e.connectionId,
    bookingId: e.bookingId,
    channel: e.channel,
    type: e.type,
    uidHash: e.uid ? shortHash(e.uid) : undefined,
    startDay: e.startDay,
    endDay: e.endDay,
    actorId: e.actorId,
    details: e.details,
  }));
  if (!docs.length) return;
  try {
    await CalendarSyncLog.insertMany(docs, { ordered: false });
  } catch (err) {
    console.error("[syncguard] journal write failed", err.message);
  }
}

module.exports = { log, record };

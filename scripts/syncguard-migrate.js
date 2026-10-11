#!/usr/bin/env node
// SyncGuard data migration (docs/syncguard.md §12).
//
//   node scripts/syncguard-migrate.js                     preflight report (READ-ONLY, default)
//   node scripts/syncguard-migrate.js --apply             deterministic repairs (idempotent)
//   node scripts/syncguard-migrate.js --create-indexes    create SyncGuard indexes; refuses while
//                                                          any unique-index conflict remains
//   node scripts/syncguard-migrate.js --rollback-prepare  before redeploying the PRE-SyncGuard
//                                                          backend (see §14)
//   node scripts/syncguard-migrate.js --rollback-undo     reverse --rollback-prepare
//   --confirm-db=<name>   abort unless the connected database is <name>
//   --json                machine-readable report
//
// Nothing here deletes a document or invalidates an issued feed URL.
// Prefer DB_URI from the environment over --uri= (keeps the credential out
// of shell history).
require("dotenv").config();
const mongoose = require("mongoose");
const crypto = require("crypto");
const ExternalCalendar = require("../models/ExternalCalendar");
const Booking = require("../models/Booking");
const BookingNight = require("../models/BookingNight");
const ListingProperty = require("../models/ListingProperty");
const CalendarSyncLog = require("../models/CalendarSyncLog");
const channels = require("../services/calendarSync/channels");
const { normaliseUrl } = require("../services/calendarSync/safeFetch");
const { adoptLegacy } = require("../services/calendarSync/reconcile");

const sha = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");
function urlHashOf(url) {
  try {
    return sha(normaliseUrl(url, { allowHttp: false, allowLoopback: false }));
  } catch {
    return sha(String(url || "").trim());
  }
}
const newToken = () => crypto.randomBytes(32).toString("base64url");

// Groups that would violate a SyncGuard unique index.
async function uniqueConflicts() {
  const ec = ExternalCalendar.collection;
  const [secrets, canonical, activeUrl, eventKeys] = await Promise.all([
    ec.aggregate([{ $match: { secret: { $type: "string" } } }, { $group: { _id: "$secret", n: { $sum: 1 } } }, { $match: { n: { $gt: 1 } } }, { $count: "groups" }]).toArray(),
    ec.aggregate([{ $match: { kind: "export", canonical: true } }, { $group: { _id: "$propertyId", n: { $sum: 1 } } }, { $match: { n: { $gt: 1 } } }, { $count: "groups" }]).toArray(),
    ec.aggregate([{ $match: { kind: "import", status: "active", urlHash: { $type: "string" } } }, { $group: { _id: { p: "$propertyId", h: "$urlHash" }, n: { $sum: 1 } } }, { $match: { n: { $gt: 1 } } }, { $count: "groups" }]).toArray(),
    Booking.collection.aggregate([{ $match: { "external.connectionId": { $exists: true } } }, { $group: { _id: { c: "$external.connectionId", k: "$external.key" }, n: { $sum: 1 } } }, { $match: { n: { $gt: 1 } } }, { $count: "groups" }]).toArray(),
  ]);
  const g = (a) => (a[0] ? a[0].groups : 0);
  return { duplicateSecrets: g(secrets), duplicateCanonical: g(canonical), duplicateActiveUrl: g(activeUrl), duplicateEventKeys: g(eventKeys) };
}

async function preflight({ now = new Date() } = {}) {
  const imports = await ExternalCalendar.find({ kind: { $in: ["import", "import_parked"] } }).lean();
  const exports = await ExternalCalendar.find({ kind: "export" }).lean();
  const listingIds = [...new Set([...imports, ...exports].map((r) => String(r.propertyId)))];
  const listings = new Map((await ListingProperty.find({ _id: { $in: listingIds } }).select("host").lean()).map((l) => [String(l._id), l]));
  const r = { database: mongoose.connection.db.databaseName, at: now.toISOString(), externalcalendars: {}, bookings: {}, legacyFeeds: {}, conflicts: {}, plan: {} };

  const activeImports = imports.filter((c) => c.kind === "import" && c.status !== "disconnected");
  const groups = new Map();
  for (const c of activeImports) {
    const k = `${c.propertyId}|${c.urlHash || urlHashOf(c.url)}`;
    groups.set(k, [...(groups.get(k) || []), c]);
  }
  const dupImports = [...groups.values()].filter((g) => g.length > 1);
  const invalidUrls = activeImports.filter((c) => {
    try {
      normaliseUrl(c.url, { allowHttp: false, allowLoopback: false });
      return false;
    } catch {
      return true;
    }
  });
  r.externalcalendars = {
    imports: imports.length,
    activeImports: activeImports.length,
    parked: imports.filter((c) => c.kind === "import_parked").length,
    needChannel: activeImports.filter((c) => !c.channel).length,
    needUrlHash: activeImports.filter((c) => !c.urlHash).length,
    needStatus: activeImports.filter((c) => !c.status).length,
    needSchedule: activeImports.filter((c) => !c.sync || !c.sync.nextSyncAt).length,
    needOutboundToken: activeImports.filter((c) => !c.secret).length,
    duplicateImportGroups: dupImports.length,
    duplicateImportRowsToDisconnect: dupImports.reduce((n, g) => n + g.length - 1, 0),
    importsOfDeletedListings: activeImports.filter((c) => !listings.has(String(c.propertyId))).length,
    importsWithUrlsThatWillFail: invalidUrls.length, // e.g. http:// — will show BROKEN and alert the host
    byChannel: activeImports.reduce((m, c) => ((m[c.channel || channels.inferChannel(c.url)] = (m[c.channel || channels.inferChannel(c.url)] || 0) + 1), m), {}),
  };
  const exportsByProperty = new Map();
  for (const e of exports) exportsByProperty.set(String(e.propertyId), [...(exportsByProperty.get(String(e.propertyId)) || []), e]);
  r.legacyFeeds = {
    exportRows: exports.length,
    withSecret: exports.filter((e) => typeof e.secret === "string").length,
    properties: exportsByProperty.size,
    propertiesWithDuplicates: [...exportsByProperty.values()].filter((g) => g.length > 1).length,
    needCanonical: [...exportsByProperty.values()].filter((g) => !g.some((e) => e.canonical)).length,
    note: "every issued secret keeps serving (Majestic-native events only); nothing is deleted",
  };

  const ical = await Booking.find({ source: { $in: ["ical", "ical_parked"] } }).select("propertyId hostId userId sourceId status checkOut external").lean();
  const today = new Date(Math.floor(now.getTime() / 86_400_000) * 86_400_000);
  const connsByProperty = new Map();
  for (const c of activeImports) connsByProperty.set(String(c.propertyId), [...(connsByProperty.get(String(c.propertyId)) || []), c]);
  const wrongHost = ical.filter((b) => {
    const l = listings.get(String(b.propertyId));
    return l && (String(b.hostId) !== String(l.host) || String(b.userId) !== String(l.host));
  });
  const legacy = ical.filter((b) => !b.external || !b.external.connectionId);
  const dupLegacy = new Map();
  for (const b of legacy) dupLegacy.set(`${b.propertyId}|${b.sourceId}`, (dupLegacy.get(`${b.propertyId}|${b.sourceId}`) || 0) + 1);
  const otherListings = new Set(ical.map((b) => String(b.propertyId)).filter((id) => !listings.has(id)));
  const allListings = new Map((await ListingProperty.find({ _id: { $in: [...otherListings] } }).select("host").lean()).map((l) => [String(l._id), l]));
  const unowned = legacy.filter((b) => !(connsByProperty.get(String(b.propertyId)) || []).length);
  r.bookings = {
    icalRows: ical.length,
    parked: ical.filter((b) => b.source === "ical_parked").length,
    wrongHostRows: wrongHost.length + ical.filter((b) => allListings.has(String(b.propertyId)) && String(b.hostId) !== String(allListings.get(String(b.propertyId)).host)).length,
    legacyRows: legacy.length,
    legacyAdoptableNow: legacy.filter((b) => (connsByProperty.get(String(b.propertyId)) || []).length === 1).length,
    legacyAdoptedAtFirstSyncByUid: legacy.filter((b) => (connsByProperty.get(String(b.propertyId)) || []).length > 1).length,
    legacyDuplicateUidGroups: [...dupLegacy.values()].filter((n) => n > 1).length,
    unownedLegacyRows: unowned.length,
    unownedLegacyFutureBlocking: unowned.filter((b) => b.status === "confirmed" && new Date(b.checkOut) > today).length,
    note: "unowned rows (no import connection) keep blocking; a human decides (they were never auto-released)",
  };
  const orphanNights = await BookingNight.aggregate([{ $match: { kind: "ical" } }, { $lookup: { from: "bookings", localField: "bookingId", foreignField: "_id", as: "b" } }, { $match: { $or: [{ b: { $size: 0 } }, { "b.status": { $in: ["cancelled", "rejected"] } }] } }, { $count: "n" }]);
  r.bookings.icalNightRowsWithoutLiveBooking = orphanNights[0] ? orphanNights[0].n : 0;
  r.conflicts = await uniqueConflicts();
  r.indexes = {};
  for (const [coll, model] of [["externalcalendars", ExternalCalendar], ["bookings", Booking], ["calendarsynclogs", CalendarSyncLog]]) {
    const names = (await model.collection.indexes().catch(() => [])).map((i) => i.name);
    r.indexes[coll] = names;
  }
  r.plan = {
    willRepair: r.externalcalendars.needChannel + r.externalcalendars.needUrlHash + r.externalcalendars.needStatus + r.externalcalendars.needSchedule + r.bookings.wrongHostRows + r.legacyFeeds.needCanonical + r.externalcalendars.duplicateImportRowsToDisconnect + r.bookings.parked + r.externalcalendars.parked,
    indexCreationSafeAfterApply: r.conflicts.duplicateSecrets === 0,
    humanDecisionsNeeded: [
      ...(r.conflicts.duplicateSecrets ? [`${r.conflicts.duplicateSecrets} feed secret(s) shared by several rows — cannot be repaired without invalidating a URL`] : []),
      ...(r.bookings.unownedLegacyFutureBlocking ? [`${r.bookings.unownedLegacyFutureBlocking} future imported block(s) with no calendar connection — confirm with the hosts before releasing`] : []),
      ...(r.externalcalendars.importsWithUrlsThatWillFail ? [`${r.externalcalendars.importsWithUrlsThatWillFail} connection(s) whose saved URL will be refused (e.g. http://) — hosts are alerted automatically`] : []),
    ],
  };
  return r;
}

async function apply({ now = new Date(), log = console.log } = {}) {
  const out = { unparkedConnections: 0, unparkedRows: 0, connectionsRepaired: 0, duplicatesDisconnected: 0, listingGone: 0, canonicalSet: 0, legacyScopeSet: 0, hostRepaired: 0, adopted: 0 };
  // 0. Undo a rollback preparation, if one is present (idempotent).
  out.unparkedConnections = (await ExternalCalendar.updateMany({ kind: "import_parked" }, { $set: { kind: "import" } })).modifiedCount;
  out.unparkedRows = (await Booking.updateMany({ source: "ical_parked" }, { $set: { source: "ical" } })).modifiedCount;

  // 1+2. Import connections: deterministic defaults, oldest first. A row that
  //      would become a second active connection of the same URL on the same
  //      listing is retired IN THE SAME UPDATE, so this works whether or not
  //      the unique index already exists (e.g. a re-run after the old backend
  //      wrote new legacy rows during the rollout).
  const imports = await ExternalCalendar.find({ kind: "import" }).sort({ _id: 1 }).lean();
  const listings = new Map((await ListingProperty.find({ _id: { $in: imports.map((c) => c.propertyId) } }).select("host").lean()).map((l) => [String(l._id), l]));
  const activeKeys = new Set();
  const retire = (reason) => ({ status: "disconnected", disconnectedAt: now, disconnectReason: reason, disconnectMode: "keep" });
  for (const c of imports) {
    const set = {};
    const unset = {};
    const listing = listings.get(String(c.propertyId));
    const hash = c.urlHash || (c.url ? urlHashOf(c.url) : null);
    if (!c.status) set.status = "active";
    if (!c.channel && c.url) set.channel = channels.inferChannel(c.url);
    if (!c.urlHash && c.url) set.urlHash = hash;
    if (!c.name) set.name = channels.label(c.channel || set.channel || "GENERIC_ICAL");
    if (!c.hostId && listing) set.hostId = listing.host;
    if (!c.createdAt) set.createdAt = c._id.getTimestamp();
    if (!c.sync || !c.sync.nextSyncAt) set["sync.nextSyncAt"] = now;
    let willBeActive = (c.status || set.status) === "active";
    if (willBeActive && !listing) {
      Object.assign(set, retire("listing_deleted"));
      out.listingGone += 1;
      willBeActive = false;
    }
    if (willBeActive && hash) {
      const k = `${c.propertyId}|${hash}`;
      if (activeKeys.has(k)) {
        Object.assign(set, retire("duplicate_merged"));
        unset.secret = "";
        out.duplicatesDisconnected += 1;
        willBeActive = false;
      } else activeKeys.add(k);
    }
    if (willBeActive && !c.secret) Object.assign(set, { secret: newToken(), exportScope: "destination" });
    if (Object.keys(set).length || Object.keys(unset).length) {
      await ExternalCalendar.updateOne({ _id: c._id }, { $set: set, ...(Object.keys(unset).length ? { $unset: unset } : {}) });
      out.connectionsRepaired += 1;
    }
    // A retired duplicate's imported rows (only possible if SyncGuard already
    // synced it, e.g. a re-run) keep blocking — as "orphaned", which the host
    // sees and can release — instead of staying "active" with no live feed.
    if (set.disconnectReason === "duplicate_merged") {
      const orphaned = await Booking.updateMany({ "external.connectionId": c._id, "external.state": { $in: ["active", "missing"] } }, { $set: { "external.state": "orphaned", updatedAt: now }, $inc: { "external.rev": 1 } });
      out.duplicateRowsOrphaned = (out.duplicateRowsOrphaned || 0) + orphaned.modifiedCount;
    }
  }
  // 3. Legacy feeds: the oldest row per listing is canonical; every secret keeps working.
  out.legacyScopeSet = (await ExternalCalendar.updateMany({ kind: "export", exportScope: { $exists: false } }, { $set: { exportScope: "legacy" } })).modifiedCount;
  const exportRows = await ExternalCalendar.find({ kind: "export", secret: { $type: "string" } }).sort({ _id: 1 }).lean();
  const firstByProperty = new Map();
  for (const e of exportRows) if (!firstByProperty.has(String(e.propertyId))) firstByProperty.set(String(e.propertyId), e);
  for (const [pid, e] of firstByProperty) {
    if (await ExternalCalendar.exists({ propertyId: pid, kind: "export", canonical: true })) continue;
    await ExternalCalendar.updateOne({ _id: e._id }, { $set: { canonical: true } });
    out.canonicalSet += 1;
  }
  // 4. Imported rows: repair host attribution (defect D3) and adopt legacy
  //    rows into the listing's single connection (same code as the live sync).
  const ical = await Booking.find({ source: "ical" }).select("propertyId hostId userId").lean();
  const allListings = new Map((await ListingProperty.find({ _id: { $in: [...new Set(ical.map((b) => String(b.propertyId)))] } }).select("host").lean()).map((l) => [String(l._id), l]));
  for (const b of ical) {
    const l = allListings.get(String(b.propertyId));
    if (l && (String(b.hostId) !== String(l.host) || String(b.userId) !== String(l.host))) {
      await Booking.updateOne({ _id: b._id }, { $set: { hostId: l.host, userId: l.host } });
      out.hostRepaired += 1;
    }
  }
  const actives = await ExternalCalendar.find({ kind: "import", status: "active" }).lean();
  const perProperty = new Map();
  for (const c of actives) perProperty.set(String(c.propertyId), [...(perProperty.get(String(c.propertyId)) || []), c]);
  for (const [pid, conns] of perProperty) {
    if (conns.length !== 1) continue; // several connections: adopted by UID at their first sync
    const listing = allListings.get(pid) || (await ListingProperty.findById(pid).select("host").lean());
    if (!listing) continue;
    out.adopted += await adoptLegacy({ conn: { ...conns[0], channel: conns[0].channel || channels.inferChannel(conns[0].url) }, listing, feedUids: new Set() });
  }
  log(`[syncguard-migrate] apply: ${JSON.stringify(out)}`);
  return out;
}

async function createIndexes({ log = console.log } = {}) {
  const conflicts = await uniqueConflicts();
  const blocking = Object.entries(conflicts).filter(([, n]) => n > 0);
  if (blocking.length) {
    log(`[syncguard-migrate] REFUSED: unique-index conflicts remain ${JSON.stringify(conflicts)} — run --apply / resolve, then retry`);
    return { created: false, conflicts };
  }
  await ExternalCalendar.createIndexes();
  await CalendarSyncLog.createIndexes();
  await Booking.collection.createIndex(
    { "external.connectionId": 1, "external.key": 1 },
    { unique: true, name: "external_connection_key", partialFilterExpression: { "external.connectionId": { $exists: true } } },
  );
  log("[syncguard-migrate] indexes created (or already present)");
  return { created: true, conflicts };
}

// Before redeploying the pre-SyncGuard backend: its sync knows one calendar
// per listing and cancels every imported row of the listing that is not in
// that calendar. Leave exactly one import per listing visible to it and
// hide every other imported row (they keep blocking — availability readers
// do not look at `source`).
async function rollbackPrepare({ log = console.log } = {}) {
  const out = { parkedConnections: 0, parkedRows: 0 };
  const conns = await ExternalCalendar.find({ kind: "import" }).sort({ _id: 1 }).lean();
  const kept = new Map();
  for (const c of conns) {
    const pid = String(c.propertyId);
    if (c.status !== "disconnected" && c.url && !kept.has(pid)) {
      kept.set(pid, c._id);
      continue;
    }
    if (c.status !== "disconnected" && c.url) {
      await ExternalCalendar.updateOne({ _id: c._id }, { $set: { kind: "import_parked" } });
      out.parkedConnections += 1;
    }
  }
  const rows = await Booking.find({ source: "ical" }).select("propertyId external").lean();
  for (const b of rows) {
    const keep = kept.get(String(b.propertyId));
    const own = b.external && b.external.connectionId && keep && String(b.external.connectionId) === String(keep);
    const legacyOfKept = !(b.external && b.external.connectionId) && keep;
    if (own || legacyOfKept) continue;
    await Booking.updateOne({ _id: b._id }, { $set: { source: "ical_parked" } });
    out.parkedRows += 1;
  }
  log(`[syncguard-migrate] rollback-prepare: ${JSON.stringify(out)}`);
  return out;
}

async function rollbackUndo({ log = console.log } = {}) {
  const out = {
    connections: (await ExternalCalendar.updateMany({ kind: "import_parked" }, { $set: { kind: "import" } })).modifiedCount,
    rows: (await Booking.updateMany({ source: "ical_parked" }, { $set: { source: "ical" } })).modifiedCount,
  };
  log(`[syncguard-migrate] rollback-undo: ${JSON.stringify(out)}`);
  return out;
}

module.exports = { preflight, apply, createIndexes, rollbackPrepare, rollbackUndo, uniqueConflicts };

if (require.main === module) {
  const args = process.argv.slice(2);
  const has = (f) => args.includes(f);
  const opt = (n) => {
    const a = args.find((x) => x.startsWith(`--${n}=`));
    return a ? a.slice(n.length + 3) : undefined;
  };
  (async () => {
    const uri = opt("uri") || process.env.DB_URI;
    if (!uri) throw new Error("DB_URI (or --uri) is required");
    await mongoose.connect(uri, { autoIndex: false });
    const db = mongoose.connection.db.databaseName;
    if (opt("confirm-db") && opt("confirm-db") !== db) throw new Error(`connected to "${db}", not "${opt("confirm-db")}" — aborting`);
    let result;
    if (has("--rollback-prepare")) result = await rollbackPrepare();
    else if (has("--rollback-undo")) result = await rollbackUndo();
    else if (has("--apply") || has("--create-indexes")) {
      result = {};
      if (has("--apply")) result.apply = await apply();
      if (has("--create-indexes")) result.indexes = await createIndexes();
      result.after = await preflight();
    } else result = await preflight();
    console.log(has("--json") ? JSON.stringify(result) : JSON.stringify(result, null, 2));
    await mongoose.disconnect();
    if (result && result.indexes && result.indexes.created === false) process.exit(2);
  })().catch(async (err) => {
    console.error("[syncguard-migrate] failed:", err.message);
    await mongoose.disconnect().catch(() => {});
    process.exit(1);
  });
}

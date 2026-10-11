// models/ExternalCalendar.js
//
// SyncGuard (docs/syncguard.md §2.1). Two kinds of rows, both pre-existing:
//   kind "import" — a *connection* to one external calendar: the inbound URL
//                   (fetched by SyncGuard) plus, optionally, the outbound
//                   token of that connection's destination feed (`secret`,
//                   exportScope "destination");
//   kind "export" — the legacy property-level feed issued before SyncGuard
//                   (exportScope "legacy": Majestic-native events only).
// Every field added by SyncGuard is optional, so rows written by the old
// code keep working and old code ignores the new fields.
const mongoose = require("mongoose");
const { CHANNEL_IDS } = require("../services/calendarSync/channels");

const syncSchema = new mongoose.Schema(
  {
    nextSyncAt: { type: Date, default: null },
    leaseUntil: { type: Date, default: null },
    leaseToken: { type: String, default: null },
    firstAttemptAt: { type: Date, default: null },
    lastAttemptAt: { type: Date, default: null },
    lastSuccessAt: { type: Date, default: null },
    lastChangeAt: { type: Date, default: null }, // feed meaning changed
    lastFullAt: { type: Date, default: null }, // last unconditional reconciliation
    lastHttpStatus: { type: Number, default: null },
    lastErrorCode: { type: String, default: null },
    lastErrorAt: { type: Date, default: null },
    consecutiveFailures: { type: Number, default: 0 },
    contentHash: { type: String, default: null },
    eventCount: { type: Number, default: null },
    pendingMissing: { type: Number, default: 0 }, // rows awaiting confirmation of a disappearance
    pendingEchoes: { type: Number, default: 0 }, // possible echoes awaiting promotion review
    pendingFlags: { type: Number, default: 0 }, // OTA conflicts not yet in the admin queue
    anomaly: { type: String, default: null }, // "MASS_DISAPPEARANCE" while a suspicious shrink is pending
    anomalyAt: { type: Date, default: null },
    anomalyAlertedAt: { type: Date, default: null }, // host told once per anomaly episode
    warnings: { type: [String], default: undefined }, // e.g. ["unsupportedRule"]
    alertedAt: { type: Date, default: null }, // host told the connection is broken (exactly once per episode)
    lastDurationMs: { type: Number, default: null },
    manualAt: { type: Date, default: null }, // last host "Sync now" (rate limit)
  },
  { _id: false },
);

const externalCalendarSchema = new mongoose.Schema({
  propertyId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "ListingProperty",
    required: true,
  },
  url: { type: String }, // remote ICS URL (a credential: never logged)
  kind: { type: String, enum: ["import", "export", "import_parked"], default: "import" },
  secret: { type: String }, // outbound feed token (legacy: 32 hex; SyncGuard: 256-bit base64url)
  etag: { type: String }, // ETag of the last 200
  lastModified: { type: Date }, // Last-Modified of the last 200
  lastFetched: { type: Date },
  // --- SyncGuard ---
  channel: { type: String, enum: CHANNEL_IDS, default: undefined },
  name: { type: String, default: undefined, maxlength: 60 },
  hostId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: undefined },
  status: { type: String, enum: ["active", "disconnected"], default: undefined }, // undefined (legacy) = active
  disconnectedAt: { type: Date, default: undefined },
  disconnectReason: { type: String, default: undefined },
  // What the host chose for already-imported blocks when disconnecting:
  // "keep" (default — they stay as orphaned blocks until released) or "release".
  disconnectMode: { type: String, enum: ["keep", "release"], default: undefined },
  urlHash: { type: String, default: undefined },
  exportScope: { type: String, enum: ["legacy", "destination"], default: undefined },
  canonical: { type: Boolean, default: undefined }, // the one legacy export row shown to the host
  export: {
    lastServedAt: { type: Date, default: undefined },
    lastServedAgent: { type: String, default: undefined },
    servedCount: { type: Number, default: undefined },
    hostConfirmedAt: { type: Date, default: undefined },
    rotatedAt: { type: Date, default: undefined },
  },
  sync: { type: syncSchema, default: undefined },
  stats: { type: mongoose.Schema.Types.Mixed, default: undefined },
  createdAt: { type: Date, default: undefined },
  updatedAt: { type: Date, default: undefined },
});

// Created by scripts/syncguard-migrate.js --create-indexes (autoIndex is
// off in production); verified at startup (services/startupChecks.js).
externalCalendarSchema.index({ propertyId: 1, kind: 1 });
externalCalendarSchema.index({ kind: 1, status: 1, "sync.nextSyncAt": 1 });
externalCalendarSchema.index({ secret: 1 }, { unique: true, partialFilterExpression: { secret: { $type: "string" } } });
externalCalendarSchema.index(
  { propertyId: 1 },
  { unique: true, name: "canonical_legacy_export", partialFilterExpression: { kind: "export", canonical: true } },
);
// One active connection per (listing, calendar URL): two concurrent
// "connect" clicks cannot create duplicates.
externalCalendarSchema.index(
  { propertyId: 1, urlHash: 1 },
  { unique: true, name: "one_active_url_per_listing", partialFilterExpression: { kind: "import", status: "active", urlHash: { $type: "string" } } },
);

module.exports = mongoose.model("ExternalCalendar", externalCalendarSchema);

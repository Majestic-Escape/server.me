// Verifies the indexes the booking/payment invariants depend on. Mongoose
// builds schema indexes automatically, but a failed build (e.g. duplicate
// `created` Payment rows from before Batch S) is only logged by Mongoose.
// This makes a missing invariant impossible to miss in the logs.
const mongoose = require("mongoose");

const REQUIRED = [
  { collection: "bookingnights", name: "propertyId_1_date_1", unique: true },
  { collection: "payments", name: "bookingId_1", unique: true, partial: true },
  { collection: "bookings", name: "idempotencyKey_1", unique: true },
  { collection: "hostpayouts", name: "bookingId_1", unique: true },
];

async function verifyRequiredIndexes() {
  const db = mongoose.connection.db;
  const missing = [];
  for (const r of REQUIRED) {
    try {
      const idx = await db.collection(r.collection).indexes();
      const found = idx.find((i) => i.name === r.name && (!r.unique || i.unique));
      if (!found) missing.push(`${r.collection}.${r.name}`);
    } catch (err) {
      missing.push(`${r.collection}.${r.name} (${err.message})`);
    }
  }
  if (missing.length) {
    console.error(
      "[startup] CRITICAL: required unique indexes are missing — run scripts/backfill-booking-nights.js --apply --create-index:",
      missing.join(", "),
    );
  } else {
    console.log("[startup] booking/payment integrity indexes present");
  }
  return missing;
}

// SyncGuard (docs/syncguard.md §12): created by
// scripts/syncguard-migrate.js --apply --create-indexes. Without them the
// sync still works (leases serialise workers) but the database no longer
// enforces one row per external event / one feed per token.
const SYNCGUARD = [
  { collection: "bookings", name: "external_connection_key" },
  { collection: "externalcalendars", name: "secret_1" },
  { collection: "externalcalendars", name: "one_active_url_per_listing" },
  { collection: "externalcalendars", name: "kind_1_status_1_sync.nextSyncAt_1" },
  { collection: "calendarsynclogs", name: "ttl_90d" }, // without it the journal grows forever
];
async function verifySyncGuardIndexes() {
  const db = mongoose.connection.db;
  const missing = [];
  for (const r of SYNCGUARD) {
    const idx = await db.collection(r.collection).indexes().catch(() => []);
    if (!idx.some((i) => i.name === r.name)) missing.push(`${r.collection}.${r.name}`);
  }
  if (missing.length) console.warn("[startup] SyncGuard indexes missing — run scripts/syncguard-migrate.js --apply --create-indexes:", missing.join(", "));
  return missing;
}

module.exports = { verifyRequiredIndexes, verifySyncGuardIndexes, REQUIRED, SYNCGUARD };

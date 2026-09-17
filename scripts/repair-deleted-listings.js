#!/usr/bin/env node
// Finishes admin listing deletions whose post-commit work did not complete
// (process died, Spaces unavailable, audit update failed). Idempotent; safe
// to run any time.
//
//   node scripts/repair-deleted-listings.js            repair
//   node scripts/repair-deleted-listings.js --dry-run  report only
//
// For every "listing.delete" audit row: the dependent sweep (host blocks,
// iCal rows, night rows of any deleted listing) runs again, and photo
// cleanup is retried for rows whose photos.cleanupStatus is "partial" or
// still "pending" after 10 minutes. Objects referenced elsewhere are never
// deleted. Uses DB_URI (or --uri=...).
require("dotenv").config();
const mongoose = require("mongoose");
const AdminAuditLog = require("../models/AdminAuditLog");
const listingDeletion = require("../services/listingDeletion");

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const opt = (name) => {
  const a = args.find((x) => x.startsWith(`--${name}=`));
  return a ? a.slice(name.length + 3) : undefined;
};
const PENDING_GRACE_MS = 10 * 60 * 1000;

// Runs against the current mongoose connection. Returns what it did.
async function repair({ dryRun = false, log = console.log } = {}) {
  const dry = dryRun;
  const summary = { deletions: 0, sweepOutstanding: 0, photosOutstanding: 0, swept: null, photos: [] };

  const rows = await AdminAuditLog.find({ action: "listing.delete" }).sort({ createdAt: 1 }).lean();
  const cutoff = new Date(Date.now() - PENDING_GRACE_MS);
  const needsSweep = rows.filter((r) => !r.details || r.details.sweepStatus !== "complete");
  const needsPhotos = rows.filter((r) => {
    const p = r.details && r.details.photos;
    if (!p || !Array.isArray(p.keys) || !p.keys.length) return false;
    if (p.cleanupStatus === "partial") return true;
    return p.cleanupStatus === "pending" && new Date(r.createdAt) < cutoff;
  });
  summary.deletions = rows.length;
  summary.sweepOutstanding = needsSweep.length;
  summary.photosOutstanding = needsPhotos.length;
  log(`[repair] ${rows.length} deletion(s); sweep outstanding: ${needsSweep.length}; photo cleanup outstanding: ${needsPhotos.length}`);
  if (dry) return summary;

  if (rows.length) {
    const swept = await listingDeletion.sweepDependents();
    summary.swept = swept;
    log(`[repair] dependent sweep removed ${swept.bookings} booking row(s), ${swept.nights} night row(s)`);
    for (const r of needsSweep) await listingDeletion.markAudit(r._id, { "details.sweepStatus": "complete", "details.sweptAt": new Date() });
  }
  for (const r of needsPhotos) {
    const p = r.details.photos;
    const retry = p.cleanupStatus === "partial" ? p.keys.filter((k) => !(p.removed || []).includes(k)) : p.keys;
    const result = await listingDeletion.cleanupPhotos(retry);
    const removed = [...new Set([...(p.removed || []), ...result.removed])];
    const status = result.failed.length ? "partial" : "complete";
    await listingDeletion.markAudit(r._id, {
      "details.photos": { keys: p.keys, cleanupStatus: status, removed, skipped: result.skipped, failed: result.failed, cleanedAt: new Date() },
    });
    summary.photos.push({ targetId: String(r.targetId), removed: result.removed.length, skipped: result.skipped.length, failed: result.failed.length, status });
    log(`[repair] ${r.targetId}: removed ${result.removed.length}, skipped ${result.skipped.length}, failed ${result.failed.length} → ${status}`);
  }
  return summary;
}

async function main() {
  const uri = opt("uri") || process.env.DB_URI;
  if (!uri) throw new Error("DB_URI (or --uri) is required");
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 20000 });
  const dry = has("--dry-run");
  console.log(`[repair] database: ${mongoose.connection.db.databaseName}${dry ? " (dry run)" : ""}`);
  await repair({ dryRun: dry });
}

module.exports = { repair };

if (require.main === module) {
  main()
    .catch((err) => {
      console.error("[repair] failed:", err.message);
      process.exitCode = 1;
    })
    .finally(() => mongoose.disconnect());
}

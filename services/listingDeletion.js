// Admin deletion of a pending ("processing") listing — Batch A2.
//
// Fail-safe, not fail-destructive:
//  * only status "processing" (drafts and live/delisted listings never);
//  * any Booking / BookingNight / Payment / HostPayout / Review / HostReview
//    row is a hard blocker (abnormal for a pending listing → stop, keep the
//    evidence); only ExternalCalendar and BookingInterest rows are cleanup;
//  * the whole DB part is ONE transaction — blocker reads, cleanup deletes,
//    the conditional listing delete and the audit row — every operation
//    awaited sequentially on the same session (the driver does not support
//    parallel operations in a transaction);
//  * after commit: the dependent sweep (host blocks / iCal rows a concurrent
//    or crashed writer may have left, for every listing ever deleted) and
//    the Spaces photo cleanup, each recording its outcome on the audit row
//    whose "pending" statuses were committed with the transaction, so a
//    crash at any point is recoverable by scripts/repair-deleted-listings.js.
const mongoose = require("mongoose");
const ListingProperty = require("../models/ListingProperty");
const Booking = require("../models/Booking");
const BookingNight = require("../models/BookingNight");
const Payment = require("../models/Payment");
const HostPayout = require("../models/HostPayout");
const Review = require("../models/Review");
const HostReview = require("../models/HostReview");
const ExternalCalendar = require("../models/ExternalCalendar");
const BookingInterest = require("../models/BookingInterest");
const User = require("../models/User");
const AdminAuditLog = require("../models/AdminAuditLog");
const storage = require("./storage");

// Admins delete pending submissions and abandoned drafts; a host deletes its
// own drafts and withdraws its own pending submissions. Live / delisted
// listings are never deleted (delist instead).
const DELETABLE_STATUSES = ["processing", "incomplete"];
const HOST_DELETABLE_STATUSES = ["incomplete", "processing"];

class DeletionRefused extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
    this.refused = true;
  }
}

function uniqueKeys(photos) {
  const keys = [];
  for (const p of Array.isArray(photos) ? photos : []) {
    const key = storage.keyFromUrl(p);
    if (key && !keys.includes(key)) keys.push(key);
  }
  return keys;
}

// Blockers in the order they are checked; each is one indexed/small query.
const BLOCKERS = [
  ["bookings", (id, s) => Booking.exists({ propertyId: id }).session(s)],
  ["nights", (id, s) => BookingNight.exists({ propertyId: id }).session(s)],
  ["payments", (id, s) => Payment.exists({ propertyId: id }).session(s)],
  ["payouts", (id, s) => HostPayout.exists({ propertyId: id }).session(s)],
  ["reviews", (id, s) => Review.exists({ property: id }).session(s)],
  ["hostReviews", (id, s) => HostReview.exists({ property: id }).session(s)],
];

// The transactional part. Resolves to the committed snapshot.
//   actorKind "admin" (default): any pending / draft listing.
//   actorKind "host": ownerId must be the listing's host (a foreign listing
//   answers 404, never 403 — no existence oracle) and only that host's own
//   drafts / pending submissions qualify.
async function deleteListingTransaction({ listingId, actorId, actorKind = "admin", ownerId = null }) {
  const allowed = actorKind === "host" ? HOST_DELETABLE_STATUSES : DELETABLE_STATUSES;
  const session = await mongoose.startSession();
  try {
    let snapshot = null;
    await session.withTransaction(async () => {
      snapshot = null;
      const listing = await ListingProperty.findById(listingId).select("status title host photos").session(session);
      if (!listing) throw new DeletionRefused(404, "LISTING_NOT_FOUND", "Listing not found");
      if (actorKind === "host" && (!ownerId || String(listing.host) !== String(ownerId))) throw new DeletionRefused(404, "LISTING_NOT_FOUND", "Listing not found");
      if (!allowed.includes(listing.status)) {
        throw new DeletionRefused(409, "LISTING_NOT_PENDING", "Only drafts and pending listings can be deleted — delist active ones instead", { status: listing.status });
      }
      const photoKeys = uniqueKeys(listing.photos);

      const blockers = [];
      for (const [name, check] of BLOCKERS) {
        // Sequential on purpose: parallel operations are not supported inside a transaction.
        if (await check(listing._id, session)) blockers.push(name);
        if (blockers.length) break;
      }
      if (blockers.length) {
        throw new DeletionRefused(409, "LISTING_HAS_DEPENDENTS", `This listing has ${blockers.join(", ")} attached and cannot be deleted`, { blockers });
      }

      const calendars = await ExternalCalendar.deleteMany({ propertyId: listing._id }, { session });
      const interests = await BookingInterest.deleteMany({ propertyId: String(listing._id) }, { session });
      const deleted = await ListingProperty.findOneAndDelete({ _id: listing._id, status: { $in: allowed }, ...(actorKind === "host" ? { host: ownerId } : {}) }, { session });
      if (!deleted) throw new DeletionRefused(409, "LISTING_NOT_PENDING", "The listing changed while it was being deleted — refresh and try again");

      const rows = await AdminAuditLog.create(
        [
          {
            actorId,
            actorKind,
            action: "listing.delete",
            targetType: "ListingProperty",
            targetId: listing._id,
            details: {
              hostId: listing.host ? String(listing.host) : null,
              title: listing.title || "",
              cleanup: { calendars: calendars.deletedCount || 0, interests: interests.deletedCount || 0 },
              sweepStatus: "pending",
              photos: { keys: photoKeys, cleanupStatus: "pending" },
            },
          },
        ],
        { session },
      );
      snapshot = { id: String(listing._id), title: listing.title || "", hostId: listing.host ? String(listing.host) : null, photoKeys, auditId: rows[0]._id, cleanup: { calendars: calendars.deletedCount || 0, interests: interests.deletedCount || 0 } };
    });
    if (!snapshot) throw new Error("listing deletion produced no snapshot");
    return snapshot;
  } finally {
    await session.endSession().catch(() => {});
  }
}

// Post-commit step (a): host blocks / iCal rows and night rows for every
// listing that was ever deleted (bounded by the number of deletions).
async function sweepDependents() {
  const ids = await AdminAuditLog.distinct("targetId", { action: "listing.delete" });
  if (!ids.length) return { bookings: 0, nights: 0 };
  const bookings = await Booking.deleteMany({ propertyId: { $in: ids }, $or: [{ action: "host" }, { source: "ical" }] });
  const nights = await BookingNight.deleteMany({ propertyId: { $in: ids } });
  return { bookings: bookings.deletedCount || 0, nights: nights.deletedCount || 0 };
}

// Canonical keys still referenced by any listing photo or profile picture.
async function keysInUse() {
  const re = storage.spacesUrlRegex();
  const photos = await ListingProperty.distinct("photos", { photos: { $regex: re } });
  const pictures = await User.distinct("profilePicture", { profilePicture: { $regex: re } });
  const set = new Set();
  for (const url of [...photos, ...pictures]) {
    const key = storage.keyFromUrl(url);
    if (key) set.add(key);
  }
  return set;
}

// Post-commit step (b): remove the listing's own photo objects unless an
// object is still referenced elsewhere.
async function cleanupPhotos(photoKeys) {
  const inUse = await keysInUse();
  const candidates = photoKeys.filter((k) => !inUse.has(k));
  const skipped = photoKeys.filter((k) => inUse.has(k));
  const result = candidates.length ? await storage.deleteObjects(candidates) : { deleted: [], failed: [] };
  return { removed: result.deleted, skipped, failed: result.failed.map((f) => ({ key: f.key, code: f.code || "", message: String(f.message || "").slice(0, 200) })) };
}

async function markAudit(auditId, set) {
  await AdminAuditLog.updateOne({ _id: auditId }, { $set: set });
}

// Runs the post-commit steps for one committed snapshot. Each step is
// idempotent; a failure in one does not stop the next, and every outcome is
// recorded so the repair script can finish the job later.
// Indirection so tests can inject failures into each post-commit step.
const steps = { sweepDependents, cleanupPhotos, markAudit };

async function finishDeletion(snapshot) {
  const outcome = { photosRemoved: 0, photosSkipped: 0, photosFailed: 0 };
  try {
    await steps.sweepDependents();
    await steps.markAudit(snapshot.auditId, { "details.sweepStatus": "complete", "details.sweptAt": new Date() });
  } catch (err) {
    console.error("listing delete: dependent sweep failed", snapshot.id, err && err.message);
  }
  try {
    const photos = await steps.cleanupPhotos(snapshot.photoKeys);
    outcome.photosRemoved = photos.removed.length;
    outcome.photosSkipped = photos.skipped.length;
    outcome.photosFailed = photos.failed.length;
    await steps.markAudit(snapshot.auditId, {
      "details.photos": { keys: snapshot.photoKeys, cleanupStatus: photos.failed.length ? "partial" : "complete", removed: photos.removed, skipped: photos.skipped, failed: photos.failed, cleanedAt: new Date() },
    });
  } catch (err) {
    outcome.photosFailed = snapshot.photoKeys.length;
    console.error("listing delete: photo cleanup failed", snapshot.id, err && err.message);
  }
  return outcome;
}

async function deletePendingListing({ listingId, actorId }) {
  const snapshot = await deleteListingTransaction({ listingId, actorId });
  const outcome = await finishDeletion(snapshot);
  return { snapshot, outcome };
}

// A host deleting its own draft or withdrawing its own pending submission.
async function deleteOwnListing({ listingId, hostId }) {
  const snapshot = await deleteListingTransaction({ listingId, actorId: hostId, actorKind: "host", ownerId: hostId });
  const outcome = await finishDeletion(snapshot);
  return { snapshot, outcome };
}

module.exports = {
  DELETABLE_STATUSES,
  HOST_DELETABLE_STATUSES,
  deleteOwnListing,
  DeletionRefused,
  deleteListingTransaction,
  finishDeletion,
  deletePendingListing,
  sweepDependents,
  cleanupPhotos,
  keysInUse,
  markAudit,
  __steps: steps,
};

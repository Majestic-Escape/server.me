// The only code that may make a listing public, change its host, or ban /
// unban a host's listings (docs/listing-visibility.md).
//
// Invariant: a listing is public (status "active", ban ≠ true) only while its
// host account exists and is neither banned nor deactivated.
//
// Every operation here is one MongoDB transaction that WRITES its host's user
// document (`listingFence` += 1) before touching listings. Two operations on
// the same host therefore conflict on that document; the loser is aborted and
// retried by withTransaction against the winner's committed state:
//   ban ↔ publish   a publish that loses re-reads the banned host and refuses;
//                   a ban that loses sees the freshly published listing and
//                   takes it down with the others.
//   ban ↔ unban     whichever commits last decides, with its own full effect.
// A crash before commit leaves nothing applied; nothing is compensated later.
// Side effects (cache notifications, e-mails) belong to the callers, AFTER
// this returns — never inside a transaction callback that may be retried.
//
// Transition rules (actor-specific; refused actions change nothing):
//   approve              (active admin)  processing | inactive → active
//   reactivate           (the host)      inactive + delist:"host" → active
//   publishing never clears a moderation ban (only unban does) and clears the
//   delist provenance, so a later host delist / relist works normally.
const mongoose = require("mongoose");
const ListingProperty = require("../models/ListingProperty");
const User = require("../models/User");

class PublishError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = "PublishError";
    this.status = status;
    this.code = code;
  }
}

const ELIGIBLE_HOST = { "status.banned": { $ne: true }, "status.active": { $ne: false } };
const ADMIN_PUBLISHABLE = ["processing", "inactive"];

// Deterministic race tests only: awaited inside the transaction callback at
// the named points. Never set outside tests.
let hooks = {};
function __setTestHooks(h) {
  hooks = h || {};
}
async function hook(name, ctx) {
  if (typeof hooks[name] === "function") await hooks[name](ctx);
}

async function inTransaction(work) {
  const session = await mongoose.startSession();
  try {
    let result;
    await session.withTransaction(async () => {
      result = await work(session);
    });
    return result;
  } finally {
    await session.endSession();
  }
}

/** Write the host's fence. eligible: also require a live (not banned / deactivated) account. */
async function fenceHost(hostId, session, { eligible }) {
  const filter = { _id: hostId, ...(eligible ? ELIGIBLE_HOST : {}) };
  const r = await User.updateOne(filter, { $inc: { listingFence: 1 } }, { session });
  return r.matchedCount === 1;
}

function idOf(v) {
  if (!v) return null;
  if (typeof v === "object" && v._id) return String(v._id);
  return String(v);
}

/**
 * Make a listing public.
 * @param {{ listingId: string, mode: "approve"|"reactivate", hostId?: string }} opts
 *   hostId (reactivate): the acting host — ownership is re-checked at the write.
 * @returns {Promise<{ already: boolean, before: Object }>}
 */
async function publishListing({ listingId, mode, hostId = null }) {
  return inTransaction(async (session) => {
    const l = await ListingProperty.findById(listingId).select("status host delist ban").session(session).lean();
    if (!l) throw new PublishError(404, "LISTING_NOT_FOUND", "Listing not found");
    if (hostId && idOf(l.host) !== idOf(hostId)) throw new PublishError(403, "FORBIDDEN", "Only the listing host can do this");
    if (l.status === "active" && l.ban !== true) {
      // Already live: approving / relisting again is a no-op (no write, no e-mail).
      return { already: true, before: l };
    }
    if (l.ban === true) {
      throw new PublishError(409, "LISTING_BANNED", "This listing is under a moderation ban; it comes back only when its host is unbanned");
    }
    if (mode === "reactivate") {
      if (l.status !== "inactive") {
        throw new PublishError(409, "LISTING_NOT_RELISTABLE", "Only a listing you delisted yourself can be relisted. This one goes live after admin review.");
      }
      if (l.delist === "admin") {
        throw new PublishError(409, "LISTING_ADMIN_DELISTED", "This listing was delisted by Majestic Escape. Contact support to relist it.");
      }
      if (l.delist !== "host") {
        throw new PublishError(409, "LISTING_NEEDS_REVIEW", "This listing needs a quick review before it goes live again. Submit it for review from your listing.");
      }
    } else if (!ADMIN_PUBLISHABLE.includes(l.status)) {
      throw new PublishError(409, "LISTING_NOT_SUBMITTED", "Only a listing submitted for review (or delisted) can go live");
    }
    if (!l.host) throw new PublishError(409, "HOST_NOT_ELIGIBLE", "This listing has no host account");
    await hook("beforeFence", { op: "publish", listingId: String(l._id), hostId: idOf(l.host) });
    if (!(await fenceHost(l.host, session, { eligible: true }))) {
      throw new PublishError(409, "HOST_NOT_ELIGIBLE", "The host's account is banned, deactivated or missing");
    }
    await hook("afterFence", { op: "publish", listingId: String(l._id), hostId: idOf(l.host) });
    const filter = { _id: l._id, host: l.host, status: l.status, ban: { $ne: true } };
    if (mode === "reactivate") filter.delist = "host";
    const upd = await ListingProperty.updateOne(
      filter,
      { $set: { status: "active" }, $unset: { delist: "" } },
      { session, runValidators: true },
    );
    if (upd.matchedCount !== 1) throw new PublishError(409, "LISTING_CHANGED", "The listing changed meanwhile. Reload and try again.");
    return { already: false, before: l };
  });
}

/**
 * Create a listing that is public from the start (admin): only for an
 * eligible host, in the same transaction as the host's fence.
 */
async function createPublishedListing(doc) {
  return inTransaction(async (session) => {
    if (!doc.host) throw new PublishError(409, "HOST_NOT_ELIGIBLE", "A live listing needs a host account");
    if (!(await fenceHost(doc.host, session, { eligible: true }))) {
      throw new PublishError(409, "HOST_NOT_ELIGIBLE", "The host's account is banned, deactivated or missing");
    }
    const [created] = await ListingProperty.create([{ ...doc, status: "active", ban: false }], { session });
    return created;
  });
}

/**
 * Hand a listing to another host (admin). Both hosts are fenced (ascending
 * id — one lock order for every reassignment); a public listing may only go
 * to an eligible host. The write is conditional on the old host and status.
 */
async function reassignListing({ listingId, toHostId, set = {} }) {
  return inTransaction(async (session) => {
    const l = await ListingProperty.findById(listingId).select("status host ban").session(session).lean();
    if (!l) throw new PublishError(404, "LISTING_NOT_FOUND", "Listing not found");
    const from = idOf(l.host);
    const to = idOf(toHostId);
    if (!mongoose.isValidObjectId(to)) throw new PublishError(400, "INVALID_HOST", "Invalid host id");
    if (from === to) {
      if (Object.keys(set).length) await ListingProperty.updateOne({ _id: l._id, host: l.host }, { $set: set }, { session, runValidators: true });
      return { before: l, moved: false };
    }
    const live = l.status === "active" && l.ban !== true;
    for (const id of [from, to].filter(Boolean).sort()) {
      const ok = await fenceHost(id, session, { eligible: id === to && live });
      if (id === to && !ok) {
        throw new PublishError(409, "HOST_NOT_ELIGIBLE", live ? "A live listing can only move to an active, non-banned host" : "Host not found");
      }
    }
    await hook("afterFence", { op: "reassign", listingId: String(l._id), hostId: to });
    // Moving a listing away from a banned host is the admin's moderation
    // decision: the ban marker goes with the old owner (the listing itself
    // stays as it is — an inactive one needs an admin approval to go live).
    const upd = await ListingProperty.updateOne(
      { _id: l._id, host: l.host, status: l.status },
      { $set: { ...set, host: to, ban: false } },
      { session, runValidators: true },
    );
    if (upd.matchedCount !== 1) throw new PublishError(409, "LISTING_CHANGED", "The listing changed meanwhile. Reload and try again.");
    return { before: l, moved: true };
  });
}

/**
 * Ban a host: the account and every live listing of it, atomically.
 * @returns {Promise<{ user: Object, affected: Array }>}
 */
async function banHost(userId) {
  return inTransaction(async (session) => {
    const user = await User.findOneAndUpdate(
      { _id: userId },
      { $set: { "status.active": false, "status.banned": true }, $inc: { tokenVersion: 1, listingFence: 1 } },
      { session, new: true },
    );
    if (!user) throw new PublishError(404, "USER_NOT_FOUND", "User not found");
    await hook("afterFence", { op: "ban", hostId: String(userId) });
    const affected = await ListingProperty.distinct("_id", { host: userId, status: "active" }).session(session);
    if (affected.length) {
      await ListingProperty.updateMany(
        { _id: { $in: affected }, host: userId, status: "active" },
        { $set: { status: "inactive", ban: true } },
        { session },
      );
    }
    await hook("beforeCommit", { op: "ban", hostId: String(userId) });
    return { user, affected };
  });
}

/**
 * Unban a host: the account, and the listings the ban took down (ban:true —
 * the ban only ever marks listings it took offline). A listing an admin
 * delisted meanwhile no longer carries the marker (the admin delist clears it),
 * so that decision stands. Keyed on the marker, not on delist provenance: rows
 * re-approved before provenance was cleared on approval still read
 * delist:"admin" and must come back too.
 */
async function unbanHost(userId) {
  return inTransaction(async (session) => {
    const user = await User.findOneAndUpdate(
      { _id: userId },
      { $set: { "status.active": true, "status.banned": false }, $inc: { listingFence: 1 } },
      { session, new: true },
    );
    if (!user) throw new PublishError(404, "USER_NOT_FOUND", "User not found");
    await hook("afterFence", { op: "unban", hostId: String(userId) });
    const restore = { host: userId, ban: true, status: "inactive" };
    const affected = await ListingProperty.distinct("_id", restore).session(session);
    if (affected.length) {
      await ListingProperty.updateMany({ _id: { $in: affected }, ...restore }, { $set: { status: "active", ban: false } }, { session });
    }
    await ListingProperty.updateMany({ host: userId, ban: true }, { $set: { ban: false } }, { session });
    return { user, affected };
  });
}

// Fields no generic edit may write: identity, the moderation ban (only the
// ban flow sets / clears it) and the delist provenance (only the delist /
// publish routes set / clear it).
const NOT_EDITABLE = ["_id", "id", "__v", "ban", "delist"];

/**
 * An admin's generic listing edit (admin edit page, PUT /prop-listing/:id,
 * the admin branch of the host wizard route). It never changes the status:
 * the edit page sends back the status it LOADED, which after a concurrent
 * approve / delist / ban is stale — written, it would republish a delisted
 * listing or take a live one down. Going live, delisting and relisting have
 * their own routes (publishListing, the delist handlers). ban / delist are
 * never editable; a different host is a reassignment (reassignListing).
 * @returns {Promise<{ before: Object }>} before = { status, host, ban } as read
 */
async function applyAdminListingPatch(listingId, body) {
  const before = await ListingProperty.findById(listingId).select("status host ban").lean();
  if (!before) throw new PublishError(404, "LISTING_NOT_FOUND", "Property not found or unauthorized to update");
  const patch = { ...(body || {}) };
  for (const k of NOT_EDITABLE) delete patch[k];
  delete patch.status;
  const rawHost = patch.host;
  delete patch.host;
  const wantHost = rawHost !== undefined && rawHost !== null && rawHost !== "" ? idOf(rawHost) : undefined;
  if (wantHost !== undefined && wantHost !== idOf(before.host)) {
    await reassignListing({ listingId, toHostId: wantHost, set: patch });
    return { before };
  }
  if (Object.keys(patch).length) {
    const r = await ListingProperty.updateOne({ _id: listingId }, { $set: patch }, { runValidators: true });
    if (r.matchedCount !== 1) throw new PublishError(404, "LISTING_NOT_FOUND", "Property not found or unauthorized to update");
  }
  return { before };
}

/** The HTTP answer for a refused publish / ban / edit. */
function sendPublishError(res, err) {
  return res.status(err.status).json({ success: false, code: err.code, message: err.message, statusCode: err.status });
}

module.exports = {
  PublishError,
  sendPublishError,
  applyAdminListingPatch,
  NOT_EDITABLE,
  publishListing,
  createPublishedListing,
  reassignListing,
  banHost,
  unbanHost,
  ELIGIBLE_HOST,
  __setTestHooks,
};

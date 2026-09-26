// Eventual cleanup of the homepage banner's objects (docs/site-hero.md).
//
// Idempotent and safe to run at any time, from any instance:
//  - one runner per window: a compare-and-set on lastSweepAt;
//  - expired drafts (7 days) are removed from the document first, each by a
//    compare-and-set on its opId (a publish of the same draft and the expiry
//    cannot both win) and a system audit row;
//  - then the prefix is listed and the document re-read from the primary.
//    Referenced = the live pair, drafts that have not expired, and retired
//    entries younger than 24 h (cached pages and open tabs may still show
//    them). An object is deleted only when it is unreferenced AND either
//    belongs to a retired entry older than 24 h or was uploaded more than
//    24 h ago (a crash between upload and commit, an abandoned or replaced
//    draft, a job that lost its lease);
//  - a retired record is pulled only after a fresh listing shows none of its
//    objects left; a failed delete or listing keeps it for the next run.
// Eligible objects are deleted by a later successful run: with the daily
// cron (Hobby: once a day, ±59 min) that can be more than a day after they
// became eligible. Nothing here can make a referenced object disappear.
const SiteSetting = require("../models/SiteSetting");
const storage = require("./storage");
const adminAudit = require("./adminAudit");
const mongoose = require("mongoose");

const GRACE_MS = 24 * 60 * 60 * 1000;
const DEFAULT_WINDOW_MS = 20 * 60 * 60 * 1000;
const coll = () => SiteSetting.collection;
const docOf = (res) => (res && Object.prototype.hasOwnProperty.call(res, "value") && Object.prototype.hasOwnProperty.call(res, "ok") ? res.value : res);

function hero() {
  return require("./siteHero");
}

async function expireDrafts(now, log) {
  const doc = await hero().readDoc();
  let expired = 0;
  for (const slot of ["desktop", "mobile"]) {
    const d = doc && doc.draft && doc.draft[slot];
    if (!d || !d.expiresAt || new Date(d.expiresAt).getTime() > now.getTime()) continue;
    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        const res = await coll().updateOne({ _id: hero().DOC_ID, [`draft.${slot}.opId`]: d.opId, [`draft.${slot}.expiresAt`]: { $lte: now } }, { $set: { [`draft.${slot}`]: null } }, { session });
        if (res.matchedCount !== 1) return;
        await adminAudit.recordSystem("site.hero.draft_expire", { targetType: "SiteSetting", targetKey: hero().DOC_ID }, { slot, opId: d.opId }, { session });
        expired += 1;
      });
    } catch (err) {
      log(`[site-hero sweep] draft expiry failed (${slot}): ${err && (err.code || err.message)}`);
    } finally {
      await session.endSession().catch(() => {});
    }
  }
  return expired;
}

/**
 * @param {{ now?: Date, window?: number, dryRun?: boolean, force?: boolean, log?: Function }} [opts]
 * @returns {Promise<object>} what was (or, with dryRun, would be) done
 */
async function sweep({ now = new Date(), window = DEFAULT_WINDOW_MS, dryRun = false, force = false, log = console.log } = {}) {
  await hero().ensureDoc();
  if (!force && !dryRun) {
    const claim = await coll().findOneAndUpdate(
      { _id: hero().DOC_ID, $or: [{ lastSweepAt: null }, { lastSweepAt: { $lt: new Date(now.getTime() - window) } }] },
      { $set: { lastSweepAt: now } },
      { returnDocument: "after" },
    );
    if (!docOf(claim)) return { skipped: "recent" };
  }
  const summary = { dryRun, expiredDrafts: 0, listed: 0, candidates: 0, deleted: 0, failed: 0, retiredPulled: 0, retiredKept: 0 };
  if (!dryRun) summary.expiredDrafts = await expireDrafts(now, log);

  const prefix = hero().keyPrefix();
  const doc = await hero().readDoc();
  let objects;
  try {
    objects = await storage.listKeys(prefix);
  } catch (err) {
    log(`[site-hero sweep] listing failed, nothing deleted: ${err && (err.code || err.message)}`);
    return { ...summary, error: "list" };
  }
  summary.listed = objects.length;
  const graceStart = now.getTime() - GRACE_MS;
  const referenced = new Set();
  const refUrl = (url) => {
    const k = storage.keyFromUrl(url);
    if (k) referenced.add(k);
  };
  for (const s of ["desktop", "mobile"]) {
    if (doc[s]) refUrl(doc[s].url);
    const d = doc.draft && doc.draft[s];
    // An expired draft is no longer publishable; in a dry run it has not been
    // removed from the document yet, so treat it the way the real run will.
    if (d && new Date(d.expiresAt).getTime() > now.getTime()) refUrl(d.url);
  }
  const oldRetired = [];
  for (const r of doc.retired || []) {
    if (new Date(r.retiredAt).getTime() >= graceStart) for (const k of r.masterKeys || []) referenced.add(k);
    else oldRetired.push(r);
  }
  const oldRetiredMasters = new Set(oldRetired.flatMap((r) => r.masterKeys || []));
  const candidates = objects.filter((o) => {
    const master = storage.masterKeyOf(o.key);
    if (referenced.has(master)) return false;
    if (oldRetiredMasters.has(master)) return true;
    return !!o.lastModified && new Date(o.lastModified).getTime() < graceStart;
  });
  summary.candidates = candidates.length;
  if (dryRun) return { ...summary, sample: candidates.slice(0, 10).map((o) => o.key) };

  if (candidates.length) {
    const res = await storage.deleteObjects(candidates.map((o) => o.key), { allowProtected: true });
    summary.deleted = res.deleted.length;
    summary.failed = res.failed.length;
    if (res.deleted.length) await storage.purgeCdn(res.deleted);
  }

  // Retired records go only once a fresh listing confirms their objects are gone.
  if (oldRetired.length) {
    let remaining;
    try {
      remaining = new Set((await storage.listKeys(prefix)).map((o) => storage.masterKeyOf(o.key)));
    } catch (err) {
      log(`[site-hero sweep] confirmation listing failed, retired records kept: ${err && (err.code || err.message)}`);
      return { ...summary, retiredKept: oldRetired.length, error: "confirm-list" };
    }
    for (const r of oldRetired) {
      if ((r.masterKeys || []).some((k) => remaining.has(k))) {
        summary.retiredKept += 1;
        continue;
      }
      const res = await coll().updateOne({ _id: hero().DOC_ID }, { $pull: { retired: { retiredAt: r.retiredAt, masterKeys: r.masterKeys } } });
      if (res.modifiedCount) summary.retiredPulled += 1;
    }
  }
  if (summary.failed) log(`[site-hero sweep] ${summary.failed} object(s) could not be deleted; the next run retries`);
  return summary;
}

module.exports = { sweep, GRACE_MS, DEFAULT_WINDOW_MS };

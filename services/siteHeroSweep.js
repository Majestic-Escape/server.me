// Eventual cleanup of the homepage banner's objects (docs/site-hero.md).
//
// It deletes ONLY what this database recorded as its own and no longer needs:
//  - `retired`: live art that was replaced or restored away, and drafts that
//    were replaced, discarded or expired — each recorded in the very update
//    that let go of it, kept 24 h (cached pages and open tabs may still show
//    it), then deleted;
//  - `pending`: an image job's uploads, recorded before the first byte is
//    stored and cleared when the draft is installed — what is left belongs
//    to a job that crashed, timed out or failed, and is deleted a day later.
// An object that no record names is never deleted, however old: it may belong
// to another environment sharing the bucket (they use separate prefixes too —
// siteHero.keyPrefix) or be something a person put there.
//
// Safety:
//  - one runner per window: a compare-and-set on lastSweepAt;
//  - expired drafts (7 days) leave the document by a compare-and-set on their
//    opId and are retired in the same update (a publish of the same draft and
//    the expiry cannot both win), with a system audit row;
//  - whatever the document still points at — the live pair and every draft —
//    is never deleted, whatever the records say; a live or draft URL that
//    does not parse to a key stops the run before anything is deleted;
//  - only keys under this environment's prefix are ever touched;
//  - a record is pulled only after a fresh listing shows none of its objects
//    left; a failed delete or listing keeps it for the next run.
// Eligible objects are deleted by a later successful run: with the daily
// cron (Hobby: once a day, ±59 min) that can be more than a day after they
// became eligible.
const SiteSetting = require("../models/SiteSetting");
const storage = require("./storage");
const adminAudit = require("./adminAudit");
const mongoose = require("mongoose");

const GRACE_MS = 24 * 60 * 60 * 1000;
const DEFAULT_WINDOW_MS = 20 * 60 * 60 * 1000;
const SLOTS = ["desktop", "mobile"];
const coll = () => SiteSetting.collection;
const docOf = (res) => (res && Object.prototype.hasOwnProperty.call(res, "value") && Object.prototype.hasOwnProperty.call(res, "ok") ? res.value : res);

function hero() {
  return require("./siteHero");
}

async function expireDrafts(now, log) {
  const doc = await hero().readDoc();
  let expired = 0;
  for (const slot of SLOTS) {
    const d = doc && doc.draft && doc.draft[slot];
    if (!d || !d.expiresAt || new Date(d.expiresAt).getTime() > now.getTime()) continue;
    const key = storage.keyFromUrl(d.url);
    const update = { $set: { [`draft.${slot}`]: null } };
    if (key) update.$push = { retired: { masterKeys: [key], retiredAt: now } };
    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        const res = await coll().updateOne({ _id: hero().DOC_ID, [`draft.${slot}.opId`]: d.opId, [`draft.${slot}.expiresAt`]: { $lte: now } }, update, { session });
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
  const summary = { dryRun, expiredDrafts: 0, records: 0, listed: 0, candidates: 0, deleted: 0, failed: 0, retiredPulled: 0, pendingPulled: 0, kept: 0, unrecorded: 0 };
  if (!dryRun) summary.expiredDrafts = await expireDrafts(now, log);

  const prefix = hero().keyPrefix();
  const doc = await hero().readDoc();

  // What the document points at is off limits. A reference that does not
  // parse means something is wrong with this environment: delete nothing.
  const referenced = new Set();
  for (const s of SLOTS) {
    for (const a of [doc[s], doc.draft && doc.draft[s]]) {
      if (!a) continue;
      const k = storage.keyFromUrl(a.url);
      if (!k) {
        log(`[site-hero sweep] a ${s} reference does not parse to a key — nothing deleted`);
        return { ...summary, error: "unparseable-reference" };
      }
      referenced.add(k);
    }
  }

  // Records past their grace period, and which of their keys may go.
  const graceStart = now.getTime() - GRACE_MS;
  const due = [];
  for (const r of doc.retired || []) if (new Date(r.retiredAt).getTime() < graceStart) due.push({ kind: "retired", record: r, keys: r.masterKeys || [] });
  for (const p of doc.pending || []) if (new Date(p.at).getTime() < graceStart) due.push({ kind: "pending", record: p, keys: [p.masterKey] });
  summary.records = due.length;
  const deletable = (k) => typeof k === "string" && k.startsWith(prefix) && !referenced.has(k);
  const masters = new Set(due.flatMap((d) => d.keys).filter(deletable));
  const recorded = new Set([...(doc.retired || []).flatMap((r) => r.masterKeys || []), ...(doc.pending || []).map((p) => p.masterKey)]);

  // One listing a day, also when nothing is due: it reports objects nobody
  // has a record of (left alone — but worth knowing about).
  let objects;
  try {
    objects = await storage.listKeys(prefix);
  } catch (err) {
    log(`[site-hero sweep] listing failed, nothing deleted: ${err && (err.code || err.message)}`);
    return { ...summary, error: "list" };
  }
  summary.listed = objects.length;
  const candidates = objects.filter((o) => masters.has(storage.masterKeyOf(o.key)));
  summary.candidates = candidates.length;
  summary.unrecorded = objects.filter((o) => {
    const m = storage.masterKeyOf(o.key);
    return !referenced.has(m) && !recorded.has(m);
  }).length;
  if (dryRun) return { ...summary, sample: candidates.slice(0, 10).map((o) => o.key) };

  if (candidates.length) {
    const res = await storage.deleteObjects(candidates.map((o) => o.key), { allowProtected: true });
    summary.deleted = res.deleted.length;
    summary.failed = res.failed.length;
    if (res.deleted.length) await storage.purgeCdn(res.deleted);
  }

  // A record goes only once a fresh listing confirms its objects are gone.
  // Keys it may not delete (another prefix, referenced again) are simply let
  // go of — never deleted.
  let remaining = new Set();
  if (masters.size) {
    try {
      remaining = new Set((await storage.listKeys(prefix)).map((o) => storage.masterKeyOf(o.key)));
    } catch (err) {
      log(`[site-hero sweep] confirmation listing failed, records kept: ${err && (err.code || err.message)}`);
      return { ...summary, kept: due.length, error: "confirm-list" };
    }
  }
  for (const d of due) {
    if (d.keys.some((k) => deletable(k) && remaining.has(k))) {
      summary.kept += 1;
      continue;
    }
    const pull = d.kind === "retired" ? { retired: { retiredAt: d.record.retiredAt, masterKeys: d.record.masterKeys } } : { pending: { masterKey: d.record.masterKey, at: d.record.at } };
    const res = await coll().updateOne({ _id: hero().DOC_ID }, { $pull: pull });
    if (res.modifiedCount) summary[d.kind === "retired" ? "retiredPulled" : "pendingPulled"] += 1;
  }
  if (summary.failed) log(`[site-hero sweep] ${summary.failed} object(s) could not be deleted; the next run retries`);
  if (summary.unrecorded) log(`[site-hero sweep] ${summary.unrecorded} object(s) under ${prefix} are not this database's — left alone`);
  return summary;
}

module.exports = { sweep, GRACE_MS, DEFAULT_WINDOW_MS };

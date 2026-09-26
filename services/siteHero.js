// The admin-managed homepage banner (docs/site-hero.md).
//
// A banner is two artworks — desktop (≥ 768 px) and mobile — and ONE
// description (alt text) that fits both. Admins prepare a draft per slot
// (the heavy step: identify → crop → one raster → master + AVIF/WebP
// renditions → storage), look at the real result, then publish: the drafts
// become live in one small transaction. The site reads the live pair from
// GET /api/v1/site/hero and falls back to its bundled banner otherwise.
//
// Safety rules (each has tests in tests/batch-s/site-hero*.test.js):
//  - every write is a compare-and-set on the singleton (version, a draft's
//    opId, the lease token) and carries a receipt + an audit row in the same
//    transaction (services/siteHeroOps.js explains the receipts);
//  - one image job at a time across all instances (the lease); a job that
//    outlived its lease can neither install its draft nor release someone
//    else's lease, and its budget really cancels encodes and uploads;
//  - objects are deleted only when they are provably unreferenced: before
//    anything was installed. After an install was attempted (outcome known
//    or not) nothing is deleted here — the sweep (siteHeroSweep.js) removes
//    whatever ends up unreferenced, 24 h later at the earliest;
//  - the objects live under the protected `site/` prefix, which no listing,
//    profile or maintenance path can delete (services/storage.js).
const crypto = require("crypto");
const mongoose = require("mongoose");
const SiteSetting = require("../models/SiteSetting");
const storage = require("./storage");
const adminAudit = require("./adminAudit");
const { notifyTags } = require("./listingChanged");
const { ImageRejected } = require("./imageSanitizer");
const img = require("./siteHeroImage");
const ops = require("./siteHeroOps");

const { HeroError } = ops;
const DOC_ID = "home_hero";
const TAG = "site-hero";
const DRAFT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const PUT_CONCURRENCY = 3;
const PUT_RETRIES = 1;
const MAX_UPLOAD_BYTES = 4 * 1024 * 1024; // under Vercel's 4.5 MB request cap
const ALT_MAX = 150;
const PENDING_CAP = 200; // records of uploads not yet installed (one image job at a time)
const leaseMs = () => Number(process.env.SITE_HERO_LEASE_MS) || 150_000;
const budgetMs = () => Number(process.env.SITE_HERO_BUDGET_MS) || 120_000;
const putTimeoutMs = () => Number(process.env.SITE_HERO_PUT_TIMEOUT_MS) || 20_000;

// Where this environment's objects live. Every environment shares the bucket
// (a developer's machine, a Vercel preview and production all have the same
// Spaces keys), so only PRODUCTION may use `site/hero/` — the namespace the
// live site reads. Anything else gets its own `_qa/site/hero/<name>/`:
// SITE_HERO_PREFIX when it is a valid one, otherwise `_qa/site/hero/dev/`.
// Otherwise a non-production server would stage, retire — and its sweep
// delete — objects in the live banner's namespace. Production is a Vercel
// production deployment (VERCEL_ENV=production) or an explicit
// SITE_HERO_PRODUCTION=1 (e.g. a maintenance script run against the
// production database); getting it wrong the other way round is visible and
// harmless: the site only accepts `site/hero/` keys, so it keeps showing its
// built-in banner, and the admin page says it is not production.
const PRODUCTION_PREFIX = "site/hero/";
const NON_PRODUCTION_PREFIX = "_qa/site/hero/dev/";
const QA_PREFIX_RE = /^_qa\/site\/hero\/[a-z0-9-]{1,40}\/$/;
let prefixWarned = false;
function isProduction() {
  return process.env.VERCEL_ENV === "production" || process.env.SITE_HERO_PRODUCTION === "1";
}
function keyPrefix() {
  const p = process.env.SITE_HERO_PREFIX;
  if (isProduction()) {
    if (p && p !== PRODUCTION_PREFIX && !prefixWarned) {
      prefixWarned = true;
      console.error("[site-hero] SITE_HERO_PREFIX ignored: production always uses site/hero/");
    }
    return PRODUCTION_PREFIX;
  }
  if (p && QA_PREFIX_RE.test(p)) return p;
  if (p && !prefixWarned) {
    prefixWarned = true;
    console.error("[site-hero] SITE_HERO_PREFIX ignored (not a _qa/site/hero/<name>/ prefix); using", NON_PRODUCTION_PREFIX);
  }
  return NON_PRODUCTION_PREFIX;
}

const coll = () => SiteSetting.collection;
const oid = (id) => new mongoose.Types.ObjectId(String(id));
const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");
// findOneAndUpdate answers { value } (driver 5) or the document (driver 6)
const docOf = (res) => (res && Object.prototype.hasOwnProperty.call(res, "value") && Object.prototype.hasOwnProperty.call(res, "ok") ? res.value : res);

function defaults() {
  return { version: 0, alt: null, desktop: null, mobile: null, draft: { desktop: null, mobile: null }, retired: [], pending: [], receipts: [], lease: null, lastSweepAt: null, updatedBy: null, updatedAt: null };
}
// The singleton exists before any compare-and-set, so publishing never upserts.
async function ensureDoc() {
  try {
    await coll().updateOne({ _id: DOC_ID }, { $setOnInsert: defaults() }, { upsert: true });
  } catch (err) {
    if (!(err && err.code === 11000)) throw err; // a concurrent first call created it
  }
}
async function readDoc() {
  return coll().findOne({ _id: DOC_ID }, { readPreference: "primary" });
}
function draftOf(doc, slot) {
  return (doc && doc.draft && doc.draft[slot]) || null;
}
function keyOf(url) {
  return storage.keyFromUrl(url);
}

// --- views --------------------------------------------------------------------
function publicSlot(s) {
  return s ? { url: s.url, width: s.width, height: s.height, lqip: s.lqip || "" } : null;
}
// GET /site/hero — the site renders this and nothing else (no admin data).
function publicView(doc) {
  if (!doc || !doc.desktop || !doc.mobile) return { version: (doc && doc.version) || 0, alt: null, desktop: null, mobile: null };
  return { version: doc.version, alt: doc.alt, desktop: publicSlot(doc.desktop), mobile: publicSlot(doc.mobile) };
}

function artworkView(a, slot) {
  const key = keyOf(a.url);
  return {
    url: a.url,
    width: a.width,
    height: a.height,
    lqip: a.lqip || "",
    source: a.source || null,
    renditions: key
      ? img.heroRenditionWidths(a.width, slot).map((w) => ({ width: w, avif: storage.cdnUrl(img.renditionKey(key, w, "avif")), webp: storage.cdnUrl(img.renditionKey(key, w, "webp")) }))
      : [],
  };
}

async function namesOf(ids) {
  const unique = [...new Set(ids.filter(Boolean).map(String))].filter((id) => mongoose.isValidObjectId(id));
  if (!unique.length) return new Map();
  const Admin = require("../models/Admin");
  const User = require("../models/User");
  const [admins, users] = await Promise.all([
    Admin.find({ _id: { $in: unique } }).select("firstName lastName").lean(),
    User.find({ _id: { $in: unique }, role: "admin" }).select("firstName lastName").lean(),
  ]);
  return new Map([...admins, ...users].map((p) => [String(p._id), [p.firstName, p.lastName].filter(Boolean).join(" ") || "an admin"]));
}

function specView() {
  const out = {};
  for (const s of img.SLOT_NAMES) {
    const c = img.SLOTS[s];
    out[s] = { box: c.box, min: c.min, recommended: c.recommended, cap: c.cap, ratio: c.ratio };
  }
  return { slots: out, maxUploadBytes: MAX_UPLOAD_BYTES, altMax: ALT_MAX, ratioTolerance: img.RATIO_TOLERANCE, ratioConfirm: img.RATIO_CONFIRM, draftTtlDays: DRAFT_TTL_MS / 86400000 };
}

// GET /site/admin/hero — everything the settings page shows.
async function adminView(doc, actor) {
  const now = Date.now();
  const names = await namesOf([doc.updatedBy, draftOf(doc, "desktop") && draftOf(doc, "desktop").stagedBy, draftOf(doc, "mobile") && draftOf(doc, "mobile").stagedBy]);
  const live = (s) => (doc[s] ? { ...artworkView(doc[s], s), publishedAt: doc[s].publishedAt || null } : null);
  const draft = (s) => {
    const d = draftOf(doc, s);
    if (!d) return null;
    return { ...artworkView(d, s), opId: d.opId, stagedBy: names.get(String(d.stagedBy)) || null, stagedAt: d.stagedAt, expiresAt: d.expiresAt, expired: new Date(d.expiresAt).getTime() <= now, notices: d.notices || [] };
  };
  const lease = doc.lease && new Date(doc.lease.until).getTime() > now ? doc.lease : null;
  return {
    version: doc.version || 0,
    alt: doc.alt || null,
    custom: !!(doc.desktop && doc.mobile),
    desktop: live("desktop"),
    mobile: live("mobile"),
    draft: { desktop: draft("desktop"), mobile: draft("mobile") },
    busy: lease ? { until: lease.until, own: !!actor && String(lease.actorId) === String(actor.id) } : null,
    updatedAt: doc.updatedAt || null,
    updatedBy: doc.updatedBy ? names.get(String(doc.updatedBy)) || null : null,
    spec: specView(),
    // where this server keeps banner objects; the site only shows production's
    environment: { production: isProduction(), prefix: keyPrefix() },
  };
}

// --- request parsing ------------------------------------------------------------
function bad(code, message) {
  return new HeroError(400, code, message);
}
function parseUnit(v, name) {
  if (v === undefined || v === null) return 0.5;
  const s = String(v).trim();
  const n = Number(s);
  if (!s || !Number.isFinite(n) || n < 0 || n > 1) throw bad("INVALID_FOCAL", `${name} must be a number from 0 to 1`);
  return n;
}
function parseBool(v, name) {
  if (v === undefined || v === null || v === "" || v === false || v === "0" || v === "false") return false;
  if (v === true || v === "1" || v === "true") return true;
  throw bad("INVALID_FIELDS", `${name} must be true or false`);
}
function parseVersion(v) {
  const s = typeof v === "number" ? String(v) : v;
  if (typeof s !== "string" || !/^\d{1,9}$/.test(s)) throw bad("INVALID_VERSION", "expectedVersion must be a whole number");
  return Number(s);
}
function parseDraftOpId(v, { required = false } = {}) {
  if (v === undefined || v === null || v === "") {
    if (required) throw bad("INVALID_FIELDS", "expectedDraftOpId is required");
    return null;
  }
  if (typeof v !== "string" || !ops.UUID_RE.test(v)) throw bad("INVALID_FIELDS", "expectedDraftOpId must be a draft id");
  return v;
}
// Control and format characters (bidi controls, zero-width marks, tag characters…)
const CONTROL_RE = /[\p{Cc}\p{Cf}]/gu;
function parseAlt(v) {
  if (typeof v !== "string") throw bad("INVALID_ALT", "Add a description of the banner");
  const alt = v.replace(CONTROL_RE, " ").replace(/\s+/g, " ").trim();
  if (!alt) throw bad("INVALID_ALT", "Add a description of the banner");
  if (alt.length > ALT_MAX) throw bad("INVALID_ALT", `Keep the description under ${ALT_MAX} characters`);
  return alt;
}
function parseSlots(v) {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw bad("INVALID_SLOTS", "Choose the drafts to publish");
  const out = {};
  for (const [k, id] of Object.entries(v)) {
    if (!img.isSlot(k)) throw bad("INVALID_SLOTS", "Unknown banner slot");
    if (id === null || id === undefined || id === "") continue;
    if (typeof id !== "string" || !ops.UUID_RE.test(id)) throw bad("INVALID_SLOTS", "Invalid draft id");
    out[k] = id;
  }
  return out;
}

// --- transactions --------------------------------------------------------------
// `work` returns { abort: true } for a compare-and-set miss (nothing written).
// Result: { committed } | { committed: false, aborted } | { committed: false,
// unknown } (the driver gave up retrying the commit: it may have happened) |
// { committed: false, error } (definitely not committed).
async function inTransaction(work) {
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      const outcome = await work(session);
      if (outcome && outcome.abort) throw Object.assign(new Error("compare-and-set miss"), { heroAbort: true });
    });
    return { committed: true };
  } catch (err) {
    if (err && err.heroAbort) return { committed: false, aborted: true };
    const unknown = !!(err && typeof err.hasErrorLabel === "function" && err.hasErrorLabel("UnknownTransactionCommitResult"));
    return { committed: false, unknown, error: err };
  } finally {
    await session.endSession().catch(() => {});
  }
}

function outcomeUnknown() {
  return new HeroError(503, "HERO_OUTCOME_UNKNOWN", "We couldn't confirm whether this change was saved — checking the result…");
}
function notRecorded() {
  return new HeroError(503, "AUDIT_UNAVAILABLE", "The change could not be recorded. Nothing was saved — please try again.");
}
function timedOut() {
  return new HeroError(503, "HERO_TIMEOUT", "Preparing the image took too long — try again, or use a smaller file");
}

// --- side effects after a committed change ---------------------------------------
function background(promise, what) {
  const p = Promise.resolve(promise).catch((err) => console.error(`[site-hero] ${what} failed`, err && (err.code || err.message)));
  try {
    require("@vercel/functions").waitUntil(p);
  } catch {
    /* outside Vercel the promise simply runs on */
  }
  return p;
}
// The site's ISR page and data cache (+ the backend's CDN entry) for the
// hero; per-channel confirmed status for the admin UI.
async function notifySite(reason) {
  try {
    const s = await notifyTags([TAG], reason);
    return { site: (s.site && s.site.status) || "unknown", cdn: (s.cdn && s.cdn.status) || "unknown" };
  } catch (err) {
    return { site: "error", cdn: "error" };
  }
}
// One GET per AVIF rendition from this region's CDN edge, so the first
// visitor after a publish is not the one who waits for the origin.
async function warmUp(doc, slots) {
  if (process.env.SPACES_MOCK === "1" || process.env.SITE_HERO_WARMUP === "off") return;
  for (const s of slots) {
    const view = doc && doc[s] ? artworkView(doc[s], s) : null;
    for (const r of view ? view.renditions : []) {
      try {
        const res = await fetch(r.avif, { signal: AbortSignal.timeout(5000) });
        await res.arrayBuffer();
      } catch {
        /* best effort */
      }
    }
  }
}
function afterWrite({ reason, doc, slots = [] }) {
  background(require("./siteHeroSweep").sweep({ window: 6 * 60 * 60 * 1000 }), "sweep");
  if (slots.length) background(warmUp(doc, slots), "warm-up");
  background(coll().updateOne({ _id: DOC_ID }, { $pull: { receipts: ops.pruneFilter() } }), `receipt prune (${reason})`);
}

// --- storage ---------------------------------------------------------------------
async function putWithRetry(key, buffer, contentType, signal) {
  let last;
  for (let attempt = 0; attempt <= PUT_RETRIES; attempt += 1) {
    if (signal.aborted) throw timedOut();
    const child = new AbortController();
    const onParent = () => child.abort();
    signal.addEventListener("abort", onParent, { once: true });
    const timer = setTimeout(() => child.abort(), putTimeoutMs());
    try {
      return await storage.putObject(key, buffer, contentType, { signal: child.signal });
    } catch (err) {
      last = err;
      if (signal.aborted) throw timedOut();
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", onParent);
    }
  }
  console.error("[site-hero] upload failed", key.split("/").pop(), last && (last.code || last.name));
  throw new HeroError(502, "STORAGE_ERROR", "The image could not be stored — please try again");
}

function jobDeadline(now) {
  let end = now + budgetMs();
  try {
    const d = require("@vercel/functions").getDeadline();
    if (d) end = Math.min(end, d.getTime() - 10_000);
  } catch {
    /* no platform deadline */
  }
  return end;
}

async function acquireLease(token, opId, actorId, now) {
  const res = await coll().findOneAndUpdate(
    { _id: DOC_ID, $or: [{ lease: null }, { "lease.until": { $lt: new Date(now) } }] },
    { $set: { lease: { token, opId, actorId: oid(actorId), until: new Date(now + leaseMs()) } } },
    { returnDocument: "after" },
  );
  return !!docOf(res);
}

function errorResult(err) {
  const status = (err && (err.status || err.statusCode)) || 500;
  return { httpStatus: status, code: (err && err.code) || "SERVER_ERROR", message: (err && err.message) || "Failed" };
}

async function replayResponse(r, doc, actor) {
  if (r.status === "failed") {
    const res = r.result || {};
    throw new HeroError(res.httpStatus || 409, res.code || "HERO_FAILED", res.message || "This operation failed earlier", { replayed: true });
  }
  return { status: 200, body: { success: true, replayed: true, result: r.result || {}, state: await adminView(doc, actor), opToken: ops.issueOpToken(actor.id) } };
}

// --- actions -----------------------------------------------------------------------

/** POST /site/admin/hero/:slot/draft */
async function stageDraft(req, actor, slot, file, body) {
  const now = Date.now();
  const op = ops.readOpToken(body.opToken, actor.id, now);
  const expectedDraftOpId = parseDraftOpId(body.expectedDraftOpId);
  const focal = { x: parseUnit(body.focalX, "focalX"), y: parseUnit(body.focalY, "focalY") };
  const acceptRatio = parseBool(body.acceptRatio, "acceptRatio");
  const clientReencoded = parseBool(body.clientReencoded, "clientReencoded");
  const fp = ops.fingerprint({ action: "stage", slot, file: sha256(file.buffer), focal, acceptRatio, expectedDraftOpId });

  await ensureDoc();
  const doc = await readDoc();
  if (doc.lease && doc.lease.opId === op.opId && new Date(doc.lease.until).getTime() > now) {
    return { status: 202, body: { success: true, status: "processing", opId: op.opId } };
  }
  const check = ops.checkOperation(doc, op, { actorId: actor.id, fingerprint: fp }, now);
  if (check.replay) return replayResponse(check.replay, doc, actor);
  const current = draftOf(doc, slot);
  if ((current ? current.opId : null) !== expectedDraftOpId) {
    throw new HeroError(409, "HERO_DRAFT_CHANGED", "This draft was changed by someone else — reload and review again", { draftOpId: current ? current.opId : null });
  }

  const leaseToken = crypto.randomUUID();
  if (!(await acquireLease(leaseToken, op.opId, actor.id, now))) {
    const busy = await readDoc();
    // the same operation, sent twice at once: it is being prepared
    if (busy && busy.lease && busy.lease.opId === op.opId) return { status: 202, body: { success: true, status: "processing", opId: op.opId } };
    const until = busy && busy.lease ? new Date(busy.lease.until).getTime() : now + 60_000;
    throw new HeroError(409, "HERO_BUSY", "Another banner image is being prepared — try again in a minute", { retryAfter: Math.max(1, Math.ceil((until - Date.now()) / 1000)) });
  }

  const deadline = jobDeadline(now);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(0, deadline - Date.now()));
  const attempted = new Set();
  const inflight = new Set();
  let installAttempted = false;
  const target = slot;
  // Stop the uploads still running, then delete what was stored: nothing can
  // land after the delete. (Anything left is in `pending`; the sweep removes it.)
  const cleanup = async () => {
    if (!controller.signal.aborted) controller.abort();
    await Promise.allSettled([...inflight]);
    if (attempted.size) await storage.deleteObjects([...attempted], { allowProtected: true }).catch((err) => console.error("[site-hero] cleanup failed", err && err.message));
  };
  // A definitive failure before anything was installed: our objects are
  // unreferenced (delete them), the failure is recorded (once), the lease
  // released — only while the lease is still ours. A job that lost its lease
  // records nothing: a same-token retry may be running and owns the outcome.
  const fail = async (err) => {
    await cleanup();
    const r = ops.receipt({ opId: op.opId, actorId: oid(actor.id), action: "stage", target, fingerprint: fp, status: "failed", result: errorResult(err) });
    try {
      const res = await coll().updateOne({ _id: DOC_ID, "lease.token": leaseToken, "receipts.opId": { $ne: op.opId } }, { $set: { lease: null }, $push: { receipts: ops.pushReceipt(r) } });
      if (res.matchedCount !== 1) await coll().updateOne({ _id: DOC_ID, "lease.token": leaseToken }, { $set: { lease: null } });
    } catch (e) {
      console.error("[site-hero] could not record the failure", e && e.message);
    }
  };

  try {
    const info = await img.identify(file.buffer);
    const region = img.cropRegion(info.width, info.height, slot, focal);
    const spec = img.SLOTS[slot];
    if (region.deviation > img.RATIO_CONFIRM && !acceptRatio) {
      throw new HeroError(422, "HERO_RATIO_CONFIRM", `This image's shape is far from the ${slot} banner's — most of it would be cropped away`, {
        expectedRatio: spec.ratio,
        actualRatio: info.width / info.height,
        deviation: region.deviation,
      });
    }
    if (img.tooSmall(region, slot)) {
      throw new HeroError(422, "HERO_TOO_SMALL", `The ${slot} banner needs at least ${spec.min[0]}×${spec.min[1]} px; cropped to the banner shape this image is ${region.width}×${region.height}`, {
        required: { width: spec.min[0], height: spec.min[1] },
        actual: { width: region.width, height: region.height },
      });
    }
    const raster = await img.prepareRaster(file.buffer, region, slot, { deadline, signal: controller.signal });
    if (await img.hasQrCode(raster)) throw new ImageRejected("IMAGE_NOT_ALLOWED", "Images with QR codes aren't allowed", 422);

    const masterKey = `${keyPrefix()}${slot}/${crypto.randomUUID()}.jpg`;
    // The URL is built from the key — never taken from the storage reply,
    // whose format differs for multipart uploads — and must parse back to it:
    // the site, the admin and the sweep all find the objects through it.
    const masterUrl = storage.publicUrl(masterKey);
    if (storage.keyFromUrl(masterUrl) !== masterKey) throw new HeroError(500, "STORAGE_MISCONFIGURED", "Image storage is not configured correctly");
    // Recorded before anything is stored: if this job dies between upload and
    // install, the sweep knows these objects are ours and removes them. The
    // sweep deletes nothing it has no record of.
    const recorded = await coll().updateOne({ _id: DOC_ID, "lease.token": leaseToken, "lease.until": { $gt: new Date() } }, { $push: { pending: { $each: [{ masterKey, at: new Date() }], $slice: -PENDING_CAP } } });
    if (recorded.matchedCount !== 1) throw timedOut(); // the lease is gone — nothing was stored
    const putErrors = [];
    const put = (key, buffer, type) => {
      attempted.add(key);
      const p = putWithRetry(key, buffer, type, controller.signal)
        .catch((err) => {
          putErrors.push(err);
          return null;
        })
        .finally(() => inflight.delete(p));
      inflight.add(p);
      return p;
    };
    const rendered = await img.renderOutputs(
      raster,
      slot,
      async (o) => {
        if (putErrors.length) throw putErrors[0];
        if (o.kind === "master") {
          await put(masterKey, o.buffer, "image/jpeg");
          if (putErrors.length) throw putErrors[0];
          return;
        }
        while (inflight.size >= PUT_CONCURRENCY) await Promise.race(inflight);
        put(img.renditionKey(masterKey, o.width, o.format), o.buffer, img.RENDITION_TYPES[o.format]);
      },
      { deadline, signal: controller.signal },
    );
    await Promise.all(inflight);
    if (putErrors.length) throw putErrors[0];
    if (controller.signal.aborted) throw timedOut();

    const notices = [];
    if (info.animated) notices.push("ANIMATION_FIRST_FRAME");
    if (region.cropped) notices.push("CROPPED");
    if (region.deviation > img.RATIO_CONFIRM) notices.push("RATIO_ACCEPTED");
    if (raster.width < Math.round(spec.recommended[0] * 0.9)) notices.push("BELOW_RECOMMENDED");
    if (clientReencoded) notices.push("CLIENT_REENCODED");
    const stagedAt = new Date();
    const draft = {
      url: masterUrl,
      width: raster.width,
      height: raster.height,
      lqip: rendered.lqip,
      source: { width: info.width, height: info.height, bytes: file.size, clientReencoded },
      opId: op.opId,
      stagedBy: oid(actor.id),
      stagedAt,
      expiresAt: new Date(stagedAt.getTime() + DRAFT_TTL_MS),
      notices,
    };

    installAttempted = true;
    const r = ops.receipt({ opId: op.opId, actorId: oid(actor.id), action: "stage", target, fingerprint: fp, status: "completed", result: { draftOpId: op.opId } }, stagedAt);
    // A replaced draft is retired in the same update (the filter proves which
    // one it is), so its objects are deleted a day later; this job's own
    // objects are now referenced and leave `pending`.
    const replacedKey = current && keyOf(current.url);
    const tx = await inTransaction(async (session) => {
      const filter = { _id: DOC_ID, "lease.token": leaseToken, "lease.until": { $gt: new Date() }, "receipts.opId": { $ne: op.opId } };
      if (expectedDraftOpId) filter[`draft.${slot}.opId`] = expectedDraftOpId;
      else filter[`draft.${slot}`] = null;
      const push = { receipts: ops.pushReceipt(r) };
      if (replacedKey) push.retired = { masterKeys: [replacedKey], retiredAt: stagedAt };
      const res = await coll().updateOne(filter, { $set: { [`draft.${slot}`]: draft, lease: null, updatedAt: stagedAt }, $push: push, $pull: { pending: { masterKey } } }, { session });
      if (res.matchedCount !== 1) return { abort: true };
      await adminAudit.record(req, "site.hero.stage", { targetType: "SiteSetting", targetKey: DOC_ID }, { slot, opId: op.opId, width: draft.width, height: draft.height, notices }, { session });
      return { ok: true };
    });

    if (tx.committed) {
      background(coll().updateOne({ _id: DOC_ID }, { $pull: { receipts: ops.pruneFilter() } }), "receipt prune (stage)");
      const fresh = await readDoc();
      return { status: 201, body: { success: true, opId: op.opId, state: await adminView(fresh, actor), opToken: ops.issueOpToken(actor.id) } };
    }
    if (tx.unknown) {
      // It may have been installed: keep every object (the sweep decides),
      // free the lease if it is still ours (a committed install already did).
      await coll().updateOne({ _id: DOC_ID, "lease.token": leaseToken }, { $set: { lease: null } }).catch(() => {});
      throw outcomeUnknown();
    }
    if (tx.error) {
      console.error("[site-hero] stage not recorded", tx.error && (tx.error.code || tx.error.message));
      await fail(notRecorded());
      throw notRecorded();
    }
    // compare-and-set miss: lost the lease (took too long) or the draft changed
    const after = await readDoc();
    if (!after || !after.lease || after.lease.token !== leaseToken) {
      // Someone else may hold the lease now (possibly a retry of this very
      // operation): delete our unreferenced objects, record nothing.
      await cleanup();
      throw timedOut();
    }
    if (new Date(after.lease.until).getTime() <= Date.now()) {
      await fail(timedOut()); // still ours, but it ran out: a timeout, not a conflict
      throw timedOut();
    }
    const changed = new HeroError(409, "HERO_DRAFT_CHANGED", "This draft was changed by someone else — reload and review again", { draftOpId: draftOf(after, slot) ? draftOf(after, slot).opId : null });
    await fail(changed);
    throw changed;
  } catch (err) {
    if (!installAttempted) {
      const final = err instanceof HeroError || err instanceof ImageRejected ? err : err && err.code === "HERO_TIMEOUT" ? timedOut() : err;
      if (final instanceof HeroError || final instanceof ImageRejected) {
        await fail(final);
        throw final;
      }
      console.error("[site-hero] stage failed", err && (err.code || err.message));
      await fail(new HeroError(500, "SERVER_ERROR", "Preparing the image failed"));
      throw new HeroError(500, "SERVER_ERROR", "Preparing the image failed — please try again");
    }
    throw err;
  } finally {
    clearTimeout(timer);
    if (!controller.signal.aborted) controller.abort(); // stop anything still running
  }
}

/** DELETE /site/admin/hero/:slot/draft */
async function discardDraft(req, actor, slot, body) {
  const now = Date.now();
  const op = ops.readOpToken(body.opToken, actor.id, now);
  const expectedDraftOpId = parseDraftOpId(body.expectedDraftOpId, { required: true });
  const fp = ops.fingerprint({ action: "discard", slot, expectedDraftOpId });
  await ensureDoc();
  const doc = await readDoc();
  const check = ops.checkOperation(doc, op, { actorId: actor.id, fingerprint: fp }, now);
  if (check.replay) return replayResponse(check.replay, doc, actor);
  const current = draftOf(doc, slot);
  if (!current || current.opId !== expectedDraftOpId) throw new HeroError(409, "HERO_DRAFT_CHANGED", "This draft was changed by someone else — reload and review again", { draftOpId: current ? current.opId : null });
  const r = ops.receipt({ opId: op.opId, actorId: oid(actor.id), action: "discard", target: slot, fingerprint: fp, status: "completed", result: {} });
  // the discarded draft's objects are retired with it: deleted a day later
  const discardedKey = keyOf(current.url);
  const tx = await inTransaction(async (session) => {
    const at = new Date();
    const push = { receipts: ops.pushReceipt(r) };
    if (discardedKey) push.retired = { masterKeys: [discardedKey], retiredAt: at };
    const res = await coll().updateOne({ _id: DOC_ID, [`draft.${slot}.opId`]: expectedDraftOpId, "receipts.opId": { $ne: op.opId } }, { $set: { [`draft.${slot}`]: null, updatedAt: at }, $push: push }, { session });
    if (res.matchedCount !== 1) return { abort: true };
    await adminAudit.record(req, "site.hero.discard", { targetType: "SiteSetting", targetKey: DOC_ID }, { slot, opId: expectedDraftOpId }, { session });
    return { ok: true };
  });
  if (!tx.committed) {
    if (tx.unknown) throw outcomeUnknown();
    if (tx.error) throw notRecorded();
    const mine = await ownReceipt(op, fp, actor);
    if (mine) return replayResponse(mine, await readDoc(), actor);
    throw new HeroError(409, "HERO_DRAFT_CHANGED", "This draft was changed by someone else — reload and review again");
  }
  return { status: 200, body: { success: true, state: await adminView(await readDoc(), actor), opToken: ops.issueOpToken(actor.id) } };
}

// A compare-and-set on the banner itself missed after the pre-checks passed:
// say precisely why.
async function conflictFor(slots) {
  const doc = await readDoc();
  for (const s of Object.keys(slots || {})) {
    const d = draftOf(doc, s);
    if (!d || d.opId !== slots[s]) return new HeroError(409, "HERO_DRAFT_CHANGED", `The ${s} draft was changed by someone else — reload and review again`, { slot: s });
    if (new Date(d.expiresAt).getTime() <= Date.now()) return new HeroError(409, "HERO_DRAFT_EXPIRED", `The ${s} draft expired — prepare it again`, { slot: s });
  }
  return new HeroError(409, "HERO_VERSION_CONFLICT", "The banner was changed by someone else — reload and review again", { version: doc ? doc.version : null });
}

// A compare-and-set missed. If this very operation's receipt is there — the
// same request sent twice at once (a "Try again" while the first was still
// committing) — the change IS done: answer with the recorded result, not
// "someone else changed it".
async function ownReceipt(op, fp, actor) {
  const r = ops.findReceipt(await readDoc(), op.opId);
  return r && String(r.actorId) === String(actor.id) && r.fingerprint === fp ? r : null;
}

// A banner change (publish / alt / restore) as one transaction: the
// compare-and-set update with its receipt, then the audit row. The filter
// also requires that this operation has no receipt yet, so two copies of one
// request can never both apply, whatever the pre-checks saw.
// Returns null when committed, or the operation's own receipt (a twin won).
async function commitBannerChange(req, { filter, update, audit, slots, op, fp, actor }) {
  const tx = await inTransaction(async (session) => {
    const res = await coll().updateOne({ ...filter, "receipts.opId": { $ne: op.opId } }, update, { session });
    if (res.matchedCount !== 1) return { abort: true };
    await adminAudit.record(req, audit.action, { targetType: "SiteSetting", targetKey: DOC_ID }, audit.details, { session });
    return { ok: true };
  });
  if (tx.committed) return null;
  if (tx.unknown) throw outcomeUnknown();
  if (tx.error) {
    console.error("[site-hero] change not recorded", tx.error && (tx.error.code || tx.error.message));
    throw notRecorded();
  }
  const mine = await ownReceipt(op, fp, actor);
  if (mine) return mine;
  throw await conflictFor(slots);
}

/** POST /site/admin/hero/publish */
async function publish(req, actor, body) {
  const now = Date.now();
  const op = ops.readOpToken(body && body.opToken, actor.id, now);
  const expectedVersion = parseVersion(body.expectedVersion);
  const slots = parseSlots(body.slots);
  const alt = parseAlt(body.alt);
  const fp = ops.fingerprint({ action: "publish", expectedVersion, slots, alt });
  await ensureDoc();
  const doc = await readDoc();
  const check = ops.checkOperation(doc, op, { actorId: actor.id, fingerprint: fp }, now);
  if (check.replay) return replayResponse(check.replay, doc, actor);

  const selected = img.SLOT_NAMES.filter((s) => slots[s]);
  if (!selected.length) throw bad("HERO_NO_SLOTS", "Choose at least one draft to publish");
  if (!doc.desktop && !doc.mobile && selected.length !== 2) throw bad("HERO_BOTH_SLOTS_REQUIRED", "The first custom banner needs both a desktop and a mobile image");
  if ((doc.version || 0) !== expectedVersion) throw new HeroError(409, "HERO_VERSION_CONFLICT", "The banner was changed by someone else — reload and review again", { version: doc.version || 0 });
  for (const s of selected) {
    const d = draftOf(doc, s);
    if (!d || d.opId !== slots[s]) throw new HeroError(409, "HERO_DRAFT_CHANGED", `The ${s} draft was changed by someone else — reload and review again`, { slot: s });
    if (new Date(d.expiresAt).getTime() <= now) throw new HeroError(409, "HERO_DRAFT_EXPIRED", `The ${s} draft expired — prepare it again`, { slot: s });
  }

  const at = new Date(now);
  const version = expectedVersion + 1;
  const $set = { alt, version, updatedBy: oid(actor.id), updatedAt: at };
  const retired = [];
  const filter = { _id: DOC_ID, version: expectedVersion };
  for (const s of selected) {
    const d = draftOf(doc, s);
    $set[s] = { url: d.url, width: d.width, height: d.height, lqip: d.lqip || "", source: d.source || null, publishedAt: at };
    $set[`draft.${s}`] = null;
    filter[`draft.${s}.opId`] = slots[s];
    filter[`draft.${s}.expiresAt`] = { $gt: at };
    const liveKey = doc[s] && keyOf(doc[s].url);
    if (liveKey) retired.push({ masterKeys: [liveKey], retiredAt: at });
  }
  const r = ops.receipt({ opId: op.opId, actorId: oid(actor.id), action: "publish", target: selected.join("+"), fingerprint: fp, status: "completed", result: { version } }, at);
  const twin = await commitBannerChange(req, {
    filter,
    update: { $set, $push: { receipts: ops.pushReceipt(r), ...(retired.length ? { retired: { $each: retired } } : {}) } },
    audit: { action: "site.hero.publish", details: { version, slots: selected, replaced: retired.length } },
    slots,
    op,
    fp,
    actor,
  });
  if (twin) return replayResponse(twin, await readDoc(), actor);
  const notified = await notifySite("hero-publish");
  const fresh = await readDoc();
  afterWrite({ reason: "publish", doc: fresh, slots: selected });
  return { status: 200, body: { success: true, version, notified, state: await adminView(fresh, actor), opToken: ops.issueOpToken(actor.id) } };
}

/** PATCH /site/admin/hero/alt */
async function editAlt(req, actor, body) {
  const now = Date.now();
  const op = ops.readOpToken(body && body.opToken, actor.id, now);
  const expectedVersion = parseVersion(body.expectedVersion);
  const alt = parseAlt(body.alt);
  const fp = ops.fingerprint({ action: "alt", expectedVersion, alt });
  await ensureDoc();
  const doc = await readDoc();
  const check = ops.checkOperation(doc, op, { actorId: actor.id, fingerprint: fp }, now);
  if (check.replay) return replayResponse(check.replay, doc, actor);
  if (!doc.desktop || !doc.mobile) throw new HeroError(409, "HERO_NOT_CUSTOM", "The bundled default banner's description can't be edited here — publish a custom banner first");
  if ((doc.version || 0) !== expectedVersion) throw new HeroError(409, "HERO_VERSION_CONFLICT", "The banner was changed by someone else — reload and review again", { version: doc.version || 0 });
  const at = new Date(now);
  const version = expectedVersion + 1;
  const r = ops.receipt({ opId: op.opId, actorId: oid(actor.id), action: "alt", target: "alt", fingerprint: fp, status: "completed", result: { version } }, at);
  const twin = await commitBannerChange(req, {
    filter: { _id: DOC_ID, version: expectedVersion, desktop: { $ne: null }, mobile: { $ne: null } },
    update: { $set: { alt, version, updatedBy: oid(actor.id), updatedAt: at }, $push: { receipts: ops.pushReceipt(r) } },
    audit: { action: "site.hero.alt", details: { version } },
    op,
    fp,
    actor,
  });
  if (twin) return replayResponse(twin, await readDoc(), actor);
  const notified = await notifySite("hero-alt");
  const fresh = await readDoc();
  afterWrite({ reason: "alt", doc: fresh });
  return { status: 200, body: { success: true, version, notified, state: await adminView(fresh, actor), opToken: ops.issueOpToken(actor.id) } };
}

/** POST /site/admin/hero/restore-default — drafts are kept; nothing is deleted now. */
async function restoreDefault(req, actor, body) {
  const now = Date.now();
  const op = ops.readOpToken(body && body.opToken, actor.id, now);
  const expectedVersion = parseVersion(body.expectedVersion);
  const fp = ops.fingerprint({ action: "reset", expectedVersion });
  await ensureDoc();
  const doc = await readDoc();
  const check = ops.checkOperation(doc, op, { actorId: actor.id, fingerprint: fp }, now);
  if (check.replay) return replayResponse(check.replay, doc, actor);
  if ((doc.version || 0) !== expectedVersion) throw new HeroError(409, "HERO_VERSION_CONFLICT", "The banner was changed by someone else — reload and review again", { version: doc.version || 0 });
  if (!doc.desktop && !doc.mobile) {
    return { status: 200, body: { success: true, changed: false, state: await adminView(doc, actor), opToken: ops.issueOpToken(actor.id) } };
  }
  const at = new Date(now);
  const version = expectedVersion + 1;
  const retired = img.SLOT_NAMES.map((s) => doc[s] && keyOf(doc[s].url)).filter(Boolean).map((k) => ({ masterKeys: [k], retiredAt: at }));
  const r = ops.receipt({ opId: op.opId, actorId: oid(actor.id), action: "reset", target: "banner", fingerprint: fp, status: "completed", result: { version } }, at);
  const twin = await commitBannerChange(req, {
    filter: { _id: DOC_ID, version: expectedVersion },
    update: { $set: { desktop: null, mobile: null, alt: null, version, updatedBy: oid(actor.id), updatedAt: at }, $push: { receipts: ops.pushReceipt(r), retired: { $each: retired } } },
    audit: { action: "site.hero.reset", details: { version, replaced: retired.length } },
    op,
    fp,
    actor,
  });
  if (twin) return replayResponse(twin, await readDoc(), actor);
  const notified = await notifySite("hero-reset");
  const fresh = await readDoc();
  afterWrite({ reason: "reset", doc: fresh });
  return { status: 200, body: { success: true, changed: true, version, notified, state: await adminView(fresh, actor), opToken: ops.issueOpToken(actor.id) } };
}

/** GET /site/admin/hero/ops/:opId — own operations only. */
async function operationStatus(actor, opId) {
  if (typeof opId !== "string" || !ops.UUID_RE.test(opId)) throw bad("INVALID_FIELDS", "Invalid operation id");
  const doc = await readDoc();
  const r = ops.findReceipt(doc, opId);
  if (r && String(r.actorId) === String(actor.id)) return { status: r.status, result: r.result || {}, at: r.at };
  const lease = doc && doc.lease;
  if (lease && lease.opId === opId && String(lease.actorId) === String(actor.id) && new Date(lease.until).getTime() > Date.now()) return { status: "processing", until: lease.until };
  return { status: "unknown" };
}

async function getAdminState(actor) {
  await ensureDoc();
  const doc = await readDoc();
  const sixHours = 6 * 60 * 60 * 1000;
  if (!doc.lastSweepAt || Date.now() - new Date(doc.lastSweepAt).getTime() > sixHours) background(require("./siteHeroSweep").sweep({ window: sixHours }), "sweep");
  return { ...(await adminView(doc, actor)), opToken: ops.issueOpToken(actor.id) };
}

async function getPublicState() {
  const doc = await coll().findOne({ _id: DOC_ID }, { projection: { version: 1, alt: 1, desktop: 1, mobile: 1 } });
  return publicView(doc);
}

module.exports = {
  DOC_ID,
  TAG,
  DRAFT_TTL_MS,
  MAX_UPLOAD_BYTES,
  ALT_MAX,
  HeroError,
  keyPrefix,
  isProduction,
  PRODUCTION_PREFIX,
  NON_PRODUCTION_PREFIX,
  ensureDoc,
  readDoc,
  publicView,
  adminView,
  parseAlt,
  stageDraft,
  discardDraft,
  publish,
  editAlt,
  restoreDefault,
  operationStatus,
  getAdminState,
  getPublicState,
};

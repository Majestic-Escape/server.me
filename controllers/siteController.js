// Homepage banner endpoints (docs/site-hero.md). The public read is cached
// at the edge like the catalogue; every admin endpoint answers no-store (the
// global default) and requires [authMiddleware, requireAdmin] in the router.
const authz = require("../middleware/authz");
const hero = require("../services/siteHero");
const { sweep } = require("../services/siteHeroSweep");
const { catalogueCache } = require("../utils/httpCache");
const { ImageRejected } = require("../services/imageSanitizer");
const { HeroError } = require("../services/siteHeroOps");

const DRAFT_FIELDS = new Set(["opToken", "expectedDraftOpId", "focalX", "focalY", "acceptRatio", "clientReencoded"]);

function fail(res, status, code, message, extra = {}) {
  return res.status(status).json({ success: false, code, message, statusCode: status, ...extra });
}
function sendError(res, err, what) {
  if (err instanceof HeroError) return fail(res, err.status, err.code, err.message, err.extra || {});
  if (err instanceof ImageRejected) return fail(res, err.status, err.code, err.message);
  console.error(`[site-hero] ${what} failed`, err && (err.code || err.name || err.message));
  return fail(res, 500, "SERVER_ERROR", "Something went wrong — please try again");
}
function send(res, result) {
  return res.status(result.status).json(result.body);
}
async function actorOf(req) {
  return authz.resolveActor(req); // requireAdmin has already resolved it
}

// GET /site/hero — public; the site server reads it with ?fresh + secret.
exports.getPublicHero = async (req, res) => {
  if (!catalogueCache(req, res, { tag: hero.TAG })) return undefined;
  try {
    return res.json(await hero.getPublicState());
  } catch (err) {
    return sendError(res, err, "public read");
  }
};

// GET /site/admin/hero
exports.getAdminHero = async (req, res) => {
  try {
    return res.json({ success: true, ...(await hero.getAdminState(await actorOf(req))) });
  } catch (err) {
    return sendError(res, err, "admin read");
  }
};

// GET /site/admin/hero/ops/:opId
exports.getOperation = async (req, res) => {
  try {
    return res.json({ success: true, opId: req.params.opId, ...(await hero.operationStatus(await actorOf(req), req.params.opId)) });
  } catch (err) {
    return sendError(res, err, "operation status");
  }
};

// POST /site/admin/hero/:slot/draft (multipart: image + text fields)
exports.stageDraft = async (req, res) => {
  try {
    if (!req.file || req.file.fieldname !== "image") return fail(res, 400, "FILE_REQUIRED", "Choose an image to upload");
    const body = req.body || {};
    for (const [k, v] of Object.entries(body)) {
      // duplicated or bracketed field names arrive as arrays/objects
      if (!DRAFT_FIELDS.has(k) || typeof v !== "string") return fail(res, 400, "INVALID_FIELDS", "Unexpected form field", { field: String(k).slice(0, 32) });
    }
    return send(res, await hero.stageDraft(req, await actorOf(req), req.params.slot, req.file, body));
  } catch (err) {
    return sendError(res, err, "draft");
  }
};

// DELETE /site/admin/hero/:slot/draft  { opToken, expectedDraftOpId }
exports.discardDraft = async (req, res) => {
  try {
    return send(res, await hero.discardDraft(req, await actorOf(req), req.params.slot, req.body || {}));
  } catch (err) {
    return sendError(res, err, "discard");
  }
};

// POST /site/admin/hero/publish  { opToken, expectedVersion, slots, alt }
exports.publish = async (req, res) => {
  try {
    return send(res, await hero.publish(req, await actorOf(req), req.body || {}));
  } catch (err) {
    return sendError(res, err, "publish");
  }
};

// PATCH /site/admin/hero/alt  { opToken, expectedVersion, alt }
exports.editAlt = async (req, res) => {
  try {
    return send(res, await hero.editAlt(req, await actorOf(req), req.body || {}));
  } catch (err) {
    return sendError(res, err, "alt");
  }
};

// POST /site/admin/hero/restore-default  { opToken, expectedVersion }
exports.restoreDefault = async (req, res) => {
  try {
    return send(res, await hero.restoreDefault(req, await actorOf(req), req.body || {}));
  } catch (err) {
    return sendError(res, err, "restore");
  }
};

// GET /site/cron/hero-sweep — Vercel Cron (CRON_SECRET), once a day.
exports.cronSweep = async (req, res) => {
  try {
    return res.json({ success: true, ...(await sweep({})) });
  } catch (err) {
    return sendError(res, err, "sweep");
  }
};

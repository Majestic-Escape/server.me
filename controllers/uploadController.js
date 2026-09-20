// Spaces uploads (listing photos, profile pictures) and object deletion.
//
// Batch A2: every route is authenticated (routes/uploadRoutes.js). New
// uploads get owner-bound keys (services/storage.js#makeUploadKey) so the
// object's owner is verifiable from the key. Deletion requires the caller to
// own the object (own upload, own listing's photo, own profile picture) or
// be an admin, and refuses — even for owners — while anyone else's listing or
// profile still references the same object (legacy keys can collide).
//
// Image pipeline: an accepted image is stored as its sanitised master plus
// the fixed set of WebP display variants (services/imageSanitizer.js
// makeVariants → services/storage.js variantKey), all immutable, so the site
// serves every public photo straight from the CDN. Work is bounded: one
// file at a time per request (the function has one vCPU, so a second encode
// in flight only raises peak memory — measured ~300 MB per 12 MP photo, 430
// MB for two), one variant encode at a time per file, three object uploads
// in flight (I/O overlaps the next encode). A 20-file request stays within
// the Fluid-compute budget (project setting: 300 s); the site uploads in
// small parallel batches so a host never waits on one long request.
const User = require("../models/User");
const ListingProperty = require("../models/ListingProperty");
const authz = require("../middleware/authz");
const storage = require("../services/storage");
const { sanitizeImage, makeVariants, outputName, ImageRejected } = require("../services/imageSanitizer");

const FILE_CONCURRENCY = 1; // files sanitised/encoded at the same time per request (one vCPU)
const PUT_CONCURRENCY = 3; // variant uploads in flight per file

function fail(res, status, code, message) {
  return res.status(status).json({ success: false, code, message, error: message, statusCode: status });
}

// Runs fn over items with at most `limit` in flight. A failure stops new
// work but the calls already in flight finish before the first error is
// rethrown, so a caller always knows exactly what was stored.
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  let failure = null;
  async function worker() {
    while (next < items.length && !failure) {
      const i = next++;
      try {
        results[i] = await fn(items[i], i);
      } catch (err) {
        failure = failure || err;
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  if (failure) throw failure;
  return results;
}

// Contact lock-down: every public image is re-encoded without metadata (EXIF
// GPS would reveal the exact location) and refused when it carries a QR code
// (sanitizeImage, run by storeImages before anything is stored). storeImage
// then stores the clean master and every display variant as it is rendered
// (uploads overlap the next encode). Resolves to { url, key, variants, errors }.
// Throws when the master cannot be stored — the request fails and the caller
// removes the siblings it already stored. A variant that fails is logged and
// healed by the backfill (scripts/image-variants-backfill.js --repair); the
// site shows the master for that size meanwhile.
async function storeImage(kind, ownerId, file, clean) {
  const key = storage.makeUploadKey(kind, ownerId, outputName(file.originalname, clean.extension));
  const url = await storage.putObject(key, clean.buffer, clean.mimetype);
  const errors = [];
  const inFlight = new Set();
  const uploaded = [];
  const { errors: renderErrors } = await makeVariants(clean.buffer, {
    onVariant: async (v) => {
      while (inFlight.size >= PUT_CONCURRENCY) await Promise.race(inFlight);
      const p = storage
        .putObject(storage.variantKey(key, v.width), v.buffer, storage.VARIANT_CONTENT_TYPE)
        .then(() => uploaded.push(v.width))
        .catch((err) => errors.push({ width: v.width, error: String((err && err.message) || err) }))
        .finally(() => inFlight.delete(p));
      inFlight.add(p);
    },
  });
  await Promise.all(inFlight);
  errors.push(...renderErrors);
  if (errors.length) console.error("upload: variant(s) not stored", key, errors.map((e) => `w${e.width}: ${e.error}`).join("; "));
  return { url, key, variants: uploaded.length, errors };
}

// Every file is sanitised first (a refused file fails the request before
// anything is stored, as before), then stored FILE_CONCURRENCY at a time. If
// a master cannot be stored, the objects of this request are removed again
// (best effort) and the error is rethrown — the same all-or-nothing contract
// the clients rely on.
async function storeImages(kind, ownerId, files) {
  const cleaned = await mapLimit(files, FILE_CONCURRENCY, (file) => sanitizeImage(file.buffer, file.mimetype));
  const stored = [];
  try {
    return await mapLimit(files, FILE_CONCURRENCY, async (file, i) => {
      const r = await storeImage(kind, ownerId, file, cleaned[i]);
      stored.push(r.key);
      return r;
    });
  } catch (err) {
    if (stored.length) await storage.deleteImages(stored).catch((e) => console.error("upload: cleanup after failure", e && e.message));
    throw err;
  }
}

exports.uploadImages = async (req, res) => {
  try {
    const actor = await authz.resolveActor(req);
    if (!actor) return fail(res, 401, "AUTH_REQUIRED", "Authentication required");
    const files = req.files;
    if (!files || files.length === 0) {
      return res.status(400).json({ error: "No files uploaded" });
    }
    // Every file is decoded before anything is stored: one bad file refuses
    // the request without leaving objects behind (as before).
    const results = await storeImages("listings", actor.id, files);
    res.json({ urls: results.map((r) => r.url) });
  } catch (error) {
    if (error instanceof ImageRejected) return fail(res, error.status, error.code, error.message);
    console.error("Upload error:", error && error.message);
    if (error.name === "MulterError") {
      return res.status(400).json({ error: error.message });
    }
    return res.status(500).json({ error: error.message || "Upload failed" });
  }
};

exports.profileImage = async (req, res) => {
  try {
    const file = req.file;
    const userId = req.query.userId;
    if (!file) {
      return res.status(400).json({ error: "No files uploaded" });
    }
    const user = await User.findById(userId).select("profilePicture").lean();
    if (!user) {
      return res.status(404).json({ message: "Profile not found" });
    }
    const [stored] = await storeImages("profiles", userId, [file]);
    await User.updateOne({ _id: userId }, { $set: { profilePicture: stored.url } });
    // The replaced picture (and its variants) is removed when it is this
    // account's own object and nothing else references it — a profile change
    // used to leave the old object in the bucket forever.
    const oldKey = storage.keyFromUrl(user.profilePicture);
    if (oldKey && oldKey !== stored.key) {
      const own = storage.ownerFromKey(oldKey) === String(userId).toLowerCase();
      const { listingRefs, profileRefs } = await referencesOf(oldKey);
      const elsewhere = listingRefs.length || profileRefs.some((u) => !authz.sameId(u._id, userId));
      if ((own || storage.ownerFromKey(oldKey) === null) && !elsewhere) {
        storage.deleteImages([oldKey]).catch((err) => console.error("profile picture: old object cleanup failed", err && err.message));
      }
    }
    return res.json({ url: stored.url });
  } catch (error) {
    if (error instanceof ImageRejected) return fail(res, error.status, error.code, error.message);
    console.error("Upload error:", error && error.message);
    if (error.name === "MulterError") {
      return res.status(400).json({ error: error.message });
    }
    return res.status(500).json({ error: error.message || "Upload failed" });
  }
};

// Every listing / profile that references the object, by canonical key.
async function referencesOf(key) {
  const re = storage.spacesUrlRegex();
  const [listings, users] = await Promise.all([
    ListingProperty.find({ photos: { $regex: re } }).select("host photos").lean(),
    User.find({ profilePicture: { $regex: re } }).select("profilePicture").lean(),
  ]);
  const listingRefs = listings.filter((l) => (l.photos || []).some((p) => storage.keyFromUrl(p) === key));
  const profileRefs = users.filter((u) => storage.keyFromUrl(u.profilePicture) === key);
  return { listingRefs, profileRefs };
}

exports.deleteImages = async (req, res) => {
  try {
    const actor = await authz.resolveActor(req);
    if (!actor) return fail(res, 401, "AUTH_REQUIRED", "Authentication required");
    const url = req.body && req.body.url;
    // A variant URL names the same photo as its master: the checks and the
    // delete apply to the master (and take every variant with it).
    const key = storage.masterKeyOf(storage.keyFromUrl(url));
    if (!key) return fail(res, 400, "INVALID_KEY", "Not an object of this platform");

    if (!authz.isAdmin(actor)) {
      const { listingRefs, profileRefs } = await referencesOf(key);
      const ownsUpload = storage.ownerFromKey(key) === String(actor.id).toLowerCase();
      const ownsListingRef = listingRefs.some((l) => authz.sameId(l.host, actor.id));
      const ownsProfileRef = profileRefs.some((u) => authz.sameId(u._id, actor.id));
      if (!ownsUpload && !ownsListingRef && !ownsProfileRef) {
        return fail(res, 403, "FORBIDDEN", "You can only remove your own uploads");
      }
      const foreign = listingRefs.some((l) => !authz.sameId(l.host, actor.id)) || profileRefs.some((u) => !authz.sameId(u._id, actor.id));
      if (foreign) return fail(res, 409, "OBJECT_IN_USE", "This image is still used by another listing or profile");
    }

    const result = await storage.deleteImages([key]);
    if (result.failed.length) return fail(res, 502, "STORAGE_ERROR", "Delete failed");
    res.json({ success: true });
  } catch (err) {
    console.error("deleteImages error", err && err.message);
    res.status(500).json({ error: "Delete failed" });
  }
};

// Retired (contact lock-down): a presigned PUT lets raw bytes reach the public
// bucket without services/imageSanitizer.js (EXIF GPS, QR codes). No shipped
// client uses it (admin.site and the site upload through POST /uploads); it
// answers 410 so it cannot be revived by setting an environment variable.
exports.generatePresignedUrl = (req, res) => {
  res.status(410).json({
    success: false,
    code: "UPLOAD_PATH_RETIRED",
    message: "Direct-to-bucket uploads are retired: upload through POST /api/v1/uploads so the image is sanitised",
    statusCode: 410,
  });
};

exports.__internals = { storeImage, storeImages, mapLimit, FILE_CONCURRENCY, PUT_CONCURRENCY };

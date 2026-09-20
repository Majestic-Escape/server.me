// Spaces uploads (listing photos, profile pictures) and object deletion.
//
// Batch A2: every route is authenticated (routes/uploadRoutes.js). New
// uploads get owner-bound keys (services/storage.js#makeUploadKey) so the
// object's owner is verifiable from the key. Deletion requires the caller to
// own the object (own upload, own listing's photo, own profile picture) or
// be an admin, and refuses — even for owners — while anyone else's listing or
// profile still references the same object (legacy keys can collide).
const User = require("../models/User");
const ListingProperty = require("../models/ListingProperty");
const authz = require("../middleware/authz");
const storage = require("../services/storage");
const { sanitizeImage, outputName, ImageRejected } = require("../services/imageSanitizer");

function fail(res, status, code, message) {
  return res.status(status).json({ success: false, code, message, error: message, statusCode: status });
}

// Contact lock-down: every public image is re-encoded without metadata (EXIF
// GPS would reveal the exact location) and refused when it carries a QR code.
async function safeImage(file) {
  const clean = await sanitizeImage(file.buffer, file.mimetype);
  return { buffer: clean.buffer, mimetype: clean.mimetype, name: outputName(file.originalname, clean.extension) };
}

exports.uploadImages = async (req, res) => {
  try {
    const actor = await authz.resolveActor(req);
    if (!actor) return fail(res, 401, "AUTH_REQUIRED", "Authentication required");
    const files = req.files;
    if (!files || files.length === 0) {
      return res.status(400).json({ error: "No files uploaded" });
    }
    const cleaned = await Promise.all(files.map(safeImage));
    const urls = await Promise.all(
      cleaned.map((file) => storage.putObject(storage.makeUploadKey("listings", actor.id, file.name), file.buffer, file.mimetype)),
    );
    res.json({ urls });
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
    const exists = await User.exists({ _id: userId });
    if (!exists) {
      return res.status(404).json({ message: "Profile not found" });
    }
    const clean = await safeImage(file);
    const url = await storage.putObject(storage.makeUploadKey("profiles", userId, clean.name), clean.buffer, clean.mimetype);
    await User.updateOne({ _id: userId }, { $set: { profilePicture: url } });
    return res.json({ url });
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
    const key = storage.keyFromUrl(url);
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

    const result = await storage.deleteObjects([key]);
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


// Site settings the admin manages without a deploy — the homepage banner
// (docs/site-hero.md). Authentication and the admin check run before any
// multipart parsing; the image parser has explicit, tight limits and answers
// its own errors in the API shape (utils/multipart.js).
const express = require("express");
const multer = require("multer");
const site = require("../controllers/siteController");
const authMiddleware = require("../middleware/authMiddleware");
const cronAuth = require("../middleware/cronAuth");
const { requireAdmin } = require("../middleware/authz");
const { uploadLimits, rejectFile, handleUpload } = require("../utils/multipart");
const { isSlot } = require("../services/siteHeroImage");
const { MAX_UPLOAD_BYTES } = require("../services/siteHero");

const router = express.Router();
const admin = [authMiddleware, requireAdmin];

// One image, six short text fields. HEIC is let through the parser so the
// admin hears the specific "export as JPEG" answer from the image check.
const heroUpload = multer({
  storage: multer.memoryStorage(),
  limits: uploadLimits({ fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 6, fieldNameSize: 32, fieldSize: 1024 }),
  fileFilter: (req, file, cb) => {
    const allowed = ["image/jpeg", "image/jpg", "image/png", "image/webp", "image/avif", "image/gif", "image/heic", "image/heif", "application/octet-stream"];
    if (!allowed.includes(file.mimetype)) return cb(rejectFile("Use a JPEG, PNG, WebP or AVIF image"), false);
    return cb(null, true);
  },
});

const slotParam = (req, res, next) => {
  if (!isSlot(req.params.slot)) return res.status(400).json({ success: false, code: "INVALID_SLOT", message: "Unknown banner slot", statusCode: 400 });
  return next();
};

router.get("/hero", site.getPublicHero);
router.get("/admin/hero", ...admin, site.getAdminHero);
router.get("/admin/hero/ops/:opId", ...admin, site.getOperation);
router.post("/admin/hero/publish", ...admin, site.publish);
router.patch("/admin/hero/alt", ...admin, site.editAlt);
router.post("/admin/hero/restore-default", ...admin, site.restoreDefault);
router.post("/admin/hero/:slot/draft", ...admin, slotParam, handleUpload(heroUpload.single("image")), site.stageDraft);
router.delete("/admin/hero/:slot/draft", ...admin, slotParam, site.discardDraft);
router.get("/cron/hero-sweep", cronAuth, site.cronSweep);

module.exports = router;

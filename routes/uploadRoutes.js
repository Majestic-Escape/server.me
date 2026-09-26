// Spaces uploads. Authenticated; a profile picture may only be set on the
// caller's own account; deletion is ownership-checked in the controller.
const express = require("express");
const uploadController = require("../controllers/uploadController");
const multer = require("multer");
const router = express.Router();
const authMiddleware = require("../middleware/authMiddleware");
const { requireAdmin } = require("../middleware/authz");
const { requireSelfUserIdQueryOrAdmin } = require("../middleware/userOwnership");
const { uploadLimits, rejectFile, handleUpload } = require("../utils/multipart");

// Explicit limits on every parser (multer's field defaults are unbounded);
// parser and limit failures answer 4xx instead of the global 500.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: uploadLimits({ fileSize: 5 * 1024 * 1024, files: 20 }), // 5MB each, 20 files
  fileFilter: (req, file, cb) => {
    const allowedTypes = [
      "image/jpg",
      "image/jpeg",
      "image/png",
      "image/webp",
      "image/heic",
      "image/heif",
      "application/octet-stream",
    ];

    if (!allowedTypes.includes(file.mimetype)) {
      return cb(rejectFile("Only image files are allowed"), false);
    }

    cb(null, true);
  },
});

const uploads = multer({
  storage: multer.memoryStorage(),
  limits: uploadLimits({ fileSize: 5 * 1024 * 1024, files: 1 }),
});
router.post("/", authMiddleware, handleUpload(upload.array("images", 20)), uploadController.uploadImages);
router.post("/profile", authMiddleware, requireSelfUserIdQueryOrAdmin("userId"), handleUpload(uploads.single("file")), uploadController.profileImage);
router.delete("/delete", authMiddleware, uploadController.deleteImages);
router.post("/generate-presigned-url", authMiddleware, requireAdmin, uploadController.generatePresignedUrl);

module.exports = router;

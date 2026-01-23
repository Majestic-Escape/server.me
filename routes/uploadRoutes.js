const express = require("express");
const uploadController = require("../controllers/uploadController");
const multer = require("multer");
const router = express.Router();
// const upload = multer({ storage: multer.memoryStorage() });

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 * 20 }, // 5MB limit
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
      return cb(new Error("Only image files are allowed"), false);
    }

    cb(null, true);
  },
});

const uploads = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
});
router.post("/", upload.array("images", 20), uploadController.uploadImages);
router.post("/profile", uploads.single("file"), uploadController.profileImage);
router.delete("/delete", uploadController.deleteImages);
router.post("/generate-presigned-url", uploadController.generatePresignedUrl);

module.exports = router;

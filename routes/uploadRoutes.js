const express = require("express");
const uploadController = require("../controllers/uploadController");
const multer = require("multer");
const router = express.Router();
// const upload = multer({ storage: multer.memoryStorage() });

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB limit
  fileFilter: (req, file, cb) => {
    const allowedTypes = ["image/jpeg", "image/png", "image/webp", "image/gif"];

    if (!allowedTypes.includes(file.mimetype)) {
      return cb(new Error("Only image files are allowed"), false);
    }

    cb(null, true);
  },
});
router.post("/", upload.array("images", 10), uploadController.uploadImages);
router.delete("/delete", uploadController.deleteImages);
router.post("/generate-presigned-url", uploadController.generatePresignedUrl);

module.exports = router;

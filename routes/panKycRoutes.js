// Identity document OCR + status verification (PAN / voter id / passport).
// Authenticated, self-only, provider-cost guarded (services/kycGuard.js).
const express = require("express");
const router = express.Router();
const { verifyKYC } = require("../controllers/panKycController");
const authMiddleware = require("../middleware/authMiddleware");
const { requireSelfBodyUserIdOrAdmin } = require("../middleware/userOwnership");

router.post("/verify", authMiddleware, requireSelfBodyUserIdOrAdmin("userId"), verifyKYC);

module.exports = router;

// /api/v1/guests — admin user management (Batch A2: admin-gated; rename,
// KYC document review) plus two self-service reads used by the customer site.
const express = require("express");
const router = express.Router();
const {
  getUserInfo,
  banUser,
  getGuests,
  getGuestsById,
  getKycDetails,
  renameUser,
  listKycDocuments,
  getKycDocumentFile,
  manualVerifyKycDocument,
} = require("../controllers/guestController");
const authMiddleware = require("../middleware/authMiddleware");
const { requireAdmin } = require("../middleware/authz");
const { validateParam } = require("../middleware/validateObjectId");

const admin = [authMiddleware, requireAdmin];

router.get("/", ...admin, getGuests);
router.get("/kyc", ...admin, getKycDetails);
// Get user information - REQUIRES AUTH to prevent data leakage
router.get("/info/:userId", authMiddleware, getUserInfo);

router.get("/guest-by-id", authMiddleware, getGuestsById);

// Rename a user/host (admin, audited, optimistic concurrency)
router.patch("/name/:userId", ...admin, validateParam("userId"), renameUser);

// KYC documents uploaded by a host (admin, audited reads)
router.get("/kyc-documents/:hostId", ...admin, validateParam("hostId"), listKycDocuments);
router.get("/kyc-documents/:hostId/:logId/file", ...admin, validateParam("hostId"), validateParam("logId"), getKycDocumentFile);
router.patch("/admin/kyc/:hostId/document-verified", ...admin, validateParam("hostId"), manualVerifyKycDocument);

// Ban / unban user
router.patch("/ban/:userId", ...admin, validateParam("userId"), banUser);

module.exports = router;

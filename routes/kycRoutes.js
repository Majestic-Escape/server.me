// Host KYC. Every route is authenticated and scoped to the caller's own
// form/user (admins may act on anyone). Verification state (documentInfo,
// gstInfo) is written only by the verification endpoints from the provider
// verdict — the PATCH routes below are kept for the existing site but can
// only confirm what the server already decided. See Batch A2 in
// docs/batch-s-authz-matrix.md.
const express = require("express");
const router = express.Router();

const { generateKycUrl, getKycDetails } = require("../controllers/kycController");
const { verifyPan } = require("../controllers/kyc/panController");
const hostFormController = require("../controllers/kyc/hostFormController");
const { verifyGst } = require("../controllers/gstController");
const authMiddleware = require("../middleware/authMiddleware");
const { requireAdmin } = require("../middleware/authz");
const { requireSelfUserIdOrAdmin } = require("../middleware/listingOwnership");
const { requireSelfBodyUserIdOrAdmin, requireKycFormOwnerOrAdmin } = require("../middleware/userOwnership");
const { validateParam } = require("../middleware/validateObjectId");

const admin = [authMiddleware, requireAdmin];

// Digitap sandbox endpoints (unused by the site, cost provider credits).
router.post("/generate-url", ...admin, generateKycUrl);
router.get("/verify/pan", ...admin, verifyPan);

router.post("/form", authMiddleware, requireSelfBodyUserIdOrAdmin("hostId"), hostFormController.createhostKycForm);
router.put("/update-form/:id", authMiddleware, requireKycFormOwnerOrAdmin("id"), hostFormController.updatehostKycForm);
router.get("/form/:id", authMiddleware, validateParam("id"), requireSelfUserIdOrAdmin("id"), hostFormController.fetchhostKycForm);
router.get("/form-kyc/:id", authMiddleware, requireKycFormOwnerOrAdmin("id"), hostFormController.fetchhostKycFormById);
router.get("/user/:id", authMiddleware, validateParam("id"), requireSelfUserIdOrAdmin("id"), hostFormController.fetchhostKycFormByUserId);
router.post("/verify/gst", authMiddleware, requireSelfBodyUserIdOrAdmin("userId"), verifyGst);
router.patch("/verify-status", authMiddleware, requireSelfBodyUserIdOrAdmin("userId"), hostFormController.updatehostKycFormStatus);
router.patch("/verify-gst-status", authMiddleware, requireSelfBodyUserIdOrAdmin("userId"), hostFormController.updatehostKycFormGstStatus);

// Keep last: the parameterised sandbox route would otherwise shadow the
// literal paths above.
router.get("/:transactionId/details", ...admin, getKycDetails);

module.exports = router;

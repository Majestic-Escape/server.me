// /api/v1/hostData — host bank details and host profile reads.
// Batch A2: bank details are the host's own (or an admin's); the all-hosts
// and all-reviews listings are admin-only.
const express = require("express");
const router = express.Router();
const hostController = require("../controllers/hostController");
const authMiddleware = require("../middleware/authMiddleware");
const { requireAdmin } = require("../middleware/authz");
const { requireSelfUserIdOrAdmin } = require("../middleware/listingOwnership");
const { validateParam } = require("../middleware/validateObjectId");

const admin = [authMiddleware, requireAdmin];

// Get all hosts and their properties
router.get("/", ...admin, hostController.getAllHosts);

router.put("/bank/:id", authMiddleware, validateParam("id"), requireSelfUserIdOrAdmin("id"), hostController.submitBankDetails);

router.get("/bank/:id", authMiddleware, validateParam("id"), requireSelfUserIdOrAdmin("id"), hostController.getBankDetails);

router.get("/review/admin", ...admin, hostController.getAllReviews);

router.get("/review/:userId", hostController.getHostReviewsById);

// Get a single host and their properties
router.get("/:hostId", authMiddleware, hostController.getHostById);

module.exports = router;

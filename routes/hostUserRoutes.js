// /api/v1/hosts — host analytics/exports (admin-only since Batch A2; no
// client used them unauthenticated) and host reads/updates.
const express = require("express");
const router = express.Router();
const hostController = require("../controllers/hostUserController");
const authMiddleware = require("../middleware/authMiddleware");
const { requireAdmin } = require("../middleware/authz");
const { validateParam } = require("../middleware/validateObjectId");

const admin = [authMiddleware, requireAdmin];

// Get all hosts (with pagination, filtering, and sorting)
router.get("/", ...admin, hostController.getAllHosts);

// Get host statistics
router.get("/stats", ...admin, hostController.getHostStats);

// Get host growth data
router.get("/growth", ...admin, hostController.getHostGrowth);

// Get top performing hosts
router.get("/top-performing", ...admin, hostController.getTopPerformingHosts);

// Get host activity data
router.get("/activity", ...admin, hostController.getHostActivity);

// Get host distribution by property type
router.get("/distribution", ...admin, hostController.getHostDistribution);

// Generate custom report
router.get("/report", ...admin, hostController.generateReport);

// Export hosts data
router.get("/export", ...admin, hostController.exportHosts);

router.get("/single/:id", authMiddleware, hostController.getSingleHostById);
// Get a single host by ID
router.get("/:id", authMiddleware, hostController.getHostById);

// Update a host (admin)
router.put("/:id", ...admin, validateParam("id"), hostController.updateHost);

module.exports = router;

const express = require("express");
const router = express.Router();
const hostController = require("../controllers/hostUserController");
const authMiddleware = require("../middleware/authMiddleware");
// Get all hosts (with pagination, filtering, and sorting)
router.get("/", hostController.getAllHosts);

// Get host statistics
router.get("/stats", hostController.getHostStats);

// Get host growth data
router.get("/growth", hostController.getHostGrowth);

// Get top performing hosts
router.get("/top-performing", hostController.getTopPerformingHosts);

// Get host activity data
router.get("/activity", hostController.getHostActivity);

// Get host distribution by property type
router.get("/distribution", hostController.getHostDistribution);

// Generate custom report
router.get("/report", hostController.generateReport);

// Export hosts data
router.get("/export", hostController.exportHosts);

router.get("/single/:id", authMiddleware, hostController.getSingleHostById);
// Get a single host by ID
router.get("/:id", authMiddleware, hostController.getHostById);

// Update a host
router.put("/:id", hostController.updateHost);

module.exports = router;

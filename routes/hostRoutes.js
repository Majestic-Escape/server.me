const express = require("express");
const router = express.Router();
const hostController = require("../controllers/hostController");
const propertyController = require("../controllers/propertyController");
const authMiddleware = require("../middleware/authMiddleware");

// Get all hosts and their properties
router.get("/", hostController.getAllHosts);

router.put("/bank/:id", authMiddleware, hostController.submitBankDetails);

router.get("/bank/:id", authMiddleware, hostController.getBankDetails);
// Get a single host and their properties
router.get("/:hostId", authMiddleware, hostController.getHostById);

router.get("/review/admin", authMiddleware, hostController.getAllReviews);

router.get("/review/:userId", hostController.getHostReviewsById);

// // Add a new property for a host
// router.post("/:hostId/properties", propertyController.addProperty);

// // Get all properties of a specific host
// router.get("/:hostId/properties", propertyController.getHostProperties);

module.exports = router;

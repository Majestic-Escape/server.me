const express = require("express");
const router = express.Router();
const reviewController = require("../controllers/reviewController");
const authMiddleware = require("../middleware/authMiddleware");
const { requireAdmin } = require("../middleware/authz");

router.post("/", authMiddleware, reviewController.submitReview);
router.post("/guest", authMiddleware, reviewController.submitHostReview);
router.post("/verify", authMiddleware, reviewController.verifyToken);
// Review moderation (hide / restore + rating recount) is an admin action; the
// admin Reviews page is its only caller. Was any authenticated user.
router.patch("/update", authMiddleware, requireAdmin, reviewController.updateReview);
router.get("/:propertyId", reviewController.getPropertyReview);
router.get("/checking/:id", reviewController.checkReview);
router.get("/host/checking/:id", reviewController.checkHostReview);

module.exports = router;

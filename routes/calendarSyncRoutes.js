const express = require("express");
const router = express.Router();
const calendarsyncController = require("../controllers/calendarsyncController");
const authMiddleware = require("../middleware/authMiddleware");
const { requireBodyListingHostOrAdmin } = require("../middleware/listingOwnership");

// Batch S: attaching an external calendar imports "confirmed" bookings that
// block inventory, so only the listing's host (or an admin) may do it.
router.post("/saveCalendar", authMiddleware, requireBodyListingHostOrAdmin, calendarsyncController.saveCalendarUrl);
// Export is keyed by the per-property secret in the URL (unchanged).
router.get("/ics/:secret.ics", calendarsyncController.exportCalendar);

module.exports = router;

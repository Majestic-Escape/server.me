const express = require("express");
const router = express.Router();
const calendarsyncController = require("../controllers/calendarsyncController");
const authMiddleware = require("../middleware/authMiddleware");
const { requireActor, requireAdmin } = require("../middleware/authz");
const { requireBodyListingHostOrAdmin, requireListingHostOrAdmin } = require("../middleware/listingOwnership");
const { validateParam } = require("../middleware/validateObjectId");
const cronAuth = require("../middleware/cronAuth");

// SyncGuard — docs/syncguard.md. Every host route resolves ownership on the
// server (listing host or admin); connection routes answer 404 for any
// connection the caller does not own.
const auth = [authMiddleware, requireActor];
const ownsListing = [...auth, validateParam("propertyId"), requireListingHostOrAdmin("propertyId")];

// Legacy (old web calendar page + mobile app): unchanged contract.
router.post("/saveCalendar", authMiddleware, requireBodyListingHostOrAdmin, calendarsyncController.saveCalendarUrl);
// Public feed, keyed by the 256-bit token in the URL (legacy tokens: 128-bit).
router.get("/ics/:secret.ics", calendarsyncController.exportCalendar);

// Host connections
router.get("/properties/:propertyId/connections", ...ownsListing, calendarsyncController.listConnections);
router.post("/properties/:propertyId/connections", ...ownsListing, calendarsyncController.createConnection);
router.get("/properties/:propertyId/explain", ...ownsListing, calendarsyncController.explain);
router.post("/properties/:propertyId/legacy-feed/revoke", ...ownsListing, calendarsyncController.revokeLegacyFeed);
router.patch("/connections/:connectionId", ...auth, calendarsyncController.updateConnection);
router.post("/connections/:connectionId/sync", ...auth, calendarsyncController.syncNow);
router.post("/connections/:connectionId/rotate-export", ...auth, calendarsyncController.rotateExport);
router.post("/connections/:connectionId/confirm-export", ...auth, calendarsyncController.confirmExport);
router.post("/connections/:connectionId/stop-export", ...auth, calendarsyncController.stopExport);
router.post("/connections/:connectionId/disconnect", ...auth, calendarsyncController.disconnect);
router.post("/connections/:connectionId/release-blocks", ...auth, calendarsyncController.releaseBlocks);

// Operations
router.get("/cron/sweep", cronAuth.anyOf("CRON_SECRET", "CALENDAR_SYNC_CRON_SECRET"), calendarsyncController.cronSweep);
router.get("/admin/overview", authMiddleware, requireAdmin, calendarsyncController.adminOverview);

module.exports = router;

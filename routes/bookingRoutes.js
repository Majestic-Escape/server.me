const express = require("express");
const router = express.Router();
const bookingController = require("../controllers/bookingController");
const lifecycle = require("../controllers/bookingLifecycleController");
const authMiddleware = require("../middleware/authMiddleware");
const { requireActor, requireAdmin } = require("../middleware/authz");
const { validateParam } = require("../middleware/validateObjectId");

// Every authenticated route below also resolves the actor (user / admin) so
// controllers can enforce ownership; object-level checks live in the
// controllers. See docs/batch-s-authz-matrix.md.
const auth = [authMiddleware, requireActor];
const admin = [authMiddleware, requireAdmin];

// Create a booking (guest) or a calendar block (listing host, action: "host")
router.post("/", ...auth, lifecycle.createBooking);

// Admin: every local guest booking
router.get("/", ...admin, bookingController.getAllBookings);

// Host analytics (scoped to the caller)
router.get("/filter", ...auth, bookingController.getAnalyticsFilterBookings);
router.get("/blocked-dates/:propertyId", validateParam("propertyId"), bookingController.blockedDates);
router.get("/admin/analytics-filter", ...admin, bookingController.getAllFilterBookings);
router.get("/analytics-filter", ...auth, bookingController.getHostFilterBookings);
router.get("/analytics-stats-filter", ...auth, bookingController.getHostFilterBookingStats);
router.get("/revenue-filter", ...auth, bookingController.getRevenueFilter);

router.patch("/modal-close", ...auth, lifecycle.updateCloseModal);
router.post("/admin-modify", ...admin, bookingController.modifyBooking);
router.patch("/update-flag", ...auth, bookingController.updateFlag);

// Host removes a calendar block (listing host or admin)
router.post("/unblock-dates/:propertyId", ...auth, validateParam("propertyId"), lifecycle.unblockDates);

router.get("/filter-active-bookings", ...auth, bookingController.getActiveBookings);
router.get("/hostEmails", ...admin, bookingController.getAllHostEmails);

// Guest: own bookings
router.get("/data", ...auth, bookingController.getAllUserBookings);

// Legacy post-payment call: notifications only (payment recorded by verify-payment)
router.post("/updateStatus", ...auth, lifecycle.markBookingAsPaid);

router.get("/user/:userId", ...auth, validateParam("userId"), bookingController.getBookingsByUser);
router.get("/host/:hostId", ...auth, validateParam("hostId"), bookingController.getBookingsByHost);

// Demo PDF (static content); signed-in only so it is no longer an anonymous Chromium launcher
router.get("/generate-pdf", ...auth, bookingController.generatePdf);
router.get("/users-by-host", ...admin, bookingController.getBookingsByHostGroupByUsers);

router.get("/check-dates/:propertyId", validateParam("propertyId"), bookingController.checkDates);

// Lifecycle (ownership enforced in the controller)
router.patch("/host/cancel", ...auth, lifecycle.cancelBooking);
router.patch("/admin/cancel", ...admin, lifecycle.cancelAdminBooking);
router.patch("/user/terminate", ...auth, lifecycle.terminateUserBooking);
router.patch("/host/terminate", ...auth, lifecycle.terminateBooking);
router.patch("/host/confirm", ...auth, lifecycle.confirmBooking);
router.patch("/instant/confirm", ...auth, lifecycle.confirmInstantBooking);

// Single booking: guest, host or admin of that booking
router.get("/:bookingId", ...auth, validateParam("bookingId"), lifecycle.getBookingById);
// Admin-only, whitelisted fields
router.put("/:bookingId", ...admin, validateParam("bookingId"), lifecycle.updateBooking);
// Admin-only
router.delete("/:bookingId", ...admin, validateParam("bookingId"), lifecycle.deleteBooking);

module.exports = router;

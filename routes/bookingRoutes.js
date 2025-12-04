const express = require("express");
const router = express.Router();
const bookingController = require("../controllers/bookingController");
const authMiddleware = require("../middleware/authMiddleware");
// Create a new booking
router.post("/", authMiddleware, bookingController.createBooking);

// Get all bookings (admin or host-specific)
router.get("/", authMiddleware, bookingController.getAllBookings);

// Get all filtered booking (host side)
router.get(
  "/filter",
  authMiddleware,
  bookingController.getAnalyticsFilterBookings
);
router.get(
  "/blocked-dates/:propertyId",

  bookingController.blockedDates
);
router.get(
  "/admin/analytics-filter",
  authMiddleware,
  bookingController.getAllFilterBookings
);
router.get(
  "/analytics-filter",
  authMiddleware,
  bookingController.getHostFilterBookings
);

router.get(
  "/revenue-filter",
  authMiddleware,
  bookingController.getRevenueFilter
);

router.patch(
  "/modal-close",
  authMiddleware,
  bookingController.updateCloseModal
);

router.post("/admin-modify", authMiddleware, bookingController.modifyBooking);

router.patch("/update-flag", authMiddleware, bookingController.updateFlag);
// router.get(
//   "/basic-filter",
//   authMiddleware,
//   bookingController.getBasicFilterBookings
// );

router.post("/unblock-dates/:propertyId", bookingController.unblockDates);

router.get(
  "/filter-active-bookings",
  authMiddleware,
  bookingController.getActiveBookings
);

router.get("/hostEmails", authMiddleware, bookingController.getAllHostEmails);
//Get all bookings (user)
router.get("/data", authMiddleware, bookingController.getAllUserBookings);

// Mark booking as paid
router.post(
  "/updateStatus",
  authMiddleware,
  bookingController.markBookingAsPaid
);

// Get bookings for a specific user
router.get(
  "/user/:userId",
  authMiddleware,
  bookingController.getBookingsByUser
);

// Get bookings for a specific host
router.get(
  "/host/:hostId",
  authMiddleware,
  bookingController.getBookingsByHost
);

router.get("/generate-pdf", bookingController.generatePdf);
router.get(
  "/users-by-host",
  authMiddleware,
  bookingController.getBookingsByHostGroupByUsers
);
// Get a specific booking by ID
router.get("/:bookingId", authMiddleware, bookingController.getBookingById);

// Update a booking (e.g., change dates, update status)
router.put("/:bookingId", authMiddleware, bookingController.updateBooking);

// Reject a booking (host action)
router.patch("/host/cancel", authMiddleware, bookingController.cancelBooking);

// Reject a booking (Admin action)
router.patch(
  "/admin/cancel",
  authMiddleware,
  bookingController.cancelAdminBooking
);

// Cancel a booking (user action)
router.patch(
  "/user/terminate",
  authMiddleware,
  bookingController.terminateUserBooking
);

// Cancel a booking (host action)
router.patch(
  "/host/terminate",
  authMiddleware,
  bookingController.terminateBooking
);

router.get("/check-dates/:propertyId", bookingController.checkDates);

// Confirm a booking (host action)
router.patch("/host/confirm", authMiddleware, bookingController.confirmBooking);

router.patch(
  "/instant/confirm",
  authMiddleware,
  bookingController.confirmInstantBooking
);

// Delete a booking (admin or system cleanup)
router.delete("/:bookingId", authMiddleware, bookingController.deleteBooking);

module.exports = router;
//

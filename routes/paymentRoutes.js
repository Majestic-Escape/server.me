// routes/paymentRoutes.js
const express = require("express");
const router = express.Router();
const paymentController = require("../controllers/paymentController");
const authMiddleware = require("../middleware/authMiddleware");
const { requireActor, requireAdmin } = require("../middleware/authz");
const cronAuth = require("../middleware/cronAuth");

const auth = [authMiddleware, requireActor];
const admin = [authMiddleware, requireAdmin];

// Admin transactions list (was anonymous: every payment incl. customer contacts)
router.get("/fetch", ...admin, paymentController.fetch);

// Create / reuse the Razorpay order for a booking (booking guest only)
router.post("/create-order", ...auth, paymentController.createOrder);

// Verify a payment (booking guest only)
router.post("/verify-payment", ...auth, paymentController.verifyPayment);

// Payment details (guest / host of the booking, or admin)
router.get("/payment/:id", ...auth, paymentController.getPayment);
router.get("/booking", ...auth, paymentController.getPaymentByBooking);

// Payout cron — Vercel Cron presents CRON_SECRET; nothing else may trigger payouts
router.get("/schedule-cron", cronAuth, paymentController.schedulecron);
module.exports = router;

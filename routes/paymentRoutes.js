// routes/paymentRoutes.js
const express = require("express");
const router = express.Router();
const paymentController = require("../controllers/paymentController");
const authMiddleware = require("../middleware/authMiddleware");

// Create new order

router.get("/fetch", paymentController.fetch);

router.post("/create-order", paymentController.createOrder);

// Verify payment
router.post("/verify-payment", paymentController.verifyPayment);

// Get payment details
router.get("/payment/:id", paymentController.getPayment);

router.get("/booking", paymentController.getPaymentByBooking);

// router.post(
//   "/payout/update",
//   express.raw({ type: "application/json" }),
//   paymentController.update
// );

router.post("/create-payout", paymentController.createPayout);

// router.post("/payout", paymentController.payout);
router.post("/schedule-cron", paymentController.schedulecron);
module.exports = router;

// routes/webhookRoutes.js
const express = require("express");
const router = express.Router();
const paymentController = require("../controllers/paymentController");

// ✅ NO body parser here - webhooks need raw body
router.post("/payout/update", paymentController.update);

module.exports = router;

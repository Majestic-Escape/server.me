// routes/authRoutes.js
const express = require("express");
const router = express.Router();
const { requestOTP, verifyOTP } = require("../controllers/loginController");
const { sendAdminLoginOtp } = require("../utils/loginOtpUtils");

router.post("/request-otp", requestOTP);
// router.post("/request-admin-otp", sendAdminLoginOtp);
router.post("/verify-otp", verifyOTP);

module.exports = router;

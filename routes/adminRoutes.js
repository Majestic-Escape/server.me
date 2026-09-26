// routes/profileRoutes.js
const express = require("express");
const router = express.Router();
const {
  requestOTP,
  verifyOTP,
  createAdmin,
  serviceFees,
  getServiceFees,
} = require("../controllers/adminController");
const authMiddleware = require("../middleware/authMiddleware");
const { requireAdmin } = require("../middleware/authz");

// Registration used to be open: anyone could create a verified Admin and got
// a 7-day admin token back. Only an existing admin may add one now (audited,
// no token for the new account — it signs in with its own e-mail OTP), and
// the fee configuration is admin-only like every other admin write.
const admin = [authMiddleware, requireAdmin];

router.post("/request-otp", requestOTP);
router.post("/verify-otp", verifyOTP);
router.post("/register", ...admin, createAdmin);
router.post("/service", ...admin, serviceFees);
router.get("/service", ...admin, getServiceFees);

// router.get("/", getAllAdmins);
// router.post("/", createAdmin);
// router.put("/:id", updateAdmin);
// router.delete("/:id", deleteAdmin);

module.exports = router;

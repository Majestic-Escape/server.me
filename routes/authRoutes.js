// userRoutes.js
const express = require("express");

const authController = require("../controllers/authController");
const authMiddleware = require("../middleware/authMiddleware");

const router = express.Router();

// Verify token route (used by the ProtectedRoute component)
router.get("/verify", authMiddleware, authController.verifyToken);
router.post("/check-token", authController.checkToken);
module.exports = router;

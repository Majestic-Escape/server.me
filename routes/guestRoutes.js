const express = require("express");
const router = express.Router();
const {
  getUserInfo,
  deleteUser,
  banUser,
  unbanUser,
  getGuests,
  getGuestsById,
} = require("../controllers/guestController");
const authMiddleware = require("../middleware/authMiddleware");

router.get("/", authMiddleware, getGuests);
// Get user information
router.get("/info/:userId", getUserInfo);

router.get("/guest-by-id", authMiddleware, getGuestsById);

// Delete user
router.delete("/delete/:userId", authMiddleware, deleteUser);

// Ban user
router.patch("/ban/:userId", authMiddleware, banUser);

// Unban user
// router.patch("/unban/:userId", authMiddleware, unbanUser);

module.exports = router;

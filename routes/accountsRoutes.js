// Profile of the signed-in user (customer site + mobile app). The
// ?email= query names the profile; it must be the caller's own (admins may
// read/update anyone's). Names are admin-managed and never written here.
const express = require("express");
const router = express.Router();
const { getProfile, updateProfile } = require("../controllers/accountsController");
const authMiddleware = require("../middleware/authMiddleware");
const { requireSelfEmailQueryOrAdmin } = require("../middleware/userOwnership");

router.get("/", authMiddleware, requireSelfEmailQueryOrAdmin, getProfile);
router.put("/", authMiddleware, requireSelfEmailQueryOrAdmin, updateProfile);

module.exports = router;

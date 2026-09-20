// /api/v1/prop-listing — legacy listing API. Reads are used by the customer
// site (/status, /:id) and the admin (/admin/:id); writes are admin-only.
// The anonymous DELETE /:id and POST /bulk-action (deleteMany) routes were
// removed in Batch A2 — the sanctioned path is DELETE /properties/admin/:id.
const express = require("express");
const router = express.Router();
const {
  getAllPListings,
  getUserPListingById,
  createPListing,
  updatePListing,
  exportPListings,
  getListingStatus,
  getAdminPListingById,
} = require("../controllers/PropListingController");
const authMiddleware = require("../middleware/authMiddleware");
const { requireAdmin } = require("../middleware/authz");
const { validateParam } = require("../middleware/validateObjectId");
const { requireSelfEmailQueryOrAdmin } = require("../middleware/userOwnership");

const admin = [authMiddleware, requireAdmin];

// Anonymous catalogue read; the ?hostEmail= filter is for the host's own
// listings (or an admin) — to anyone else it was an e-mail → host oracle.
router.get("/", authMiddleware.optional, getAllPListings);
// Batch P: a host reads their own stage (the site sends ?email=<own> with the
// session token); admins may ask for any host.
router.get("/status", authMiddleware, requireSelfEmailQueryOrAdmin, getListingStatus);

// Batch P: the export (whole catalogue with hosts) and the raw admin document
// (hostEmail, street, registration number) were anonymous.
router.get("/export", ...admin, exportPListings);
router.get("/admin/:id", ...admin, validateParam("id"), getAdminPListingById);
// The listing's own host (the edit wizard) or an admin gets the stored
// document — exact address, owner flags; everyone else the public view.
router.get("/:id", authMiddleware.optional, validateParam("id"), getUserPListingById);

router.post("/", ...admin, createPListing);
router.put("/:id", ...admin, validateParam("id"), updatePListing);

module.exports = router;

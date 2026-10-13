// routes/propertyRoutes.js
const express = require("express");
const router = express.Router();
const propertyController = require("../controllers/propertyController");
const authMiddleware = require("../middleware/authMiddleware");
const { requireAdmin } = require("../middleware/authz");
const { validateParam } = require("../middleware/validateObjectId");
const {
  requireListingHostOrAdmin,
  requireBodyListingHostOrAdmin,
  requireSelfHostEmailOrAdmin,
  requireSelfUserIdOrAdmin,
  requireSelfEmailParamOrAdmin,
} = require("../middleware/listingOwnership");
// Batch S: listing mutations decide price/bookability -> host-or-admin only.
const admin = [authMiddleware, requireAdmin];
router.get("/", propertyController.getAllProperties);
router.get("/static", propertyController.getAllStaticProperties);
router.get("/dynamic", propertyController.getAllStays);
router.get("/front/dynamic", propertyController.getFrontPageAllStays);
// A host's whole live portfolio by host id: admin only (no client uses it).
router.get("/id-and-name/:id", ...admin, validateParam("id"), propertyController.getIdandName);
router.get(
  "/active/:id",
  authMiddleware,
  validateParam("id"),
  propertyController.getActivePropertyById,
);
// Batch P: admin host-profile data (host contact details) — admin only.
router.get(
  "/active/filter/:id",
  ...admin,
  validateParam("id"),
  propertyController.getFilterActivePropertyById,
);
router.get("/countstays", propertyController.getPropertyCount);
router.get("/admin-filter", ...admin, propertyController.getAdminFilter); // Batch P: was anonymous
router.get("/search-properties", propertyController.getCustomSearch);
// Public read with an entitled-caller upgrade (docs/listing-visibility.md):
// soft auth — a stale or invalid token is anonymous, never a 401.
// "More stays hosted by …" / "Similar stays nearby" (docs/related-stays.md)
router.get("/:id/related", validateParam("id"), propertyController.getRelatedStays);
router.get("/:id", authMiddleware.soft, validateParam("id"), propertyController.getPropertyById);
// Legacy `Property` model endpoints (no client uses them): admin only.
router.post("/", ...admin, propertyController.createProperty);
router.put("/:id", ...admin, validateParam("id"), propertyController.updateProperty);

// Every live listing as stored (exact street, precise point): the admin
// reviews page only — it was open to any signed-in user.
router.get(
  "/admin/active",
  ...admin,
  propertyController.getAllActiveProperty,
);
router.get(
  "/admin/processing-listings",
  ...admin,
  propertyController.getProcessingListingsForAdmin,
);
router.get(
  "/admin/filtered-listings",
  ...admin,
  propertyController.getFilteredListingsForAdmin,
);
// PUT approve a listing
router.patch(
  "/admin/approve/:id",
  ...admin,
  validateParam("id"),
  propertyController.approveListing,
);

// Which kind of delist this is comes from the route, never from ?hostSide.
router.patch("/admin/delist/:id", ...admin, validateParam("id"), propertyController.adminDeListing);
router.patch("/host/delist/:id", authMiddleware, requireListingHostOrAdmin("id"), propertyController.hostDeListing);
router.patch(
  "/host/reactivate/:id",
  authMiddleware,
  requireListingHostOrAdmin("id"),
  propertyController.reactivate,
);

// Admin deletes a pending listing (Batch A2): transactional, blocker-checked,
// audited; photos removed from the Space after commit (services/listingDeletion.js).
router.delete("/admin/:id", ...admin, validateParam("id"), propertyController.adminDeleteListing);
// a host deletes its own draft / withdraws its own pending submission (the service re-checks ownership inside the transaction)
router.delete("/host/:id", authMiddleware, validateParam("id"), propertyController.hostDeleteListing);

router.post(
  "/create-listing-property",
  authMiddleware,
  requireSelfHostEmailOrAdmin,
  propertyController.createListingProperty,
);

router.put(
  "/update-listing-property/:id",
  authMiddleware,
  requireListingHostOrAdmin("id"),
  propertyController.updateListingProperty,
);
router.put(
  "/admin-update-property/:id",
  ...admin,
  validateParam("id"),
  propertyController.adminUpdateListingProperty,
);
router.patch("/update-kyc-property/:id", authMiddleware, requireSelfUserIdOrAdmin("id"), propertyController.updateKycProperty);
router.get(
  "/user-properties/:userEmail",
  authMiddleware,
  requireSelfEmailParamOrAdmin("userEmail"),
  propertyController.getUserPropertyListings,
);
router.get(
  "/get-timings/:propertyId",
  authMiddleware,
  requireListingHostOrAdmin("propertyId"),
  propertyController.getTiming,
);
router.post("/timings", authMiddleware, requireBodyListingHostOrAdmin, propertyController.timing);

module.exports = router;

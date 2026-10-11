const ListingProperty = require("../models/ListingProperty");
const {
  sanitizeProperty,
  sanitizeProperties,
  sanitizePropertyForOwner,
  SAFE_HOST_SELECT,
} = require("../utils/sanitizeResponse");
const { resolveListingAccess, nonPublicView, ownedListingsFilter, hostIdForEmail } = require("../services/listingAccess");
const listingPublish = require("../services/listingPublish");
const { isPublicListing } = require("../utils/listingProjection");
const authz = require("../middleware/authz");
const { checkListingWrite, refusePublicText, LISTING_TEXT_SELECT, checkListingImages, refuseImages } = require("../utils/publicTextPolicy");
const { notifyListingChanged } = require("../services/listingChanged");
const { escapeRegex } = require("../utils/listingProjection");

const LISTING_STATUSES = ["incomplete", "processing", "inactive", "active"];

// Host dashboard stage card. Used to read req.params.email on a route that
// has no :email param, so the filter was { email: undefined } — which
// matched every listing in the collection (hydrated, with vectors) and told
// every host the site-wide aggregate. Now: the caller's own listings, by
// host id or legacy hostEmail, status only.
exports.getListingStatus = async (req, res) => {
  try {
    const email = String(req.query.email || "").trim().toLowerCase();
    const actor = req.actor; // resolved by requireSelfEmailQueryOrAdmin
    // the caller's own listings by account id; an admin asking by e-mail gets
    // that account's (e-mail matches only legacy rows without a host id)
    const hostId = actor && actor.kind === "user" ? actor.id : await hostIdForEmail(email);
    const listings = hostId || email
      ? await ListingProperty.find(ownedListingsFilter({ hostId, email })).select("status").lean()
      : [];

    if (!listings.length) {
      return res.json({ status: "noListings" });
    }

    const statuses = listings.map((listing) => listing.status);

    if (statuses.every((status) => status === "incomplete")) {
      return res.json({ status: "incompleteListings" });
    }

    if (statuses.every((status) => status === "processing")) {
      return res.json({ status: "pendingListings" });
    }

    if (statuses.every((status) => status === "active")) {
      return res.json({ status: "activeListings" });
    }

    return res.json({ status: "mixedListings" });
  } catch (error) {
    console.error("Error fetching listing status:", error);
    res.status(500).json({ message: "Server error" });
  }
};

exports.getAllPListings = async (req, res) => {
  const { page, status, sortBy, searchTerm, hostEmail } = req.query;
  // One string per parameter: `status[$ne]=x` / `searchTerm[]=` never
  // reach the query as operators.
  for (const [name, value] of Object.entries({ page, status, sortBy, searchTerm, hostEmail })) {
    if (value !== undefined && typeof value !== "string") {
      return res.status(400).json({ success: false, code: "INVALID_PARAM", message: `${name} must be a single value`, statusCode: 400 });
    }
  }
  if (status && status !== "all" && !LISTING_STATUSES.includes(status)) {
    return res.status(400).json({ success: false, code: "INVALID_PARAM", message: "unknown status", statusCode: 400 });
  }
  const limit = 10; // Items per page
  const skip = page ? (Math.max(parseInt(page, 10) || 1, 1) - 1) * limit : 0;

  try {
    let query = { status: { $ne: "incomplete" } };
    if (status && status !== "all") {
      query.status = status;
    }
    if (searchTerm) {
      // Literal, bounded text — was a raw regex (ReDoS / match-anything).
      const term = escapeRegex(searchTerm.trim().slice(0, 100));
      query.$or = [
        { title: { $regex: term, $options: "i" } },
        { "address.city": { $regex: term, $options: "i" } },
      ];
    }
    let own = false;
    if (hostEmail) {
      // Contact lock-down: only the host themselves (or an admin) may list by
      // e-mail — otherwise a known address revealed whether it belongs to a
      // host and which listings are theirs.
      const actor = req.actor || null;
      own = !!(actor && actor.kind === "user" && actor.user && actor.user.email &&
        String(actor.user.email).toLowerCase() === String(hostEmail).trim().toLowerCase());
      if (!authz.isAdmin(actor) && !own) {
        return res.status(actor ? 403 : 401).json({
          success: false,
          code: actor ? "FORBIDDEN" : "AUTH_REQUIRED",
          message: actor ? "You can only list your own listings" : "Authentication required",
          statusCode: actor ? 403 : 401,
        });
      }
      // The listings OF that host: by account id (a reassigned listing leaves
      // the old owner's list), e-mail only for legacy rows without a host id.
      const hostId = own ? actor.id : await hostIdForEmail(hostEmail);
      query.$and = [...(query.$and || []), ownedListingsFilter({ hostId, email: hostEmail })];
    }
    // Drafts, listings in review and delisted ones are not public: anyone
    // but an admin or the host listing their own sees active listings only
    // (anonymous `?status=incomplete` used to list every draft).
    if (!own && !authz.isAdmin(req.actor || null)) {
      query.status = "active";
      query.ban = { $ne: true };
    }

    let sortQuery = {};
    if (sortBy === "price_high_to_low") sortQuery.basePrice = -1;
    if (sortBy === "price_low_to_high") sortQuery.basePrice = 1;
    if (sortBy === "rating_high_to_low") sortQuery.rating = -1;
    if (sortBy === "recently_added") sortQuery.createdAt = -1;

    const listings = await ListingProperty.find(query)
      .sort(sortQuery)
      .skip(skip)
      .limit(limit)
      .populate({
        path: "host",
        select: SAFE_HOST_SELECT,
      });

    const total = await ListingProperty.countDocuments(query);

    // Sanitize listings to remove hostEmail and other sensitive data
    const sanitizedListings = sanitizeProperties(listings);

    res.status(200).json({
      listings: sanitizedListings,
      currentPage: page ? parseInt(page) : 1,
      totalPages: Math.ceil(total / limit),
      total,
    });
  } catch (err) {
    res
      .status(500)
      .json({ message: "Error fetching listings", error: err.message });
  }
};

exports.getUserPListingById = async (req, res) => {
  const { id } = req.params;
  const { hostEmail } = req.query;
  try {
    const listing = await ListingProperty.findById(id).populate({
      path: "host",
      select: SAFE_HOST_SELECT,
    });

    // The owner (the edit wizard writes this object back) and admins read the
    // stored document; everyone else the public view (approximate point, no
    // street, no owner flags) — and, for a listing that is not public, the
    // narrow views of docs/listing-visibility.md. authMiddleware.optional
    // resolved req.actor (the owner check runs first, so a host's own live
    // listing keeps its stored address).
    const actor = req.actor || null;
    const owner = !!listing && (authz.isAdmin(actor) || authz.isListingHost(actor, listing));
    // ?hostEmail= narrows the owner's own read as before; for anyone else it
    // would only be an e-mail ↔ listing oracle, so it is ignored.
    if (!listing || (owner && hostEmail && String(listing.hostEmail || "").toLowerCase() !== String(hostEmail).toLowerCase())) {
      return res.status(404).json({
        message: "Listing not found",
      });
    }

    let sanitizedListing;
    if (owner) sanitizedListing = sanitizePropertyForOwner(listing);
    else if (isPublicListing(listing)) sanitizedListing = sanitizeProperty(listing);
    else sanitizedListing = nonPublicView(listing, await resolveListingAccess(listing, actor));
    res.status(200).json(sanitizedListing);
  } catch (error) {
    console.error("Error fetching user property listing:", error);
    res.status(500).json({
      message: "Error fetching property listing",
    });
  }
};
exports.getAdminPListingById = async (req, res) => {
  try {
    const { id } = req.params;
    const propertyDetail = await ListingProperty.findById(id);
    if (!propertyDetail) {
      return res
        .status(404)
        .json({ success: false, message: "Property not found" });
    }
    return res.status(200).json({ success: true, data: propertyDetail });
  } catch (error) {
    // Used to be an empty catch: the request hung until the function timed out.
    console.error("getAdminPListingById error", error && error.message);
    return res.status(500).json({ success: false, message: "Server error" });
  }
};
exports.createPListing = async (req, res) => {
  try {
    // Contact lock-down (admins included): no contact details / exact address in public text
    const policy = checkListingWrite(null, req.body);
    if (!policy.ok) return refusePublicText(res, policy);
    const images = checkListingImages(null, req.body);
    if (!images.ok) return refuseImages(res, images);
    const doc = { ...(req.body || {}) };
    for (const k of listingPublish.NOT_EDITABLE) delete doc[k];
    let savedListing;
    if (doc.status === "active") {
      // Created live: only for an eligible host, fenced like any publish.
      try {
        savedListing = await listingPublish.createPublishedListing(doc);
      } catch (err) {
        if (err instanceof listingPublish.PublishError) return listingPublish.sendPublishError(res, err);
        throw err;
      }
    } else {
      // hostEmail is the host account's, never the body's
      if (doc.host) doc.hostEmail = (await listingPublish.hostEmailOf(doc.host)) || undefined;
      savedListing = await new ListingProperty(doc).save();
    }
    if (savedListing.status === "active") {
      try {
        await notifyListingChanged([savedListing._id], "admin-create"); // PUBLIC_CHANGE only when created live
      } catch (err) {
        console.error("admin-create notify failed", err && err.message);
      }
    }
    res.status(201).json(savedListing);
  } catch (error) {
    res
      .status(400)
      .json({ message: "Error creating listing", error: error.message });
  }
};

exports.updatePListing = async (req, res) => {
  const { id } = req.params;
  try {
    const before = await ListingProperty.findById(id).select(`status ${LISTING_TEXT_SELECT}`).lean();
    const policy = checkListingWrite(before, req.body);
    if (!policy.ok) return refusePublicText(res, policy);
    const images = checkListingImages(before, req.body);
    if (!images.ok) return refuseImages(res, images);
    // status / host / ban / delist follow the publish rules
    // (services/listingPublish.js) — an echoed value is ignored.
    try {
      await listingPublish.applyAdminListingPatch(id, req.body);
    } catch (err) {
      if (!(err instanceof listingPublish.PublishError)) throw err;
      if (err.status === 404) return res.status(404).json({ message: "Listing not found" });
      return listingPublish.sendPublishError(res, err);
    }
    const updatedListing = await ListingProperty.findById(id);
    if (!updatedListing) {
      return res.status(404).json({ message: "Listing not found" });
    }
    if ((before && before.status === "active") || updatedListing.status === "active") {
      try {
        await notifyListingChanged([id], "admin-prop-update"); // PUBLIC_CHANGE when visible before or after
      } catch (err) {
        console.error("admin-prop-update notify failed", err && err.message);
      }
    }
    res.status(200).json(updatedListing);
  } catch (error) {
    res
      .status(400)
      .json({ message: "Error updating listing", error: error.message });
  }
};

exports.deletePListing = async (req, res) => {
  const { id } = req.params;
  try {
    const deletedListing = await ListingProperty.findByIdAndDelete(id);
    if (!deletedListing) {
      return res.status(404).json({ message: "Listing not found" });
    }
    res.status(200).json({ message: "Listing deleted successfully" });
  } catch (error) {
    res
      .status(400)
      .json({ message: "Error deleting listing", error: error.message });
  }
};

// bulkActionPListings was removed (its route went in Batch A2): it wrote
// "Active" / "Inactive" statuses outside the publish rules.

exports.exportPListings = async (req, res) => {
  const { format = "csv", hostEmail } = req.query;
  try {
    let query = { status: { $ne: "incomplete" } };
    if (hostEmail) {
      query.hostEmail = hostEmail;
    }

    const listings = await ListingProperty.find(query).populate({
      path: "host",
      select: SAFE_HOST_SELECT,
    });

    if (format === "csv") {
      // Sanitize listings before export to remove sensitive data
      const sanitizedListings = sanitizeProperties(listings);
      res.status(200).json(sanitizedListings);
    } else {
      res.status(400).json({ message: "Unsupported export format" });
    }
  } catch (error) {
    res
      .status(400)
      .json({ message: "Error exporting listings", error: error.message });
  }
};

const ListingProperty = require("../models/ListingProperty");
const {
  sanitizeProperty,
  sanitizeProperties,
  SAFE_HOST_SELECT,
} = require("../utils/sanitizeResponse");
const { checkListingWrite, refusePublicText, LISTING_TEXT_SELECT } = require("../utils/publicTextPolicy");
const { notifyListingChanged } = require("../services/listingChanged");

// Host dashboard stage card. Used to read req.params.email on a route that
// has no :email param, so the filter was { email: undefined } — which
// matched every listing in the collection (hydrated, with vectors) and told
// every host the site-wide aggregate. Now: the caller's own listings, by
// host id or legacy hostEmail, status only.
exports.getListingStatus = async (req, res) => {
  try {
    const email = String(req.query.email || "").trim().toLowerCase();
    const actor = req.actor; // resolved by requireSelfEmailQueryOrAdmin
    const or = [];
    if (email) or.push({ hostEmail: email });
    if (actor && actor.kind === "user") or.push({ host: actor.id });
    const listings = or.length
      ? await ListingProperty.find({ $or: or }).select("status").lean()
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
  const limit = 10; // Items per page
  const skip = page ? (parseInt(page) - 1) * limit : 0;

  try {
    let query = { status: { $ne: "incomplete" } };
    if (status && status !== "all") {
      query.status = status;
    }
    if (searchTerm) {
      query.$or = [
        { title: { $regex: searchTerm, $options: "i" } },
        { "address.city": { $regex: searchTerm, $options: "i" } },
      ];
    }
    if (hostEmail) {
      query.hostEmail = hostEmail;
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
    let query = { _id: id };
    if (hostEmail) {
      query.hostEmail = hostEmail;
    }

    const listing = await ListingProperty.findOne(query).populate({
      path: "host",
      select: SAFE_HOST_SELECT,
    });

    if (!listing) {
      return res.status(404).json({
        message: "Listing not found",
      });
    }

    // Sanitize listing to remove hostEmail and other sensitive data
    const sanitizedListing = sanitizeProperty(listing);
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
    const newListing = new ListingProperty(req.body);
    const savedListing = await newListing.save();
    if (savedListing.status === "active") await notifyListingChanged([savedListing._id], "admin-create"); // PUBLIC_CHANGE only when created live
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
    const updatedListing = await ListingProperty.findByIdAndUpdate(
      id,
      req.body,
      { new: true },
    );
    if (!updatedListing) {
      return res.status(404).json({ message: "Listing not found" });
    }
    if ((before && before.status === "active") || updatedListing.status === "active") {
      await notifyListingChanged([id], "admin-prop-update"); // PUBLIC_CHANGE when visible before or after
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

exports.bulkActionPListings = async (req, res) => {
  const { propertyIds, action, hostEmail } = req.body;
  try {
    let query = { _id: { $in: propertyIds } };
    if (hostEmail) {
      query.hostEmail = hostEmail;
    }

    let result;
    switch (action) {
      case "approve":
        result = await ListingProperty.updateMany(query, {
          $set: { status: "Active" },
        });
        break;
      case "disable":
        result = await ListingProperty.updateMany(query, {
          $set: { status: "Inactive" },
        });
        break;
      case "delete":
        result = await ListingProperty.deleteMany(query);
        break;
      default:
        return res.status(400).json({ message: "Invalid action" });
    }
    res.status(200).json({ message: "Bulk action completed", result });
  } catch (error) {
    res
      .status(400)
      .json({ message: "Error performing bulk action", error: error.message });
  }
};

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

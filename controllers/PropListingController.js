const ListingProperty = require("../models/ListingProperty");

exports.getListingStatus = async (req, res) => {
  try {
    const email = req.params.email;
    const listings = await ListingProperty.find({ email: email });

    if (process.env.NEXT_PUBLIC_ENV === "dev") {
      console.log("Listings", email);
    }
    if (process.env.NEXT_PUBLIC_ENV === "dev") {
      console.log("Length", listings.length);
    }

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
      .populate("host");

    const total = await ListingProperty.countDocuments(query);

    res.status(200).json({
      listings,
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

    const listing = await ListingProperty.findOne(query).populate("host");

    if (!listing) {
      return res.status(404).json({
        message: "Listing not found",
      });
    }
    res.status(200).json(listing);
  } catch (error) {
    console.error("Error fetching user property listing:", error);
    res.status(500).json({
      message: "Error fetching property listing",
    });
  }
};

exports.createPListing = async (req, res) => {
  try {
    const newListing = new ListingProperty(req.body);
    const savedListing = await newListing.save();
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
    const updatedListing = await ListingProperty.findByIdAndUpdate(
      id,
      req.body,
      { new: true }
    );
    if (!updatedListing) {
      return res.status(404).json({ message: "Listing not found" });
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

    const listings = await ListingProperty.find(query).populate("host");

    if (format === "csv") {
      // Implement CSV export logic here
      // For simplicity, we're just sending JSON data
      res.status(200).json(listings);
    } else {
      res.status(400).json({ message: "Unsupported export format" });
    }
  } catch (error) {
    res
      .status(400)
      .json({ message: "Error exporting listings", error: error.message });
  }
};

const Property = require("../models/Property");
const ListingProperty = require("../models/ListingProperty");
const Booking = require("../models/Booking");
const { sendEmail } = require("../utils/sendEmail");
const {
  dummyHostData,
  dummyReviewsData,
  dummyPropertyData,
} = require("../utils/data");
const User = require("../models/User");
const { default: mongoose } = require("mongoose");
const { changeToUpperCase } = require("../utils/convertToUpperCase");

// exports.getCustomSearch = async (req, res) => {
//   try {
//     const { location, from, to, guests, propertyType } = req.query;

//     const checkin = new Date(from);
//     const checkout = new Date(to);

//     const bookings = await Booking.find({
//       $or: [
//         {
//           checkIn: { $lte: checkout },
//           checkOut: { $gte: checkin },
//         }, // overlapping condition
//       ],
//     }).select("propertyId"); // only fetch propertyId

//     console.log("big big", propertyType);
//     // 2. Collect booked property IDs
//     const bookedPropertyIds = bookings.map((b) => b.propertyId);

//     function filter(users) {
//       return users.filter((property) => {
//         const matchesSearch =
//           property?.address?.district
//             ?.toLowerCase()
//             .includes(location.toLowerCase()) ||
//           property?.address?.city
//             ?.toLowerCase()
//             .includes(location.toLowerCase()) ||
//           (property?.address?.state)
//             .toLowerCase()
//             .includes(location.toLowerCase());

//         const checkProperty = property?.propertyType
//           ?.toLowerCase()
//           .includes(propertyType?.toLowerCase());

//         return matchesSearch && checkProperty;
//       });
//     }

//     if (!guests) {
//       const availableHousing = await ListingProperty.find({
//         _id: { $nin: bookedPropertyIds },
//         status: "active",
//         // optional filter for guest capacity
//       });

//       const final = filter(availableHousing);
//       res.status(200).json({ success: true, data: final });
//     } else {
//       // 3. Find properties that are NOT booked in this date range
//       const availableProperties = await ListingProperty.find({
//         _id: { $nin: bookedPropertyIds },
//         status: "active",
//         guests: { $gte: guests }, // optional filter for guest capacity
//       });
//       const final = filter(availableProperties);
//       res.status(200).json({ success: true, data: final });
//     }
//     // 4. Return available properties
//   } catch (error) {
//     res.status(400).json({ success: false, error: error.message });
//   }
// };

exports.getCustomSearch = async (req, res) => {
  try {
    const {
      location,
      from,
      to,
      guests,
      propertyType,
      minPrice,
      maxPrice,
      placeType,
      beds,
      bedrooms,
      bathrooms,
      checkinType,
      bookingType,
      pets,
      amenities,
    } = req.query;

    // Build the base filter with status always active
    let filter = { status: "active" };

    // Initialize bookedPropertyIds as empty array (will be populated if dates are provided)
    let bookedPropertyIds = [];

    if (placeType) {
      if (placeType.toLowerCase() == "entire_place") {
        filter.placeType = "entire";
      } else if (placeType.toLowerCase() == "room") {
        filter.placeType = "room";
      } else {
        filter.placeType = { $in: ["entire", "room"] };
      }
    }

    if (minPrice && maxPrice) {
      filter.basePrice = { $gte: minPrice, $lte: maxPrice };
    }

    if (beds) {
      filter.beds = parseInt(beds);
    }

    if (bathrooms) {
      filter.bathrooms = pasreInt(bathrooms);
    }

    if (bedrooms) {
      filter.bedrooms = parseInt(bedrooms);
    }

    if (bookingType) {
      filter["bookingType.instantBook"] = true;
    }

    if (checkinType) {
      filter.occupancy = "self-check-in";
    }

    if (pets) {
      filter.selectedRules = "no_pets";
    }

    if (amenities) {
      filter.amenities = { $in: amenities };
    }

    console.log("amenities", filter);
    // 1. Handle date filtering only if both from and to are provided
    if (from && to) {
      const checkin = new Date(from);
      const checkout = new Date(to);

      // Validate dates
      if (isNaN(checkin.getTime()) || isNaN(checkout.getTime())) {
        return res.status(400).json({
          success: false,
          error: "Invalid date format",
        });
      }

      const bookings = await Booking.find({
        $or: [
          {
            checkIn: { $lte: checkout },
            checkOut: { $gte: checkin },
          }, // overlapping condition
        ],
      }).select("propertyId");

      bookedPropertyIds = bookings.map((b) => b.propertyId);
      filter._id = { $nin: bookedPropertyIds };
    }

    // 2. Handle guest capacity filtering (if provided)
    if (guests) {
      filter.guests = { $gte: parseInt(guests) };
    }

    // 3. Handle property type filtering (if provided)
    if (
      propertyType &&
      propertyType !== "null" &&
      propertyType !== "undefined"
    ) {
      filter.propertyType = {
        $regex: new RegExp(propertyType, "i"),
      };
    }

    // 4. Find properties based on the built filter
    const availableProperties = await ListingProperty.find(filter);

    // 5. Handle location filtering (if provided) - using JavaScript filter for more complex matching
    let filteredProperties = availableProperties;

    if (location && location !== "null" && location !== "undefined") {
      filteredProperties = availableProperties.filter((property) => {
        const propertyLocation = property.address || {};
        return (
          (propertyLocation.district &&
            propertyLocation.district
              .toLowerCase()
              .includes(location.toLowerCase())) ||
          (propertyLocation.city &&
            propertyLocation.city
              .toLowerCase()
              .includes(location.toLowerCase())) ||
          (propertyLocation.state &&
            propertyLocation.state
              .toLowerCase()
              .includes(location.toLowerCase()))
        );
      });
    }

    console.log(
      `Found ${filteredProperties.length} properties matching the criteria`
    );

    res.status(200).json({
      success: true,
      data: filteredProperties,
      filtersApplied: {
        location: !!location,
        dates: !!(from && to),
        guests: !!guests,
        propertyType: !!propertyType,
      },
    });
  } catch (error) {
    console.error("Search error:", error);
    res.status(400).json({
      success: false,
      error: error.message,
    });
  }
};

exports.getAdminFilter = async (req, res) => {
  try {
    const { search, hostId } = req.query;

    const filter = { status: "active" };

    if (hostId && hostId.toLowerCase() != "all") {
      filter.host = new mongoose.Types.ObjectId(hostId);
    }
    let property = await ListingProperty.aggregate([
      { $match: filter },
      {
        $group: {
          _id: "$host",
          totalProperty: { $sum: 1 },
          totalReviews: {
            $sum: "$reviewCount",
          },
          averageRating: { $avg: "$averageRating" },
          host: { $first: "$host" },
          hostEmail: { $first: "$hostEmail" },
        },
      },
    ]);

    property = await ListingProperty.populate(property, [
      { path: "host", select: "firstName lastName phoneNumber kyc" },
    ]);
    if (search) {
      const s = search.toLowerCase();
      property = property.filter(
        (b) =>
          b.host?.phoneNumber?.toLowerCase().includes(s) ||
          `${b.host?.firstName} ${b.host?.lastName}`.toLowerCase().includes(s)
      );
    }

    console.log("abc", property);
    res.json({ success: true, data: property });
  } catch (error) {
    console.error("Search error:", error);
    res.status(400).json({
      success: false,
      error: error.message,
    });
  }
};
exports.timing = async (req, res) => {
  try {
    const { checkinTime, checkoutTime, propertyId } = req.body;
    console.log("db", propertyId, checkinTime, checkoutTime);
    const property = await ListingProperty.findByIdAndUpdate(propertyId, {
      checkinTime: checkinTime,
      checkoutTime: checkoutTime,
    });
    if (!property) {
      return res
        .status(404)
        .json({ success: false, message: "Property not found" });
    }
    res.status(200).json({ success: true, data: property });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
};
exports.getAllStays = async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 12;
    const skip = (page - 1) * limit;

    // Get filter parameters
    const { type } = req.query;

    // Build query object
    let query = {};
    if (type) {
      query.propertyType = type;
    }
    // Only include documents with status 'processing' or 'completed'
    query.status = { $in: ["active", "completed"] };

    // Execute queries in parallel for better performance
    const [properties, totalProperties] = await Promise.all([
      ListingProperty.find(query)
        .sort({ createdAt: -1 }) // Sort by newest first
        .skip(skip)
        .limit(limit)
        .lean(), // Use lean() for better performance
      ListingProperty.countDocuments(query),
    ]);

    // Calculate pagination metadata
    const totalPages = Math.ceil(totalProperties / limit);
    const hasMore = page * limit < totalProperties;

    // Send response
    res.status(200).json({
      properties,
      currentPage: page,
      totalPages,
      totalProperties,
      hasMore,
      resultsPerPage: limit,
    });
  } catch (error) {
    console.error("Error fetching properties:", error);
    res.status(500).json({
      message: "Failed to fetch properties",
      error: error.message,
    });
  }
};
exports.getIdandName = async (req, res) => {
  try {
    const filter = { status: "active" };
    const data = await ListingProperty.find(filter);

    if (!data) {
      return res.status(404).json({ message: "Listing not found" });
    }
    res.status(200).json({
      data: data,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({
      message: "Failed to fetch properties",
      error: error.message,
    });
  }
};
exports.getAllStaticProperties = async (req, res) => {
  try {
    // Get pagination parameters from query
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 30;
    const skip = (page - 1) * limit;

    // Get filter parameters
    const { type } = req.query;

    // Build query object
    let query = {};
    if (type) {
      query.type = type;
    }

    // Execute queries in parallel for better performance
    const [properties, totalProperties] = await Promise.all([
      Property.find(query)
        .sort({ createdAt: -1 }) // Sort by newest first
        .skip(skip)
        .limit(limit)
        .lean(), // Use lean() for better performance
      Property.countDocuments(query),
    ]);

    // Calculate pagination metadata
    const totalPages = Math.ceil(totalProperties / limit);
    const hasMore = page * limit < totalProperties;

    // Send response
    res.status(200).json({
      properties,
      currentPage: page,
      totalPages,
      totalProperties,
      hasMore,
      resultsPerPage: limit,
    });
  } catch (error) {
    console.error("Error fetching properties:", error);
    res.status(500).json({
      message: "Failed to fetch properties",
      error: error.message,
    });
  }
};

// controllers/propertyController.js
exports.getAllProperties = async (req, res) => {
  console.log("getAllProperties");
  try {
    // Get pagination parameters from query with radix specified
    const page = parseInt(req.query.page, 10) || 1;
    const limit = parseInt(req.query.limit, 10) || 30;
    const skip = (page - 1) * limit;

    // Get filter parameters
    const { type } = req.query;

    // Build query object
    const query = {};
    if (type) {
      query.type = type;
    }

    // Execute queries in parallel for better performance
    const [properties, totalProperties] = await Promise.all([
      ListingProperty.find(query)
        .sort({ createdAt: -1 }) // Sort by newest first
        .skip(skip)
        .limit(limit)
        .lean(), // Use lean() for better performance
      ListingProperty.countDocuments(query),
    ]);

    // Calculate pagination metadata
    const totalPages = Math.ceil(totalProperties / limit);
    const hasMore = page * limit < totalProperties;

    // Send response
    res.status(200).json({
      properties,
      currentPage: page,
      totalPages,
      totalProperties,
      hasMore,
      resultsPerPage: limit,
    });
  } catch (error) {
    console.error("Error fetching properties:", error);
    res.status(500).json({
      message: "Failed to fetch properties",
      error: error.message,
    });
  }
};

exports.getProcessingListingsForAdmin = async (req, res) => {
  try {
    // ---- STATS ----
    const totalListings = await ListingProperty.countDocuments({});
    const totalActiveListings = await ListingProperty.countDocuments({
      status: "active",
    });
    const totalPendingListings = await ListingProperty.countDocuments({
      status: "processing",
    });

    // Count how many listings were created "today"
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0); // midnight of current day
    const listingsToday = await ListingProperty.countDocuments({
      createdAt: { $gte: startOfToday },
    });

    // ---- PAGINATION FOR PROCESSING LISTINGS ----
    const page = parseInt(req.query.page, 10) || 1;
    const limit = parseInt(req.query.limit, 10) || 30;
    const skip = (page - 1) * limit;

    // We want only "processing" listings
    const query = { status: "processing" };

    // Fetch the listing data in parallel
    const [properties, totalProperties] = await Promise.all([
      ListingProperty.find(query)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      ListingProperty.countDocuments(query),
    ]);

    const totalPages = Math.ceil(totalProperties / limit);
    const hasMore = page * limit < totalProperties;

    return res.status(200).json({
      // Stats
      totalListings,
      totalActiveListings,
      totalPendingListings,
      listingsToday,
      // Listings
      properties,
      currentPage: page,
      totalPages,
      totalProperties,
      hasMore,
      resultsPerPage: limit,
    });
  } catch (error) {
    console.error("Error fetching admin listings:", error);
    res.status(500).json({
      message: "Failed to fetch admin listings",
      error: error.message,
    });
  }
};

exports.getFilteredListingsForAdmin = async (req, res) => {
  try {
    // ---- STATS ----
    const totalListings = await ListingProperty.countDocuments({});
    const totalActiveListings = await ListingProperty.countDocuments({
      status: "active",
    });
    const totalPendingListings = await ListingProperty.countDocuments({
      status: "processing",
    });

    // Count how many listings were created "today"
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0); // midnight of current day
    const listingsToday = await ListingProperty.countDocuments({
      createdAt: { $gte: startOfToday },
    });

    // ---- PAGINATION FOR FILTERED LISTINGS ----
    const page = parseInt(req.query.page, 10) || 1;
    const limit = parseInt(req.query.limit, 10) || 30;
    const skip = (page - 1) * limit;

    // Get the status filter from the query
    const statusFilter = req.query.status || "all"; // Default to 'all' if no status is provided
    console.log("Status", statusFilter);

    // Prepare the query based on the status filter
    let query = {};
    if (statusFilter !== "all") {
      query.status = statusFilter; // Only filter by status if it's not 'all'
    }

    // Fetch the listing data in parallel
    const [properties, totalProperties] = await Promise.all([
      ListingProperty.find(query)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      ListingProperty.countDocuments(query),
    ]);

    const totalPages = Math.ceil(totalProperties / limit);
    const hasMore = page * limit < totalProperties;
    console.log(properties);
    return res.status(200).json({
      // Stats
      totalListings,
      totalActiveListings,
      totalPendingListings,
      listingsToday,
      // Listings
      properties,
      currentPage: page,
      totalPages,
      totalProperties,
      hasMore,
      resultsPerPage: limit,
    });
  } catch (error) {
    console.error("Error fetching filtered listings for admin:", error);
    res.status(500).json({
      message: "Failed to fetch filtered listings for admin",
      error: error.message,
    });
  }
};

exports.approveListing = async (req, res) => {
  try {
    console.log("entered in new op");
    const { id } = req.params; // listing ID

    // const property = await ListingProperty.findById(id);
    // const host = await User.findById(property?.host);

    const updatedListing = await ListingProperty.findByIdAndUpdate(
      id,
      { status: "active" },
      { new: true }
    ).populate("host");
    if (!updatedListing) {
      return res.status(404).json({ message: "Listing not found" });
    }

    const hostName =
      updatedListing.host.firstName + " " + updatedListing.host.lastName;
    const params = {
      hostName: hostName,
      propertyId: id,
      propertyTitle: updatedListing.title,
      createdAt: new Date().toLocaleDateString(),
      state: updatedListing.address.state,
      city: updatedListing.address.city,
    };
    const adminEmail = "admin@majesticescape.in";
    await sendEmail(updatedListing.hostEmail, 25, params);
    await sendEmail(adminEmail, 26, params);
    console.log("Approve Listing");
    return res.status(200).json({
      message: "Listing approved successfully",
      listing: updatedListing,
    });
  } catch (error) {
    console.error("Error approving listing:", error);
    return res.status(500).json({
      message: "Failed to approve listing",
      error: error.message,
    });
  }
};

exports.deListing = async (req, res) => {
  try {
    console.log("entered in new op");
    const { id } = req.params; // listing ID

    const property = await ListingProperty.findById(id);
    const host = await User.findById(property?.host);
    console.log("new riv", host);
    const updatedListing = await ListingProperty.findByIdAndUpdate(
      id,
      { status: "inactive" },
      { new: true }
    ).populate("host");
    if (!updatedListing) {
      return res.status(404).json({ message: "Listing not found" });
    }

    const hostName = host?.firstName + " " + host?.lastName;
    const params = {
      hostName: hostName,
      propertyId: updatedListing._id,
      city: updatedListing.address.city,
      state: updatedListing.state,
      delistDate: new Date().toLocaleDateString(),
      hostEmail: updatedListing.hostEmail,
      hostContact: updatedListing.host.phoneNumber,
    };
    const adminEmail = "admin@majesticescape.in";
    await sendEmail(host?.email, 27, params);
    await sendEmail(adminEmail, 28, params);

    return res.status(200).json({
      message: "Listing approved successfully",
      listing: updatedListing,
    });
  } catch (error) {
    console.error("Error approving listing:", error);
    return res.status(500).json({
      message: "Failed to approve listing",
      error: error.message,
    });
  }
};

exports.getPropertyById = async (req, res) => {
  try {
    console.log(req.params.id);
    const property = await ListingProperty.findById(req.params.id).populate(
      "host"
    );
    console.log("si", property);
    if (!property) {
      return res.status(404).json({ message: "Property not found" });
    }
    res.status(200).json({ success: true, data: property });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.getActivePropertyById = async (req, res) => {
  try {
    const hostId = req.params.id;

    const filter = {
      host: hostId,
      status: "active",
    };

    const property = await ListingProperty.find(filter);

    if (!property) {
      return res.status(404).json({ message: "Property not found" });
    }
    res.status(200).json({ success: true, data: property });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};
exports.getAllActiveProperty = async (req, res) => {
  try {
    const hostId = req.params.id;

    const filter = {
      status: "active",
    };

    const property = await ListingProperty.find(filter);

    if (!property) {
      return res.status(404).json({ message: "Property not found" });
    }
    res.status(200).json({ success: true, data: property });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.getFilterActivePropertyById = async (req, res) => {
  try {
    const hostId = req.params.id;
    const { search, placeType, propertyType } = req.query;
    console.log("nand", search);
    const filter = {
      host: hostId,
      status: "active",
    };

    if (placeType && placeType != "all") {
      filter.placeType = placeType;
    }
    if (propertyType && propertyType != "all") {
      filter.propertyType = propertyType;
    }

    let property = await ListingProperty.find(filter).populate("host");

    if (!property) {
      return res.status(404).json({ message: "Property not found" });
    }
    console.log("abc", property);
    if (search) {
      const s = search.toLowerCase();
      property = property.filter(
        (b) =>
          b.title?.toLowerCase().includes(s) ||
          b.address?.district?.toLowerCase().includes(s) ||
          b.address?.city?.toLowerCase().includes(s) ||
          b.address?.state?.toLowerCase().includes(s) ||
          b.address?.pincode?.toLowerCase().includes(s)
      );
    }
    res.status(200).json({ success: true, data: property });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};
exports.createProperty = async (req, res) => {
  try {
    const property = new Property(req.body);
    const savedProperty = await property.save();
    res.status(201).json(savedProperty);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
};

exports.updateProperty = async (req, res) => {
  try {
    const property = await Property.findByIdAndUpdate(req.params.id, req.body, {
      new: true,
    });
    if (!property) {
      return res.status(404).json({ message: "Property not found" });
    }
    res.status(200).json(property);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
};

exports.deleteProperty = async (req, res) => {
  try {
    const { id } = req.params; // listing ID

    // const propertyData = await ListingProperty.findById(id);
    // const host = await User.findById(propertyData?.host);

    const property = await ListingProperty.findByIdAndDelete(
      req.params.id
    ).populate("host");
    if (!property) {
      console.log("deleteProperty", "No property found");

      return res.status(404).json({ message: "Property not found" });
    }

    const hostName = changeToUpperCase(
      property.host.firstName + " " + property.host.lastName
    );
    const params = {
      hostName: hostName,
      propertyId: property._id,
      propertyTitle: property.title,
      city: property.address.city,
      state: property.address.state,
      deleteDate: new Date().toLocaleDateString(),
    };
    const adminEmail = "admin@majesticescape.in";
    await sendEmail(host.email, 29, params);
    await sendEmail(adminEmail, 44, params);

    const hostId = await res
      .status(200)
      .json({ message: "Property deleted successfully" });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.deleteHostProperty = async (req, res) => {
  try {
    const { id } = req.params; // listing ID

    const propertyData = await ListingProperty.findById(id);
    const host = await User.findById(propertyData?.host);

    const property = await ListingProperty.findByIdAndDelete(req.params.id);
    if (!property) {
      console.log("deleteProperty", "No property found");

      return res.status(404).json({ message: "Property not found" });
    }

    const hostName = host?.firstName + " " + host?.lastName;
    const params = { hostName: hostName };
    const adminEmail = "admin@majesticescape.in";
    await sendEmail(host.email, 29, params);
    await sendEmail(adminEmail, 44, params);

    const hostId = await res
      .status(200)
      .json({ message: "Property deleted successfully" });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.createListingProperty = async (req, res) => {
  try {
    const { ...propertyData } = req.body;
    const user = await User.findOne({ email: req.body.hostEmail });
    console.log("xmennn", propertyData);

    if (!user) {
      return res.status(404).json({ message: "Host not found" });
    }

    const property = new ListingProperty({
      ...propertyData,
      // _id: new mongoose.Types.ObjectId(),
      host: user._id,
      status: "incomplete",
    });

    await property.save();
    console.log(property);
    res.status(201).json(property);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
};

exports.updateListingProperty = async (req, res) => {
  try {
    const { id } = req.params;
    const user = await User.findOne({ email: req.body.hostEmail });
    if (!user) {
      return res.status(404).json({ message: "Host not found" });
    }
    console.log("jjj", req.body._id);

    const property = await ListingProperty.findOneAndUpdate(
      { _id: id, host: user._id },
      { $set: req.body },
      { new: true, runValidators: true }
    );

    if (!property) {
      return res
        .status(404)
        .json({ message: "Property not found or unauthorized to update" });
    }

    res.status(200).json(property);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
};

exports.updateKycProperty = async (req, res) => {
  try {
    const { id } = req.params;
    console.log("enre", id);
    const property = await ListingProperty.updateMany(
      { host: id },
      { $set: { kycStatus: "completed" } }
    );

    if (!property) {
      return res
        .status(404)
        .json({ message: "Property not found or unauthorized to update" });
    }

    res.status(200).json(property);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
};
exports.getUserPropertyListings = async (req, res) => {
  const { userEmail } = req.params;
  console.log("userEmail", userEmail);
  const { page = 1, limit = 10 } = req.query;

  try {
    const skip = (parseInt(page) - 1) * parseInt(limit);

    const query = { hostEmail: userEmail };
    const [listings, totalListings] = await Promise.all([
      ListingProperty.find(query)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(parseInt(limit))
        .populate("host", "firstName lastName email"),
      ListingProperty.countDocuments(query),
    ]);

    const totalPages = Math.ceil(totalListings / parseInt(limit));

    const response = {
      listings,
      currentPage: parseInt(page),
      totalPages,
      totalListings,
      hasNextPage: parseInt(page) < totalPages,
      hasPrevPage: parseInt(page) > 1,
    };

    res.status(200).json(response);
  } catch (error) {
    console.error("Error fetching user property listings:", error);
    res.status(500).json({
      message: "Error fetching property listings",
      error: error.message,
    });
  }
};

exports.getPropertyListings = async (req, res) => {
  console.log("getPropertyListings");
  const { page = 1, limit = 10 } = req.query;

  try {
    const skip = (parseInt(page) - 1) * parseInt(limit);

    const [listings, totalListings] = await Promise.all([
      ListingProperty.find()
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(parseInt(limit)),
      ListingProperty.countDocuments(),
    ]);

    const totalPages = Math.ceil(totalListings / parseInt(limit));

    const response = {
      listings,
      currentPage: parseInt(page),
      totalPages,
      totalListings,
      hasNextPage: parseInt(page) < totalPages,
      hasPrevPage: parseInt(page) > 1,
    };

    res.status(200).json(response);
  } catch (error) {
    console.error("Error fetching user property listings:", error);
    res.status(500).json({
      message: "Error fetching property listings",
      error: error.message,
    });
  }
};

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
const BankDetail = require("../models/BankDetail");
const agenda = require("../utils/agenda");
const adminEmail = process.env.ADMIN_EMAIL.split(",");
const kycHostForm = require("../models/KycHostForm");
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

//     process.env.ENV === 'dev' && if (process.env.NEXT_PUBLIC_ENV === "dev") {
//   console.log("big big", propertyType);
// }
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
      page = 1,
      limit = 16,
    } = req.query;

    const skip = (Number(page) - 1) * Number(limit);
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

    if (process.env.NEXT_PUBLIC_ENV === "dev") {
      console.log("amenities", filter);
    }
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
    // const totalCount = await ListingProperty.countDocuments(filter);
    // // 4. Find properties based on the built filter
    // const availableProperties = await ListingProperty.find(filter)
    //   .skip(skip)
    //   .limit(limit);

    // 5. Handle location filtering (if provided) - using JavaScript filter for more complex matching
    // let filteredProperties = availableProperties;

    // if (location && location !== "null" && location !== "undefined") {
    //   filteredProperties = availableProperties.filter((property) => {
    //     const propertyLocation = property.address || {};
    //     return (
    //       (propertyLocation.title &&
    //         propertyLocation.district
    //           .toLowerCase()
    //           .replace(/\s+/g, "")
    //           .trim()
    //           .includes(location.toLowerCase())
    //           .replace(/\s+/g, "")
    //           .trim()) ||
    //       (propertyLocation.city &&
    //         propertyLocation.city
    //           .toLowerCase()
    //           .replace(/\s+/g, "")
    //           .trim()
    //           .includes(location.toLowerCase().replace(/\s+/g, "").trim())) ||
    //       (propertyLocation.state &&
    //         propertyLocation.state
    //           .toLowerCase()
    //           .replace(/\s+/g, "")
    //           .trim()
    //           .includes(location.toLowerCase().replace(/\s+/g, "").trim())) ||
    //       (propertyLocation.district &&
    //         propertyLocation.district
    //           .toLowerCase()
    //           .replace(/\s+/g, "")
    //           .trim()
    //           .includes(location.toLowerCase().replace(/\s+/g, "").trim()))
    //     );
    //   });
    // }
    if (location && location !== "null" && location !== "undefined") {
      filter.$or = [
        { "address.district": { $regex: location, $options: "i" } },
        { "address.city": { $regex: location, $options: "i" } },
        { "address.state": { $regex: location, $options: "i" } },
      ];
    }
    const totalCount = await ListingProperty.countDocuments(filter);

    const availableProperties = await ListingProperty.find(filter)
      .skip(skip)
      .limit(limit);

    res.json({
      data: availableProperties,
      pagination: {
        totalCount,
        totalPages: Math.ceil(totalCount / limit),
      },
    });

    // res.status(200).json({
    //   success: true,
    //   data: filteredProperties,
    //   pagination: {
    //     totalCount: totalCount,
    //     page: Number(page),
    //     limit: Number(limit),
    //     totalPages: Math.ceil(totalCount / limit),
    //   },
    //   filtersApplied: {
    //     location: !!location,
    //     dates: !!(from && to),
    //     guests: !!guests,
    //     propertyType: !!propertyType,
    //   },
    // });
  } catch (error) {
    console.error("Search error:", error);
    res.status(400).json({
      success: false,
      error: error.message,
    });
  }
};

// exports.getAdminFilter = async (req, res) => {
//   try {
//     const { search, hostId } = req.query;

//     const filter = { status: "active" };
//     const limit = req.query.limit || 10;
//     const skip = req.query.skip || 0;
//     if (hostId && hostId.toLowerCase() != "all") {
//       filter.host = new mongoose.Types.ObjectId(hostId);
//     }
//     let user = await User.findById(hostId).limit(limit).skip(skip);
//     if (!user) {
//       return res
//         .status(404)
//         .json({ success: false, message: "Could not find the user" });
//     }
//     if (search) {
//       const s = search.toLowerCase();
//       user = user.filter(
//         (b) =>
//           b.phoneNumber?.toLowerCase().includes(s) ||
//           `${b.firstName} ${b.lastName}`.toLowerCase().includes(s)
//       );
//     }

//     res.json({ success: true, data: user });
//   } catch (error) {
//     console.error("Search error:", error);
//     res.status(400).json({
//       success: false,
//       error: error.message,
//     });
//   }
// };

exports.getAdminFilter = async (req, res) => {
  try {
    const { search } = req.query;

    // const limit = parseInt(req.query.limit, 10) || 10;
    // const skip = parseInt(req.query.skip, 10) || 0;
    const page = parseInt(req.query.page, 10) || 1;
    const limit = parseInt(req.query.limit, 10) || 10;
    const skip = (page - 1) * limit;
    const pipeline = [
      // 1️⃣ Lookup ACTIVE properties
      {
        $lookup: {
          from: "listingproperties",
          let: { userId: "$_id" },
          pipeline: [
            {
              $match: {
                $expr: {
                  $and: [{ $eq: ["$host", "$$userId"] }],
                },
              },
            },
          ],
          as: "allProperties",
        },
      },
      {
        $lookup: {
          from: "listingproperties",
          let: { userId: "$_id" },
          pipeline: [
            {
              $match: {
                $expr: {
                  $and: [
                    { $eq: ["$host", "$$userId"] },
                    { $eq: ["$status", "active"] },
                  ],
                },
              },
            },
          ],
          as: "activeProperties",
        },
      },
      {
        $lookup: {
          from: "listingproperties",
          let: { userId: "$_id" },
          pipeline: [
            {
              $match: {
                $expr: {
                  $and: [
                    { $eq: ["$host", "$$userId"] },
                    { $eq: ["$status", "inactive"] },
                  ],
                },
              },
            },
          ],
          as: "inactiveProperties",
        },
      },

      // 2️⃣ Lookup KYC documents
      {
        $lookup: {
          from: "kychostdatas",
          localField: "_id",
          foreignField: "hostId",
          as: "kycDocs",
        },
      },
      {
        $lookup: {
          from: "kychostdatas",
          localField: "_id",
          foreignField: "hostId",
          as: "kycDetails",
        },
      },

      // 3️⃣ Count both
      {
        $addFields: {
          allPropertyCount: { $size: "$allProperties" },
          activePropertyCount: { $size: "$activeProperties" },
          inactivePropertyCount: { $size: "$inactiveProperties" },
          kycDocCount: { $size: "$kycDocs" },
        },
      },

      // 4️⃣ OR CONDITION (IMPORTANT PART)
      {
        $match: {
          $or: [
            { allPropertyCount: { $gte: 1 } },
            { kycDocCount: { $gte: 1 } },
          ],
        },
      },

      // 5️⃣ Split results
      {
        $facet: {
          // 🔹 A) Filtered + paginated users
          data: [
            ...(search
              ? [
                  {
                    $match: {
                      $or: [
                        { email: { $regex: search, $options: "i" } },
                        { firstName: { $regex: search, $options: "i" } },
                        { lastName: { $regex: search, $options: "i" } },
                        {
                          $expr: {
                            $regexMatch: {
                              input: {
                                $concat: ["$firstName", " ", "$lastName"],
                              },
                              regex: search,
                              options: "i",
                            },
                          },
                        },
                      ],
                    },
                  },
                ]
              : []),
            { $skip: skip },
            { $limit: limit },
            {
              $project: {
                password: 0,
                allProperties: 0,
                activeProperties: 0,
                inactiveProperties: 0,
                kycDocs: 0,
              },
            },
          ],

          // 🔹 B) GLOBAL email list (constant)
          allEligibleHostEmails: [
            {
              $project: {
                _id: 0,
                email: 1,
              },
            },
          ],

          // 🔹 C) Total count AFTER OR condition + search
          filteredCount: [{ $count: "count" }],
          // propertyStats: [
          //   {
          //     $group: {
          //       _id: null,
          //       totalProperties: { $sum: "$totalPropertyCount" },
          //       totalActiveProperties: { $sum: "$activePropertyCount" },
          //     },
          //   },
          // ],
        },
      },
    ];

    const result = await User.aggregate(pipeline);

    const totalHost = result[0].filteredCount[0]?.count || 0;

    const totalPages = Math.ceil(totalHost / limit);
    res.json({
      success: true,
      data: result[0].data,
      totalPages,
      resultsPerPage: limit,

      total: totalHost,

      allEligibleHostEmails: result[0].allEligibleHostEmails.map(
        (u) => u.email
      ),
    });
  } catch (error) {
    console.error("Search error:", error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
};

exports.timing = async (req, res) => {
  try {
    const { checkinTime, checkoutTime, propertyId } = req.body;

    if (process.env.NEXT_PUBLIC_ENV === "dev") {
      console.log("db", propertyId, checkinTime, checkoutTime);
    }
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

exports.getTiming = async (req, res) => {
  try {
    if (process.env.NEXT_PUBLIC_ENV === "dev") {
      console.log("enetered the gettim");
    }
    const { propertyId } = req.params;

    if (process.env.NEXT_PUBLIC_ENV === "dev") {
      console.log("propertyId:", propertyId);
    }
    if (!propertyId || propertyId === "undefined") {
      return res
        .status(400)
        .json({ success: false, message: "propertyId missing" });
    }
    if (!mongoose.Types.ObjectId.isValid(propertyId)) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid propertyId" });
    }
    const property = await ListingProperty.findById(propertyId);
    if (!property) {
      return res
        .status(404)
        .json({ success: false, message: "Property not found" });
    }
    if (process.env.NEXT_PUBLIC_ENV === "dev") {
      console.log("dsajhjkhdsjkhdajhsdjhaj");
    }
    res.status(200).json({ success: true, data: property });
  } catch (error) {
    res.status(500).json({
      message: "Failed to fetch properties time",
      error: error.message,
    });
  }
};
exports.getFrontPageAllStays = async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 16;
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
exports.getAllStays = async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 16;
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
    const hostId = req.params.id;
    const filter = { status: "active", host: hostId };
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
  if (process.env.NEXT_PUBLIC_ENV === "dev") {
    console.log("getAllProperties");
  }
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

// exports.getFilteredListingsForAdmin = async (req, res) => {
//   try {
//     // ---- STATS ----
//     const totalListings = await ListingProperty.countDocuments({});
//     const totalActiveListings = await ListingProperty.countDocuments({
//       status: "active",
//     });
//     const totalPendingListings = await ListingProperty.countDocuments({
//       status: "processing",
//     });

//     // Count how many listings were created "today"
//     const startOfToday = new Date();
//     startOfToday.setHours(0, 0, 0, 0); // midnight of current day
//     const listingsToday = await ListingProperty.countDocuments({
//       createdAt: { $gte: startOfToday },
//     });

//     // ---- PAGINATION FOR FILTERED LISTINGS ----
//     const page = parseInt(req.query.page, 10) || 1;
//     const limit = parseInt(req.query.limit, 10) || 30;
//     const skip = (page - 1) * limit;

//     // Get the status filter from the query
//     const statusFilter = req.query.status || "all"; // Default to 'all' if no status is provided
//     if (process.env.NEXT_PUBLIC_ENV === "dev") {
//       console.log("Status", statusFilter);
//     }

//     // Prepare the query based on the status filter
//     let query = {};
//     if (statusFilter !== "all") {
//       query.status = statusFilter; // Only filter by status if it's not 'all'
//     }

//     // Fetch the listing data in parallel
//     const [properties, totalProperties] = await Promise.all([
//       ListingProperty.find(query)
//         .populate("host")
//         .sort({ updatedAt: -1 })
//         .skip(skip)
//         .limit(limit)
//         .lean(),
//       ListingProperty.countDocuments(query),
//     ]);

//     const totalPages = Math.ceil(totalProperties / limit);
//     const hasMore = page * limit < totalProperties;
//     if (process.env.NEXT_PUBLIC_ENV === "dev") {
//       console.log(properties);
//     }
//     return res.status(200).json({
//       // Stats
//       totalListings,
//       totalActiveListings,
//       totalPendingListings,
//       listingsToday,
//       // Listings
//       properties,
//       currentPage: page,
//       totalPages,
//       totalProperties,
//       hasMore,
//       resultsPerPage: limit,
//     });
//   } catch (error) {
//     console.error("Error fetching filtered listings for admin:", error);
//     res.status(500).json({
//       message: "Failed to fetch filtered listings for admin",
//       error: error.message,
//     });
//   }
// };

exports.getFilteredListingsForAdmin = async (req, res) => {
  try {
    const { search, status } = req.query;

    const page = parseInt(req.query.page, 10) || 1;
    const limit = parseInt(req.query.limit, 10) || 30;
    const skip = (page - 1) * limit;

    const matchStage = {};

    if (status) {
      if (status !== "all") {
        matchStage.status = status;
      } else {
        matchStage.status = { $nin: ["incomplete"] };
      }
    }

    if (search && search.toLowerCase().trim() != "") {
      matchStage.$or = [
        { title: { $regex: search, $options: "i" } },
        // { placeType: { $regex: search, $options: "i" } },
        {
          $expr: {
            $regexMatch: {
              input: { $ifNull: ["$host.email", ""] },
              regex: search,
              options: "i",
            },
          },
        },
      ];
    }

    const pipeline = [
      {
        $lookup: {
          from: "users",
          localField: "host",
          foreignField: "_id",
          as: "host",
        },
      },
      { $unwind: { path: "$host", preserveNullAndEmptyArrays: true } },
      {
        $facet: {
          /* ---------- FILTERED DATA ---------- */
          data: [
            { $match: matchStage },
            { $sort: { updatedAt: -1 } },
            { $skip: skip },
            { $limit: limit },
          ],

          /* ---------- PAGINATION COUNT (FILTERED) ---------- */
          totalFilteredCount: [{ $match: matchStage }, { $count: "count" }],

          /* ---------- GLOBAL STATS (UNFILTERED) ---------- */
          stats: [
            {
              $group: {
                _id: null,
                totalList: {
                  $sum: {
                    $cond: [{ $ne: ["$status", "incomplete"] }, 1, 0],
                  },
                },
                totalActive: {
                  $sum: {
                    $cond: [{ $eq: ["$status", "active"] }, 1, 0],
                  },
                },
                totalProcessing: {
                  $sum: {
                    $cond: [{ $eq: ["$status", "processing"] }, 1, 0],
                  },
                },
              },
            },
          ],
        },
      },
    ];

    const [result] = await ListingProperty.aggregate(pipeline);

    const properties = result.data;

    const totalProperties = result.totalFilteredCount[0]?.count || 0;

    const totalPages = Math.ceil(totalProperties / limit);
    const hasMore = page < totalPages;
    const stats = result.stats[0] || {
      totalActive: 0,
      totalProcessing: 0,
      totalList: 0,
    };
    return res.status(200).json({
      properties,
      currentPage: page,
      totalPages,
      totalProperties,
      hasMore,
      resultsPerPage: limit,
      totalActiveListings: stats.totalActive,
      totalProcessingListings: stats.totalProcessing,
      totalList: stats.totalList,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({
      message: "Failed to fetch filtered listings for admin",
      error: error.message,
    });
  }
};

exports.approveListing = async (req, res) => {
  try {
    if (process.env.NEXT_PUBLIC_ENV === "dev") {
      console.log("entered in new op");
    }
    const { id } = req.params; // listing ID

    // const property = await ListingProperty.findById(id);
    // const host = await User.findById(property?.host);
    // let updatedListing = await ListingProperty.findById(id).populate("host");

    // if (updatedListing.delist == "host") {
    //   return res.status(200).json({
    //     message: "Listing approved successfully",
    //     data: "hostDelist",
    //   });
    // }
    // updatedListing.status = "active";

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
      hostEmail: updatedListing.hostEmail,
      propertyTitle: updatedListing.title,
      createdAt: new Date().toLocaleDateString(),
      updatedAt: new Date().toLocaleDateString(),
      state: updatedListing.address.state,
      city: updatedListing.address.city,
    };

    if (updatedListing.delist == "admin") {
      await Promise.all(
        adminEmail.map((email) => sendEmail(email.trim(), 48, params))
      );
      await sendEmail(params.hostEmail, 49, params);
    } else {
      await sendEmail(params.hostEmail, 25, params);

      await Promise.all(
        adminEmail.map((email) => sendEmail(email.trim(), 26, params))
      );
    }
    if (process.env.NEXT_PUBLIC_ENV === "dev") {
      console.log("Approve Listing");
    }
    return res.status(200).json({
      message: "Listing approved successfully",
      data: updatedListing,
    });
  } catch (error) {
    console.error("Error approving listing:", error);
    return res.status(500).json({
      message: "Failed to approve listing",
      error: error.message,
    });
  }
};
exports.reactivate = async (req, res) => {
  try {
    if (process.env.NEXT_PUBLIC_ENV === "dev") {
      console.log("entered in new op");
    }
    const { id } = req.params; // listing ID

    // const property = await ListingProperty.findById(id);
    // const host = await User.findById(property?.host);
    let updatedListing = await ListingProperty.findById(id).populate("host");
    if (!updatedListing) {
      return res.status(404).json({ message: "Listing not found" });
    }
    if (updatedListing.delist == "admin") {
      return res.status(200).json({
        message: "Listing reactivation failed",
        listing: "adminDelist",
      });
    }
    // const updatedListing = await ListingProperty.findByIdAndUpdate(
    //   id,
    //   { status: "active", delist: "host" },
    //   { new: true }
    // ).populate("host");
    // if (!updatedListing) {
    //   return res.status(404).json({ message: "Listing not found" });
    // }
    updatedListing.status = "active";
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

    // await sendEmail(updatedListing.hostEmail, 25, params);
    // await sendEmail(adminEmail, 26, params);

    return res.status(200).json({
      message: "Listing reactivated successfully",
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
    if (process.env.NEXT_PUBLIC_ENV === "dev") {
      console.log("entered in new op");
    }
    const { id } = req.params; // listing ID
    const { hostSide } = req.query;

    if (hostSide && hostSide == "true") {
      const updatedListing = await ListingProperty.findByIdAndUpdate(
        id,
        { status: "inactive" },
        { new: true }
      ).populate("host");
      if (!updatedListing) {
        return res.status(404).json({ message: "Listing not found" });
      }

      const hostName =
        updatedListing.host.firstName + " " + updatedListing.host.lastName;
      const params = {
        hostName: hostName,
        propertyId: updatedListing._id,
        city: updatedListing.address.city,
        state: updatedListing.state,
        delistDate: new Date().toLocaleDateString(),
        hostEmail: updatedListing.hostEmail,
        hostContact: updatedListing.host.phoneNumber,
      };

      await sendEmail(params.hostEmail, 29, params);

      await Promise.all(
        adminEmail.map((email) => sendEmail(email.trim(), 49, params))
      );
      return res.status(200).json({
        sucess: true,
        message: "Listing delisted successfully",
        listing: updatedListing,
      });
    } else {
      const updatedListing = await ListingProperty.findByIdAndUpdate(
        id,
        { status: "inactive", delist: "admin" },
        { new: true }
      ).populate("host");
      if (!updatedListing) {
        return res.status(404).json({ message: "Listing not found" });
      }

      const hostName =
        updatedListing.host.firstName + " " + updatedListing.host.lastName;
      const params = {
        hostName: hostName,
        propertyId: updatedListing._id,
        city: updatedListing.address.city,
        state: updatedListing.state,
        delistDate: new Date().toLocaleDateString(),
        hostEmail: updatedListing.hostEmail,
        hostContact: updatedListing.host.phoneNumber,
      };
      await sendEmail(params.hostEmail, 27, params);
      await sendEmail(adminEmail, 28, params);
      return res.status(200).json({
        sucess: true,
        message: "Listing delisted successfully",
        data: updatedListing,
      });
    }
  } catch (error) {
    console.error("Error approving delisting:", error);
    return res.status(500).json({
      message: "Failed to approve delisting",
      error: error.message,
    });
  }
};

exports.getPropertyById = async (req, res) => {
  try {
    if (process.env.NEXT_PUBLIC_ENV === "dev") {
      console.log(req.params.id);
    }
    const property = await ListingProperty.findById(req.params.id).populate({
      path: "host",
      model: "User",
      select:
        "firstName lastName languages profilePicture address dob about averageRating reviewCount avgPropertyRating propertyReviewCount",
    });
    if (process.env.NEXT_PUBLIC_ENV === "dev") {
      console.log("si", property);
    }
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

// exports.getFilterActivePropertyById = async (req, res) => {
//   try {
//     const hostId = req.params.id;
//     const { search, placeType, propertyType } = req.query;
//     if (process.env.NEXT_PUBLIC_ENV === "dev") {
//       console.log("nand", search);
//     }
//     const filter = {
//       host: hostId,
//       status: "active",
//     };

//     if (placeType && placeType != "all") {
//       filter.placeType = placeType;
//     }
//     if (propertyType && propertyType != "all") {
//       filter.propertyType = propertyType;
//     }

//     let property = await ListingProperty.find(filter).populate("host");

//     if (!property) {
//       return res.status(404).json({ message: "Property not found" });
//     }
//     if (process.env.NEXT_PUBLIC_ENV === "dev") {
//       console.log("abc", property);
//     }
//     if (search) {
//       const s = search.toLowerCase();
//       property = property.filter(
//         (b) =>
//           b.title?.toLowerCase().includes(s) ||
//           b.address?.district?.toLowerCase().includes(s) ||
//           b.address?.city?.toLowerCase().includes(s) ||
//           b.address?.state?.toLowerCase().includes(s) ||
//           b.address?.pincode?.toLowerCase().includes(s)
//       );
//     }
//     res.status(200).json({ success: true, data: property });
//   } catch (error) {
//     res.status(500).json({ message: error.message });
//   }
// };

exports.getFilterActivePropertyById = async (req, res) => {
  try {
    const hostId = new mongoose.Types.ObjectId(req.params.id);
    const { search, placeType, propertyType } = req.query;

    const page = parseInt(req.query.page, 10) || 1;
    const limit = parseInt(req.query.limit, 10) || 10;
    const skip = (page - 1) * limit;
    // Execute all database queries in parallel for better performance
    const [hostDetails, kycDetails, total, active, inactive, properties] =
      await Promise.all([
        // 1. Fetch host details from User table
        User.findOne(
          { _id: hostId },
          { password: 0 } // Exclude sensitive fields
        ),

        // 2. Fetch all KYC data from KycHostData table
        kycHostForm.find({ hostId: hostId }, { __v: 0 }),
        ListingProperty.countDocuments({
          host: hostId,
          status: { $in: ["active", "inactive"] },
        }),
        ListingProperty.countDocuments({
          host: hostId,
          status: { $in: ["active"] },
        }),
        ListingProperty.countDocuments({
          host: hostId,
          status: { $in: ["inactive"] },
        }),
        // 3. Fetch properties with filters
        (async () => {
          // Build property filter
          const propertyFilter = {
            host: hostId,
            status: { $in: ["active", "inactive"] },
          };

          // Apply optional filters
          if (placeType && placeType !== "all") {
            propertyFilter.placeType = placeType;
          }

          if (propertyType && propertyType !== "all") {
            propertyFilter.propertyType = propertyType;
          }

          // Build search filter if provided
          let searchFilter = {};
          if (search) {
            const regex = new RegExp(search, "i");
            searchFilter = {
              $or: [
                { title: regex },
                { "address.district": regex },
                { "address.city": regex },
                { "address.state": regex },
                { "address.pincode": regex },
              ],
            };
          }

          // Combine filters
          const finalFilter = {
            ...propertyFilter,
            ...(Object.keys(searchFilter).length > 0 && searchFilter),
          };

          return await ListingProperty.find(finalFilter)
            .limit(limit)
            .skip(skip)
            .populate({
              path: "host",
              select: "-password",
            })
            .lean();
        })(),
      ]);

    // Validate host exists
    if (!hostDetails) {
      return res.status(404).json({
        success: false,
        message: "Host not found",
      });
    }

    const totalPages = Math.ceil(total / limit);

    res.status(200).json({
      success: true,
      totalPages,
      resultsPerPage: limit,
      hostProfile: hostDetails,
      kycData: kycDetails,
      properties: properties,
      stats: {
        totalProperties: total,
        activeProperties: active,
        inactiveProperties: inactive,
        kycCount: kycDetails.length,
      },
    });
  } catch (error) {
    console.error("Error in getFilterActivePropertyById:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch host data",
      error: error.message,
    });
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

// exports.deleteProperty = async (req, res) => {
//   try {
//     const { id } = req.params; // listing ID

//     // const propertyData = await ListingProperty.findById(id);
//     // const host = await User.findById(propertyData?.host);

//     const property = await ListingProperty.findByIdAndDelete(
//       req.params.id
//     ).populate("host");
//     if (!property) {
//       process.env.ENV === 'dev' && if (process.env.NEXT_PUBLIC_ENV === "dev") {
//   console.log("deleteProperty", "No property found");
// }

//       return res.status(404).json({ message: "Property not found" });
//     }

//     const hostName = changeToUpperCase(
//       property.host.firstName + " " + property.host.lastName
//     );
//     const params = {
//       hostName: hostName,
//       propertyId: property._id,
//       propertyTitle: property.title,
//       city: property.address.city,
//       state: property.address.state,
//       deleteDate: new Date().toLocaleDateString(),
//     };
//     const adminEmail = "admin@majesticescape.in";
//     await sendEmail(host.email, 29, params);
//     await sendEmail(adminEmail, 44, params);

//     const hostId = await res
//       .status(200)
//       .json({ message: "Property deleted successfully" });
//   } catch (error) {
//     res.status(500).json({ message: error.message });
//   }
// };

// exports.deleteHostProperty = async (req, res) => {
//   try {
//     const { id } = req.params; // listing ID

//     const propertyData = await ListingProperty.findById(id);
//     const host = await User.findById(propertyData?.host);

//     const property = await ListingProperty.findByIdAndDelete(req.params.id);
//     if (!property) {
//       process.env.ENV === 'dev' && if (process.env.NEXT_PUBLIC_ENV === "dev") {
//   console.log("deleteProperty", "No property found");
// }

//       return res.status(404).json({ message: "Property not found" });
//     }

//     const hostName = host?.firstName + " " + host?.lastName;
//     const params = { hostName: hostName };
//     const adminEmail = "admin@majesticescape.in";
//     await sendEmail(host.email, 29, params);
//     await sendEmail(adminEmail, 44, params);

//     const hostId = await res
//       .status(200)
//       .json({ message: "Property deleted successfully" });
//   } catch (error) {
//     res.status(500).json({ message: error.message });
//   }
// };

exports.createListingProperty = async (req, res) => {
  try {
    const { ...propertyData } = req.body;
    const user = await User.findOne({ email: req.body.hostEmail });
    if (process.env.NEXT_PUBLIC_ENV === "dev") {
      console.log("xmennn", propertyData);
    }

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
    if (process.env.NEXT_PUBLIC_ENV === "dev") {
      console.log(property);
    }
    res.status(201).json(property);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
};

exports.updateListingProperty = async (req, res) => {
  try {
    const { id } = req.params;
    const { submit, status } = req.query;
    // const user = await User.findOne({ email: req.body.hostEmail });
    // if (!user) {
    //   return res.status(404).json({ message: "Host not found" });
    // }
    // if (process.env.NEXT_PUBLIC_ENV === "dev") {
    //   console.log("jjj", req.body._id);
    // }

    const property = await ListingProperty.findOneAndUpdate(
      { _id: id },
      { $set: req.body },
      { new: true, runValidators: true }
    ).populate("host");

    if (!property) {
      return res
        .status(404)
        .json({ message: "Property not found or unauthorized to update" });
    }
    if (property.host.kyc === true) {
      property.kycStatus = "completed";
      await property.save();
    }
    if (property.host.bank === true) {
      property.bankDetails = true;
      await property.save();
    }
    const host = property.host.firstName + " " + property.host.lastName;
    const params = {
      hostName: host,
      propertyTitle: property.title,
      city: property.address.city,
      state: property.address.state,
      propertyId: property._id,
      createdAt: new Date(property.createdAt).toLocaleDateString(),
      updatedAt: new Date(property.updatedAt).toLocaleDateString(),
    };

    if (submit) {
      if (status == "active") {
        await Promise.all(
          adminEmail.map((email) => sendEmail(email.trim(), 51, params))
        );
      } else {
        await Promise.all(
          adminEmail.map((email) => sendEmail(email.trim(), 50, params))
        );
      }
    }

    const hostEmail = property.hostEmail;
    const newStatus = property.status;
    if (status == "inactive") {
      await agenda
        .create("sendPropertyReminderEmail", {
          newStatus,
          hostEmail,
          host,
          propertyId: property._id.toString(),
        })
        .unique({
          name: "sendPropertyReminderEmail",
          "data.propertyId": property._id.toString(),
        })
        .schedule("24 hours")
        .save();
    }
    // await agenda.schedule(`24 hours`, "sendPropertyReminderEmail", {
    //   status,
    //   hostEmail,
    //   host,
    // });
    res.status(200).json(property);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
};

exports.updateKycProperty = async (req, res) => {
  try {
    const { id } = req.params;
    if (process.env.NEXT_PUBLIC_ENV === "dev") {
      console.log("enre", id);
    }
    const property = await ListingProperty.updateMany(
      { host: id },
      { $set: { kycStatus: "completed" } }
    ).populate("host");

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
  if (process.env.NEXT_PUBLIC_ENV === "dev") {
    console.log("userEmail", userEmail);
  }
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
  if (process.env.NEXT_PUBLIC_ENV === "dev") {
    console.log("getPropertyListings");
  }
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

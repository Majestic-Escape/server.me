const Property = require("../models/Property");
const ListingProperty = require("../models/ListingProperty");
const { parseListQuery, listMeta, pageStages, searchRegex } = require("../utils/listQuery");
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
const {
  sanitizeProperty,
  sanitizeProperties,
  SAFE_HOST_SELECT,
} = require("../utils/sanitizeResponse");
// Batch P — public catalogue: card projection, edge-cache policy, change
// notifications and the authoritative night ledger for date searches.
const BookingNight = require("../models/BookingNight");
const { catalogueCache } = require("../utils/httpCache");
const { CARD_PROJECTION, pageParams } = require("../utils/listingProjection");
const { checkListingWrite, refusePublicText, LISTING_TEXT_SELECT, checkListingImages, refuseImages } = require("../utils/publicTextPolicy");
const { notifyListingChanged } = require("../services/listingChanged");
const authz = require("../middleware/authz");
// Place-aware search (docs/place-search.md).
const places = require("../utils/places");
const placeSearch = require("../services/placeSearch");
const { parseSearchQuery, refuseSearchParam, SearchParamError } = require("../utils/searchParams");

// Host listing writes were `$set: req.body`: a host could activate their own
// listing (no admin review), mark it KYC-complete / bank-verified, unban it,
// forge its rating or hand it to another host. These fields belong to the
// server, the admin or the host's KYC — never to the wizard's PUT body.
const HOST_IMMUTABLE_LISTING_FIELDS = [
  "_id",
  "id",
  "host",
  "hostEmail",
  "kycStatus",
  "bankDetails",
  "validRegistrationNo",
  "ban",
  "badge",
  "averageRating",
  "reviewCount",
  "embedding",
  "embeddingUpdatedAt",
  "embeddingVersion",
  "createdAt",
  "updatedAt",
  "__v",
];
// A host may leave the status alone, park a draft ("incomplete") or submit
// it for review ("processing"). Activation is the admin's decision and
// delisting / relisting have their own routes.
const HOST_SETTABLE_STATUSES = ["incomplete", "processing"];

function stripHostImmutableFields(body) {
  const patch = { ...(body || {}) };
  for (const field of HOST_IMMUTABLE_LISTING_FIELDS) delete patch[field];
  return patch;
}
// Host fields the approve / delist / update handlers read for their emails
// and responses — never the whole user document.
const HOST_CONTACT_SELECT = "firstName lastName phoneNumber kyc bank";

exports.getCustomSearch = async (req, res) => {
  let params;
  try {
    params = parseSearchQuery(req.query);
  } catch (error) {
    if (error instanceof SearchParamError) return refuseSearchParam(res, error);
    throw error;
  }
  try {
    // Cacheable at the edge unless dates are involved: availability moves
    // with bookings, which the listing tags do not cover.
    if (!catalogueCache(req, res, { cacheable: !(params.from && params.to) })) return;

    // Authoritative availability (Batch S night ledger): a listing is
    // unavailable when any of the requested nights is held — by a paid or
    // still-valid unpaid booking, a host block or an iCal import. Expired
    // holds and cancelled bookings hold no nights.
    let booked = new Set();
    if (params.nightFrom && params.nightTo && params.nightTo > params.nightFrom) {
      const ids = await BookingNight.distinct("propertyId", {
        date: { $gte: params.nightFrom, $lt: params.nightTo },
        $or: [{ expiresAt: null }, { expiresAt: { $gt: new Date() } }],
      });
      booked = new Set(ids.map(String));
    }

    // One aggregate: every active listing's location (to place it, to know
    // whether a place has stays at all and to find the nearest ones) and the
    // ids that pass the non-date filters. Strict, nearby, near-me and text
    // modes all run on this single result, so a search is at most 3 ops.
    const [facets] = await ListingProperty.aggregate([
      { $match: { status: "active" } },
      {
        $facet: {
          inv: [{ $project: placeSearch.LOCATION_PROJECTION }],
          open: [{ $match: params.filter }, { $project: { _id: 1 } }],
        },
      },
    ]);
    const inv = (facets ? facets.inv : []).map(placeSearch.classify);
    const openIds = new Set((facets ? facets.open : []).map((d) => String(d._id)));
    const live = placeSearch.livePlaces(inv);
    let counts = null;
    const stays = (id) => (counts || (counts = placeSearch.countPlaces(inv, live))).get(id) || 0;
    const scope = placeSearch.resolveScope({ placeId: params.placeId, point: params.point, location: params.location }, { live, stays, inv });
    const { rows, search } = placeSearch.plan(scope, { inv, openIds, booked });
    search.query = params.location || null;

    const paging = pageParams(req.query, 16);
    const pageRows = rows.slice(paging.skip, paging.skip + paging.limit);
    let data = [];
    if (pageRows.length) {
      const docs = await ListingProperty.find({ _id: { $in: pageRows.map((r) => r.id) }, status: "active" })
        .select(CARD_PROJECTION)
        .lean();
      const byId = new Map(docs.map((d) => [String(d._id), d]));
      data = pageRows
        .map((r) => {
          const doc = byId.get(r.id);
          if (!doc) return null; // deactivated between the two reads
          const card = sanitizeProperty(doc);
          if (typeof r.distanceKm === "number") card.distanceKm = r.distanceKm;
          return card;
        })
        .filter(Boolean);
    }

    res.json({
      data,
      pagination: {
        totalCount: rows.length,
        totalPages: Math.ceil(rows.length / paging.limit),
      },
      search,
    });
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
exports.getPropertyCount = async (req, res) => {
  try {
    const { city } = req.query;
    const cities = typeof city === "string" ? city.split(",").map((c) => c.trim()).filter(Boolean).slice(0, 50) : [];
    if (cities.length === 0) {
      return res.status(400).json({
        success: false,
        message: "cities must be a non-empty array",
      });
    }
    if (!catalogueCache(req, res)) return;
    // A name counts the stays IN that place (same rules as the search), so
    // the home card "Panjim" counts listings saved as "Panaji"; a name the
    // gazetteer does not know keeps the old exact city match. One read.
    const docs = await ListingProperty.find({ status: "active" }).select(placeSearch.LOCATION_PROJECTION).lean();
    const inv = docs.map(placeSearch.classify);
    const live = placeSearch.livePlaces(inv);
    const extra = [...live.values()];
    const result = cities.map((name) => {
      const lower = name.toLowerCase();
      const r = places.resolveQuery(name, { extra });
      if (r && r.place && !r.corrected) {
        return { city: lower, count: inv.filter((c) => placeSearch.inPlace(c, r.place)).length };
      }
      return { city: lower, count: inv.filter((c) => typeof c.raw.city === "string" && c.raw.city.trim().toLowerCase() === lower).length };
    });

    return res.status(200).json({
      success: true,
      data: result,
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
};
// Sortable columns of the admin Hosts (host-history) table → Mongo paths.
const ADMIN_HOST_SORT = {
  firstName: "firstName",
  lastName: "lastName",
  email: "email",
  createdAt: "createdAt",
  allPropertyCount: "allPropertyCount",
  activePropertyCount: "activePropertyCount",
  inactivePropertyCount: "inactivePropertyCount",
  kycDocCount: "kycDocCount",
};

exports.getAdminFilter = async (req, res) => {
  try {
    const { search } = req.query;

    const { page, limit, skip, sort, sortKey } = parseListQuery(req.query, {
      sortable: ADMIN_HOST_SORT,
      defaultSort: "-createdAt",
    });
    const term = searchRegex(search);
    // the same search narrows both the page and the count, so totalPages is right
    const searchStages = term
      ? [
          {
            $match: {
              $or: [
                { email: { $regex: term } },
                { firstName: { $regex: term } },
                { lastName: { $regex: term } },
                {
                  $expr: {
                    $regexMatch: {
                      input: { $concat: [{ $ifNull: ["$firstName", ""] }, " ", { $ifNull: ["$lastName", ""] }] },
                      regex: term,
                    },
                  },
                },
              ],
            },
          },
        ]
      : [];
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
            { $project: { _id: 1 } }, // counted, never read
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
            { $project: { _id: 1 } },
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
            { $project: { _id: 1 } },
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
            ...searchStages,
            { $sort: sort },
            ...pageStages({ skip, limit }),
            {
              $project: {
                password: 0,
                otp: 0,
                otpRetries: 0,
                lockUntil: 0,
                tokenVersion: 0,
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
          filteredCount: [...searchStages, { $count: "count" }],
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

    const meta = listMeta({ page, limit, total: totalHost, sortKey });
    res.json({
      success: true,
      data: result[0].data,
      resultsPerPage: limit,
      allEligibleHostEmails: result[0].allEligibleHostEmails.map(
        (u) => u.email,
      ),
      ...meta,
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
    if (property.status === "active") await notifyListingChanged([propertyId], "timing"); // shown on the stay page
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
// Home page grid (and its legacy twin /properties/dynamic): newest active
// listings as cards. Edge-cached under the `listings` tag; a listing write
// purges it (services/listingChanged.js).
async function listActiveCards(req, res) {
  try {
    if (!catalogueCache(req, res)) return;
    const { page, limit, skip } = pageParams(req.query, 16);
    const { type } = req.query;
    const query = { status: { $in: ["active", "completed"] } };
    if (type) query.propertyType = type;

    const [properties, totalProperties] = await Promise.all([
      ListingProperty.find(query)
        .select(CARD_PROJECTION)
        .sort({ createdAt: -1, _id: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      ListingProperty.countDocuments(query),
    ]);

    const totalPages = Math.ceil(totalProperties / limit);
    const hasMore = page * limit < totalProperties;
    res.status(200).json({
      properties: sanitizeProperties(properties),
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
}
exports.getFrontPageAllStays = listActiveCards;
exports.getAllStays = listActiveCards;
exports.getIdandName = async (req, res) => {
  try {
    const hostId = req.params.id;
    const filter = { status: "active", host: hostId };
    const data = await ListingProperty.find(filter);

    if (!data) {
      return res.status(404).json({ message: "Listing not found" });
    }

    // Sanitize properties to remove hostEmail and other sensitive data
    const sanitizedData = sanitizeProperties(data);

    res.status(200).json({
      data: sanitizedData,
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

    // Sanitize properties to remove host contact info
    const sanitizedProperties = sanitizeProperties(properties);

    // Send response
    res.status(200).json({
      properties: sanitizedProperties,
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
// Public, anonymous list. Used to return every listing regardless of status
// (drafts, pending, delisted — with host ids and rules) and filtered on a
// field the schema does not have. Batch P: active listings only, as cards,
// same envelope; `type` means propertyType like the other public lists.
exports.getAllProperties = async (req, res) => {
  try {
    if (!catalogueCache(req, res)) return;
    const { page, limit, skip } = pageParams(req.query, 30);
    const { type } = req.query;
    const query = { status: "active" };
    if (type) query.propertyType = type;

    const [properties, totalProperties] = await Promise.all([
      ListingProperty.find(query)
        .select(CARD_PROJECTION)
        .sort({ createdAt: -1, _id: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      ListingProperty.countDocuments(query),
    ]);

    // Calculate pagination metadata
    const totalPages = Math.ceil(totalProperties / limit);
    const hasMore = page * limit < totalProperties;

    // Sanitize properties to remove hostEmail and other sensitive data
    const sanitizedProperties = sanitizeProperties(properties);

    // Send response
    res.status(200).json({
      properties: sanitizedProperties,
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

// Sortable columns of the admin Properties table → Mongo paths.
const ADMIN_LISTING_SORT = {
  title: "title",
  propertyType: "propertyType",
  placeType: "placeType",
  guests: "guests",
  bedrooms: "bedrooms",
  beds: "beds",
  bathrooms: "bathrooms",
  basePrice: "basePrice",
  status: "status",
  kycStatus: "kycStatus",
  hostEmail: "host.email",
  hostKyc: "host.kyc",
  hostBank: "host.bank",
  createdAt: "createdAt",
  updatedAt: "updatedAt",
};

exports.getFilteredListingsForAdmin = async (req, res) => {
  try {
    const { search, status } = req.query;

    const { page, limit, skip, sort, sortKey } = parseListQuery(req.query, {
      sortable: ADMIN_LISTING_SORT,
      defaultSort: "-updatedAt",
      defaultLimit: 30,
    });

    const matchStage = {};

    if (status) {
      if (status !== "all") {
        matchStage.status = status;
      } else {
        matchStage.status = { $nin: ["incomplete"] };
      }
    }

    const term = searchRegex(search);
    if (term) {
      matchStage.$or = [
        { title: { $regex: term } },
        {
          $expr: {
            $regexMatch: {
              input: { $ifNull: ["$host.email", ""] },
              regex: term,
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
            { $sort: sort },
            ...pageStages({ skip, limit }),
            // Aggregations bypass the model's embedding exclusion, and the
            // joined user document must not carry credentials to the admin UI.
            {
              $project: {
                ...ListingProperty.EMBEDDING_PROJECTION,
                "host.password": 0,
                "host.otp": 0,
                "host.otpRetries": 0,
                "host.lockUntil": 0,
                "host.tokenVersion": 0,
              },
            },
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
      ...listMeta({ page, limit, total: totalProperties, sortKey }),
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
      { new: true },
    ).populate({ path: "host", select: HOST_CONTACT_SELECT });
    if (!updatedListing) {
      return res.status(404).json({ message: "Listing not found" });
    }
    await notifyListingChanged([id], "approve"); // PUBLIC_CHANGE: processing → active
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
        adminEmail.map((email) => sendEmail(email.trim(), 48, params)),
      );
      await sendEmail(params.hostEmail, 49, params);
    } else {
      await sendEmail(params.hostEmail, 25, params);

      await Promise.all(
        adminEmail.map((email) => sendEmail(email.trim(), 26, params)),
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
    let updatedListing = await ListingProperty.findById(id).populate({ path: "host", select: HOST_CONTACT_SELECT });
    if (!updatedListing) {
      return res.status(404).json({ message: "Listing not found" });
    }
    if (updatedListing.delist == "admin") {
      return res.status(200).json({
        message: "Listing reactivation failed",
        listing: "adminDelist",
      });
    }
    // Used to set the field on the loaded document only and report success
    // without saving — the listing stayed inactive.
    await ListingProperty.updateOne({ _id: id }, { $set: { status: "active" } });
    await notifyListingChanged([id], "reactivate"); // PUBLIC_CHANGE: inactive → active
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
        { new: true },
      ).populate({ path: "host", select: HOST_CONTACT_SELECT });
      if (!updatedListing) {
        return res.status(404).json({ message: "Listing not found" });
      }
      await notifyListingChanged([id], "delist"); // PUBLIC_CHANGE: active → inactive

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
        adminEmail.map((email) => sendEmail(email.trim(), 49, params)),
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
        { new: true },
      ).populate({ path: "host", select: HOST_CONTACT_SELECT });
      if (!updatedListing) {
        return res.status(404).json({ message: "Listing not found" });
      }
      await notifyListingChanged([id], "admin-delist"); // PUBLIC_CHANGE: active → inactive

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
      select: SAFE_HOST_SELECT,
    });
    if (process.env.NEXT_PUBLIC_ENV === "dev") {
      console.log("si", property);
    }
    if (!property) {
      return res.status(404).json({ message: "Property not found" });
    }

    // Sanitize property to remove ALL sensitive data (host info, address, hostEmail, etc.)
    const sanitizedData = sanitizeProperty(property);

    res.status(200).json({ success: true, data: sanitizedData });
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
          { password: 0 }, // Exclude sensitive fields
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
              select: "-password -otp -otpRetries -lockUntil -tokenVersion",
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

// DELETE /properties/admin/:id — admin deletes a pending listing.
exports.adminDeleteListing = async (req, res) => {
  const authz = require("../middleware/authz");
  const listingDeletion = require("../services/listingDeletion");
  try {
    const actor = await authz.resolveActor(req);
    if (!authz.isAdmin(actor)) return authz.forbid(res, "Admin access required");
    const { snapshot, outcome } = await listingDeletion.deletePendingListing({ listingId: req.params.id, actorId: actor.id });
    return res.status(200).json({
      success: true,
      message: "Listing deleted",
      data: { _id: snapshot.id, title: snapshot.title, photosRemoved: outcome.photosRemoved, photosSkipped: outcome.photosSkipped, photosFailed: outcome.photosFailed },
    });
  } catch (err) {
    if (err && err.refused) {
      return res.status(err.status).json({ success: false, code: err.code, message: err.message, statusCode: err.status, ...err.extra });
    }
    console.error("adminDeleteListing error", err && err.message);
    return res.status(503).json({ success: false, code: "DELETE_UNAVAILABLE", message: "The listing could not be deleted right now. Nothing was changed — please try again.", statusCode: 503 });
  }
};

// DELETE /properties/host/:id — a host deletes its own draft ("incomplete")
// or withdraws its own pending submission ("processing"); the same fail-safe
// service as the admin deletion (blockers, one transaction, photo cleanup,
// audit row with actorKind "host").
exports.hostDeleteListing = async (req, res) => {
  const authz = require("../middleware/authz");
  const listingDeletion = require("../services/listingDeletion");
  try {
    const actor = await authz.resolveActor(req);
    if (!actor || actor.kind !== "user") return authz.forbid(res, "Sign in as the listing's host");
    const { snapshot, outcome } = await listingDeletion.deleteOwnListing({ listingId: req.params.id, hostId: actor.id });
    return res.status(200).json({
      success: true,
      message: "Listing deleted",
      data: { _id: snapshot.id, title: snapshot.title, photosRemoved: outcome.photosRemoved, photosSkipped: outcome.photosSkipped, photosFailed: outcome.photosFailed },
    });
  } catch (err) {
    if (err && err.refused) {
      return res.status(err.status).json({ success: false, code: err.code, message: err.message, statusCode: err.status, ...err.extra });
    }
    console.error("hostDeleteListing error", err && err.message);
    return res.status(503).json({ success: false, code: "DELETE_UNAVAILABLE", message: "The listing could not be deleted right now. Nothing was changed — please try again.", statusCode: 503 });
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
    const propertyData = authz.isAdmin(req.actor) ? { ...req.body } : stripHostImmutableFields(req.body);
    const user = await User.findOne({ email: req.body.hostEmail });
    if (process.env.NEXT_PUBLIC_ENV === "dev") {
      console.log("xmennn", propertyData);
    }

    if (!user) {
      return res.status(404).json({ message: "Host not found" });
    }
    // Contact lock-down: public text may not carry contact details or the exact address
    const policy = checkListingWrite(null, propertyData);
    if (!policy.ok) return refusePublicText(res, policy);
    const images = checkListingImages(null, propertyData);
    if (!images.ok) return refuseImages(res, images);

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
exports.adminUpdateListingProperty = async (req, res) => {
  try {
    const { id } = req.params;
    const { submit, status } = req.query;

    const before = await ListingProperty.findById(id).select(`status ${LISTING_TEXT_SELECT}`).lean();
    // Contact lock-down applies to admin edits too: admin visibility is not a
    // licence to publish contact details or the exact address.
    const policy = checkListingWrite(before, req.body);
    if (!policy.ok) return refusePublicText(res, policy);
    const images = checkListingImages(before, req.body);
    if (!images.ok) return refuseImages(res, images);
    const property = await ListingProperty.findOneAndUpdate(
      { _id: id },
      { $set: req.body },
      { new: true, runValidators: true },
    ).populate({ path: "host", select: HOST_CONTACT_SELECT });
    if (!property) {
      return res
        .status(404)
        .json({ message: "Property not found or unauthorized to update" });
    }
    // PUBLIC_CHANGE only when the listing was or is publicly visible.
    if ((before && before.status === "active") || property.status === "active") {
      await notifyListingChanged([id], "admin-update");
    }
    // if (property.host.kyc === true) {
    //   property.kycStatus = "completed";
    //   await property.save();
    // }
    // if (property.host.bank === true) {
    //   property.bankDetails = true;
    //   await property.save();
    // }
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

    const hostEmail = property.hostEmail;
    const newStatus = property.status;

    res.status(200).json(property);
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

    const before = await ListingProperty.findById(id).select(`status ${LISTING_TEXT_SELECT}`).lean();
    if (!before) {
      return res.status(404).json({ message: "Property not found or unauthorized to update" });
    }
    const isAdmin = authz.isAdmin(req.actor);
    const patch = isAdmin ? { ...req.body } : stripHostImmutableFields(req.body);
    if (!isAdmin && patch.status !== undefined && patch.status !== before.status && !HOST_SETTABLE_STATUSES.includes(patch.status)) {
      return res.status(403).json({
        success: false,
        code: "LISTING_STATUS_NOT_ALLOWED",
        message: "A listing goes live only after admin review; use delist / reactivate for the other changes",
        statusCode: 403,
      });
    }
    // Contact lock-down: judged on the resulting listing (existing + patch),
    // so a number split across fields or across saves is refused too.
    const policy = checkListingWrite(before, patch);
    if (!policy.ok) return refusePublicText(res, policy);
    const images = checkListingImages(before, patch);
    if (!images.ok) return refuseImages(res, images);
    const property = await ListingProperty.findOneAndUpdate(
      { _id: id },
      { $set: patch },
      { new: true, runValidators: true },
    ).populate({ path: "host", select: HOST_CONTACT_SELECT });

    if (!property) {
      return res
        .status(404)
        .json({ message: "Property not found or unauthorized to update" });
    }
    // The wizard PUTs on every step of a draft; only a listing that was or
    // is publicly visible purges the catalogue caches.
    if ((before && before.status === "active") || property.status === "active") {
      await notifyListingChanged([id], "host-update");
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
          adminEmail.map((email) => sendEmail(email.trim(), 51, params)),
        );
      } else {
        await Promise.all(
          adminEmail.map((email) => sendEmail(email.trim(), 50, params)),
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
      { $set: { kycStatus: "completed" } },
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

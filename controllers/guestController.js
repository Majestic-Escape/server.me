const ListingProperty = require("../models/ListingProperty");
const User = require("../models/User");
const KycHostData = require("../models/KycHostForm");
// Get user information by ID
// exports.getGuests = async (req, res) => {
//   try {
//     pipeline;
//     const { search ,status} = req.query;
//     const limit = parseInt(req.query.limit) || 10;
//     const skip = parseInt(req.query.skip) || 0;

//     const matchStage = {};
//     if (status && status !== "all") {
//       matchStage.status = status;
//     }

//     if (search && search.toLowerCase().trim() != "") {
//       matchStage.$or = [
//         { title: { $regex: search, $options: "i" } },
//         // { placeType: { $regex: search, $options: "i" } },
//         {
//           $expr: {
//             $regexMatch: {
//               input: { $ifNull: ["$hostId.firstName", ""] },
//               regex: search,
//               options: "i",
//             },
//             $regexMatch: {
//               input: { $ifNull: ["$hostId.lastName", ""] },
//               regex: search,
//               options: "i",
//             },
//             $regexMatch: {
//               input: { $ifNull: ["$hostId.phoneNumber", ""] },
//               regex: search,
//               options: "i",
//             },
//           },
//         },
//       ];
//     }
//    const pipeline=[{ $sort: { updatedAt: -1 } },
//       {
//         $facet: {
//           data: [{ $skip: skip }, { $limit: limit }],
//           totalCount: [{ $count: "count" }],
//         },
//       },]
//       const users = await User.aggregate();
//       if (!users) {
//         return res
//           .status(404)
//           .json({ success: false, message: "User data could not be found" });
//       }
//       if (process.env.NEXT_PUBLIC_ENV === "dev") {
//         console.log("entered get guests 3");
//       }
//       res.json({ data: users, total: total });
//     } // Fetch all users
//     else {
//       let users = await User.find();
//       if (!users) {
//         return res
//           .status(404)
//           .json({ success: false, message: "Could not find user data" });
//       }
//       users = users.filter(
//         (item) =>
//           item.firstName.toLowerCase().includes(search.toLowerCase()) ||
//           item.lastName.toLowerCase().includes(search.toLowerCase()) ||
//           (item.firstName + " " + item.lastName)
//             .toLowerCase()
//             .includes(search.toLowerCase())
//       );

//       res.json({ data: users, total: total });
//     }
//   } catch (err) {
//     res.status(500).json({ error: "Failed to fetch users" });
//   }
// };

exports.getGuests = async (req, res) => {
  try {
    const { search, status } = req.query;
    const limit = parseInt(req.query.limit) || 10;
    const skip = parseInt(req.query.skip) || 0;

    const matchStage = {};

    // Status filter
    if (status && status !== "all") {
      matchStage.status = status;
    }

    // Search filter
    if (search && search.trim() !== "") {
      matchStage.$or = [
        { firstName: { $regex: search, $options: "i" } },
        { lastName: { $regex: search, $options: "i" } },

        // 🔹 phoneNumber (number → string)
        {
          $expr: {
            $regexMatch: {
              input: { $toString: "$phoneNumber" },
              regex: search,
            },
          },
        },

        // 🔹 full name search
        {
          $expr: {
            $regexMatch: {
              input: { $concat: ["$firstName", " ", "$lastName"] },
              regex: search,
              options: "i",
            },
          },
        },
      ];
    }

    const pipeline = [
      // 1️⃣ Match users first (search + status)
      { $match: matchStage },

      // 2️⃣ Lookup properties
      {
        $lookup: {
          from: "listingproperties",
          localField: "_id",
          foreignField: "host",
          as: "properties",
        },
      },

      // 3️⃣ Keep only users who are hosts
      {
        $match: {
          "properties.0": { $exists: true },
        },
      },

      // 4️⃣ Count properties
      {
        $addFields: {
          totalProperties: { $size: "$properties" },
        },
      },

      // 5️⃣ Lookup reviews
      {
        $lookup: {
          from: "reviews",
          localField: "_id",
          foreignField: "hostId",
          as: "reviews",
        },
      },

      // 6️⃣ Review stats
      {
        $addFields: {
          totalReviews: { $size: "$reviews" },
          averageRating: {
            $cond: [
              { $gt: [{ $size: "$reviews" }, 0] },
              { $avg: "$reviews.rating" },
              0,
            ],
          },
        },
      },

      // 7️⃣ Clean up payload
      {
        $project: {
          password: 0,
          properties: 0,
          reviews: 0,
        },
      },

      // 8️⃣ Sort
      { $sort: { updatedAt: -1 } },

      // 9️⃣ Pagination
      {
        $facet: {
          data: [{ $skip: skip }, { $limit: limit }],
          totalCount: [{ $count: "count" }],
        },
      },
    ];

    const result = await User.aggregate(pipeline);

    const hosts = result[0].data;
    const total = result[0].totalCount[0]?.count || 0;

    res.status(200).json({
      data: hosts,
      total,
      limit,
      skip,
      hasMore: skip + limit < total,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch hosts" });
  }
};

exports.getKycDetails = async (req, res) => {
  const { id } = req.query;
  const data = await KycHostData.find({ hostId: id });
  if (!data) {
    return res.status(404).json({ message: "Kyc data not found" });
  }
  return res.status(200).json({ data: data });
};
exports.getGuestsById = async (req, res) => {
  try {
    const { userId } = req.query;
    const users = await User.findById(userId); // Fetch all users
    res.json(users);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch users" });
  }
};

// Get user information by ID
exports.getUserInfo = async (req, res) => {
  const { userId } = req.params;

  try {
    const user = await User.findById(userId)
      .select("-otp.value -otp.expiry -lockUntil") // Exclude sensitive fields
      .lean(); // Optimize for read-only

    if (!user) return res.status(404).json({ message: "User not found" });

    res
      .status(200)
      .json({ message: "User information retrieved successfully", user });
  } catch (err) {
    res
      .status(500)
      .json({ error: "Error fetching user information", details: err.message });
  }
};

// Delete a user by ID
exports.deleteUser = async (req, res) => {
  const { userId } = req.params;

  try {
    const user = await User.findByIdAndDelete(userId);

    if (!user) return res.status(404).json({ message: "User not found" });

    const updatedList = await User.find();
    res.status(200).json({ message: "User deleted successfully", updatedList });
  } catch (err) {
    res
      .status(500)
      .json({ error: "Error deleting user", details: err.message });
  }
};

// Deactivate/Ban a user by ID
exports.banUser = async (req, res) => {
  const { userId } = req.params;
  // const { bannedReason } = req.body;
  const { active } = req.body;
  try {
    const user = await User.findById(userId);

    if (!user) return res.status(404).json({ message: "User not found" });
    if (active) {
      user.status.active = false;
      user.status.banned = true;
      // user.status.bannedReason = bannedReason || "No reason provided";
      user.tokenVersion += 1;
      const property = await ListingProperty.updateMany(
        { host: userId, status: "active" },
        { status: "inactive", ban: true }
      );
      if (!property) {
        return res
          .status(404)
          .json({ success: false, message: "Properties of host not found" });
      }
    } else {
      user.status.active = true;
      user.status.banned = false;

      const property = await ListingProperty.updateMany(
        { host: userId, ban: true },
        { status: "active" }
      );
      if (!property) {
        return res
          .status(404)
          .json({ success: false, message: "Properties of host not found" });
      }
    }

    await user.save();

    const data = await User.find();
    if (!data) {
      return res
        .status(404)
        .json({ success: false, message: "User data could not be found" });
    }
    res.status(200).json({ message: "User banned successfully", data });
  } catch (err) {
    res.status(500).json({ error: "Error banning user", details: err.message });
  }
};

// Unban a user by ID
exports.unbanUser = async (req, res) => {
  const { userId } = req.params;

  try {
    const user = await User.findById(userId);

    if (!user) return res.status(404).json({ message: "User not found" });

    user.status.active = true;
    user.status.banned = false;
    user.status.bannedReason = null;

    await user.save();

    res.status(200).json({ message: "User unbanned successfully", user });
  } catch (err) {
    res
      .status(500)
      .json({ error: "Error unbanning user", details: err.message });
  }
};

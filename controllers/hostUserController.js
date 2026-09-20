const User = require("../models/User");
const authz = require("../middleware/authz");
const { PUBLIC_USER_SELECT, SELF_USER_SELECT, toPublicUser, toSelfUser, publicFirstName } = require("../utils/sanitizeResponse");
const ListingProperty = require("../models/ListingProperty");
const { sendHostNotification } = require("../utils/sendEmail");

const getHostUsers = async () => {
  const hostUsers = await User.find({
    $or: [
      { role: "host" },
      { _id: { $in: await ListingProperty.distinct("host") } },
    ],
  });
  return hostUsers;
};

exports.getAllHosts = async (req, res) => {
  const { page = 1, status, sortBy, searchTerm } = req.query;
  const limit = 10;
  const skip = (page - 1) * limit;

  try {
    let query = {
      $or: [
        { role: "host" },
        { _id: { $in: await ListingProperty.distinct("host") } },
      ],
    };
    if (status && status !== "all") {
      query["status.active"] = status === "Active";
    }
    if (searchTerm) {
      query.$and = [
        {
          $or: [
            { firstName: { $regex: searchTerm, $options: "i" } },
            { lastName: { $regex: searchTerm, $options: "i" } },
            { email: { $regex: searchTerm, $options: "i" } },
          ],
        },
      ];
    }

    let sortQuery = {};
    if (sortBy === "properties") sortQuery["bookings.length"] = -1;
    if (sortBy === "rating") sortQuery.rating = -1;
    if (sortBy === "totalEarnings") sortQuery.totalEarnings = -1;

    const hosts = await User.find(query)
      .sort(sortQuery)
      .skip(skip)
      .limit(limit)
      .select(
        "firstName lastName email bookings rating totalEarnings createdAt status"
      );

    const total = await User.countDocuments(query);

    const hostsWithListings = await Promise.all(
      hosts.map(async (host) => {
        const listingsCount = await ListingProperty.countDocuments({
          host: host._id,
        });
        return {
          id: host._id,
          name: `${host.firstName} ${host.lastName}`,
          email: host.email,
          properties: listingsCount,
          rating: host.rating || 0,
          totalEarnings: host.totalEarnings || 0,
          joinDate: host.createdAt,
          status: host.status.active ? "Active" : "Inactive",
        };
      })
    );

    res.status(200).json({
      hosts: hostsWithListings,
      currentPage: parseInt(page),
      totalPages: Math.ceil(total / limit),
      total,
    });
  } catch (error) {
    res
      .status(500)
      .json({ message: "Error fetching hosts", error: error.message });
  }
};

exports.getHostStats = async (req, res) => {
  try {
    const hostUsers = await getHostUsers();
    const totalHosts = hostUsers.length;
    const newHosts = hostUsers.filter(
      (host) =>
        host.createdAt >=
        new Date(new Date().setMonth(new Date().getMonth() - 1))
    ).length;
    const avgRating =
      hostUsers.reduce((sum, host) => sum + (host.rating || 0), 0) / totalHosts;

    res.status(200).json({
      totalHosts,
      newHosts,
      avgRating: avgRating || 0,
    });
  } catch (error) {
    res
      .status(500)
      .json({ message: "Error fetching host stats", error: error.message });
  }
};

exports.getHostGrowth = async (req, res) => {
  try {
    const hostUsers = await getHostUsers();
    const growth = hostUsers.reduce((acc, host) => {
      const month = host.createdAt.toISOString().slice(0, 7); // YYYY-MM
      acc[month] = (acc[month] || 0) + 1;
      return acc;
    }, {});

    const sortedGrowth = Object.entries(growth)
      .sort(([a], [b]) => a.localeCompare(b))
      .slice(-6)
      .map(([_id, count]) => ({ _id, count }));

    res.status(200).json(sortedGrowth);
  } catch (error) {
    res
      .status(500)
      .json({ message: "Error fetching host growth", error: error.message });
  }
};

exports.getTopPerformingHosts = async (req, res) => {
  try {
    const hostUsers = await getHostUsers();
    const topHosts = hostUsers
      .sort((a, b) => (b.totalEarnings || 0) - (a.totalEarnings || 0))
      .slice(0, 5)
      .map((host) => ({
        name: `${host.firstName} ${host.lastName}`,
        earnings: host.totalEarnings || 0,
      }));

    res.status(200).json(topHosts);
  } catch (error) {
    res.status(500).json({
      message: "Error fetching top performing hosts",
      error: error.message,
    });
  }
};

exports.getHostActivity = async (req, res) => {
  try {
    const hostUsers = await getHostUsers();
    const activity = hostUsers.reduce((acc, host) => {
      const month = host.updatedAt.toISOString().slice(0, 7); // YYYY-MM
      if (!acc[month]) {
        acc[month] = { active: 0, inactive: 0 };
      }
      if (host.status.active) {
        acc[month].active++;
      } else {
        acc[month].inactive++;
      }
      return acc;
    }, {});

    const sortedActivity = Object.entries(activity)
      .sort(([a], [b]) => a.localeCompare(b))
      .slice(-6)
      .map(([_id, data]) => ({ _id, ...data }));

    res.status(200).json(sortedActivity);
  } catch (error) {
    res
      .status(500)
      .json({ message: "Error fetching host activity", error: error.message });
  }
};

exports.getHostDistribution = async (req, res) => {
  try {
    const distribution = await ListingProperty.aggregate([
      {
        $group: {
          _id: "$propertyType",
          count: { $sum: 1 },
        },
      },
    ]);

    res.status(200).json(distribution);
  } catch (error) {
    res.status(500).json({
      message: "Error fetching host distribution",
      error: error.message,
    });
  }
};

exports.generateReport = async (req, res) => {
  const { metric, startDate, endDate } = req.query;

  try {
    const hostUsers = await getHostUsers();
    const filteredHosts = hostUsers.filter(
      (host) =>
        host.createdAt >= new Date(startDate) &&
        host.createdAt <= new Date(endDate)
    );

    let report;
    switch (metric) {
      case "earnings":
        report = [
          {
            _id: null,
            totalEarnings: filteredHosts.reduce(
              (sum, host) => sum + (host.totalEarnings || 0),
              0
            ),
          },
        ];
        break;
      case "bookings":
        report = [
          {
            _id: null,
            totalBookings: filteredHosts.reduce(
              (sum, host) => sum + (host.bookings?.length || 0),
              0
            ),
          },
        ];
        break;
      case "ratings":
        report = [
          {
            _id: null,
            avgRating:
              filteredHosts.reduce((sum, host) => sum + (host.rating || 0), 0) /
              filteredHosts.length,
          },
        ];
        break;
      default:
        return res.status(400).json({ message: "Invalid metric" });
    }

    res.status(200).json(report);
  } catch (error) {
    res
      .status(500)
      .json({ message: "Error generating report", error: error.message });
  }
};

exports.exportHosts = async (req, res) => {
  const { format } = req.query;

  try {
    const hostUsers = await getHostUsers();
    const hostsData = await Promise.all(
      hostUsers.map(async (host) => {
        const listingsCount = await ListingProperty.countDocuments({
          host: host._id,
        });
        return {
          name: `${host.firstName} ${host.lastName}`,
          email: host.email,
          properties: listingsCount,
          rating: host.rating || 0,
          totalEarnings: host.totalEarnings || 0,
          joinDate: host.createdAt,
          status: host.status.active ? "Active" : "Inactive",
        };
      })
    );

    if (format === "csv") {
      // Implement CSV export logic
      res.status(200).json({
        message: "CSV export not implemented yet",
        data: hostsData,
      });
    } else {
      res.status(400).json({ message: "Unsupported export format" });
    }
  } catch (error) {
    res
      .status(500)
      .json({ message: "Error exporting hosts", error: error.message });
  }
};

exports.createHost = async (req, res) => {
  try {
    const { firstName, lastName, email, password } = req.body;
    const newHost = new User({
      firstName,
      lastName,
      email,
      password,
      role: "host",
      status: { active: true },
    });
    await newHost.save();
    res
      .status(201)
      .json({ message: "Host created successfully", host: newHost });
  } catch (error) {
    res
      .status(500)
      .json({ message: "Error creating host", error: error.message });
  }
};

exports.deleteHost = async (req, res) => {
  try {
    const host = await User.findById(req.params.id);
    if (!host) {
      return res.status(404).json({ message: "Host not found" });
    }
    await host.remove();
    res.status(200).json({ message: "Host deleted successfully" });
  } catch (error) {
    res
      .status(500)
      .json({ message: "Error deleting host", error: error.message });
  }
};

exports.getHostListings = async (req, res) => {
  try {
    const listings = await ListingProperty.find({ host: req.params.id });
    res.status(200).json(listings);
  } catch (error) {
    res
      .status(500)
      .json({ message: "Error fetching host listings", error: error.message });
  }
};

exports.getHostEarnings = async (req, res) => {
  try {
    const host = await User.findById(req.params.id);
    if (!host) {
      return res.status(404).json({ message: "Host not found" });
    }
    // Assuming we have an earnings field in the User model
    res.status(200).json({ earnings: host.totalEarnings || 0 });
  } catch (error) {
    res
      .status(500)
      .json({ message: "Error fetching host earnings", error: error.message });
  }
};

exports.toggleHostStatus = async (req, res) => {
  try {
    const host = await User.findById(req.params.id);
    if (!host) {
      return res.status(404).json({ message: "Host not found" });
    }
    host.status.active = !host.status.active;
    await host.save();
    res.status(200).json({
      message: "Host status updated",
      status: host.status.active ? "Active" : "Inactive",
    });
  } catch (error) {
    res
      .status(500)
      .json({ message: "Error toggling host status", error: error.message });
  }
};

exports.notifyHost = async (req, res) => {
  try {
    const { message } = req.body;
    const host = await User.findOne({
      _id: req.params.id,
      $or: [
        { role: "host" },
        { _id: { $in: await ListingProperty.distinct("host") } },
      ],
    });

    if (!host) {
      return res.status(404).json({ message: "Host not found" });
    }

    // Send email notification
    await sendHostNotification(host.email, host.firstName, message);

    res.status(200).json({ message: "Notification sent to host successfully" });
  } catch (error) {
    console.error("Error sending notification to host:", error);
    res.status(500).json({
      message: "Error sending notification to host",
      error: error.message,
    });
  }
};

exports.bulkAction = async (req, res) => {
  try {
    const { action, hostIds } = req.body;
    let result;

    switch (action) {
      case "activate":
        result = await User.updateMany(
          { _id: { $in: hostIds } },
          { "status.active": true }
        );
        break;
      case "deactivate":
        result = await User.updateMany(
          { _id: { $in: hostIds } },
          { "status.active": false }
        );
        break;
      case "delete":
        result = await User.deleteMany({ _id: { $in: hostIds } });
        break;
      default:
        return res.status(400).json({ message: "Invalid action" });
    }

    res.status(200).json({ message: "Bulk action completed", result });
  } catch (error) {
    res
      .status(500)
      .json({ message: "Error performing bulk action", error: error.message });
  }
};
exports.getSingleHostById = async (req, res) => {
  try {
    const { id } = req.params;
    // Contact lock-down: own record minus secrets; anyone else → public projection.
    const actor = await authz.resolveActor(req);
    const self = actor && authz.sameId(actor.id, id);
    const host = await User.findById(id).select(authz.isAdmin(actor) ? "" : self ? SELF_USER_SELECT : PUBLIC_USER_SELECT).lean();
    if (!host) {
      return res.status(404).json({ message: "Host not found" });
    }
    if (authz.isAdmin(actor)) return res.status(200).json(host);
    res.status(200).json(self ? toSelfUser(host) : toPublicUser(host, { fallbackName: "Host" }));
  } catch (error) {
    res
      .status(500)
      .json({ message: "Error fetching host details", error: error.message });
  }
};

exports.getHostById = async (req, res) => {
  try {
    const host = await User.findOne({
      _id: req.params.id,
      $or: [
        { role: "host" },
        { _id: { $in: await ListingProperty.distinct("host") } },
      ],
    });

    if (!host) {
      return res.status(404).json({ message: "Host not found" });
    }

    const listingsCount = await ListingProperty.countDocuments({
      host: host._id,
    });

    const actor = await authz.resolveActor(req);
    const privileged = authz.isAdmin(actor) || (actor && authz.sameId(actor.id, host._id));
    const hostData = privileged
      ? {
          id: host._id,
          firstName: host.firstName,
          lastName: host.lastName,
          email: host.email,
          properties: listingsCount,
          rating: host.rating || 0,
          totalEarnings: host.totalEarnings || 0,
          joinDate: host.createdAt,
          status: host.status.active ? "Active" : "Inactive",
        }
      : {
          // Contact lock-down: a counterpart sees the public profile only
          id: host._id,
          firstName: publicFirstName(host.firstName, "Host"),
          properties: listingsCount,
          rating: host.rating || 0,
          joinDate: host.createdAt,
        };

    res.status(200).json(hostData);
  } catch (error) {
    res
      .status(500)
      .json({ message: "Error fetching host details", error: error.message });
  }
};

exports.updateHost = async (req, res) => {
  try {
    const { firstName, lastName, email, status } = req.body;

    const host = await User.findOne({
      _id: req.params.id,
      $or: [
        { role: "host" },
        { _id: { $in: await ListingProperty.distinct("host") } },
      ],
    });

    if (!host) {
      return res.status(404).json({ message: "Host not found" });
    }

    // Update host details
    host.firstName = firstName || host.firstName;
    host.lastName = lastName || host.lastName;
    host.email = email || host.email;
    if (status !== undefined) {
      host.status.active = status === "Active";
    }

    await host.save();

    const listingsCount = await ListingProperty.countDocuments({
      host: host._id,
    });

    const updatedHostData = {
      id: host._id,
      firstName: host.firstName,
      lastName: host.lastName,
      email: host.email,
      properties: listingsCount,
      rating: host.rating || 0,
      totalEarnings: host.totalEarnings || 0,
      joinDate: host.createdAt,
      status: host.status.active ? "Active" : "Inactive",
    };

    res
      .status(200)
      .json({ message: "Host updated successfully", host: updatedHostData });
  } catch (error) {
    res
      .status(500)
      .json({ message: "Error updating host", error: error.message });
  }
};

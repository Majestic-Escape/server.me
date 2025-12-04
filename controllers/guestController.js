const ListingProperty = require("../models/ListingProperty");
const User = require("../models/User");

// Get user information by ID
exports.getGuests = async (req, res) => {
  try {
    const { search } = req.query;
    const total = await User.countDocuments();
    console.log("entered get guests 1");
    if (!total) {
      return res
        .status(404)
        .json({ success: false, message: "Document count failed" });
    }
    if (!search && search == "") {
      console.log("entered get guests 2");
      const limit = parseInt(req.query.limit) || 2;
      const skip = parseInt(req.query.skip) || 0;
      const users = await User.find().limit(limit).skip(skip);
      if (!users) {
        return res
          .status(404)
          .json({ success: false, message: "User data could not be found" });
      }
      console.log("entered get guests 3");
      res.json({ data: users, total: total });
    } // Fetch all users
    else {
      let users = await User.find();
      if (!users) {
        return res
          .status(404)
          .json({ success: false, message: "Could not find user data" });
      }
      users = users.filter(
        (item) =>
          item.firstName.toLowerCase().includes(search.toLowerCase()) ||
          item.lastName.toLowerCase().includes(search.toLowerCase()) ||
          (item.firstName + " " + item.lastName)
            .toLowerCase()
            .includes(search.toLowerCase())
      );

      res.json({ data: users, total: total });
    }
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch users" });
  }
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

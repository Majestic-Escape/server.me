const User = require("../models/User");

// GET /api/profile - fetch user profile using email
exports.getProfile = async (req, res) => {
  try {
    // Get email from query parameters
    const { email } = req.query;
    if (!email) {
      return res.status(400).json({ message: "Email is required" });
    }

    // Find the user by email
    const user = await User.findOne({ email });
    if (!user) {
      return res.status(404).json({ message: "Profile not found" });
    }

    res.json({
      firstName: user.firstName,
      lastName: user?.lastName,
      email: user.email,
      phone: user.phoneNumber,
      profilePicture: user?.profilePicture,
      dob: user.dob,
      languages: user?.languages,
      about: user?.about,
      address: {
        street: user.address?.street,
        city: user.address?.city,
        state: user.address?.state,
        postalCode: user.address?.postalCode,
        country: user.address?.country,
      },
      governmentIdType: user.kyc?.govDoc?.docType || "",
    });
  } catch (error) {
    console.error("Error fetching profile:", error);
    res.status(500).json({ message: "Server error" });
  }
};

// POST /api/profile - update/save user profile using email
exports.updateProfile = async (req, res) => {
  try {
    // Extract email from query parameters
    const { email } = req.query;
    console.log("Email", email);
    if (!email) {
      return res.status(400).json({ message: "Email is required" });
    }

    // Destructure required fields and any optional fields
    const {
      firstName,
      lastName,
      dob,
      phoneNumber,
      profilePicture,
      address,
      languages,
      about,
      governmentIdType,
    } = req.body;

    // Validate required fields
    if (!firstName || !lastName || !dob || !phoneNumber) {
      return res.status(400).json({
        message: "firstName, lastName, dob, and phoneNumber are required",
      });
    }
    console.log("s1");

    // Find the existing user by email
    const user = await User.findOne({ email });
    if (!user) {
      return res.status(404).json({ message: "Profile not found" });
    }
    console.log("s2");

    // Update required fields
    user.firstName = firstName;
    user.lastName = lastName;
    user.dob = dob;
    user.phoneNumber = phoneNumber;
    user.languages = languages;
    user.about = about;

    // Update optional fields if provided
    if (profilePicture !== undefined) {
      user.profilePicture = profilePicture;
    }
    if (address !== undefined) {
      // Merge existing address with new values (if provided)
      user.address = { ...user.address.toObject(), ...address };
    }
    if (governmentIdType !== undefined) {
      user.governmentIdType = governmentIdType;
    }
    console.log("s3");
    // Save the updated user
    await user.save();

    // Return the updated profile data
    res.json({
      fullName: user.fullName,
      email: user.email,
      phone: user.phoneNumber,
      avatarUrl: user.profilePicture,
      dob: user.dob,
      address: {
        street: user.address?.street,
        city: user.address?.city,
        state: user.address?.state,
        postalCode: user.address?.postalCode,
        country: user.address?.country,
      },
      governmentIdType: user.governmentIdType,
      languages: user.languages,
      about: user.about,
    });
  } catch (error) {
    console.error("Error updating profile:", error);
    res.status(500).json({ message: "Server error" });
  }
};

const User = require("../models/User");
const { checkPublicText, refusePublicText, addressTokensOf, checkProfileImage, refuseImages } = require("../utils/publicTextPolicy");
const ListingProperty = require("../models/ListingProperty");

// GET /api/profile - fetch user profile using email
exports.getProfile = async (req, res) => {
  try {
    // Get email from query parameters
    const email = String(req.query.email || "").trim().toLowerCase();
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
      profilePicture: user?.profilePicture ? user?.profilePicture : "",
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

// PUT /api/v1/accounts?email= — update the caller's own profile.
//
// Closed whitelist (Batch A2): dob, phoneNumber, profilePicture,
// address{street,city,state,postalCode,country}, languages, about. Names are
// admin-managed (the site renders them read-only and echoes cached values on
// every save — accepting them here would silently undo an admin's rename);
// email, role, status, kyc, bank, tokenVersion and every other field are
// never touched. firstName/lastName/dob/phoneNumber stay *required* in the
// body for client compatibility.
const ADDRESS_FIELDS = ["street", "city", "state", "postalCode", "country"];

function cleanString(v, max = 500) {
  if (v === undefined || v === null) return undefined;
  return String(v).trim().slice(0, max);
}

exports.updateProfile = async (req, res) => {
  try {
    const email = String(req.query.email || "").trim().toLowerCase();
    if (!email) {
      return res.status(400).json({ message: "Email is required" });
    }
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const { firstName, lastName, dob, phoneNumber, profilePicture, address, languages, about } = body;

    if (!firstName || !lastName || !dob || !phoneNumber) {
      return res.status(400).json({
        message: "firstName, lastName, dob, and phoneNumber are required",
      });
    }

    const user = await User.findOne({ email });
    if (!user) {
      return res.status(404).json({ message: "Profile not found" });
    }

    // Contact lock-down: `about` and `languages` are public — judged as one
    // resource (existing + patch) against contact details and the exact
    // address of every listing this user hosts.
    const nextAbout = about !== undefined ? cleanString(about, 2000) : user.about;
    const nextLanguages = languages !== undefined ? (Array.isArray(languages) ? languages.map((l) => cleanString(l, 50)).filter(Boolean).slice(0, 20) : []) : user.languages || [];
    const listings = await ListingProperty.find({ host: user._id }).select("address line1 line2").lean();
    const policy = checkPublicText(
      [{ field: "about", text: nextAbout || "" }, ...nextLanguages.map((l, i) => ({ field: `languages[${i}]`, text: String(l) }))],
      { addressTokens: listings.map(addressTokensOf) }
    );
    if (!policy.ok) return refusePublicText(res, policy);
    // a profile picture must be one of our (sanitised) bucket objects
    const image = checkProfileImage(user, body);
    if (!image.ok) return refuseImages(res, image);

    user.dob = dob;
    user.phoneNumber = cleanString(phoneNumber, 20);
    if (languages !== undefined) {
      user.languages = Array.isArray(languages) ? languages.map((l) => cleanString(l, 50)).filter(Boolean).slice(0, 20) : [];
    }
    if (about !== undefined) user.about = cleanString(about, 2000);
    if (profilePicture !== undefined) user.profilePicture = cleanString(profilePicture, 1000);
    if (address !== undefined && address !== null && typeof address === "object") {
      const current = user.address && typeof user.address.toObject === "function" ? user.address.toObject() : user.address || {};
      const next = { ...current };
      for (const field of ADDRESS_FIELDS) {
        if (address[field] !== undefined) next[field] = cleanString(address[field], 200);
      }
      user.address = next;
    }
    await user.save();

    res.json({
      firstName: user.firstName,
      lastName: user.lastName,
      fullName: `${user.firstName || ""} ${user.lastName || ""}`.trim(),
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
      governmentIdType: user.kyc?.govDoc?.docType || "",
      languages: user.languages,
      about: user.about,
    });
  } catch (error) {
    if (error && error.code === 11000) {
      return res.status(409).json({ success: false, code: "PHONE_IN_USE", message: "That phone number is already used by another account", statusCode: 409 });
    }
    console.error("Error updating profile:", error && error.message);
    res.status(500).json({ message: "Server error" });
  }
};

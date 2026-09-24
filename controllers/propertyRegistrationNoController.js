const PropertyRegistrationNo = require("../models/PropertyRegistrationNo");
const { escapeRegex } = require("../utils/listingProjection");

exports.getAll = async (req, res) => {
  try {
    const properties = await PropertyRegistrationNo.find();
    res.status(200).json({ success: true, data: properties });
  } catch (error) {
    console.error("Error fetching properties:", error);
    res.status(500).json({ success: false, message: error.message });
  }
};
// Controller to save an array of property objects
exports.saveProperties = async (req, res) => {
  try {
    const properties = req.body; // expects an array of property objects
    const result = await PropertyRegistrationNo.insertMany(properties, {
      ordered: false,
    });
    res.status(201).json({ success: true, data: result });
  } catch (error) {
    console.error("Error saving properties:", error);
    res.status(500).json({ success: false, message: error.message });
  }
};

exports.checkRegistrationNoExists = async (req, res) => {
  try {
    const registrationNo = String(req.params.registrationNo || "").trim();
    // A literal, bounded match: the number used to be a raw regex, so ".*"
    // "existed" and passed the Goa registration check.
    if (!registrationNo || registrationNo.length > 64) {
      return res.status(404).json({
        exists: false,
        message: "Registration not found. Ensure number starts with HOT",
      });
    }

    if (process.env.NEXT_PUBLIC_ENV === "dev") {
      console.log("registrationNo: ", req.params);
    }

    const property = await PropertyRegistrationNo.findOne({
      registrationNo: { $regex: new RegExp(`^${escapeRegex(registrationNo)}$`, "i") },
    });
    if (property) {
      return res.status(200).json({ exists: true, property });
    } else {
      return res.status(404).json({
        exists: false,
        message: "Registration not found. Ensure number starts with HOT",
      });
    }
  } catch (error) {
    console.error("Error checking registration number:", error);
    res.status(500).json({ success: false, message: error.message });
  }
};

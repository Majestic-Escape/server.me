const Booking = require("../models/BookingInterest");
const User = require("../models/User");
const authz = require("../middleware/authz");

exports.createBooking = async (req, res) => {
  try {
    const { propertyId, dateFrom, dateTo, guests, specialOffers } = req.body;
    // Contact lock-down: the enquiry belongs to the caller (the body's userId
    // used to resolve — and echo — any user's email).
    const actor = await authz.resolveActor(req);
    const userId = actor && actor.kind === "user" ? actor.id : null;
    if (!userId) return res.status(403).json({ success: false, code: "FORBIDDEN", message: "Not allowed" });
    const userData = await User.findById(userId);

    if (!userData) return res.status(403).json({ success: false, code: "FORBIDDEN", message: "Not allowed" });
    const email = userData.email;
    if (!propertyId || !dateFrom || !dateTo || !Number.isFinite(Number(guests))) {
      return res.status(400).json({ success: false, code: "VALIDATION_ERROR", message: "propertyId, dateFrom, dateTo and guests are required" });
    }
    // The collection keeps one enquiry per account (unique e-mail index in
    // production), so a second enquiry is an update of the first — it used to
    // fail with a raw E11000 on every enquiry after the first.
    const saved = await Booking.findOneAndUpdate(
      { email },
      { $set: { userId, email, propertyId: String(propertyId), dateFrom, dateTo, guests: Number(guests), specialOffers: !!specialOffers, createdAt: new Date() } },
      { upsert: true, new: true, runValidators: true, setDefaultsOnInsert: true },
    );
    const data = saved.toObject();
    delete data.email;

    res.status(201).json({
      success: true,
      data,
      message: "Booking created successfully",
    });
  } catch (error) {
    console.error("booking-interest create failed:", error && error.message);
    res.status(400).json({
      success: false,
      code: "BOOKING_INTEREST_FAILED",
      message: "Error creating booking",
    });
  }
};

exports.getBookings = async (req, res) => {
  try {
    const bookings = await Booking.find();
    res.status(200).json({
      success: true,
      data: bookings,
      message: "Bookings retrieved successfully",
    });
  } catch (error) {
    res.status(400).json({
      success: false,
      message: "Error retrieving bookings",
      error: error.message,
    });
  }
};

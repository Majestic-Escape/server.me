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

    const email = await userData.email;
    if (process.env.NEXT_PUBLIC_ENV === "dev") {
      console.log("this is email", email);
    }
    const newBooking = new Booking({
      userId,
      email,
      propertyId,
      dateFrom,
      dateTo,
      guests,
      specialOffers,
    });

    const savedBooking = await newBooking.save();
    const data = savedBooking.toObject();
    delete data.email;

    res.status(201).json({
      success: true,
      data,
      message: "Booking created successfully",
    });
  } catch (error) {
    res.status(400).json({
      success: false,
      message: "Error creating booking",
      error: error.message,
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

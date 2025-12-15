const Booking = require("../models/BookingInterest");
const User = require("../models/User");

exports.createBooking = async (req, res) => {
  try {
    const { userId, propertyId, dateFrom, dateTo, guests, specialOffers } =
      req.body;
    if (process.env.NEXT_PUBLIC_ENV === "dev") {
      console.log("this is id", userId);
    }
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

    res.status(201).json({
      success: true,
      data: savedBooking,
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

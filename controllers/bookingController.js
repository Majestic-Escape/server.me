const Booking = require("../models/Booking");
const puppeteer = require("puppeteer-core");
const Payment = require("../models/Payment");
const moment = require("moment-timezone");
const jwt = require("jsonwebtoken");
const ListingProperty = require("../models/ListingProperty");
const Users = require("../models/User");
const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");
const Agenda = require("agenda");
const { sendEmail } = require("../utils/sendEmail");
const User = require("../models/User");
const Razorpay = require("razorpay");
const getUnavailableDates = require("../services/getUnavailableDates");
const { blockedDates } = require("../services/blockedDates");
const { parseMDYToUTC, parseMDYToUTCBooking } = require("../utils/convertDate");
const HostPayout = require("../models/HostPayout");
const { changeToUpperCase } = require("../utils/convertToUpperCase");
const { paramsToObject } = require("../utils/paramsObject");
const agenda = require("../utils/agenda");
const generateInvoiceHTML = require("../utils/generateInvoiceHTML");
const generateInvoicePDF = require("../utils/generateInvoicePDF");
const TOKEN_EXPIRATION = "14d";
const mongoConnectionString = process.env.DB_URI;
const baseUrl = process.env.NEXTAUTH_URL;
const moderate = process.env.MODERATE_POLICY_DAYS * 24 * 60 * 60;
const flexible = process.env.FLEXIBLE_POLICY_DAYS * 60 * 60;
const key = process.env.RAZORPAY_KEY_ID;
const secret = process.env.RAZORPAY_KEY_SECRET;
const adminEmail = process.env.ADMIN_EMAIL.split(",");
// Create a new booking
// exports.createBooking = async (req, res) => {
//   try {
//     const { propertyId, checkIn, checkOut } = req.body;

//     if (!propertyId || !checkIn || !checkOut) {
//       return res.status(400).json({
//         success: false,
//         message: "propertyId, checkIn and checkOut are required",
//       });
//     }

//     const newCheckIn = new Date(checkIn);
//     newCheckIn.setHours(0, 0, 0, 0);

//     const newCheckOut = new Date(checkOut);
//     newCheckOut.setHours(0, 0, 0, 0);

//     if (
//       Number.isNaN(newCheckIn.getTime()) ||
//       Number.isNaN(newCheckOut.getTime())
//     ) {
//       return res
//         .status(400)
//         .json({ success: false, message: "Invalid date format" });
//     }

//     if (newCheckIn >= newCheckOut) {
//       return res.status(400).json({
//         success: false,
//         message: "checkIn must be earlier than checkOut",
//       });
//     }

//     // Find overlapping bookings
//     const overlapping = await Booking.findOne({
//       propertyId,
//       status: { $nin: ["rejected", "cancelled"] },
//       checkIn: { $lt: newCheckOut },
//       checkOut: { $gt: newCheckIn }, // will catch overlap
//     }).lean();

//     if (overlapping) {
//       // ✅ Special allowance: if new checkIn == existing checkOut → allow
//       process.env.ENV === 'dev' && if (process.env.NEXT_PUBLIC_ENV === "dev") {
//   console.log("S1");
// }
//       if (
//         newCheckIn.getTime() ===
//         new Date(overlapping.checkOut).setHours(0, 0, 0, 0)
//       ) {
//         // continue without blocking
//       } else {
//         return res.status(409).json({
//           success: false,
//           message: "Selected dates overlap with an existing booking",
//         });
//       }
//     }
//     process.env.ENV === 'dev' && if (process.env.NEXT_PUBLIC_ENV === "dev") {
//   console.log("S3");
// }
//     // Save booking
//     const booking = new Booking({
//       ...req.body,
//       checkIn: newCheckIn,
//       checkOut: newCheckOut,
//     });

//     await booking.save();

//     res.status(200).json({ success: true, data: booking });
//   } catch (error) {
//     res.status(400).json({ success: false, error: error.message });
//   }
// };

exports.createBooking = async (req, res) => {
  try {
    const { propertyId, checkIn, checkOut } = req.body;
    function normalizeDate(dateStr) {
      const d = new Date(dateStr);
      return new Date(
        Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()),
      );
    }
    if (!propertyId || !checkIn || !checkOut) {
      return res.status(400).json({
        success: false,
        message: "propertyId, checkIn and checkOut are required",
      });
    }

    // Normalize dates
    //  const newCheckIn = normalizeDate(checkIn);
    // const newCheckOut = normalizeDate(checkOut);
    const newCheckIn = new Date(checkIn);

    const newCheckOut = new Date(checkOut);
    console.log("Checkin and checkout Dates", newCheckIn, newCheckOut);
    if (process.env.NEXT_PUBLIC_ENV === "dev") {
      console.log("gobl", checkIn, checkOut);
    }
    if (
      Number.isNaN(newCheckIn.getTime()) ||
      Number.isNaN(newCheckOut.getTime())
    ) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid date format" });
    }

    if (newCheckIn >= newCheckOut) {
      return res.status(400).json({
        success: false,
        message: "checkIn must be earlier than checkOut",
      });
    }
    const fmt = new Intl.DateTimeFormat("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    });

    // Check overlaps
    const overlapping = await Booking.findOne({
      propertyId,
      status: { $nin: ["rejected", "cancelled"] },
      paymentStatus: "paid",
      checkIn: { $lt: newCheckOut },
      checkOut: { $gt: newCheckIn },
    }).lean();
    console.log("check overlap booking", overlapping);
    if (process.env.NEXT_PUBLIC_ENV === "dev") {
      console.log("have found any overlap", overlapping);
    }

    if (overlapping) {
      const existingCheckOut = new Date(overlapping.checkOut);
      console.log("overlapping checkout date", existingCheckOut);
      console.log(
        "gob2",
        newCheckIn.getDate(),
        newCheckIn.getMonth(),
        overlapping.checkOut.getDate(),
        overlapping.checkOut.getMonth(),
      );
      // ✅ Allow exact checkout == new checkin
      if (
        `${newCheckIn.getDate()}/${newCheckIn.getMonth()}` !==
        `${overlapping.checkOut.getDate()}/${existingCheckOut.getMonth()}`
      ) {
        return res.status(409).json({
          success: false,
          message: "Selected dates overlap with an existing booking",
        });
      }
    }
    function getOffset(utcDate) {
      const offsetHours = 5.5;
      const offsetMilliseconds = offsetHours * 3600000; // 3600 seconds * 1000 ms
      const localTime = new Date(utcDate.getTime() + offsetMilliseconds);
      return localTime;
    }
    const offsetCheckin = getOffset(newCheckIn);
    const offsetCheckout = getOffset(newCheckOut);
    // Save booking
    const booking = new Booking({
      ...req.body,
      checkIn: newCheckIn,
      checkOut: newCheckOut,
    });

    await booking.save();

    return res.status(201).json({ success: true, data: booking });
  } catch (err) {
    console.error("createBooking error:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
};

// Get all bookings (admin or host-specific)
exports.getAllBookings = async (req, res) => {
  try {
    const bookings = await Booking.find({
      source: "local",
      action: "user",
    }).populate("userId propertyId hostId");
    res.status(200).json({ success: true, data: bookings });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};

exports.getAnalyticsFilterBookings = async (req, res) => {
  try {
    const bookings = await Booking.find({
      source: "local",
      action: "user",
    }).populate("userId propertyId hostId");
    res.status(200).json({ success: true, data: bookings });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};
// Get all filtered bookings (host-specific)
// exports.getBasicFilterBookings = async (req, res) => {
//   try {
//     const { search, status, from, to } = req.query;
//     process.env.ENV === 'dev' && if (process.env.NEXT_PUBLIC_ENV === "dev") {
//   console.log("daysof", search, status, from, to);
// }
//     const bookings = await Booking.find({ source: "local" })
//       .populate("userId propertyId hostId")
//       .sort({ createdAt: -1 });

//     process.env.ENV === 'dev' && if (process.env.NEXT_PUBLIC_ENV === "dev") {
//   console.log("what is", from, to);
// }
//     function filter(users) {
//       return users.filter((booking) => {
//         const matchesSearch =
//           booking.userId?.firstName
//             ?.toLowerCase()
//             .includes(search.toLowerCase()) ||
//           booking.userId?.lastName
//             ?.toLowerCase()
//             .includes(search.toLowerCase()) ||
//           (booking.userId?.firstName + " " + booking.userId?.lastName)
//             .toLowerCase()
//             .includes(search.toLowerCase()) ||
//           booking.propertyId?.title
//             ?.toLowerCase()
//             .includes(search.toLowerCase());

//         const matchesDate = from
//           ? new Date(booking.checkIn) >= new Date(from) &&
//             new Date(booking.checkIn) <= new Date()
//           : new Date(booking.checkIn) >= new Date(from);

//         const matchesStatus =
//           status.toLowerCase() === "all"
//             ? "true"
//             : booking.status?.toLowerCase() === status.toLowerCase();

//         return matchesSearch && matchesDate && matchesStatus;
//       });
//     }

//     const final = filter(bookings);
//     res.json({ success: true, data: final });
//   } catch (error) {
//     res.status(500).json({ success: false, error: error.message });
//   }
// };
exports.getAllFilterBookings = async (req, res) => {
  try {
    const { search, status, from, to, title, hostEmail } = req.query;
    const limit = parseInt(req.query.limit) || 10;
    const skip = parseInt(req.query.skip) || 0;
    let date;
    if (to == from) {
      return res.json({ success: false, error: "toDate" });
    } else {
      date = parseMDYToUTC(from, to);
    }
    const total = await Booking.countDocuments({
      source: "local",
      action: "user",
      paymentStatus: "paid",
    });
    const filter = {
      source: "local",
      action: "user",
    };
    // const date = parseMDYToUTC(from, to);
    if (process.env.NEXT_PUBLIC_ENV === "dev") {
      console.log("rub", title, date.from, date.to);
    }
    if (status && status.toLowerCase() !== "all") {
      filter.status = { $regex: new RegExp(status, "i") };
    }

    filter.checkIn = {};
    if (from) filter.checkIn.$gte = date.from;
    if (to) filter.checkIn.$lte = date.to;

    // Fetch bookings first
    if (!title && !hostEmail && !search) {
      const bookings = await Booking.find(filter)
        .populate("userId propertyId hostId")
        .limit(limit)
        .skip(skip)
        .sort({ checkIn: 1 })
        .lean();
      res.json({ success: true, data: bookings, total: total });
    } else {
      let bookings = await Booking.find(filter)
        .populate("userId propertyId hostId")
        .sort({ checkIn: -1 })
        .lean();
      if (title && title.toLowerCase() !== "all") {
        bookings = bookings.filter((item) =>
          item.propertyId?.title?.toLowerCase().includes(title.toLowerCase()),
        );
      }

      if (hostEmail && hostEmail.toLowerCase() !== "all") {
        bookings = bookings.filter((item) =>
          item.hostId?.email?.toLowerCase().includes(hostEmail.toLowerCase()),
        );
      }

      if (search) {
        const s = search.toLowerCase();
        bookings = bookings.filter(
          (b) =>
            b.propertyId?.title?.toLowerCase().includes(s) ||
            b.userId?.firstName.toLowerCase().includes(s) ||
            b.userId?.lastName.toLowerCase().includes(s) ||
            (b.userId?.firstName + " " + b.userId?.lastName)
              .toLowerCase()
              .includes(s),
        );
      }

      bookings = bookings.slice(skip, skip + limit);
      res.json({ success: true, data: bookings, total: total });
    }
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};

exports.getHostFilterBookingStats = async (req, res) => {
  try {
    const { search, status, from, to, title, hostEmail, hostId } = req.query;

    if (process.env.NEXT_PUBLIC_ENV === "dev") {
      console.log("All the data that we need", from, to);
    }

    const limit = req.query.limit || 10;
    const skip = req.query.skip || 0;
    const filter = {
      source: "local",
      action: "user",
    };
    let date;
    if (to == from) {
      return res.json({ success: false, error: "toDate" });
    } else {
      date = parseMDYToUTC(from, to);
    }

    if (process.env.NEXT_PUBLIC_ENV === "dev") {
      console.log("rub testing", title, date.from, date.to, hostId);
    }
    if (status && status.toLowerCase() !== "all") {
      filter.status = { $regex: new RegExp(status, "i") };
    }
    if (hostId) {
      filter.hostId = hostId;
    }

    filter.checkIn = {};
    if (from) filter.checkIn.$gte = date.from;
    if (to) filter.checkIn.$lte = date.to;

    // Fetch bookings first
    let bookings = await Booking.find(filter)
      .populate("userId propertyId hostId")
      .sort({ checkIn: 1 })
      .lean();

    // Apply property title & user search in JS
    if (process.env.NEXT_PUBLIC_ENV === "dev") {
      console.log("rub2", bookings);
    }

    if (title && title.toLowerCase() !== "all") {
      bookings = bookings.filter((item) =>
        item.propertyId?.title?.toLowerCase().includes(title.toLowerCase()),
      );
    }

    if (hostEmail && hostEmail.toLowerCase() !== "all") {
      bookings = bookings.filter((item) =>
        item.hostId?.email?.toLowerCase().includes(hostEmail.toLowerCase()),
      );
    }

    if (search) {
      const s = search.toLowerCase();
      bookings = bookings.filter(
        (b) =>
          b.propertyId?.title?.toLowerCase().includes(s) ||
          b.userId?.firstName.toLowerCase().includes(s) ||
          b.userId?.lastName.toLowerCase().includes(s) ||
          (b.userId?.firstName + " " + b.userId?.lastName)
            .toLowerCase()
            .includes(s),
      );
    }

    res.json({ success: true, data: bookings });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};

exports.getHostFilterBookings = async (req, res) => {
  try {
    const { search, status, from, to, title, hostEmail, hostId } = req.query;

    const limit = parseInt(req.query.limit) || 10;
    const skip = parseInt(req.query.skip) || 0;

    if (from && to && from === to) {
      return res.json({ success: false, error: "toDate" });
    }

    const date = from && to ? parseMDYToUTC(from, to) : null;

    /** ---------------- MATCH STAGE (BASE FILTER) ---------------- */
    const matchStage = {
      source: "local",
      action: "user",
      paymentStatus: "paid",
    };

    if (status && status.toLowerCase() !== "all") {
      matchStage.status = new RegExp(`^${status}$`, "i");
    }

    if (hostId) {
      matchStage.hostId = new mongoose.Types.ObjectId(hostId);
    }

    if (date) {
      matchStage.checkIn = {
        ...(from && { $gte: date.from }),
        ...(to && { $lte: date.to }),
      };
    }

    /** ---------------- AGGREGATION PIPELINE ---------------- */
    const pipeline = [
      { $match: matchStage },

      // user
      {
        $lookup: {
          from: "users",
          localField: "userId",
          foreignField: "_id",
          as: "userId",
        },
      },
      { $unwind: "$userId" },

      // property
      {
        $lookup: {
          from: "listingproperties",
          localField: "propertyId",
          foreignField: "_id",
          as: "propertyId",
        },
      },
      { $unwind: "$propertyId" },

      // host
      {
        $lookup: {
          from: "users",
          localField: "hostId",
          foreignField: "_id",
          as: "hostId",
        },
      },
      { $unwind: "$hostId" },
    ];

    /** ---------------- TEXT FILTERS ---------------- */
    const textFilters = [];

    if (title && title.toLowerCase() !== "all") {
      textFilters.push({
        "propertyId.title": { $regex: title, $options: "i" },
      });
    }

    if (hostEmail && hostEmail.toLowerCase() !== "all") {
      textFilters.push({
        "hostId.email": { $regex: hostEmail, $options: "i" },
      });
    }

    if (search && search.trim()) {
      const s = search.trim();
      textFilters.push({
        $or: [
          { "propertyId.title": { $regex: s, $options: "i" } },
          { "userId.firstName": { $regex: s, $options: "i" } },
          { "userId.lastName": { $regex: s, $options: "i" } },
          {
            $expr: {
              $regexMatch: {
                input: {
                  $concat: ["$userId.firstName", " ", "$userId.lastName"],
                },
                regex: s,
                options: "i",
              },
            },
          },
        ],
      });
    }

    if (textFilters.length) {
      pipeline.push({ $match: { $and: textFilters } });
    }

    /** ---------------- SORT + PAGINATION ---------------- */
    pipeline.push(
      { $sort: { checkIn: 1 } },
      {
        $facet: {
          data: [{ $skip: skip }, { $limit: limit }],
          totalCount: [{ $count: "count" }],
        },
      },
    );

    /** ---------------- EXECUTE ---------------- */
    const result = await Booking.aggregate(pipeline);

    const bookings = result[0].data;
    const total = result[0].totalCount[0]?.count || 0;

    res.json({
      success: true,
      data: bookings,
      total,
      limit,
      skip,
      hasMore: skip + limit < total,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
};

exports.getRevenueFilter = async (req, res) => {
  try {
    const { search, status, from, to, title, hostEmail, hostId } = req.query;

    const filter = {};

    const date = parseMDYToUTC(from, to);

    if (process.env.NEXT_PUBLIC_ENV === "dev") {
      console.log("rev", title, date.from, date.to, status);
    }
    if (status && status.toLowerCase() !== "all") {
      filter.status = { $regex: new RegExp(status, "i") };
    }

    if (from || to) {
      filter.createdAt = {};
      if (from) filter.createdAt.$gte = date.from;
      if (to) filter.createdAt.$lte = date.to;
    }
    if (process.env.NEXT_PUBLIC_ENV === "dev") {
      console.log("rev1.5", title);
    }
    // Fetch bookings first
    let bookings = await HostPayout.find(filter)
      .populate([
        {
          path: "bookingId",
          model: "Booking",
          select: "userId checkIn checkOut",
          populate: {
            path: "userId",
            model: "User",
            select: "firstName lastName", // whatever fields you want
          },
        },
        {
          path: "propertyId",
          model: "ListingProperty",
          select: "title host",
        },
      ])
      .sort({ createdAt: -1 })
      .lean();

    // Apply property title & user search in JS
    if (process.env.NEXT_PUBLIC_ENV === "dev") {
      console.log("rev2", bookings);
    }
    if (hostId) {
      bookings = bookings.filter((item) => item.propertyId?.host == hostId);
    }
    if (title && title.toLowerCase() !== "all") {
      bookings = bookings.filter((item) =>
        item.propertyId?.title?.toLowerCase().includes(title.toLowerCase()),
      );
    }

    if (hostEmail && hostEmail.toLowerCase() !== "all") {
      bookings = bookings.filter((item) =>
        item.hostId?.email?.toLowerCase().includes(hostEmail.toLowerCase()),
      );
    }

    if (search) {
      const s = search.toLowerCase();
      bookings = bookings.filter(
        (b) =>
          b.propertyId?.title?.toLowerCase().includes(s) ||
          b.bookingId?.userId?.firstName.toLowerCase().includes(s) ||
          b.bookingId?.userId?.lastName.toLowerCase().includes(s) ||
          (b.bookingId?.userId?.firstName + " " + b.bookingId?.userId?.lastName)
            .toLowerCase()
            .includes(s),
      );
    }

    res.json({ success: true, data: bookings });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};

exports.updateCloseModal = async (req, res) => {
  try {
    const { bookingId } = req.body;
    if (process.env.NEXT_PUBLIC_ENV === "dev") {
      console.log("triggggg");
    }
    const data = await Booking.findByIdAndUpdate(bookingId, {});

    res.json({ success: true, data: data });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};
exports.modifyBooking = async (req, res) => {
  try {
    const {
      bookingId,
      hostEmail,
      userEmail,
      adults,
      children,
      guest,
      property,
      from,
      to,
    } = req.query;

    const date = parseMDYToUTCBooking(from, to);
    const filter = {
      guests: Number(guest),
      adults: Number(adults),
      checkIn: date.from,
      checkOut: date.to,
    };
    if (property && property.toLowerCase() != "all") {
      filter.propertyId = property;
    }
    if (children) {
      filter.children = Number(children);
    }
    const data = await Booking.findByIdAndUpdate(bookingId, filter);
    if (!data) {
      return res
        .status(404)
        .json({ success: false, message: "Booking not found" });
    }
    const params = { firstName: "Ad" };
    await sendEmail(hostEmail, 40, params);
    await sendEmail(userEmail, 40, params);

    res.status(200).json({ success: true, data: data });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};

exports.updateFlag = async (req, res) => {
  try {
    const { id, email } = req.query;
    const data = await Booking.findByIdAndUpdate(id, { flag: true }).populate(
      "hostId propertyId userId payment",
    );
    if (!data) {
      return res
        .status(404)
        .json({ success: false, message: "Booking not found" });
    }
    if (process.env.NEXT_PUBLIC_ENV === "dev") {
      console.log(email);
    }
    const params = paramsToObject(userName, lastName, data);
    // const params = {
    //   userName: userName,
    //   hostName: hostName,
    //   hostEmail: data.hostId.email,
    //   hostContact: data.hostId.phoneNumber,
    //   guestEmail: data.userId.email,
    //   guestContact: data.userId.phoneNumber,
    //   bookingId: data._id,
    //   from: new Date(data.checkIn).toLocaleDateString(),
    //   to: new Date(data.checkOut).toLocaleDateString(),
    //   checkInTime: changeTime(data.propertyId.checkinTime),
    //   checkOutTime: changeTime(data.propertyId.checkoutTime),
    //   propertyTitle: data.propertyId.title,
    //   adults: data.adults,
    //   children: data.children,
    //   amount: data.price,
    //   paymentId: data.payment.paymentId,
    // };
    await sendEmail(email, 39, params);
    res.status(200).json({ success: true, data: data });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};
exports.getActiveBookings = async (req, res) => {
  try {
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);

    // End of the day (11:59:59 PM)
    const endOfDay = new Date();
    endOfDay.setHours(23, 59, 59, 999);

    const now = new Date();
    // Query: checkIn <= endOfDay AND checkOut >= startOfDay
    const bookings = await Booking.find({
      checkIn: { $lte: endOfDay },
      checkOut: { $gte: startOfDay },
    }).populate("userId propertyId hostId");

    const bookingData = bookings.filter((item) => {
      if (!item.propertyId?.checkinTime || !item.propertyId?.checkoutTime) {
        return false; // skip if property has no time info
      }

      // Build full datetime objects for checkin & checkout
      const checkinDateTime = new Date(item.checkIn);
      checkinDateTime.setHours(item.propertyId.checkinTime, 0, 0, 0);

      const checkoutDateTime = new Date(item.checkOut);
      checkoutDateTime.setHours(item.propertyId.checkoutTime, 0, 0, 0);

      // Current time must fall between checkin and checkout datetimes
      return now >= checkinDateTime && now <= checkoutDateTime;
    });

    res.json({ success: true, data: bookingData });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};

exports.getAllHostEmails = async (req, res) => {
  const emails = await ListingProperty.find({
    status: "active",
  });
  if (!emails) {
    return res
      .status(404)
      .json({ success: false, message: "Host email not found" });
  }

  res.status(200).json({ success: true, data: emails });
};
exports.getAllUserBookings = async (req, res) => {
  try {
    const { userId } = req.query;
    const bookings = await Booking.find({
      userId: userId,
      source: "local",
      action: "user",
      paymentStatus: "paid",
    })
      .populate("userId propertyId hostId")
      .sort({ createdAt: -1 })
      .lean();
    if (!bookings) {
      return res
        .status(404)
        .json({ success: false, message: "Booking not found" });
    }
    res.status(200).json({ success: true, data: bookings });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};

// Get bookings for a specific user
exports.getBookingsByUser = async (req, res) => {
  try {
    const bookings = await Booking.find({
      userId: req.params.userId,
      source: "local",
      action: "user",
    }).populate("propertyId hostId");
    res.status(200).json({ success: true, data: bookings });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};

// Get bookings for a specific host
exports.getBookingsByHost = async (req, res) => {
  try {
    const bookings = await Booking.find({
      hostId: req.params.hostId,
      source: "local",
      action: "user",
    }).populate("userId propertyId");
    res.status(200).json({ success: true, data: bookings });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};

exports.generatePdf = async (req, res) => {
  try {
    if (process.env.NEXT_PUBLIC_ENV === "dev") {
      console.log("🧪 Starting Puppeteer...");
    }

    const browser = await puppeteer.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
      ],
    });

    const page = await browser.newPage();

    await page.setContent(`
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Invoice - Majestic Escape</title>
  <style>
    body {
      font-family: Arial, sans-serif;
      background-color: #f9fafb;
      display: flex;
      justify-content: center;
      padding: 40px 0;
      margin: 0;
    }

    .invoice-container {
      background-color: #fff;
      width: 100%;
      max-width: 700px;
      
      
      padding: 32px;
    }

    h1, h2, h3 {
      margin: 0;
      color: #1f2937;
    }

    p {
      margin: 4px 0;
    }

    .header {
      border-bottom: 1px solid #e5e7eb;
      padding-bottom: 16px;
      margin-bottom: 24px;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }

    .header img {
      width: 48px;
      height: 48px;
    }

    .section {
      margin-bottom: 24px;
    }

    .section h3 {
      font-size: 14px;
      font-weight: 600;
      margin-bottom: 6px;
    }

    .text-sm {
      font-size: 14px;
      color: #4b5563;
    }

    .text-gray {
      color: #6b7280;
    }

    .font-semibold {
      font-weight: 600;
    }

    .font-medium {
      font-weight: 500;
    }

    .border-t {
      border-top: 1px solid #e5e7eb;
    }

    .border-b {
      border-bottom: 1px solid #e5e7eb;
    }

    .py-4 {
      padding-top: 16px;
      padding-bottom: 16px;
    }

    .price-row {
      display: flex;
      justify-content: space-between;
      font-size: 14px;
      color: #374151;
    }

    .total-row {
      border-top: 1px solid #e5e7eb;
      margin-top: 8px;
      padding-top: 8px;
      font-weight: 600;
    }

    .underline a {
      text-decoration: underline;
      color: #2563eb;
      margin-right: 16px;
      font-size: 14px;
    }

    .footer {
      border-top: 1px solid #e5e7eb;
      padding-top: 16px;
      font-size: 12px;
      color: #6b7280;
    }

    .footer a {
      color: #2563eb;
      text-decoration: underline;
    }
  </style>
</head>
<body>
  <div class="invoice-container">
    <!-- Header -->
    <div class="header">
      <div>
        <h1>Your receipt from Majestic Escape</h1>
        <p class="text-sm text-gray">
          Booking ID: <span class="font-medium text-gray">RC54F8Q3EA</span> · April 7, 2025
        </p>
      </div>
      <img src="logo.svg" alt="Logo" />
    </div>

    <!-- Property Info -->
    <div class="section">
      <h2 class="font-semibold">Parcem</h2>
      <p class="text-sm text-gray">1 night in Parcem</p>
      <p class="text-sm text-gray">Fri, Apr 25, 2025 – Sat, Apr 26, 2025</p>
      <p class="text-sm text-gray">Entire home/apt · 1 bed · 1 guest</p>
      <p class="text-sm text-gray">Hosted by <span class="font-medium">Olesia Shtanko</span></p>
      <div style="margin-top: 8px;">
        <p class="text-sm text-gray">
          Confirmation code: <span class="font-semibold">HM5ZA5R82N</span>
        </p>
        <div class="underline" style="margin-top: 8px;">
          <a href="#">Go to itinerary</a>
          <a href="#">Go to listing</a>
        </div>
      </div>
    </div>

    <!-- Traveler Info -->
    <div class="section border-t border-b py-4">
      <p class="text-sm">
        <span class="font-semibold">Traveler:</span> Deepam Lotlikar
      </p>
    </div>

    <!-- Cancellation Policy -->
    <div class="section">
      <h3>Cancellation policy</h3>
      <p class="text-sm text-gray">
        Free cancellation before 1:00 PM on Apr 20. After that, the reservation is non-refundable.
        Cutoff times are based on the listing’s local time.
      </p>
    </div>

    <!-- Price Breakdown -->
    <div class="section">
      <h3>Price breakdown</h3>
      <div class="text-sm">
        <div class="price-row"><span>₹2,500.00 × 1 night</span><span>₹2,500.00</span></div>
        <div class="price-row"><span>Majestic Escape service fee</span><span>₹352.94</span></div>
        <div class="price-row"><span>Taxes</span><span>₹300.00</span></div>
        <div class="price-row total-row"><span>Total (INR)</span><span>₹3,152.94</span></div>
      </div>
    </div>

    <!-- Payment Info -->
    <div class="section">
      <h3>Payment</h3>
      <div class="text-sm text-gray">
        <p>UPI</p>
        <p>April 7, 2025, 2:29:26 PM GMT+5:30</p>
        <p class="font-medium">₹3,152.94</p>
        <div class="price-row total-row">
          <span>Amount paid (INR)</span>
          <span>₹3,152.94</span>
        </div>
      </div>
    </div>

    <!-- Taxes Info -->
    <div class="section text-sm text-gray">
      <p>Occupancy taxes include CGST (In - Goa), SGST (In - Goa).</p>
      <p style="margin-top: 8px;">
        Majestic Escape Payments India Pvt. Ltd. is a limited payment collection agent of your Host.
        Upon payment of the total price to Majestic Escape Payments, your payment obligation to your host is satisfied.
      </p>
    </div>

    <!-- Footer -->
    <div class="footer">
      <p>
        Payment processed by Majestic Escape Payments India Pvt. Ltd.<br />
        c/o 4th floor, Statesman House, Barakhamba Road, Connaught Place, New Delhi - 110001
      </p>
      <p style="margin-top: 8px;">
        Level 9, Spaze i-Tech Park, A1 Tower, Sector 49, Sohna Road, Gurugram, India - 122018
      </p>
      <p style="margin-top: 8px;">
        <a href="https://www.majesticescape.in">www.majesticescape.in</a>
      </p>
    </div>
  </div>
</body>
</html>

    `);

    const pdfBuffer = await page.pdf({
      format: "A4",
      printBackground: true,
    });

    await browser.close();

    if (process.env.NEXT_PUBLIC_ENV === "dev") {
      console.log("✅ PDF generated successfully, size:", pdfBuffer.length);
    }

    // 🧠 Critical headers
    res.set({
      "Content-Type": "application/pdf",
      "Content-Disposition": "inline; filename=test.pdf",
      "Content-Length": pdfBuffer.length,
    });

    // 🧱 Must use .end() to send binary data
    res.end(pdfBuffer);
  } catch (err) {
    console.error("❌ PDF generation failed:", err);
    res.status(500).send("Internal Server Error");
  }
};

// Test endpoint to check if PDF generation works
exports.testPdf = async (req, res) => {
  try {
    if (process.env.NEXT_PUBLIC_ENV === "dev") {
      console.log("🧪 Testing PDF generation...");
    }

    const browser = await puppeteer.launch({
      headless: "new",
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });

    const page = await browser.newPage();

    // Very simple HTML for testing
    await page.setContent(`
      <html>
        <body>
          <h1>Test PDF</h1>
          <p>This is a test PDF generated at ${new Date().toISOString()}</p>
          <p>If you can see this, PDF generation is working!</p>
        </body>
      </html>
    `);

    const pdfBuffer = await page.pdf({ format: "A4" });
    await browser.close();

    if (process.env.NEXT_PUBLIC_ENV === "dev") {
      console.log("✅ Test PDF generated successfully");
    }

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", 'attachment; filename="test.pdf"');
    res.send(pdfBuffer);
  } catch (error) {
    console.error("❌ Test PDF failed:", error);
    res.status(500).json({
      success: false,
      error: "Test failed",
      message: error.message,
    });
  }
};
exports.getBookingsByHostGroupByUsers = async (req, res) => {
  try {
    const { search, from, to, title, hostId } = req.query;
    if (process.env.NEXT_PUBLIC_ENV === "dev") {
      console.log("mys", hostId);
    }

    // 1. Build filter
    const filter = {
      source: "local",
      action: "user",
      status: "confirmed",
    };
    let date;
    if (to == from) {
      return res.json({ success: false, error: "toDate" });
    } else {
      date = parseMDYToUTC(from, to);
    }
    filter.checkIn = {};
    if (from) filter.checkIn.$gte = date.from;
    if (to) filter.checkIn.$lte = date.to;

    if (hostId && hostId.toLowerCase() != "all") {
      filter.userId = new mongoose.Types.ObjectId(hostId);
    }
    // const date = parseMDYToUTC(from, to);
    // if (from || to) {
    //   filter.checkIn = {};
    //   if (from) filter.checkIn.$gte = new Date(date.from);
    //   if (to) filter.checkIn.$lte = new Date(date.to);
    // }

    // 2. Aggregation pipeline
    let bookings = await Booking.aggregate([
      { $match: filter },
      {
        $group: {
          _id: "$userId",
          totalBookings: { $sum: 1 },
          totalAmountSpent: { $sum: "$price" },

          totalReviews: {
            $sum: {
              $cond: [
                {
                  $or: [{ $eq: ["$reviewed", true] }],
                },
                1,
                0,
              ],
            },
          },
          // keep refs for populate
          userId: { $first: "$userId" },
        },
      },
      { $sort: { totalBookings: -1 } }, // sort inside pipeline
    ]);

    // 3. Populate refs
    bookings = await Booking.populate(bookings, [
      { path: "userId", select: "firstName lastName email averageRating kyc" },
      { path: "hostId", select: "email" },
      { path: "propertyId", select: "title" },
    ]);

    // 4. Apply JS filters after populate
    if (title && title.toLowerCase() !== "all") {
      bookings = bookings.filter((item) =>
        item.propertyId?.title?.toLowerCase().includes(title.toLowerCase()),
      );
    }
    if (process.env.NEXT_PUBLIC_ENV === "dev") {
      console.log("p3", bookings);
    }
    if (search) {
      const s = search.toLowerCase();
      bookings = bookings.filter(
        (b) =>
          b.propertyId?.title?.toLowerCase().includes(s) ||
          `${b.userId?.firstName} ${b.userId?.lastName}`
            .toLowerCase()
            .includes(s),
      );
    }

    res.json({ success: true, data: bookings });
  } catch (error) {
    console.error("Error fetching bookings:", error);
    res.status(500).json({ success: false, error: error.message });
  }
};

// Get a specific booking by ID
exports.getBookingById = async (req, res) => {
  try {
    const booking = await Booking.findById(req.params.bookingId).populate(
      "userId propertyId hostId",
    );
    if (process.env.NEXT_PUBLIC_ENV === "dev") {
      console.log("try try", booking);
    }
    if (!booking)
      return res
        .status(404)
        .json({ success: false, message: "Booking not found" });
    res.status(200).json({ success: true, data: booking });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};

// Update a booking
exports.updateBooking = async (req, res) => {
  try {
    const booking = await Booking.findByIdAndUpdate(
      req.params.bookingId,
      req.body,
      { new: true },
    );
    if (!booking)
      return res
        .status(404)
        .json({ success: false, message: "Booking not found" });
    res.status(200).json({ success: true, data: booking });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
};

// Reject a booking
exports.cancelBooking = async (req, res) => {
  try {
    const { bookingId, userEmail, hostEmail, userName, hostName } = req.body;
    const booking = await Booking.findByIdAndUpdate(bookingId, {
      status: "rejected",
    }).populate("hostId userId propertyId payment");
    const params = paramsToObject(userName, hostName, booking);
    if (!booking)
      return res
        .status(404)
        .json({ success: false, message: "Booking not found" });

    const instance = new Razorpay({ key_id: key, key_secret: secret });
    let refundSuccessful = false;

    const paymentData = await Payment.findOneAndUpdate(
      { bookingId: bookingId },
      { status: "refund initiated" },
      { new: true },
    );
    if (process.env.NEXT_PUBLIC_ENV === "dev") {
      console.log("batm1");
    }
    const payment = await Payment.findOne({ bookingId: bookingId });
    if (!payment) {
      return res.status(404).json({
        success: false,
        message: "Payment refund initiation failed",
      });
    }
    if (process.env.NEXT_PUBLIC_ENV === "dev") {
      console.log("batm2");
    }
    const refund = await instance.payments.refund(payment.paymentId, {
      amount: payment.amount,
      speed: "normal",
      notes: { notes_key_1: "Full Refund" },
      receipt: `Refund No. ${bookingId}`,
    });
    if (process.env.NEXT_PUBLIC_ENV === "dev") {
      console.log("batm3");
    }
    if (!refund) {
      return res
        .status(404)
        .json({ success: false, message: "Payment refund failed" });
    }
    if (process.env.NEXT_PUBLIC_ENV === "dev") {
      console.log("batm4");
    }
    refundSuccessful = true;

    // Update statuses only if refund is successful
    await Payment.findOneAndUpdate(
      { bookingId: bookingId },
      { status: "refunded" },
      { paymentType: "refunded" },
    );
    await Booking.findByIdAndUpdate(bookingId, { paymentStatus: "refunded" });

    await sendEmail(userEmail, 11, params);

    await Promise.all(
      adminEmail.map((email) => sendEmail(email.trim(), 16, params)),
    );
    await sendEmail(hostEmail, 17, params);
    res.status(200).json({ success: true, data: booking });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
};

exports.cancelAdminBooking = async (req, res) => {
  try {
    const { bookingId } = req.body;
    if (process.env.NEXT_PUBLIC_ENV === "dev") {
      console.log("testc", bookingId);
    }
    const booking = await Booking.findByIdAndUpdate(bookingId, {
      status: "cancelled",
    }).populate("userId hostId propertyId payment");
    if (!booking)
      return res
        .status(404)
        .json({ success: false, message: "Booking not found" });
    // const data = await Booking.findById(bookingId).populate("userId hostId");
    // if (!data) {
    //   return res
    //     .status(404)
    //     .json({ success: false, message: "User data not found" });
    // }
    const userName = changeToUpperCase(
      booking?.userId?.firstName + " " + booking?.userId?.lastName,
    );
    const hostName = changeToUpperCase(
      booking?.hostId?.firstName + " " + booking?.hostId?.lastName,
    );

    const instance = new Razorpay({ key_id: key, key_secret: secret });
    let refundSuccessful = false;

    const paymentData = await Payment.findOneAndUpdate(
      { bookingId: bookingId },
      { status: "refund initiated" },
      { new: true },
    );
    if (process.env.NEXT_PUBLIC_ENV === "dev") {
      console.log("batm1");
    }
    const payment = await Payment.findOne({ bookingId: bookingId });
    if (!payment) {
      return res.status(404).json({
        success: false,
        message: "Payment refund initiation failed",
      });
    }
    if (process.env.NEXT_PUBLIC_ENV === "dev") {
      console.log("batm2");
    }
    const refund = await instance.payments.refund(payment.paymentId, {
      amount: payment.amount,
      speed: "normal",
      notes: { notes_key_1: "Full Refund" },
      receipt: `Refund No. ${bookingId}`,
    });
    if (process.env.NEXT_PUBLIC_ENV === "dev") {
      console.log("batm3");
    }
    if (!refund) {
      return res
        .status(404)
        .json({ success: false, message: "Payment refund failed" });
    }
    if (process.env.NEXT_PUBLIC_ENV === "dev") {
      console.log("batm4");
    }
    refundSuccessful = true;

    // Update statuses only if refund is successful
    await Payment.findOneAndUpdate(
      { bookingId: bookingId },
      { status: "refunded", paymentType: "refunded" }, // ✅ both fields updated
      { new: true },
    );
    await Booking.findByIdAndUpdate(bookingId, {
      paymentStatus: "refunded",
    }).populate("hostId userId propertyId payment");
    const params = paramsToObject(userName, hostName, booking);

    await sendEmail(booking.userId.email, 32, params);

    await Promise.all(
      adminEmail.map((email) => sendEmail(email.trim(), 31, params)),
    );

    await sendEmail(booking.hostId.email, 33, params);
    res.status(200).json({
      success: true,
      message: refundSuccessful
        ? "Refund issued and booking terminated"
        : "Booking cancelled without refund",
      data: booking,
    });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
};

exports.checkDates = async (req, res) => {
  try {
    const { propertyId } = req.params;

    const today = new Date();
    today.setHours(0, 0, 0, 0); // normalize to midnight

    const bookings = await Booking.find({
      propertyId,
      paymentStatus: "paid",
      checkOut: { $gt: today }, // only future or today’s checkIn
      status: { $nin: ["rejected", "cancelled"] }, // exclude rejected & cancelled
    });

    const todayBooking = [];
    const datesArray = [];

    blockedDates(bookings, datesArray, todayBooking, today);

    if (process.env.NEXT_PUBLIC_ENV === "dev") {
      console.log("final output", datesArray);
    }
    res.json({ success: true, data: datesArray, today: todayBooking });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

exports.blockedDates = async (req, res) => {
  try {
    const { propertyId } = req.params;

    const today = new Date();
    today.setHours(0, 0, 0, 0); // normalize to midnight

    const bookings = await Booking.find({
      propertyId,
      paymentStatus: "paid",
      checkOut: { $gt: today }, //checkin:gte:today
      status: { $nin: ["rejected", "cancelled"] }, // exclude rejected & cancelled
      action: "user",
    });
    const manualBlock = await Booking.find({
      propertyId,
      checkOut: { $gt: today }, // only future or today’s checkIn
      status: { $nin: ["rejected", "cancelled"] }, // exclude rejected & cancelled
      action: "host",
    });
    // console.log("bloc", bookings);
    const todayBooking = [];
    const datesArray = [];

    const todayHostBooking = [];
    const datesHostArray = [];
    blockedDates(bookings, datesArray, todayBooking, today);
    blockedDates(manualBlock, datesHostArray, todayHostBooking, today);

    res.json({
      success: true,
      data: datesArray,
      today: todayBooking,
      blocked: datesHostArray,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

//host side unblocking dates that host blocked
exports.unblockDates = async (req, res) => {
  if (process.env.NEXT_PUBLIC_ENV === "dev") {
    console.log("entsssssssss");
  }
  try {
    const { propertyId } = req.params;
    const { selectedDate } = req.body;

    const from = moment.utc(selectedDate).startOf("day").toDate();
    const to = moment.utc(selectedDate).endOf("day").toDate();
    // normalize to midnight

    if (process.env.NEXT_PUBLIC_ENV === "dev") {
      console.log("unblock1", from, to, selectedDate);
    }

    const booking = await Booking.findOne({
      propertyId,
      source: "local",
      checkIn: { $gte: from, $lt: to }, // only future or today’s checkIn

      status: { $nin: ["rejected", "cancelled"] }, // exclude rejected & cancelled

      action: "host",
    }).lean();
    if (!booking) {
      return res.status(404).json({
        success: false,
        message: "No booking found for that date",
      });
    }
    if (process.env.NEXT_PUBLIC_ENV === "dev") {
      console.log("unblock2", booking);
    }
    const unblock = await Booking.findByIdAndUpdate(
      booking._id,
      { status: "cancelled" },
      { new: true },
    );
    if (process.env.NEXT_PUBLIC_ENV === "dev") {
      console.log("unblock3", unblock);
    }
    res.json({
      success: true,
      data: unblock,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};
// exports.checkDates = async (req, res) => {
//   try {
//     const { propertyId } = req.params;

//     const date = new Date();
//     date.setHours(0, 0, 0, 0); // normalize to midnight

//     const bookings = await Booking.find({
//       propertyId,
//       checkIn: { $gte: date }, // only future or today’s checkIn
//       status: { $nin: ["rejected", "cancelled"] }, // exclude rejected & cancelled
//     });

//     const todayBooking = [];
//     const datesArray = [];

//     const todayDate = new Date();
//     const today = new Date(todayDate.toLocaleDateString());

//     // const unavailableDates = await getUnavailableDates(propertyId);
//     for (const i of bookings) {
//       const checkIn = new Date(bookings[i].checkIn);
//       const checkOut = new Date(bookings[i].checkOut);
//       if (isNaN(checkIn.getTime()) || isNaN(checkOut.getTime())) {
//         return; // Skip invalid dates
//       }

//       const currentDate = new Date(checkIn);
//       process.env.ENV === 'dev' && if (process.env.NEXT_PUBLIC_ENV === "dev") {
//   console.log("haya", currentDate, checkOut);
// }
//       while (currentDate <= checkOut && checkIn >= today) {
//         const formattedDate = currentDate.toISOString().split("T")[0]; // Alternative method
//         if (
//           currentDate.toISOString().split("T")[0] !==
//           checkOut.toISOString().split("T")[0]
//         ) {
//           datesArray.push(formattedDate);
//         }
//         currentDate.setDate(currentDate.getDate() + 1);
//       }

//       const newdate = new Date(checkIn.toLocaleDateString())
//         .toISOString()
//         .split("T")[0];

//       if (newdate == today.toISOString().split("T")[0]) {
//         const next = new Date(checkOut);
//         if (!todayBooking.includes(next)) {
//           todayBooking.push(next.setDate(next.getDate() + 1));
//         }
//       }
//     }

//     process.env.ENV === 'dev' && if (process.env.NEXT_PUBLIC_ENV === "dev") {
//   console.log("final outpu", datesArray);
// }
//     res.json({ success: true, data: datesArray, today: todayBooking });
//   } catch (err) {
//     res.status(500).json({ success: false, message: err.message });
//   }
// };

//Cancel a booking (host)
exports.terminateBooking = async (req, res) => {
  try {
    const { bookingId, userEmail, hostEmail, userName, hostName } = req.body;
    const ObjectId = require("mongoose").Types.ObjectId;
    const id = new ObjectId(`${bookingId}`);
    const booking = await Booking.findByIdAndUpdate(bookingId, {
      status: "cancelled",
    }).populate("userId hostId propertyId payment");

    if (!booking)
      return res
        .status(404)
        .json({ success: false, message: "Booking not found" });

    const params = paramsToObject(userName, hostName, booking);

    const instance = new Razorpay({ key_id: key, key_secret: secret });

    let refundSuccessful = false;

    const paymentData = await Payment.findOneAndUpdate(
      { bookingId: bookingId },
      { status: "refund initiated" },
      { new: true },
    );
    if (process.env.NEXT_PUBLIC_ENV === "dev") {
      console.log("batm1", paymentData);
    }
    const payment = await Payment.findOne({ bookingId: id });
    if (!payment) {
      return res.status(404).json({
        success: false,
        message: "Payment refund initiation failed",
      });
    }
    if (process.env.NEXT_PUBLIC_ENV === "dev") {
      console.log("batm2", payment);
    }
    const refund = await instance.payments.refund(payment.paymentId, {
      amount: payment?.amount,
      speed: "normal",
      notes: { notes_key_1: "Full Refund" },
      receipt: `Refund No. ${bookingId}`,
    });

    if (process.env.NEXT_PUBLIC_ENV === "dev") {
      console.log("batm3");
    }
    if (!refund) {
      return res
        .status(404)
        .json({ success: false, message: "Payment refund failed" });
    }
    if (process.env.NEXT_PUBLIC_ENV === "dev") {
      console.log("batm4");
    }
    refundSuccessful = true;

    // Update statuses only if refund is successful
    await Payment.findOneAndUpdate(
      { bookingId: bookingId },
      { status: "refunded" },
      { paymentType: "refunded" },
    );
    await Booking.findByIdAndUpdate(bookingId, { paymentStatus: "refunded" });

    await sendEmail(userEmail, 13, params);
    await sendEmail(hostEmail, 14, params);

    await Promise.all(
      adminEmail.map((email) => sendEmail(email.trim(), 15, params)),
    );

    res.status(200).json({ success: true, data: booking });
  } catch (err) {
    if (err.response) {
      console.error("Razorpay Error Status:", err.response.status);
      console.error("Razorpay Error Body:", err.response.data); // 👈 full details
    } else {
      console.error("Refund Error:", err);
    }
    return res.status(400).json({
      success: false,
      error: err.response?.data || err.message,
    });
  }
};

//Cancel a booking (user)
// exports.terminateUserBooking = async (req, res) => {
//   try {
//     const { bookingId, userEmail, hostEmail, userName, hostName } = req.body;

//     const booking = await Booking.findByIdAndUpdate(bookingId, {
//       status: "cancelled",
//     });
//     if (!booking) {
//       return res
//         .status(404)
//         .json({ success: false, message: "Booking not found" });
//     }

//     const bookingData = await Booking.findById(bookingId);
//     if (!bookingData) {
//       return res
//         .status(404)
//         .json({ success: false, message: "Check Out date not found" });
//     }
//     process.env.ENV === 'dev' && if (process.env.NEXT_PUBLIC_ENV === "dev") {
//   console.log("get date", bookingData.checkOut);
// }
//     const futureDate = new Date(bookingData.checkOut);
//     const date1 = new Date();
//     const differenceInSeconds = (futureDate - date1) / 1000;

//     async function execute() {
//       process.env.ENV === 'dev' && if (process.env.NEXT_PUBLIC_ENV === "dev") {
//   console.log("reached ex");
// }
//       const ObjectId = require("mongoose").Types.ObjectId;
//       const id = new ObjectId(`${bookingId}`);

//       const paymentStatus = await Payment.findOneAndUpdate(
//         { bookingId: id },
//         { status: "refund initiated" },
//         { new: true }
//       );
//       if (!paymentStatus) {
//         return res.status(404).json({
//           success: false,
//           message: "Payment refund initiation failed",
//         });
//       }

//       const instance = new Razorpay({ key_id: key, key_secret: secret });
//       const paymentData = await Payment.findOne({ bookingId: id });
//       const refund = await instance.payments.refund(paymentData.paymentId, {
//         amount: paymentData.amount,
//         speed: "normal",
//         notes: {
//           notes_key_1: "Full Refund",
//         },
//         receipt: `Refund No. ${bookingId}`,
//       });

//       return refund;
//     }
//     if (
//       bookingData.cancellationPolicy == "moderate" &&
//       differenceInSeconds >= moderate
//     ) {
//       const checkTransaction = await execute();
//       if (!checkTransaction) {
//         return;
//       }
//     }

//     if (
//       bookingData.cancellationPolicy == "flexible" &&
//       differenceInSeconds >= flexible
//     ) {
//       process.env.ENV === 'dev' && if (process.env.NEXT_PUBLIC_ENV === "dev") {
//   console.log("now ex", differenceInSeconds);
// }
//       execute();
//     }

//     const ObjectId = require("mongoose").Types.ObjectId;
//     const id = new ObjectId(`${bookingId}`);
//     const updatePaymentData = await Payment.findOneAndUpdate(
//       { bookingId: id },
//       { status: "refunded" }
//     );
//     const updateBookingData = await Booking.findByIdAndUpdate(bookingId, {
//       status: "refunded",
//     });
//     const params = { userName: userName, hostName: hostName };

//     const adminEmail = "majesticescape.in@gmail.com";

//     await sendEmail(userEmail, 22, params);
//     await sendEmail(hostEmail, 20, params);
//     // await sendEmail(adminEmail, 21, params);

//     res.status(200).json({
//       success: true,
//       paymentData: updatePaymentData,
//       bookingData: updateBookingData,
//     });
//   } catch (error) {
//     res.status(400).json({ success: false, error: error.message });
//   }
// };
exports.terminateUserBooking = async (req, res) => {
  try {
    const { bookingId, userEmail, hostEmail, userName, hostName } = req.body;
    const ObjectId = require("mongoose").Types.ObjectId;
    const id = new ObjectId(`${bookingId}`);

    const booking = await Booking.findByIdAndUpdate(bookingId, {
      status: "cancelled",
    }).populate("userId hostId propertyId payment");
    if (!booking) {
      return res
        .status(404)
        .json({ success: false, message: "Booking not found" });
    }

    // const bookingData = await Booking.findById(bookingId);
    // if (!bookingData) {
    //   return res
    //     .status(404)
    //     .json({ success: false, message: "Check Out date not found" });
    // }

    const futureDate = new Date(booking?.checkIn);
    const now = new Date();
    const differenceInSeconds = (futureDate - now) / 1000;

    const instance = new Razorpay({ key_id: key, key_secret: secret });

    let refundSuccessful = false;

    if (
      (booking.cancellationPolicy === "moderate" &&
        differenceInSeconds >= moderate) ||
      (booking.cancellationPolicy === "flexible" &&
        differenceInSeconds >= flexible)
    ) {
      const paymentData = await Payment.findOneAndUpdate(
        { bookingId: id },
        { status: "refund initiated" },
        { new: true },
      );
      const payment = await Payment.findOne({ bookingId: id });
      if (!payment) {
        return res.status(404).json({
          success: false,
          message: "Payment refund initiation failed",
        });
      }

      const refund = await instance.payments.refund(payment.paymentId, {
        amount: payment.amount,
        speed: "normal",
        notes: { notes_key_1: "Full Refund" },
        receipt: `Refund No. ${bookingId}`,
      });

      if (!refund) {
        return res
          .status(404)
          .json({ success: false, message: "Payment refund failed" });
      }

      refundSuccessful = true;

      // Update statuses only if refund is successful
      await Payment.findOneAndUpdate(
        { bookingId: id },
        { status: "refunded", paymentType: "refunded" },
      );
      await Booking.findByIdAndUpdate(bookingId, { paymentStatus: "refunded" });
    }
    const params = paramsToObject(userName, hostName, booking);

    // Email Notifications

    await sendEmail(userEmail, 22, params);
    await sendEmail(hostEmail, 20, params);

    await Promise.all(
      adminEmail.map((email) => sendEmail(email.trim(), 21, params)),
    );

    res.status(200).json({
      success: true,
      message: refundSuccessful
        ? "Refund issued and booking terminated"
        : "Booking cancelled without refund",
    });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
};

exports.terminateNonUserBooking = async (req, res) => {
  try {
    const { bookingId, userEmail, hostEmail, userName, hostName } = req.body;
    const ObjectId = require("mongoose").Types.ObjectId;
    const id = new ObjectId(`${bookingId}`);

    const booking = await Booking.findByIdAndUpdate(bookingId, {
      status: "cancelled",
    });
    if (!booking) {
      return res
        .status(404)
        .json({ success: false, message: "Booking not found" });
    }

    const bookingData = await Booking.findById(bookingId);
    if (!bookingData) {
      return res
        .status(404)
        .json({ success: false, message: "Check Out date not found" });
    }

    const futureDate = new Date(bookingData?.checkIn);
    const now = new Date();
    const differenceInSeconds = (futureDate - now) / 1000;

    const instance = new Razorpay({ key_id: key, key_secret: secret });

    let refundSuccessful = false;

    if (
      (bookingData.cancellationPolicy === "moderate" &&
        differenceInSeconds >= moderate) ||
      (bookingData.cancellationPolicy === "flexible" &&
        differenceInSeconds >= flexible)
    ) {
      const paymentData = await Payment.findOneAndUpdate(
        { bookingId: id },
        { status: "refund initiated" },
        { new: true },
      );
      const payment = await Payment.findOne({ bookingId: id });
      if (!payment) {
        return res.status(404).json({
          success: false,
          message: "Payment refund initiation failed",
        });
      }

      const refund = await instance.payments.refund(payment.paymentId, {
        amount: payment.amount,
        speed: "normal",
        notes: { notes_key_1: "Full Refund" },
        receipt: `Refund No. ${bookingId}`,
      });

      if (!refund) {
        return res
          .status(404)
          .json({ success: false, message: "Payment refund failed" });
      }

      refundSuccessful = true;

      // Update statuses only if refund is successful
      await Payment.findOneAndUpdate(
        { bookingId: id },
        { status: "refunded", paymentType: "refunded" },
      );
      await Booking.findByIdAndUpdate(bookingId, { paymentStatus: "refunded" });
    }

    // Email Notifications
    const params = { userName, hostName };
    await sendEmail(userEmail, 22, params);
    await sendEmail(hostEmail, 20, params);

    res.status(200).json({
      success: true,
      message: refundSuccessful
        ? "Refund issued and booking terminated"
        : "Booking cancelled without refund",
    });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
};

// Confirm a booking
// exports.confirmBooking = async (req, res) => {
//   try {
//     const { bookingId, userEmail, hostEmail, userName, hostName } = req.body;

//     // const generateToken = (payload) => {
//     //   return jwt.sign({ bookingId: payload }, process.env.JWT_SECRET, {
//     //     expiresIn: TOKEN_EXPIRATION,
//     //   }); // expires in 14 days
//     // };
//     // const token = generateToken(bookingId);
//     // if (!token) {
//     //   throw new error("Unsucessful token");
//     // }

//     // const confirmationUrl = `${baseUrl}/rating?token=${token}&booking=${bookingId}`;
//     // // const params = { userFirstName: "abc", url: confirmationUrl };
//     // const agenda = new Agenda({ db: { address: mongoConnectionString } });
//     // agenda.define("sendReviewEmail", async (job, done) => {
//     //   await sendEmail(userEmail, 12, params);
//     //   done();
//     // });
//     // function findSecondsDifference(date1, date2) {
//     //   const oneSecond_ms = 1000;
//     //   const date1_ms = date1.getTime();
//     //   const date2_ms = date2.getTime();
//     //   const delay = 5 * 60 * 60 * 1000;
//     //   const difference_ms = date2_ms - date1_ms + delay;
//     //   return Math.round(difference_ms / oneSecond_ms);
//     // }

//     // const checkOutBooking = await Booking.findById(bookingId);

//     // const futureDate = new Date(checkOutBooking.checkOut);

//     // await booking.save();
//     // await sendOTPEmail(recipient, firstName, otp);

//     // var secsFromNow = findSecondsDifference(new Date(), futureDate);

//     const booking = await Booking.findByIdAndUpdate(bookingId, {
//       status: "confirmed",
//     }).populate("propertyId payment hostId userId");

//     if (!booking) {
//       return res
//         .status(404)
//         .json({ success: false, message: "Booking not found" });
//     }
//     const params = paramsToObject(userName, hostName, booking);

//     const adminEmail = "admin@majesticescape.in";

//     await sendEmail(userEmail, 10, params);
//     await sendEmail(hostEmail, 19, params);
//     await sendEmail(adminEmail, 18, params);
//     // (async function () {
//     //   try {
//     //     await agenda.start();
//     //     await agenda.schedule("in 2 minutes", "sendReviewEmail");
//     //     // agenda.schedule(secsFromNow + " seconds", "sendReviewEmail");
//     //   } catch (err) {
//     //     console.error("Agenda start failed:", err.message);
//     //   }
//     // })();
//     res.status(200).json({ success: true });
//     //  res.status(200).json({ success: true, data: booking });
//   } catch (error) {
//     res.status(400).json({ success: false, error: error.message });
//   }
// };

exports.confirmBooking = async (req, res) => {
  try {
    const { bookingId } = req.body;
    const booking = await Booking.findByIdAndUpdate(
      bookingId,
      { status: "confirmed" },
      { new: true },
    ).populate("hostId userId propertyId");

    if (!booking) {
      return res
        .status(404)
        .json({ success: false, message: "Booking not found" });
    }

    const bookingStatus = booking.status;
    const hostEmail = booking.hostId.email;
    const userEmail = booking.userId.email;
    const token = jwt.sign({ bookingId }, process.env.JWT_SECRET, {
      expiresIn: "14d",
    });

    const params = {
      userName: `${booking.userId.firstName} ${booking.userId.lastName}`,
      hostName: `${booking.hostId.firstName} ${booking.hostId.lastName}`,
      propertyTitle: `${booking.propertyId.title}`,
      userUrl: `${baseUrl}/rating?token=${token}&booking=${bookingId}`,
      hostUrl: `${baseUrl}/rating?token=${token}&booking=${bookingId}`,
    };

    if (process.env.NEXT_PUBLIC_ENV === "dev") {
      console.log("Agenda scheduling started");
    }

    // schedule 5 hours after checkout
    const now = new Date();
    const checkoutDate = new Date(booking.checkOut);
    const delayMs = checkoutDate.getTime() + 5 * 60 * 60 * 1000 - now.getTime();
    const delaySeconds = Math.max(0, Math.round(delayMs / 1000));
    if (process.env.ENV === "dev") {
      await agenda.schedule(`40 seconds`, "sendReviewEmail", {
        userEmail,
        hostEmail,
        params,
        bookingStatus,
      });
    } else {
      await agenda.schedule(`${delaySeconds} seconds`, "sendReviewEmail", {
        userEmail,
        hostEmail,
        params,
        bookingStatus,
      });
    }

    if (process.env.NEXT_PUBLIC_ENV === "dev") {
      console.log("✅ Job scheduled successfully");
    }
    res.status(200).json({ success: true });
  } catch (error) {
    console.error("Booking confirm error:", error);
    res.status(400).json({ success: false, error: error.message });
  }
};
// exports.confirmInstantBooking = async (req, res) => {
//   try {
//     const { bookingId, userId, propertyTitle } = req.body;
//     const booking = await Booking.findByIdAndUpdate(bookingId, {
//       status: "confirmed",
//     }).populate("hostId userId");

//     if (!booking) {
//       return res
//         .status(404)
//         .json({ success: false, message: "Booking not found" });
//     }
//     const bookingStatus = booking.status;
//     const hostEmail = booking.hostId.email;
//     const userEmail = booking.userId.email;
//     const adminEmail = "admin@majesticescape.in";

//     const generateToken = (payload) => {
//       return jwt.sign({ bookingId: payload }, process.env.JWT_SECRET, {
//         expiresIn: TOKEN_EXPIRATION,
//       }); // expires in 14 days
//     };
//     const token = generateToken(bookingId);
//     if (!token) {
//       return res
//         .status(404)
//         .json({ success: false, message: "Unsucessful token" });
//     }

//     const userConfirmationUrl = `${baseUrl}/rating?token=${token}&booking=${bookingId}`;
//     const hostConfirmationUrl = `${baseUrl}/rating?token=${token}&booking=${bookingId}`;
//     const params = {
//       userName: booking.userId.firstName + " " + booking.userId.lastName,
//       hostName: booking.hostId.firstName + " " + booking.hostId.lastName,
//       propertyTitle: propertyTitle,
//       userUrl: userConfirmationUrl,
//       hostUrl: hostConfirmationUrl,
//     };
//     const agenda = new Agenda({ db: { address: mongoConnectionString } });
//     agenda.define("sendReviewEmail", async (job, done) => {
//       process.env.ENV === 'dev' && if (process.env.NEXT_PUBLIC_ENV === "dev") {
//   console.log("Agenda Function");
// }
//       const { userEmail, hostEmail, params, bookingStatus } = job.attrs.data;
//       if (bookingStatus == "confirmed") {
//         process.env.ENV === 'dev' && if (process.env.NEXT_PUBLIC_ENV === "dev") {
//   console.log("Agenda Function Inside");
// }
//         await sendEmail(userEmail, 12, params);
//         await sendEmail(hostEmail, 43, params);
//         process.env.ENV === 'dev' && if (process.env.NEXT_PUBLIC_ENV === "dev") {
//   console.log("Agenda Function complete");
// }
//         done();
//       }
//     });
//     function findSecondsDifference(date1, date2) {
//       const oneSecond_ms = 1000;
//       const date1_ms = date1.getTime();
//       const date2_ms = date2.getTime();
//       const delay = 5 * 60 * 60 * 1000;
//       const difference_ms = date2_ms - date1_ms + delay;
//       return Math.round(difference_ms / oneSecond_ms);
//     }

//     // const checkOutBooking = await Booking.findById(bookingId);

//     const futureDate = new Date(booking.checkOut);

//     // await booking.save();
//     // await sendOTPEmail(recipient, firstName, otp);

//     // var secsFromNow = findSecondsDifference(new Date(), futureDate);
//     // const params = { userFirstName: "Test" };

//     // await sendEmail(userEmail, 35, params);
//     // await sendEmail(hostEmail, 34, params);
//     // await sendEmail(adminEmail, 36, params);

//     (async function () {
//       try {
//         process.env.ENV === 'dev' && if (process.env.NEXT_PUBLIC_ENV === "dev") {
//   console.log("Agenda Started");
// }
//         await agenda.start();
//         await agenda.schedule("in 2 minutes", "sendReviewEmail", {
//           userEmail,
//           hostEmail,
//           params,
//           bookingStatus,
//         });
//         // agenda.schedule(secsFromNow + " seconds", "sendReviewEmail");
//       } catch (err) {
//         console.error("Agenda start failed:", err.message);
//       }
//     })();
//     res.status(200).json({ success: true });
//     //  res.status(200).json({ success: true, data: booking });
//   } catch (error) {
//     res.status(400).json({ success: false, error: error.message });
//   }
// };
// Mark booking as paid

exports.confirmInstantBooking = async (req, res) => {
  try {
    const { bookingId, propertyTitle } = req.body;
    const booking = await Booking.findByIdAndUpdate(
      bookingId,
      { status: "confirmed" },
      { new: true },
    ).populate("hostId userId");

    if (!booking) {
      return res
        .status(404)
        .json({ success: false, message: "Booking not found" });
    }

    const bookingStatus = booking.status;
    const hostEmail = booking.hostId.email;
    const userEmail = booking.userId.email;
    const token = jwt.sign({ bookingId }, process.env.JWT_SECRET, {
      expiresIn: "14d",
    });

    const params = {
      userName: `${booking.userId.firstName} ${booking.userId.lastName}`,
      hostName: `${booking.hostId.firstName} ${booking.hostId.lastName}`,
      propertyTitle,
      userUrl: `${baseUrl}/rating?token=${token}&booking=${bookingId}`,
      hostUrl: `${baseUrl}/rating?token=${token}&booking=${bookingId}`,
    };

    if (process.env.NEXT_PUBLIC_ENV === "dev") {
      console.log("Agenda scheduling started");
    }

    // schedule 5 hours after checkout
    const now = new Date();
    const checkoutDate = new Date(booking.checkOut);
    const delayMs = checkoutDate.getTime() + 5 * 60 * 60 * 1000 - now.getTime();
    const delaySeconds = Math.max(0, Math.round(delayMs / 1000));

    await agenda.schedule(`${delaySeconds} seconds`, "sendReviewEmail", {
      userEmail,
      hostEmail,
      params,
      bookingStatus,
    });

    if (process.env.NEXT_PUBLIC_ENV === "dev") {
      console.log("✅ Job scheduled successfully");
    }
    res.status(200).json({ success: true });
  } catch (error) {
    console.error("Booking confirm error:", error);
    res.status(400).json({ success: false, error: error.message });
  }
};

exports.markBookingAsPaid = async (req, res) => {
  try {
    const { bookingId, userId, manual, payment } = req.body;
    console.log("Entered update status");
    const booking = await Booking.findByIdAndUpdate(
      bookingId,
      { paymentStatus: "paid", payment: payment },
      { new: true },
    ).populate("userId hostId propertyId payment");

    if (!booking)
      return res
        .status(404)
        .json({ success: false, message: "Booking not found" });
    console.log("Updated booking id");
    const data = await User.findById(userId);
    if (!data)
      return res
        .status(404)
        .json({ success: false, message: "User not found" });
    console.log("Found user details");
    const userEmail = await data.email;
    if (process.env.NEXT_PUBLIC_ENV === "dev") {
      console.log("inside the mark");
    }

    if (process.env.NEXT_PUBLIC_ENV === "dev") {
      console.log("inside the mark2");
    }
    // console.log("=======Before payment");

    const bank = await Payment.findOne({ bookingId: booking._id });
    if (!bank) {
      return res
        .status(404)
        .json({ success: false, message: "Payment not found" });
    }
    console.log("Found payment details");
    // console.log("=======Bank payment", bank);
    const calTax = (subtotal, serviceFee) => {
      if (subtotal <= 7500) {
        return Math.round(subtotal * 0.12) + Math.round(serviceFee * 0.18); // 12% GST in India
      } else if (subtotal > 7500) {
        return Math.round(subtotal * 0.18) + Math.round(serviceFee * 0.18); // 18% GST in India
      }
    };
    const tax = calTax(
      booking.subTotal,
      booking.subTotal * 0.12,
    ).toLocaleString();
    console.log("Calculated Tax");
    const html = generateInvoiceHTML(booking, bank, tax);
    // console.log("=======pdf html", html);
    // Generate PDF buffer
    console.log("Build Email HTML Body");
    const pdfBuffer = await generateInvoicePDF(html);
    console.log(" Generate Email HTML Body");
    // console.log("=======pdf buffer");
    let invoicesDir;
    if (process.env.NEXT_PUBLIC_ENV == "dev") {
      invoicesDir = path.join(__dirname, "/..");
    } else {
      invoicesDir = "/tmp";
    }

    if (!fs.existsSync(invoicesDir)) {
      fs.mkdirSync(invoicesDir, { recursive: true });
    }
    console.log("Generate PDF");
    // File path
    const filePath = path.join(invoicesDir, `invoice-${booking._id}.pdf`);

    // Save PDF
    fs.writeFileSync(filePath, pdfBuffer);
    console.log("Save PDF");
    const localPdf = await fs.readFileSync(filePath);

    // Convert buffer → base64
    // const pdfPath = path.join(process.cwd(), "test.pdf");
    // const pdfBuffer = fs.readFileSync(pdfPath);
    // console.log("pdf path", pdfPath);
    console.log("Read PDF");
    const attachmentBase64 = localPdf.toString("base64");
    console.log("Convert Base 64 PDF");
    // console.log("=======Attachment");
    const invoiceAttachment = [
      {
        name: `invoice-${booking._id}.pdf`,
        content: attachmentBase64,
        type: "application/pdf",
      },
    ];

    const userName = changeToUpperCase(
      booking.userId.firstName + " " + booking.userId.lastName,
    );
    const hostName = changeToUpperCase(
      booking.hostId.firstName + " " + booking.hostId.lastName,
    );
    const params = paramsToObject(userName, hostName, booking);

    if (process.env.NEXT_PUBLIC_ENV === "dev") {
      console.log("inside the mark3");
    }
    if (manual) {
      console.log("Send Email Manual");
      await sendEmail(booking.hostId.email, 42, params, invoiceAttachment);

      await Promise.all(
        adminEmail.map((email) =>
          sendEmail(email.trim(), 9, params, invoiceAttachment),
        ),
      );

      await sendEmail(booking.userId.email, 8, params, invoiceAttachment);
      //invoiceAttachment;
      console.log("Done Send Email Manual");
      try {
        await fs.promises.unlink(filePath);
      } catch (unlinkError) {
        console.error("Failed to delete PDF file:", unlinkError);
      }
      console.log("Delete PDF");
      return res.status(200).json({ success: true, data: booking });
    } else {
      console.log("Send Email Instant");
      // console.log("=======Before email");
      await sendEmail(booking.hostId.email, 34, params, invoiceAttachment);
      await sendEmail(booking.userId.email, 35, params, invoiceAttachment);
      // console.log("=======after host");
      await Promise.all(
        adminEmail.map((email) =>
          sendEmail(email.trim(), 36, params, invoiceAttachment),
        ),
      );
      // console.log("invoice", invoiceAttachment);
      console.log("Done Send Email Instant");
      // invoiceAttachment
      try {
        await fs.promises.unlink(filePath);
      } catch (unlinkError) {
        console.error("Failed to delete PDF file:", unlinkError);
      }
    }
    console.log("Delete PDF");
    return res.status(200).json({ success: true, data: booking });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
};

// Delete a booking
exports.deleteBooking = async (req, res) => {
  try {
    const booking = await Booking.findByIdAndDelete(req.params.bookingId);
    if (!booking)
      return res
        .status(404)
        .json({ success: false, message: "Booking not found" });
    res
      .status(200)
      .json({ success: true, message: "Booking deleted successfully" });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};

// Utility to calculate refund (add your logic here)
const calculateRefund = (booking) => {
  // Example logic: Partial refund based on cancellation policy
  const now = new Date();
  if (booking.cancellationPolicy === "strict") return 0;
  if (booking.cancellationPolicy === "moderate") return booking.price * 0.5;
  if (booking.cancellationPolicy === "flexible") return booking.price * 0.75;
  return 0;
};

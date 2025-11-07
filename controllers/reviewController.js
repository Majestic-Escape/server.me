const Review = require("../models/Review");
const Booking = require("../models/Booking");
const ListingProperty = require("../models/ListingProperty");
const jwt = require("jsonwebtoken");
const secret = process.env.JWT_SECRET;
const mongoose = require("mongoose");
const HostReview = require("../models/HostReview");
const User = require("../models/User");
const { sendEmail } = require("../utils/sendEmail");
const { changeToUpperCase } = require("../utils/convertToUpperCase");

// exports.submitReview = async (req, res) => {
//   try {
//     const { bookingId, rating, content } = req.body;

//     // const review = new Review(req.body);

//     const booking = await Booking.findById(bookingId);

//     console.log("ssss", booking.hostId.toString());

//     const review = new Review({
//       bookingId: bookingId,
//       hostId: booking.hostId.toString(),
//       property: booking.propertyId.toString(),
//       user: booking.userId.toString(),
//       rating: rating,
//       content: content,
//     });
//     await review.save();
//     const result = await Review.aggregate([
//       {
//         $match: { property: booking.propertyId },
//       },
//       {
//         $group: {
//           _id: "$property",
//           averageRating: { $avg: "$rating" },
//           reviewCount: { $sum: 1 },
//         },
//       },
//     ]);
//     console.log("nice go 2", result);
//     if (result.length === 0) {
//       return res.status(404).json({
//         success: false,
//         message: "No reviews found for this property.",
//       });
//     }
//     const avgData = result[0] || {
//       averageRating: 0,
//       reviewCount: 0,
//     };
//     console.log(
//       "nice go",
//       avgData.averageRating.toFixed(2),
//       avgData.reviewCount
//     );
//     // const ObjectId = require("mongoose").Types.ObjectId;
//     // const id = new ObjectId(booking.propertyId.toString());
//     const data = await ListingProperty.findByIdAndUpdate(
//       booking.propertyId.toString(),
//       {
//         averageRating: Number(avgData.averageRating.toFixed(2)),
//         reviewCount: avgData.reviewCount,
//       }
//     );
//     if (!data) {
//       return res
//         .status(404)
//         .json({ success: false, message: "Property not found" });
//     }

//     res.status(201).json({ success: true, data: data });
//   } catch (error) {
//     res.status(400).json({ success: false, error: error.message });
//   }
// };

exports.submitReview = async (req, res) => {
  try {
    const { bookingId, rating, content } = req.body;

    // 1. Find booking
    const booking = await Booking.findById(bookingId);
    if (!booking) {
      return res
        .status(404)
        .json({ success: false, message: "Booking not found" });
    }

    // 2. Create and save review
    const review = new Review({
      bookingId: booking._id,
      hostId: booking.hostId, // keep as ObjectId
      property: booking.propertyId, // keep as ObjectId
      user: booking.userId, // keep as ObjectId
      rating,
      content,
    });

    await review.save();
    const listproperty = await ListingProperty.findById(booking.propertyId);
    // 3. Calculate new average rating for this property
    if (!listproperty) {
      return res.status(404).json({
        success: false,
        message: "No property found.",
      });
    }
    if (listproperty.averageRating == 0) {
      const result = await Review.aggregate([
        {
          $match: { property: new mongoose.Types.ObjectId(booking.propertyId) },
        },
        {
          $group: {
            _id: "$property",
            averageRating: { $avg: "$rating" },
            reviewCount: { $sum: 1 },
          },
        },
      ]);

      if (result.length === 0) {
        return res.status(404).json({
          success: false,
          message: "No reviews found for this property.",
        });
      }

      const avgData = {
        averageRating: Number(result[0].averageRating.toFixed(2)),
        reviewCount: result[0].reviewCount,
      };

      // 4. Update property ratings
      const updatedProperty = await ListingProperty.findByIdAndUpdate(
        booking.propertyId,
        {
          averageRating: avgData.averageRating,
          reviewCount: avgData.reviewCount,
        },
        { new: true }
      );
      if (!updatedProperty) {
        return res
          .status(404)
          .json({ success: false, message: "Property not found" });
      }
      const updateStatus = await Booking.findByIdAndUpdate(bookingId, {
        reviewed: true,
      });
      if (!updateStatus) {
        return res
          .status(404)
          .json({ success: false, message: "Review not found" });
      }
      res.status(201).json({
        success: true,
        data: updatedProperty,
      });
    } else {
      const averageRating =
        (Number(listproperty?.averageRating) *
          Number(listproperty?.reviewCount) +
          Number(rating)) /
        (Number(listproperty?.reviewCount) + 1);
      const reviewCount = Number(listproperty?.reviewCount) + 1;
      const updatedProperty = await ListingProperty.findByIdAndUpdate(
        booking.propertyId,
        {
          averageRating: averageRating,
          reviewCount: reviewCount,
        },
        { new: true }
      );
      if (!updatedProperty) {
        return res
          .status(404)
          .json({ success: false, message: "Property not found" });
      }
      const updateStatus = await Booking.findByIdAndUpdate(bookingId, {
        reviewed: true,
      });
      if (!updateStatus) {
        return res
          .status(404)
          .json({ success: false, message: "Review not found" });
      }
      res.status(201).json({
        success: true,
        data: updatedProperty,
      });
    }

    // 5. Respond success
  } catch (error) {
    console.error("Error in submitReview:", error);
    res.status(500).json({ success: false, error: error.message });
  }
};

// Assumes: Booking, HostReview, User are mongoose models already required

exports.submitHostReview = async (req, res) => {
  try {
    const { bookingId, rating, content } = req.body;

    // 0) Basic validation
    if (!bookingId) {
      return res
        .status(400)
        .json({ success: false, message: "bookingId is required" });
    }
    const numericRating = Number(rating);
    if (Number.isNaN(numericRating) || numericRating < 1 || numericRating > 5) {
      return res.status(400).json({
        success: false,
        message: "rating must be a number between 1 and 5",
      });
    }

    // 1) Find booking
    const booking = await Booking.findById(bookingId).populate(
      "hostId propertyId"
    );
    if (!booking) {
      return res
        .status(404)
        .json({ success: false, message: "Booking not found" });
    }

    // Optional: prevent duplicate review for same booking
    const existing = await HostReview.findOne({ bookingId: booking._id });
    if (existing) {
      return res.status(409).json({
        success: false,
        message: "Review for this booking already exists",
      });
    }

    // 2) Create and save review
    const review = new HostReview({
      bookingId: booking._id,
      hostId: booking.hostId,
      property: booking.propertyId,
      user: booking.userId,
      rating: numericRating,
      content: content || "",
    });

    await review.save();

    // 3) Update host profile: compute new average correctly
    const host = await User.findById(booking.hostId).lean(); // read-only copy
    if (!host) {
      // host missing — still return review but warn
      return res.status(201).json({
        success: true,
        data: review,
        warning: "Review saved but host not found to update stats",
      });
    }

    // Ensure host.hostProfile exists and has numeric fields
    const oldCount = (host && Number(host.reviewCount)) || 0;
    const oldRating = (host && Number(host.averageRating)) || 0;

    const newCount = oldCount + 1;
    // Weighted average formula:
    const newRating = (oldRating * oldCount + numericRating) / newCount;

    // 4) Save the updated host values (use $set to update nested fields)
    const updatedHost = await User.findByIdAndUpdate(
      booking.hostId,
      {
        $set: {
          averageRating: newRating,
          reviewCount: newCount,
        },
      },
      { new: true, runValidators: true } // return updated doc
    ).select("-password"); // avoid returning sensitive fields

    // 5) Mark booking as reviewed (optional, if model supports)
    booking.hostReviewed = true;
    await booking.save();
    const hostName = changeToUpperCase(
      booking.hostId.firstName + " " + booking.hostId.lastName
    );
    const userName = changeToUpperCase(
      booking.userId.firstName + " " + booking.userId.lastName
    );
    const params = {
      hostName: hostName,
      userName: userName,
      propertyTitle: booking.propertyId.title,
    };
    await sendEmail(booking.hostId.email, 43, params);
    // 6) Respond with created review and updated host
    return res.status(201).json({
      success: true,
      data: {
        review,
        host: updatedHost,
      },
    });
  } catch (error) {
    console.error("Error in submitHostReview:", error);
    return res.status(500).json({ success: false, error: error.message });
  }
};

exports.checkReview = async (req, res) => {
  try {
    const { id } = req.params;

    const data = await Review.find({ bookingId: id });
    console.log("supernm", data);
    if (!data || data.length === 0) {
      return res
        .status(404)
        .json({ success: false, data: false, message: "Review not found" });
    }

    res.status(201).json({ success: true, data: true });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
};
exports.checkReview = async (req, res) => {
  try {
    const { id } = req.params;

    const data = await Review.find({ bookingId: id });
    console.log("supernm", data);
    if (!data || data.length === 0) {
      return res
        .status(404)
        .json({ success: false, data: false, message: "Review not found" });
    }

    res.status(201).json({ success: true, data: true });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
};

// exports.updateReview = async (req, res) => {
//   try {
//     const { propertyId, bookingId, rating, status } = req.query;

//     const property = await ListingProperty.findById(propertyId);
//     if (!property) {
//       return res
//         .status(404)
//         .json({ success: false, data: false, message: "Review not found" });
//     }

//     const total = Number(property.averageRating) * Number(property.reviewCount);
//     const newTotal = total - Number(rating);
//     const newCount = Number(property.reviewCount) - 1;
//     const newAvg = newTotal / newCount;
//     const updateRating = await ListingProperty.findOneAndUpdate(
//       { bookingId: bookingId },
//       {
//         averageRating: newAvg,
//         reviewCount: newCount,
//       }
//     );
//     const filter = {};
//     if (status) {
//       filter.hideStatus = status;
//     }
//     const data = await Review.findOneAndUpdate(
//       { bookingId: bookingId },
//       { filter }
//     );
//     res.status(201).json({ success: true, data: data });
//   } catch (error) {
//     res.status(400).json({ success: false, error: error.message });
//   }
// };
exports.updateReview = async (req, res) => {
  try {
    const { propertyId, bookingId, rating, status } = req.query;

    // Find the property first
    const property = await ListingProperty.findById(
      new mongoose.Types.ObjectId(propertyId)
    );
    if (!property) {
      return res
        .status(404)
        .json({ success: false, data: false, message: "Property not found" });
    }

    // ✅ Recalculate average rating
    if (status && status == "accept") {
      const total =
        Number(property.averageRating) * Number(property.reviewCount);
      const newTotal = total - Number(rating);
      if (newTotal >= 0) {
        const newCount = Math.max(Number(property.reviewCount) - 1, 0); // avoid negative
        const newAvg = newCount > 0 ? newTotal / newCount : 0;

        // ✅ Update property by its _id
        await ListingProperty.findByIdAndUpdate(
          new mongoose.Types.ObjectId(propertyId),
          {
            averageRating: newAvg,
            reviewCount: newCount,
          }
        );
      }
    }

    // ✅ Update review (status/hideStatus)
    const updateFields = {};
    if (status) {
      updateFields.hideStatus = status;
    }

    const review = await Review.findOneAndUpdate(
      { bookingId: new mongoose.Types.ObjectId(bookingId) },
      updateFields,
      { new: true } // return updated review
    ).populate("user bookingId property hostId");

    if (!review) {
      return res
        .status(404)
        .json({ success: false, message: "Review not found" });
    }
    const params = {
      userName: changeToUpperCase(
        review.user.firstName + " " + review.user.lastName
      ),
      bookingId: review.bookingId._id,
      from: new Date(review.bookingId.checkIn).toLocaleDateString(),
      to: new Date(review.bookingId.checkOut).toLocaleDateString(),
      userId: new Date(review.user._id),
      propertyTitle: review.property.title,
      rating: review.rating,
      review: review.content,
      hostName: changeToUpperCase(
        review.hostId.firstName + " " + review.hostId.lastName
      ),
      guestEmail: review.user.email,
      guestContact: review.user.phoneNumber,
      hostEmail: review.hostId.email,
      hostContact: review.hostId.phoneNumber,
    };
    if (status == "accept") {
      await sendEmail(property.hostEmail, 37, params);
    } else if (status == "reject") {
      await sendEmail(property.hostEmail, 38, params);
    }

    res.status(200).json({ success: true, data: review });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
};

exports.checkHostReview = async (req, res) => {
  try {
    const { id } = req.params;

    const data = await HostReview.find({ bookingId: id });
    console.log("supernm", data);
    if (!data || data.length === 0) {
      return res
        .status(404)
        .json({ success: false, data: false, message: "Review not found" });
    }

    res.status(201).json({ success: true, data: true });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
};
exports.verifyToken = async (req, res) => {
  try {
    const { emailToken } = req.body;
    console.log("abc");
    const verify = jwt.verify(emailToken, secret);
    res.status(201).json({ success: true });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
};

// exports.getPropertyReview = async (req, res) => {
//   try {
//     const ObjectId = require("mongoose").Types.ObjectId;
//     const id = new ObjectId(`${req.params.propertyId}`);
//     const review = await Review.find({ property: id }).populate("user");
//     console.log("ratingssss", review);
//     res.status(200).json({ success: true, data: review });
//   } catch (error) {
//     res.status(400).json({ success: false, error: error.message });
//   }
// };
exports.getPropertyReview = async (req, res) => {
  try {
    const limitValue = parseInt(req.query.limit) || 2;
    const skipValue = parseInt(req.query.skip) || 0;
    const ObjectId = require("mongoose").Types.ObjectId;
    const id = new ObjectId(`${req.params.propertyId}`);
    const review = await Review.find({
      property: id,
      hideStatus: { $nin: ["accept"] },
    })
      .populate("user")
      .limit(limitValue)
      .skip(skipValue)
      .sort({ createdAt: -1 });

    res.status(200).json({
      success: true,
      data: review,
    });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
};

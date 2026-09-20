const BankDetail = require("../models/BankDetail");
const ListingProperty = require("../models/ListingProperty");
const Razorpay = require("razorpay");
const Review = require("../models/Review");
const User = require("../models/User");
const { parseMDYToUTC } = require("../utils/convertDate");
const { parseListQuery, listMeta, pageStages, searchRegex } = require("../utils/listQuery");
const axios = require("axios");
const { encrypt } = require("../utils/encrypt");
const authz = require("../middleware/authz");
const { sanitizeHost, SAFE_HOST_SELECT, PUBLIC_USER_SELECT, SELF_USER_SELECT, toPublicUser, toSelfUser, listingAddressTokens } = require("../utils/sanitizeResponse");
const { maskContactInfo } = require("../utils/contactModeration");
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

// const YOUR_KEY = "rzp_test_RRelkKgMDh3dun";
// const YOUR_SECRET = "gYeQi2lZFvXMMBRs1lWjGANA";

const auth = Buffer.from(`${razorpay.key_id}:${razorpay.key_secret}`).toString(
  "base64"
);

const API_URL = process.env.RAZORPAY_API;
// Get all hosts and their properties
exports.getAllHosts = async (req, res) => {
  try {
    // Only select safe fields to prevent PII leakage
    const hosts = await User.find().select(SAFE_HOST_SELECT).populate("properties");
    res.status(200).json({ hosts });
  } catch (error) {
    res.status(500).json({ message: "Error fetching hosts", error });
  }
};

exports.submitBankDetails = async (req, res) => {
  try {
    const { id } = req.params;

    // Validate required fields
    if (!id) {
      return res.status(400).json({
        success: false,
        message: "Missing host ID",
      });
    }

    const { accountNumber, ifsc, accountHolderName, bankName } = req.body;

    if (!accountNumber || !ifsc || !accountHolderName || !bankName) {
      return res.status(400).json({
        success: false,
        message: "All fields are required",
      });
    }

    // Check if bank details already exist for this host
    const bankAccount = await BankDetail.findOne({ hostId: id });
    if (bankAccount) {
      bankAccount.accountNumber = accountNumber;
      bankAccount.ifsc = ifsc;
      bankAccount.name = accountHolderName;
      bankAccount.bankName = bankName;

      await bankAccount.save();

      return res.status(200).json({
        success: true,
        data: bankAccount,
        message: "Bank details added successfully",
      });
    } else {
      const user = await User.findById(id);

      if (!user) {
        return res.status(404).json({
          success: false,
          message: "No Data",
        });
      }
      if (process.env.NEXT_PUBLIC_ENV === "dev") {
        console.log("enter");
      }
      // Update existing record
      let createContact;
      try {
        createContact = await axios.post(
          `${API_URL}/contacts`,
          {
            name: accountHolderName,
            email: user.email,
            contact: user.phoneNumber,
            type: "vendor",
          },
          {
            headers: {
              "Content-Type": "application/json",
              Authorization: `Basic ${auth}`,
            },
          }
        );
      } catch (razorpayError) {
        console.error("Razorpay Contact Error:", razorpayError.response?.data || razorpayError.message);
        return res.status(400).json({ 
          success: false, 
          message: "Failed to create Razorpay contact",
          error: razorpayError.response?.data || razorpayError.message 
        });
      }

      if (createContact.status != 200 && createContact.status !== 201) {
        return res.json({ success: false, message: createContact.status });
      }
      if (process.env.NEXT_PUBLIC_ENV === "dev") {
        console.log("reach");
      }

      let fundAccount;
      try {
        fundAccount = await axios.post(
          `${API_URL}/fund_accounts`,
          {
            contact_id: `${createContact.data.id}`,
            account_type: "bank_account",
            bank_account: {
              name: accountHolderName,
              ifsc: ifsc,
              account_number: accountNumber,
            },
          },
          {
            headers: {
              "Content-Type": "application/json",
              Authorization: `Basic ${auth}`,
            },
          }
        );
      } catch (razorpayError) {
        console.error("Razorpay Fund Account Error:", razorpayError.response?.data || razorpayError.message);
        return res.status(400).json({ 
          success: false, 
          message: "Failed to create Razorpay fund account",
          error: razorpayError.response?.data || razorpayError.message 
        });
      }
      if (process.env.NEXT_PUBLIC_ENV === "dev") {
        console.log("reach2");
      }
      if (fundAccount.status !== 200 && fundAccount.status !== 201) {
        return res.json({ success: false, message: fundAccount.status });
      }
      if (process.env.NEXT_PUBLIC_ENV === "dev") {
        console.log("reach3");
      }
      const accountNumberEncrypt = encrypt(accountNumber);
      const data = new BankDetail({
        hostId: id,
        accountNumber: accountNumberEncrypt,
        bankName: bankName,
        ifsc: ifsc,
        name: accountHolderName,
        contactId: createContact.data.id,
        fundId: fundAccount.data.id,
      });
      await data.save();
      const filter = { host: id };
      const update = { $set: { bankDetails: true } };
      const property = await ListingProperty.updateMany(filter, update);

      if (!property) {
        return res
          .status(400)
          .json({ success: false, message: "No property found " });
      }
      const userBank = await User.findByIdAndUpdate(id, { bank: true });
      if (!userBank) {
        return res
          .status(400)
          .json({ success: false, message: "No user found " });
      }
      if (process.env.NEXT_PUBLIC_ENV === "dev") {
        console.log("reach4");
      }
      return res.status(200).json({
        success: true,
        message: "Bank details added successfully",
      });
    }
  } catch (error) {
    console.error("Error saving bank details:", error);
    res
      .status(500)
      .json({ success: false, message: "Server error", error: error.message });
  }
};

exports.getBankDetails = async (req, res) => {
  try {
    const { id } = req.params;
    if (!id) {
      return res
        .status(400)
        .json({ success: false, error: "Missing required parameter" });
    }
    const data = await BankDetail.findOne({ hostId: id });
    if (!data) {
      return res.status(404).json({ success: false, error: "Data not found" });
    }

    return res.status(200).json({
      success: true,
      messsage: "Bank details successfuly fetched",
      data: data,
    });
  } catch (error) {
    res.status(500).json({ message: "Failed API", error: error.message });
  }
};
// Get a single host and their properties
exports.getHostById = async (req, res) => {
  try {
    // Contact lock-down: the caller's own record minus secrets (the membership
    // popup reads hostOffer); anyone else gets the public projection, with
    // `about` masked against every address this host has listed.
    const actor = await authz.resolveActor(req);
    const self = actor && authz.sameId(actor.id, req.params.hostId);
    const host = await User.findById(req.params.hostId).select(authz.isAdmin(actor) ? "" : self ? SELF_USER_SELECT : PUBLIC_USER_SELECT).lean();
    if (!host) {
      return res.status(404).json({ message: "Host not found" });
    }
    if (authz.isAdmin(actor)) return res.status(200).json({ success: true, data: host });
    if (self) return res.status(200).json({ success: true, data: toSelfUser(host) });
    const listings = await ListingProperty.find({ host: host._id }).select("address line1 line2").lean();
    res.status(200).json({ success: true, data: toPublicUser(host, { fallbackName: "Host", addressTokens: listings.map(listingAddressTokens) }) });
  } catch (error) {
    res.status(500).json({ message: "Error fetching host", error });
  }
};

exports.getHostReviewsById = async (req, res) => {
  try {
    const { search, stars, email, checkin, checkout, property } = req.query;
    const ObjectId = require("mongoose").Types.ObjectId;

    // Host ID from params
    const hostId = new ObjectId(req.params.userId);

    // Step 1: Build base filter
    let filter = { hostId: hostId };

    // ⭐ Fix date filter
    if (checkin && checkout) {
      const range = parseMDYToUTC(checkin, checkout);
      filter.createdAt = { $gte: range.from, $lte: range.to };
    } else if (checkin && !checkout) {
      const singleDay = parseMDYToUTC(checkin); // pass only checkin
      filter.createdAt = { $gte: singleDay.from, $lte: singleDay.to };
    }
    if (stars && stars !== "all") {
      filter.rating = Number(stars);
    }

    // Step 2: Fetch reviews with population
    let reviews = await Review.find(filter)
      .populate({
        path: "bookingId",
        model: "Booking",
        select: "checkIn checkOut flag",
      })
      .populate({
        path: "property",
        select: "title", // Removed hostEmail to prevent PII leakage
      })
      .populate({
        path: "user",
        select: "firstName lastName profilePicture",
      })
      .lean();

    // Step 3: Extra filters in JS
    if (search) {
      const s = search.toLowerCase();
      reviews = reviews.filter(
        (r) =>
          r.content?.toLowerCase().includes(s) ||
          `${r.user?.firstName} ${r.user?.lastName}`.toLowerCase().includes(s)
      );
    }
    // Contact lock-down (public endpoint): reviewer first name + photo only, text masked
    for (const r of reviews) {
      if (r.user && typeof r.user === "object") r.user = toPublicUser(r.user, { fallbackName: "Guest" });
      if (typeof r.content === "string") r.content = maskContactInfo(r.content);
    }

    if (property && property !== "all") {
      const p = property.toLowerCase();
      reviews = reviews.filter((r) =>
        r.property?.title?.toLowerCase().includes(p)
      );
    }

    // Step 4: Average rating
    const avgRating =
      reviews.length > 0
        ? (
            reviews.reduce((sum, r) => sum + (r.rating || 0), 0) /
            reviews.length
          ).toFixed(2)
        : 0;

    res.status(200).json({
      success: true,
      data: reviews,
      averageRating: avgRating,
      reviewCount: reviews.length,
    });
  } catch (error) {
    console.error("Error in getHostReviewsById:", error);
    res
      .status(500)
      .json({ message: "Error fetching reviews", error: error.message });
  }
};

// Sortable columns of the admin Reviews table.
const ADMIN_REVIEW_SORT = {
  createdAt: "createdAt",
  rating: "rating",
  hideStatus: "hideStatus",
  guest: "user.firstName",
  title: "property.title",
  checkIn: "bookingId.checkIn",
};

// GET /hostData/review/admin — filters, search, sort and paging in one
// aggregation (it used to load every review and filter in JS); without
// ?page= / ?limit= the whole list is returned as before. averageRating and
// reviewCount describe the filtered set, not the page.
exports.getAllReviews = async (req, res) => {
  try {
    const { flagged, search, stars, checkin, checkout, property } = req.query;
    const { page, limit, skip, sort, sortKey } = parseListQuery(req.query, {
      sortable: ADMIN_REVIEW_SORT,
      defaultSort: "-createdAt",
      defaultLimit: 0,
    });
    const filter = {};
    if (checkin && checkout) {
      const range = parseMDYToUTC(checkin, checkout);
      filter.createdAt = { $gte: range.from, $lte: range.to };
    } else if (checkin && !checkout) {
      const singleDay = parseMDYToUTC(checkin);
      filter.createdAt = { $gte: singleDay.from, $lte: singleDay.to };
    }
    if (stars && stars !== "all") filter.rating = Number(stars);

    const afterLookup = [];
    if (flagged && flagged == "true") afterLookup.push({ $match: { "bookingId.flag": true, hideStatus: "pending" } });
    const term = searchRegex(search);
    if (term) {
      afterLookup.push({
        $match: {
          $or: [
            { content: { $regex: term } },
            { "user.firstName": { $regex: term } },
            { "user.lastName": { $regex: term } },
            {
              $expr: {
                $regexMatch: {
                  input: { $concat: [{ $ifNull: ["$user.firstName", ""] }, " ", { $ifNull: ["$user.lastName", ""] }] },
                  regex: term,
                },
              },
            },
          ],
        },
      });
    }
    const propertyTerm = property && property !== "all" ? searchRegex(property) : null;
    if (propertyTerm) afterLookup.push({ $match: { "property.title": { $regex: propertyTerm } } });

    const [result] = await Review.aggregate([
      { $match: filter },
      { $lookup: { from: "bookings", localField: "bookingId", foreignField: "_id", pipeline: [{ $project: { checkIn: 1, checkOut: 1, flag: 1 } }], as: "bookingId" } },
      { $unwind: { path: "$bookingId", preserveNullAndEmptyArrays: true } },
      { $lookup: { from: "listingproperties", localField: "property", foreignField: "_id", pipeline: [{ $project: { title: 1 } }], as: "property" } },
      { $unwind: { path: "$property", preserveNullAndEmptyArrays: true } },
      { $lookup: { from: "users", localField: "user", foreignField: "_id", pipeline: [{ $project: { firstName: 1, lastName: 1 } }], as: "user" } },
      { $unwind: { path: "$user", preserveNullAndEmptyArrays: true } },
      ...afterLookup,
      {
        $facet: {
          data: [{ $sort: sort }, ...pageStages({ skip, limit })],
          stats: [{ $group: { _id: null, count: { $sum: 1 }, avg: { $avg: "$rating" } } }],
        },
      },
    ]);
    const stats = result.stats[0] || { count: 0, avg: 0 };
    const total = stats.count;
    res.status(200).json({
      success: true,
      data: result.data,
      averageRating: total > 0 ? Number(stats.avg).toFixed(2) : 0,
      reviewCount: total,
      ...listMeta({ page, limit, total, sortKey }),
    });
  } catch (error) {
    console.error("Error in getAllReviews:", error);
    res
      .status(500)
      .json({ message: "Error fetching reviews", error: error.message });
  }
};

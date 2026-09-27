// controllers/authController.js
const crypto = require("crypto");

// A new admin's id is derived from its e-mail: two registrations of the same
// address at once collide on _id — always unique, no extra index needed —
// and exactly one is created. (Existing admins keep their ids; the e-mail
// pre-check covers them.)
function adminIdFor(email) {
  const hex = crypto.createHash("sha256").update(`admin-email:${String(email).trim().toLowerCase()}`).digest("hex").slice(0, 24);
  return new (require("mongoose").Types.ObjectId)(hex);
}
// Sign-in by e-mail must be unambiguous: with two Admin records for one
// address, a ban on one could be walked around through the other.
async function adminByEmail(email) {
  const found = await Admin.find({ email }).limit(2);
  return { admin: found[0] || null, ambiguous: found.length > 1 };
}
function ambiguousAdmin(res, requestType) {
  return res.status(409).json({ requestType, success: false, code: "ADMIN_AMBIGUOUS", message: "More than one admin account uses this e-mail. Sign-in is disabled for it until the owner resolves the duplicate.", statusCode: 409 });
}
const mongoose = require("mongoose");
const Admin = require("../models/Admin");
const User = require("../models/User");
const adminAudit = require("../services/adminAudit");
const { normalizeName, validateName } = require("../utils/names");
const Configure = require("../models/Configure");
const { generateOTP, sendAdminLoginOtp } = require("../utils/loginOtpUtils");
const jwt = require("jsonwebtoken");

// Constants
const MAX_RETRIES = 3;
const LOCK_DURATION = 5 * 60 * 1000; // 5 minutes in milliseconds
const TOKEN_EXPIRATION = "7d";

const createAdmin = async (req, res) => {
  try {
    const {
      firstName,
      lastName,
      email,
      phoneNumber,
      countryCode,
      profilePicture,
      dob,
      gender,
      preferences,
    } = req.body || {};

    // Basic validation for required fields. Strings only: an object here
    // would reach the findOne filters below as a query operator.
    const notString = (v) => v !== undefined && v !== null && typeof v !== "string";
    if (!firstName || !email || [firstName, lastName, email, phoneNumber, countryCode, profilePicture, gender].some(notString)) {
      return res.status(400).json({
        requestType: "CREATE_ADMIN",
        success: false,
        code: "MISSING_FIELDS",
        message: "First name and email are required, and every field must be text",
        statusCode: 400,
        fields: { firstName, email },
      });
    }

    // Check if admin with the same email already exists
    const existingAdmin = await Admin.findOne({ email });
    if (existingAdmin) {
      return res.status(409).json({
        requestType: "CREATE_ADMIN",
        success: false,
        code: "EMAIL_ALREADY_EXISTS",
        message: "An admin with this email already exists",
        statusCode: 409,
        fields: { email },
      });
    }

    // Check if phoneNumber is provided and unique
    if (phoneNumber) {
      const existingPhone = await Admin.findOne({ phoneNumber });
      if (existingPhone) {
        return res.status(409).json({
          requestType: "CREATE_ADMIN",
          success: false,
          code: "PHONE_ALREADY_EXISTS",
          message: "An admin with this phone number already exists",
          statusCode: 409,
          fields: { phoneNumber },
        });
      }
    }

    // The admin and the audit row naming who added it are written in one
    // transaction: an account without that record is exactly what the old
    // open registration produced. Built as a plain object so a retried
    // transaction inserts a fresh document.
    const fields = {
      _id: adminIdFor(email),
      firstName,
      lastName: lastName || "", // Optional field with default empty string
      email,
      phoneNumber: phoneNumber || undefined, // Optional, schema allows undefined
      countryCode: countryCode || "+91", // Default from schema
      profilePicture: profilePicture || undefined, // Optional
      dob: dob ? new Date(dob) : undefined, // Convert to Date if provided
      gender: gender || undefined, // Optional, schema has enum
      isVerified: true, // Set as verified since no OTP is required
      status: {
        active: true,
        banned: false,
        bannedReason: undefined,
      },
      preferences: preferences || {
        language: "en-IN",
        currency: "INR",
        theme: "light",
        notificationSettings: {
          email: true,
          sms: true,
          push: true,
        },
      }, // Use provided preferences or schema defaults
    };

    let savedAdmin = null;
    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        savedAdmin = null;
        [savedAdmin] = await Admin.create([fields], { session });
        await adminAudit.record(req, "admin.create", { targetType: "Admin", targetId: savedAdmin._id }, {}, { session });
      });
    } catch (err) {
      if (err && err.code === 11000 && err.keyPattern && err.keyPattern._id) {
        // the same address registered at the same moment: the other one won
        return res.status(409).json({ requestType: "CREATE_ADMIN", success: false, code: "EMAIL_ALREADY_EXISTS", message: "An admin with this email already exists", statusCode: 409, fields: { email } });
      }
      if (err && (err.name === "ValidationError" || err.code === 11000)) throw err;
      console.error("createAdmin: not recorded", err && (err.code || err.name));
      return res.status(503).json({
        requestType: "CREATE_ADMIN",
        success: false,
        code: "AUDIT_UNAVAILABLE",
        message: "The admin could not be recorded. Nothing was saved — please try again.",
        statusCode: 503,
      });
    } finally {
      await session.endSession().catch(() => {});
    }

    // No token for the new account: it signs in with its own e-mail OTP.
    return res.status(201).json({
      requestType: "CREATE_ADMIN",
      success: true,
      code: "ADMIN_CREATED",
      message: "Admin created successfully",
      statusCode: 201,
      data: {
        adminId: savedAdmin._id,
        firstName: savedAdmin.firstName,
        email: savedAdmin.email,
        createdAt: savedAdmin.createdAt,
      },
    });
  } catch (error) {
    // Name/code only — a duplicate-key message carries the e-mail.
    console.error("Error in createAdmin:", error && (error.code || error.name));

    if (error && error.code === 11000) {
      const phone = error.keyPattern && error.keyPattern.phoneNumber;
      return res.status(409).json({
        requestType: "CREATE_ADMIN",
        success: false,
        code: phone ? "PHONE_ALREADY_EXISTS" : "EMAIL_ALREADY_EXISTS",
        message: phone ? "An admin with this phone number already exists" : "An admin with this email already exists",
        statusCode: 409,
      });
    }

    // Handle specific Mongoose validation errors
    if (error.name === "ValidationError") {
      const errors = Object.values(error.errors).map((err) => err.message);
      return res.status(400).json({
        requestType: "CREATE_ADMIN",
        success: false,
        code: "VALIDATION_ERROR",
        message: "Validation failed",
        statusCode: 400,
        errors,
      });
    }

    return res.status(500).json({
      requestType: "CREATE_ADMIN",
      success: false,
      code: "SERVER_ERROR",
      message: "An unexpected error occurred",
      statusCode: 500,
    });
  }
};

// The login endpoints are public: their inputs must be plain strings, or a
// JSON object like {"$regex": "^a"} becomes a query operator — enumerating
// admins, mailing them OTPs and locking their accounts.
const isEmailInput = (v) => typeof v === "string" && v.length > 0 && v.length <= 254;
const badLoginInput = (res, requestType) =>
  res.status(400).json({ requestType, success: false, code: "INVALID_FIELDS", message: "Enter your admin email and the 6-digit code", statusCode: 400 });

const requestOTP = async (req, res) => {
  // Read outside the try: the catch echoes `email` (see loginController).
  const { email } = req.body || {};
  if (!isEmailInput(email)) return badLoginInput(res, "LOGIN_OTP_REQUEST");
  try {

    // Check if admin exists in the system
    const { admin: existingAdmin, ambiguous } = await adminByEmail(email);
    if (ambiguous) return ambiguousAdmin(res, "LOGIN_OTP_REQUEST");

    if (!existingAdmin) {
      return res.status(403).json({
        requestType: "LOGIN_OTP_REQUEST",
        success: false,
        code: "ADMIN_NOT_FOUND",
        message: "Admin not found. Please register first",
        statusCode: 403,
        fields: { email },
      });
    }

    if (!existingAdmin.isVerified) {
      return res.status(403).json({
        requestType: "LOGIN_OTP_REQUEST",
        success: false,
        code: "ADMIN_NOT_VERIFIED",
        message: "Admin not verified. Please complete registration",
        statusCode: 403,
        fields: { email },
      });
    }

    if (existingAdmin.status.banned) {
      return res.status(403).json({
        requestType: "LOGIN_OTP_REQUEST",
        success: false,
        code: "ADMIN_NOT_ACTIVE",
        message:
          "You are banned from the platform. Please contact support to know more",
        statusCode: 403,
        fields: { email },
      });
    }

    // Generate a new OTP and set expiry time
    const otp = generateOTP();
    const otpExpiry = new Date(Date.now() + 5 * 60 * 1000); // 5 minutes

    // Update admin with OTP
    existingAdmin.otp = {
      value: otp,
      expiry: otpExpiry,
    };

    // Save admin and send OTP
    await existingAdmin.save();
    await sendAdminLoginOtp(email, otp, existingAdmin.firstName);

    return res.status(200).json({
      requestType: "LOGIN_OTP_REQUEST",
      success: true,
      code: "OTP_SENT",
      message: "OTP sent successfully",
      statusCode: 200,
      fields: { email },
    });
  } catch (error) {
    console.error("Error in requestOTP:", error);
    return res.status(500).json({
      requestType: "LOGIN_OTP_REQUEST",
      success: false,
      code: "SERVER_ERROR",
      message: "An unexpected error occurred",
      statusCode: 500,
      fields: { email },
    });
  }
};

const verifyOTP = async (req, res) => {
  try {
    const { email, otp } = req.body || {};
    if (!isEmailInput(email) || (otp !== undefined && otp !== null && otp !== "" && typeof otp !== "string")) return badLoginInput(res, "LOGIN_OTP_VERIFICATION");

    // Validate OTP presence
    if (!otp) {
      return res.status(400).json({
        requestType: "LOGIN_OTP_VERIFICATION",
        success: false,
        error: true,
        code: "OTP_MISSING",
        message: "OTP is required for login verification",
        statusCode: 400,
      });
    }

    // Find admin by email
    const { admin, ambiguous } = await adminByEmail(email);
    if (ambiguous) return ambiguousAdmin(res, "LOGIN_OTP_VERIFICATION");

    if (!admin) {
      return res.status(404).json({
        requestType: "LOGIN_OTP_VERIFICATION",
        success: false,
        error: true,
        code: "ADMIN_NOT_FOUND",
        message: "Admin not found",
        statusCode: 404,
      });
    }

    // A lock that has run out gives a fresh set of attempts (otherwise the
    // counter stays at the limit and one wrong guess every few minutes keeps
    // the admin locked out for good).
    const now = new Date();
    await Admin.updateOne({ _id: admin._id, lockUntil: { $lte: now }, otpRetries: { $gte: MAX_RETRIES } }, { $set: { otpRetries: 0 }, $unset: { lockUntil: 1 } });

    // Every guess first takes one of the attempts, atomically: parallel
    // guesses can never be compared more than MAX_RETRIES times per code
    // (read → compare → save would let any number of them through).
    const claimed = await Admin.findOneAndUpdate(
      {
        _id: admin._id,
        otpRetries: { $lt: MAX_RETRIES },
        $or: [{ lockUntil: null }, { lockUntil: { $lte: now } }],
        "otp.value": { $nin: [null, ""] },
        "otp.expiry": { $gt: now },
      },
      { $inc: { otpRetries: 1 } },
      { new: true },
    ).lean();

    if (!claimed) {
      const current = await Admin.findById(admin._id).lean();
      const lockedUntil = current && current.lockUntil && new Date(current.lockUntil) > new Date() ? new Date(current.lockUntil) : null;
      if (lockedUntil || (current && current.otpRetries >= MAX_RETRIES)) {
        const until = lockedUntil || new Date(Date.now() + LOCK_DURATION);
        return res.status(423).json({
          requestType: "LOGIN_OTP_VERIFICATION",
          success: false,
          error: true,
          code: "ACCOUNT_LOCKED",
          message:
            "Account is temporarily locked due to multiple failed attempts",
          statusCode: 423,
          unlocksAt: {
            unlocksAt: until.toISOString(),
            remainingMinutes: Math.ceil((until - Date.now()) / 60000),
          },
        });
      }
      return res.status(410).json({
        requestType: "LOGIN_OTP_VERIFICATION",
        success: false,
        error: true,
        code: "OTP_EXPIRED",
        message: "OTP has expired. Please request a new one",
        statusCode: 410,
        expiredAt: (current && current.otp && current.otp.expiry) || null,
      });
    }

    const given = Buffer.from(otp);
    const expected = Buffer.from(String(claimed.otp.value));
    const matches = given.length === expected.length && crypto.timingSafeEqual(given, expected);

    if (!matches) {
      const remainingAttempts = MAX_RETRIES - claimed.otpRetries;

      // The last attempt locks the account and ends this code: after the
      // lock a new one must be requested.
      if (claimed.otpRetries >= MAX_RETRIES) {
        const lockUntil = new Date(Date.now() + LOCK_DURATION);
        await Admin.updateOne({ _id: admin._id }, { $set: { lockUntil, otp: { value: null, expiry: null } } });
        return res.status(423).json({
          requestType: "LOGIN_OTP_VERIFICATION",
          success: false,
          error: true,
          code: "ACCOUNT_LOCKED",
          message: "Account locked due to too many failed attempts",
          statusCode: 423,
          unlockAt: {
            unlocksAt: lockUntil.toISOString(),
            lockDuration: "5 minutes",
          },
        });
      }

      return res.status(400).json({
        requestType: "LOGIN_OTP_VERIFICATION",
        success: false,
        error: true,
        code: "INVALID_OTP",
        message: "Invalid OTP provided",
        statusCode: 400,
        otpAttempts: {
          remainingAttempts,
          attemptsUsed: claimed.otpRetries,
        },
      });
    }

    // The code is used once: only the request that clears it signs in.
    const used = await Admin.updateOne(
      { _id: admin._id, "otp.value": claimed.otp.value },
      { $set: { otp: { value: null, expiry: null }, otpRetries: 0 }, $unset: { lockUntil: 1 } },
    );
    if (used.modifiedCount !== 1) {
      return res.status(410).json({
        requestType: "LOGIN_OTP_VERIFICATION",
        success: false,
        error: true,
        code: "OTP_EXPIRED",
        message: "OTP has expired. Please request a new one",
        statusCode: 410,
        expiredAt: null,
      });
    }

    // Generate authentication token
    const token = jwt.sign(
      { userId: admin._id, firstName: admin.firstName },
      process.env.JWT_SECRET,
      {
        expiresIn: TOKEN_EXPIRATION,
      }
    );

    return res.status(200).json({
      requestType: "LOGIN_OTP_VERIFICATION",
      success: true,
      error: false,
      code: "VERIFICATION_COMPLETE",
      message: "Email verified successfully",
      statusCode: 200,
      token: {
        token,
        expiresIn: TOKEN_EXPIRATION,
      },
    });
  } catch (error) {
    console.error("Error in verifyOTP:", error);
    return res.status(500).json({
      requestType: "LOGIN_OTP_VERIFICATION",
      success: false,
      error: true,
      code: "SERVER_ERROR",
      message: "An unexpected error occurred",
      statusCode: 500,
    });
  }
};

const serviceFees = async (req, res) => {
  try {
    const { gst, service } = req.body;

    if (!gst || !service) {
      return res
        .status(400)
        .json({ success: false, error: "Missing required fields" });
    }
    if (gst < 0 || service < 0) {
      return res
        .status(400)
        .json({ success: false, error: "Gst cannot be less than 0" });
    }
    const existingData = await Configure.findOne();

    if (existingData.length != 0) {
      existingData.gst = gst;
      existingData.service = service;
      if (process.env.NEXT_PUBLIC_ENV === "dev") {
        console.log(existingData);
      }
      await existingData.save();

      res
        .status(200)
        .json({ success: true, message: "Updated", data: existingData });
    } else {
      const response = new Configure({ gst: gst, service: service });
      await response.save();

      res
        .status(200)
        .json({ success: true, message: "Succesful", data: response });
    }
  } catch (error) {
    res
      .status(500)
      .json({ message: "Failed to store data", error: error.message });
  }
};
const getServiceFees = async (req, res) => {
  try {
    const data = await Configure.find();

    if (!data) {
      return res
        .status(404)
        .json({ success: false, message: "Failed to find data" });
    }

    res
      .status(200)
      .json({ success: true, message: "Successful fetched", data: data });
  } catch (error) {
    res
      .status(500)
      .json({ message: "Failed to store data", error: error.message });
  }
};
// --- The signed-in admin's own profile (/admin/me) ---------------------------
// The target is always the caller: requireAdmin has resolved req.actor to an
// Admin record (actor.admin) or a User with role "admin" (actor.user). Only
// the name is writable here; e-mail, role and status are not.
function selfTarget(actor) {
  return actor.admin ? { Model: Admin, targetType: "Admin" } : { Model: User, targetType: "User" };
}
function selfFail(res, status, code, message, extra = {}) {
  return res.status(status).json({ success: false, code, message, statusCode: status, ...extra });
}

// GET /admin/me → { firstName, lastName, email }
const getMyProfile = async (req, res) => {
  try {
    const actor = req.actor;
    const { Model } = selfTarget(actor);
    const me = await Model.findById(actor.id).select("firstName lastName email").lean();
    if (!me) return selfFail(res, 404, "ADMIN_NOT_FOUND", "Your account no longer exists");
    return res.status(200).json({ success: true, data: { firstName: me.firstName, lastName: me.lastName || "", email: me.email } });
  } catch (err) {
    console.error("getMyProfile error", err && (err.code || err.name));
    return selfFail(res, 500, "SERVER_ERROR", "Could not load your profile");
  }
};

// PATCH /admin/me/name  { firstName, lastName, expected: { firstName, lastName } }
// Same semantics as the admin rename of a user (guestController.renameUser):
// validated, optimistic (expected), transactional with its audit row.
const renameMe = async (req, res) => {
  const body = req.body && typeof req.body === "object" ? req.body : {};
  const firstName = normalizeName(body.firstName);
  const lastName = normalizeName(body.lastName);
  const firstError = validateName(firstName, { required: true, label: "First name" });
  if (firstError) return selfFail(res, 400, "INVALID_NAME", firstError, { field: "firstName" });
  const lastError = validateName(lastName, { required: false, label: "Last name" });
  if (lastError) return selfFail(res, 400, "INVALID_NAME", lastError, { field: "lastName" });
  const expected = body.expected && typeof body.expected === "object" ? body.expected : null;
  if (!expected || typeof expected.firstName !== "string") return selfFail(res, 400, "EXPECTED_REQUIRED", "expected.firstName and expected.lastName are required");

  const actor = req.actor;
  const { Model, targetType } = selfTarget(actor);
  const session = await mongoose.startSession();
  let outcome;
  try {
    await session.withTransaction(async () => {
      outcome = null;
      const me = await Model.findById(actor.id).select("firstName lastName").session(session);
      if (!me) {
        outcome = { status: 404, code: "ADMIN_NOT_FOUND", message: "Your account no longer exists" };
        return;
      }
      const currentLast = me.lastName || "";
      if (me.firstName === firstName && currentLast === lastName) {
        outcome = { status: 200, body: { success: true, changed: false, data: { firstName: me.firstName, lastName: currentLast } } };
        return;
      }
      const expectedLast = typeof expected.lastName === "string" ? expected.lastName : "";
      const match = {
        _id: me._id,
        firstName: expected.firstName,
        $or: expectedLast === "" ? [{ lastName: "" }, { lastName: null }, { lastName: { $exists: false } }] : [{ lastName: expectedLast }],
      };
      const updated = await Model.updateOne(match, { $set: { firstName, lastName } }, { session });
      if (updated.matchedCount === 0) {
        outcome = { status: 409, code: "NAME_CHANGED", message: "Your name was changed elsewhere. Refresh and try again.", extra: { data: { firstName: me.firstName, lastName: currentLast } } };
        // Abort: nothing else must be written.
        throw Object.assign(new Error("NAME_CHANGED"), { abort: true });
      }
      await adminAudit.record(req, "admin.rename", { targetType, targetId: me._id }, { before: { firstName: me.firstName, lastName: currentLast }, after: { firstName, lastName } }, { session });
      outcome = { status: 200, body: { success: true, changed: true, data: { firstName, lastName } } };
    });
  } catch (err) {
    if (!(err && err.abort)) {
      console.error("renameMe error", err && (err.code || err.name));
      return selfFail(res, 503, "AUDIT_UNAVAILABLE", "The change could not be recorded. Nothing was saved — please try again.");
    }
  } finally {
    await session.endSession().catch(() => {});
  }
  if (!outcome) return selfFail(res, 500, "SERVER_ERROR", "Rename failed");
  if (outcome.body) return res.status(outcome.status).json(outcome.body);
  return selfFail(res, outcome.status, outcome.code, outcome.message, outcome.extra || {});
};

module.exports = {
  requestOTP,
  verifyOTP,
  createAdmin,
  serviceFees,
  getServiceFees,
  getMyProfile,
  renameMe,
};

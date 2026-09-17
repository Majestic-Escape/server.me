// controllers/authController.js
const Admin = require("../models/Admin");
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
    } = req.body;

    // Basic validation for required fields
    if (!firstName || !email) {
      return res.status(400).json({
        requestType: "CREATE_ADMIN",
        success: false,
        code: "MISSING_FIELDS",
        message: "First name and email are required",
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

    // Create new admin object
    const newAdmin = new Admin({
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
    });

    // Save the new admin to the database
    const savedAdmin = await newAdmin.save();

    // Generate JWT token (optional, remove if not needed)
    const token = jwt.sign(
      { userId: savedAdmin._id, firstName: savedAdmin.firstName },
      process.env.JWT_SECRET,
      { expiresIn: TOKEN_EXPIRATION }
    );

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
      token: {
        token,
        expiresIn: TOKEN_EXPIRATION,
      },
    });
  } catch (error) {
    console.error("Error in createAdmin:", error);

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

const requestOTP = async (req, res) => {
  // Read outside the try: the catch echoes `email` (see loginController).
  const { email } = req.body || {};
  try {

    // Check if admin exists in the system
    const existingAdmin = await Admin.findOne({ email });

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
    const { email, otp } = req.body;

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
    const admin = await Admin.findOne({ email });

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

    // Check if account is locked
    if (admin.isLocked()) {
      const remainingLockTime = admin.lockUntil - Date.now();
      return res.status(423).json({
        requestType: "LOGIN_OTP_VERIFICATION",
        success: false,
        error: true,
        code: "ACCOUNT_LOCKED",
        message:
          "Account is temporarily locked due to multiple failed attempts",
        statusCode: 423,
        unlocksAt: {
          unlocksAt: admin.lockUntil.toISOString(),
          remainingMinutes: Math.ceil(remainingLockTime / 60000),
        },
      });
    }

    // Check if OTP is expired
    if (!admin.otp || !admin.otp.value || admin.otp.expiry < Date.now()) {
      return res.status(410).json({
        requestType: "LOGIN_OTP_VERIFICATION",
        success: false,
        error: true,
        code: "OTP_EXPIRED",
        message: "OTP has expired. Please request a new one",
        statusCode: 410,
        expiredAt: admin.otp.expiry,
      });
    }

    // Check if OTP is valid
    if (admin.otp.value !== otp) {
      admin.otpRetries += 1;
      const remainingAttempts = MAX_RETRIES - admin.otpRetries;

      // Lock the account if retry limit is reached
      if (admin.otpRetries >= MAX_RETRIES) {
        admin.lockUntil = new Date(Date.now() + LOCK_DURATION);
        await admin.save();
        return res.status(423).json({
          requestType: "LOGIN_OTP_VERIFICATION",
          success: false,
          error: true,
          code: "ACCOUNT_LOCKED",
          message: "Account locked due to too many failed attempts",
          statusCode: 423,
          unlockAt: {
            unlocksAt: admin.lockUntil.toISOString(),
            lockDuration: "5 minutes",
          },
        });
      }

      await admin.save();
      return res.status(400).json({
        requestType: "LOGIN_OTP_VERIFICATION",
        success: false,
        error: true,
        code: "INVALID_OTP",
        message: "Invalid OTP provided",
        statusCode: 400,
        otpAttempts: {
          remainingAttempts,
          attemptsUsed: admin.otpRetries,
        },
      });
    }

    // Clear OTP and mark as verified
    admin.otp = { value: null, expiry: null }; // Clear OTP
    admin.otpRetries = 0;
    await admin.save();

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
module.exports = {
  requestOTP,
  verifyOTP,
  createAdmin,
  serviceFees,
  getServiceFees,
};

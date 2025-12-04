// controllers/authController.js
const User = require("../models/User");
const { generateOTP, sendOTP } = require("../utils/loginOtpUtils");

const jwt = require("jsonwebtoken");

// Constants
const MAX_RETRIES = 3;
const LOCK_DURATION = 5 * 60 * 1000; // 30 minutes in milliseconds
const TOKEN_EXPIRATION = "7d";

const requestOTP = async (req, res) => {
  try {
    const { email, admin = false } = req.body;

    // Check if user already exists in the system
    const existingUser = await User.findOne({ email });

    if (!existingUser) {
      return res.status(403).json({
        requestType: "LOGIN_OTP_REQUEST",
        success: false,
        code: "USER_NOT_FOUND",
        message: "User not found. Please register first",
        statusCode: 403,
        fields: { email },
      });
    }
    if (admin && existingUser.role != "admin") {
      return res.status(403).json({
        requestType: "LOGIN_OTP_REQUEST",
        success: false,
        code: "ADMIN_ACCESS_DENIED",
        message: "Admin access denied",
        statusCode: 403,
      });
    }

    if (!existingUser.isVerified) {
      return res.status(403).json({
        requestType: "LOGIN_OTP_REQUEST",
        success: false,
        code: "USER_NOT_VERIFIED",
        message: "User not verified. Please complete registration",
        statusCode: 403,
        fields: { email },
      });
    }

    if (existingUser.status.banned) {
      return res.status(403).json({
        requestType: "LOGIN_OTP_REQUEST",
        success: false,
        code: "USER_NOT_ACTIVE",
        message:
          "You are banned from the platform. Please contact support to know more",
        statusCode: 403,
        fields: { email },
      });
    }

    // Generate a new OTP and set expiry time
    const otp = generateOTP();
    const otpExpiry = new Date(Date.now() + 5 * 60 * 1000); // 5 minutes

    // Create new user with basic information and OTP
    existingUser.otp = {
      value: otp,
      expiry: otpExpiry,
    };
    // Save user and send OTP
    await existingUser.save();
    const name = existingUser.firstName + " " + existingUser.lastName;
    await sendOTP(email, otp, name);

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
      statusCode: 200,
      fields: { email },
    });
  }
};

const verifyOTP = async (req, res) => {
  try {
    const { email, otp, admin = false } = req.body;

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

    // Find user by phone number
    const user = await User.findOne({ email });

    if (!user) {
      return res.status(404).json({
        requestType: "LOGIN_OTP_VERIFICATION",
        success: false,
        error: true,
        code: "USER_NOT_FOUND",
        message: "User not found",
        statusCode: 404,
      });
    }

    // Check if account is locked
    if (user.isLocked()) {
      const remainingLockTime = user.lockUntil - Date.now();
      return res.status(423).json({
        requestType: "LOGIN_OTP_VERIFICATION",
        success: false,
        error: true,
        code: "ACCOUNT_LOCKED",
        message:
          "Account is temporarily locked due to multiple failed attempts",
        statusCode: 423,
        unlocksAt: {
          unlocksAt: user.lockUntil.toISOString(),
          remainingMinutes: Math.ceil(remainingLockTime / 60000),
        },
      });
    }

    // Check if OTP is expired
    if (!user.otp || !user.otp.value || user.otp.expiry < Date.now()) {
      return res.status(410).json({
        requestType: "LOGIN_OTP_VERIFICATION",
        success: false,
        error: true,
        code: "OTP_EXPIRED",
        message: "OTP has expired. Please request a new one",
        statusCode: 410,
        expiredAt: user.otp.expiry,
      });
    }

    // Check if OTP is valid
    if (user.otp.value !== otp) {
      user.otpRetries += 1;
      const remainingAttempts = MAX_RETRIES - user.otpRetries;

      // Lock the account if retry limit is reached
      if (user.otpRetries >= MAX_RETRIES) {
        user.lockUntil = new Date(Date.now() + LOCK_DURATION);
        await user.save();
        return res.status(423).json({
          requestType: "LOGIN_OTP_VERIFICATION",
          success: false,
          error: true,
          code: "ACCOUNT_LOCKED",
          message: "Account locked due to too many failed attempts",
          statusCode: 423,
          unlockAt: {
            unlocksAt: user.lockUntil.toISOString(),
            lockDuration: "5 minutes",
          },
        });
      }

      await user.save();
      return res.status(400).json({
        requestType: "LOGIN_OTP_VERIFICATION",
        success: false,
        error: true,
        code: "INVALID_OTP",
        message: "Invalid OTP provided",
        statusCode: 400,
        otpAttempts: {
          remainingAttempts,
          attemptsUsed: user.otpRetries,
        },
      });
    }

    // Clear OTP and mark as verified
    user.otp = { value: null, expiry: null }; // Clear OTP
    user.otpRetries = 0;
    await user.save();
    console.log("We are setting the token", admin, typeof admin);
    // Generate authentication token
    const token = jwt.sign(
      {
        userId: user._id,
        firstName: user.firstName,
        tokenVersion: user.tokenVersion,
        admin: admin ? 1 : 0,
      },
      process.env.JWT_SECRET,
      {
        expiresIn: TOKEN_EXPIRATION,
      }
    );

    return res.status(200).json({
      userId: user._id,
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

module.exports = {
  requestOTP,
  verifyOTP,
};

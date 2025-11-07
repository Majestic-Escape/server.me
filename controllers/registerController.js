const User = require("../models/User");
const { generateOTP, sendOTP } = require("../utils/otpUtils");
const { sendWelcomeMail } = require("../utils/sendWelcomeMail");
const jwt = require("jsonwebtoken");

const capitalize = (str) =>
  str.charAt(0).toUpperCase() + str.slice(1).toLowerCase();

// Constants
const MAX_RETRIES = 3;
const LOCK_DURATION = 5 * 60 * 1000; // 5 minutes in milliseconds
const TOKEN_EXPIRATION = "7d";

const requestOTP = async (req, res) => {
  try {
    const { firstName, lastName, phoneNumber, email, dob } = req.body;

    // Check if user already exists
    const existingUser = await User.findOne({
      $or: [{ phoneNumber }, { email }],
    });

    if (existingUser) {
      if (existingUser.isVerified) {
        return res.status(409).json({
          requestType: "REGISTRATION_OTP_REQUEST",
          success: false,
          code: "USER_EXISTS",
          message: "A user with this email or phone number already exists",
          statusCode: 409,
          fields: { email, phoneNumber },
        });
      } else {
        // Generate a new OTP and set expiry time
        const otp = generateOTP();
        const otpExpiry = new Date(Date.now() + 15 * 60 * 1000); // 15 minutes expiry

        // Update existing user with the new OTP and expiry
        existingUser.otp = {
          value: otp,
          expiry: otpExpiry,
        };

        // Save the updated user data
        await existingUser.save();

        try {
          // Send OTP via email
          await sendOTP(email, otp, existingUser.firstName);
        } catch (error) {
          console.error("Error sending OTP:", error);
          return res.status(500).json({
            requestType: "REGISTRATION_OTP_REQUEST",
            success: false,
            code: "EMAIL_ERROR",
            message: "Failed to send OTP. Please try again later.",
            statusCode: 500,
          });
        }

        return res.status(200).json({
          requestType: "REGISTRATION_OTP_REQUEST",
          success: true,
          code: "OTP_SENT",
          message: "OTP sent successfully",
          statusCode: 200,
          fields: { firstName, lastName, phoneNumber, email, dob },
        });
      }
    } else {
      // User doesn't exist, create a new user (this part already exists in your code)
      const otp = generateOTP();
      const otpExpiry = new Date(Date.now() + 15 * 60 * 1000);

      try {
        const user = new User({
          firstName: capitalize(firstName),
          lastName: capitalize(lastName),
          email: email.toLowerCase(),
          phoneNumber,
          dob,
          otp: {
            value: otp,
            expiry: otpExpiry,
          },
        });

        // Save new user and send OTP
        await user.save();
        const name = user.firstName + " " + user.lastName;
        try {
          await sendOTP(email, otp, name);
        } catch (error) {
          console.error("Error sending OTP:", error);
          return res.status(500).json({
            requestType: "REGISTRATION_OTP_REQUEST",
            success: false,
            code: "EMAIL_ERROR",
            message: "Failed to send OTP. Please try again later.",
            statusCode: 500,
          });
        }

        return res.status(200).json({
          userId: user._id,
          requestType: "REGISTRATION_OTP_REQUEST",
          success: true,
          code: "OTP_SENT",
          message: "OTP sent successfully",
          statusCode: 200,
          fields: { firstName, lastName, phoneNumber, email, dob },
        });
      } catch (error) {
        console.error("Error saving user:", error);
        return res.status(500).json({
          requestType: "REGISTRATION_OTP_REQUEST",
          success: false,
          code: "SERVER_ERROR",
          message: "An unexpected error occurred",
          statusCode: 500,
        });
      }
    }
  } catch (error) {
    console.error("Error in requestOTP:", error);
    return res.status(500).json({
      requestType: "REGISTRATION_OTP_REQUEST",
      success: false,
      code: "SERVER_ERROR",
      message: "An unexpected error occurred",
      statusCode: 500,
      fields: { email, phoneNumber },
    });
  }
};

const verifyOTP = async (req, res) => {
  try {
    const { email, otp } = req.body;

    // Validate OTP presence
    if (!otp) {
      return res.status(400).json({
        requestType: "REGISTRATION_OTP_VERIFICATION",
        success: false,
        error: true,
        code: "OTP_MISSING",
        message: "OTP is required for verification",
        statusCode: 400,
      });
    }

    // Find user by email
    const user = await User.findOne({ email });

    if (!user) {
      return res.status(404).json({
        requestType: "REGISTRATION_OTP_VERIFICATION",
        success: false,
        error: true,
        code: "USER_NOT_FOUND",
        message: "User not found",
        statusCode: 404,
      });
    }

    // Check if account is locked
    if (user.lockUntil && user.lockUntil > Date.now()) {
      const remainingLockTime = user.lockUntil - Date.now();
      return res.status(423).json({
        requestType: "REGISTRATION_OTP_VERIFICATION",
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
    if (
      !user.otp ||
      !user.otp.value ||
      new Date(user.otp.expiry).getTime() < Date.now()
    ) {
      return res.status(410).json({
        requestType: "REGISTRATION_OTP_VERIFICATION",
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
          requestType: "REGISTRATION_OTP_VERIFICATION",
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
        requestType: "REGISTRATION_OTP_VERIFICATION",
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
    user.otp = { value: null, expiry: null };
    user.otpRetries = 0;
    user.verification.emailVerified = true;
    user.isVerified = true;
    await user.save();

    // Send welcome email
    try {
      const name = user.firstName + " " + user.lastName;
      await sendWelcomeMail(user.email, name);
    } catch (error) {
      console.error("Error sending welcome email:", error);
    }

    // Generate authentication token
    const token = jwt.sign(
      { userId: user._id, firstName: user.firstName },
      process.env.JWT_SECRET,
      { expiresIn: TOKEN_EXPIRATION }
    );

    return res.status(200).json({
      userId: user._id,
      requestType: "REGISTRATION_OTP_VERIFICATION",
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
      requestType: "REGISTRATION_OTP_VERIFICATION",
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

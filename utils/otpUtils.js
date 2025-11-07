// utils/otpUtils.js
const axios = require("axios");
require("dotenv").config();

// Configuration constants
const BREVO_API_URL = "https://api.brevo.com/v3/smtp/email";
const DEFAULT_SENDER = {
  name: process.env.EMAIL_SENDER_NAME || "Majestic Escape",
  email: process.env.EMAIL_SENDER_ADDRESS || "notify@majesticescape.in",
};

/**
 * Sends OTP email using Brevo's API
 * @param {string} recipientEmail - Recipient's email address
 * @param {string} firstName - Recipient's first name
 * @param {string} otp - Generated OTP code
 * @returns {Promise} API response
 */
async function sendOTPEmail(recipientEmail, firstName, otp) {
  // Prepare the request payload for Brevo API
  const requestPayload = {
    sender: DEFAULT_SENDER,
    to: [{ email: recipientEmail }],
    templateId: parseInt(process.env.REGISTRATION_OTP_TEMPLATE_ID),
    params: {
      firstName: firstName,
      otp: otp,
    },
  };

  try {
    // Make API request to Brevo
    const response = await axios.post(BREVO_API_URL, requestPayload, {
      headers: {
        accept: "application/json",
        "api-key": process.env.BREVO_API_KEY,
        "content-type": "application/json",
      },
    });

    console.log("Email sent successfully:", {
      messageId: response.data.messageId,
      recipient: recipientEmail,
    });

    return response.data;
  } catch (error) {
    // Enhanced error logging
    console.error("Error sending email:", {
      status: error.response?.status,
      message: error.response?.data?.message || error.message,
      recipient: recipientEmail,
    });

    throw new Error(
      `Failed to send OTP email: ${
        error.response?.data?.message || error.message
      }`
    );
  }
}

/**
 * Generates a random 6-digit OTP
 * @returns {string} 6-digit OTP
 */
const generateOTP = () => {
  return Math.floor(100000 + Math.random() * 900000).toString();
};

/**
 * Sends OTP via SMS (placeholder for SMS implementation)
 * @param {string} phoneNumber - Recipient's phone number
 * @param {string} otp - Generated OTP
 * @returns {Promise} Promise resolving to SMS send result
 */
const sendOTPSMS = async (phoneNumber, otp) => {
  console.log(
    `SMS OTP feature not implemented. Would send ${otp} to ${phoneNumber}`
  );
  return Promise.resolve(true);
};

/**
 * Main function to send OTP via either email or SMS
 * @param {string} recipient - Email or phone number
 * @param {string} otp - Generated OTP
 * @param {string} firstName - Recipient's first name
 * @param {string} type - Type of OTP delivery ('email' or 'sms')
 * @returns {Promise} Promise resolving to send result
 */
const sendOTP = async (recipient, otp, name, type = "email") => {
  console.log("Sending OTP:", { type, recipient, name, otp });
  try {
    // Validate OTP format
    if (!otp || otp.length !== 6) {
      throw new Error("Invalid OTP format");
    }

    // Send OTP based on delivery type
    if (type === "email") {
      return await sendOTPEmail(recipient, name, otp);
    } else if (type === "sms") {
      return await sendOTPSMS(recipient, otp);
    } else {
      throw new Error("Invalid OTP delivery type");
    }
  } catch (error) {
    console.error("Error in sendOTP:", {
      type,
      recipient,
      error: error.message,
    });
    throw error;
  }
};

module.exports = {
  generateOTP,
  sendOTP,
  sendOTPEmail,
  sendOTPSMS,
};

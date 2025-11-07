// utils/otpUtils.js
const axios = require("axios");
require("dotenv").config();

// Configuration constants
const BREVO_API_URL = "https://api.brevo.com/v3/smtp/email";
const DEFAULT_SENDER = {
  name: process.env.EMAIL_SENDER_NAME || "Majestic Escape",
  email: process.env.EMAIL_SENDER_ADDRESS || "notify@majesticescape.in",
};

async function sendOTPEmail(recipientEmail, firstName, otp) {
  // Prepare the request payload for Brevo API
  const requestPayload = {
    sender: DEFAULT_SENDER,
    to: [{ email: recipientEmail }],
    templateId: parseInt(process.env.LOGIN_OTP_TEMPLATE_ID),
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

async function sendAdminOTPEmail(recipientEmail, firstName, otp) {
  // Prepare the request payload for Brevo API
  const requestPayload = {
    sender: DEFAULT_SENDER,
    to: [{ email: recipientEmail }],
    templateId: parseInt(process.env.LOGIN_OTP_TEMPLATE_ID),
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

const generateOTP = () => {
  return Math.floor(100000 + Math.random() * 900000).toString();
};

const sendOTPSMS = async (phoneNumber, otp) => {
  console.log(
    `SMS OTP feature not implemented. Would send ${otp} to ${phoneNumber}`
  );
  return Promise.resolve(true);
};

const sendOTP = async (recipient, otp, firstName, type = "email") => {
  console.log("Sending OTP:", { type, recipient, firstName, otp });
  try {
    // Validate OTP format
    if (!otp || otp.length !== 6) {
      throw new Error("Invalid OTP format");
    }

    // Send OTP based on delivery type
    if (type === "email") {
      return await sendOTPEmail(recipient, firstName, otp);
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

const sendAdminLoginOtp = async (
  recipient,
  otp,
  firstName = "Admin",
  type = "email"
) => {
  console.log("Sending OTP:", { type, recipient, firstName, otp });
  try {
    // Validate OTP format
    if (!otp || otp.length !== 6) {
      throw new Error("Invalid OTP format");
    }

    // Send OTP based on delivery type
    if (type === "email") {
      return await sendOTPEmail(recipient, firstName, otp);
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
  sendAdminLoginOtp,
  sendAdminOTPEmail,
};

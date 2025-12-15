// utils/otpUtils.js
const axios = require("axios");
const { sendEmail } = require("./sendEmail");
require("dotenv").config();

// Configuration constants
const BREVO_API_URL = "https://api.brevo.com/v3/smtp/email";
const DEFAULT_SENDER = {
  name: process.env.EMAIL_SENDER_NAME || "Majestic Escape",
  email: process.env.EMAIL_SENDER_ADDRESS || "notify@majesticescape.in",
};

async function sendWelcomeMail(recipientEmail, firstName) {
  // Prepare the request payload for Brevo API
  const offer = process.env.HOST_COMMISSION_OFFER.trim() === "true";
  let requestPayload;
  let requestOfferPayload;
  if (offer) {
    requestPayload = {
      sender: DEFAULT_SENDER,
      to: [{ email: recipientEmail }],
      templateId: parseInt(process.env.WELCOME_MAIL_TEMPLATE_ID),
      params: {
        firstName: firstName,
        // header: process.env.WELCOME_MESSAGE_HEADER,
        // body: process.env.WELCOME_MESSAGE_BODY,
        // bottom: process.env.WELCOME_MESSAGE_BOTTOM,
        // otp: otp
      },
    };
    requestOfferPayload = {
      sender: DEFAULT_SENDER,
      to: [{ email: recipientEmail }],
      templateId: parseInt(process.env.OFFER_MAIL_TEMPLATE_ID),
      params: {
        firstName: firstName,
        // header: process.env.WELCOME_MESSAGE_HEADER,
        // body: process.env.WELCOME_MESSAGE_BODY,
        // bottom: process.env.WELCOME_MESSAGE_BOTTOM,
        // otp: otp
      },
    };
  } else {
    requestPayload = {
      sender: DEFAULT_SENDER,
      to: [{ email: recipientEmail }],
      templateId: parseInt(process.env.WELCOME_MAIL_TEMPLATE_ID),
      params: {
        firstName: firstName,
        // header: process.env.WELCOME_MESSAGE_HEADER,
        // body: process.env.WELCOME_MESSAGE_BODY,
        // bottom: process.env.WELCOME_MESSAGE_BOTTOM,
        // otp: otp
      },
    };
  }
  try {
    // Make API request to Brevo
    const response = await axios.post(BREVO_API_URL, requestPayload, {
      headers: {
        accept: "application/json",
        "api-key": process.env.BREVO_API_KEY,
        "content-type": "application/json",
      },
    });
    if (offer) {
      const offer = await axios.post(BREVO_API_URL, requestOfferPayload, {
        headers: {
          accept: "application/json",
          "api-key": process.env.BREVO_API_KEY,
          "content-type": "application/json",
        },
      });
    }

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

module.exports = {
  sendWelcomeMail,
};

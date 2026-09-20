const axios = require("axios");
require("dotenv").config();

// Configuration constants
const BREVO_API_URL = "https://api.brevo.com/v3/smtp/email";
const DEFAULT_SENDER = {
  name: process.env.EMAIL_SENDER_NAME || "Majestic Escape",
  email: process.env.EMAIL_SENDER_ADDRESS || "notify@majesticescape.in",
};

async function sendEmail(recipientEmail, templateId, params, attachments = []) {
  // Test seam (never set in a deployment): record instead of sending.
  if (process.env.EMAIL_DISABLED === "1") {
    sendEmail.sent = sendEmail.sent || [];
    sendEmail.sent.push({ recipientEmail, templateId: Number(templateId), attachments: attachments.length, params });
    return { skipped: true, recipientEmail, templateId };
  }
  // Prepare the request payload for Brevo API
  const requestPayload = {
    sender: DEFAULT_SENDER,
    to: [{ email: recipientEmail }],
    templateId: parseInt(templateId),
    params: params,
  };

  if (attachments.length > 0) {
    requestPayload.attachment = attachments;
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
      `Failed to send email: ${error.response?.data?.message || error.message}`
    );
  }
}

async function sendHostNotification(recipientEmail, firstName, message) {
  return sendEmail(
    recipientEmail,
    process.env.HOST_NOTIFICATION_TEMPLATE_ID || 2,
    {
      firstName: firstName,
      message: message,
    }
  );
}

module.exports = {
  sendEmail,
  sendHostNotification,
};

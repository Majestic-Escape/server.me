// pendingKycMailer.js
const axios = require("axios");
require("dotenv").config();

// Configuration constants
const BREVO_API_URL = "https://api.brevo.com/v3/smtp/email";
const DEFAULT_SENDER = {
  name: process.env.EMAIL_SENDER_NAME || "Majestic Escape",
  email: process.env.EMAIL_SENDER_ADDRESS || "notify@majesticescape.in",
};

/**
 * Sends a pending KYC email using the Brevo API.
 * @param {string} recipientEmail - The recipient's email address.
 * @param {string} firstName - The recipient's first name.
 * @returns {Promise<Object>}f The API response.
 */
async function sendPendingKycMail(recipientEmail, firstName) {
  // Prepare the request payload for the Brevo API
  const requestPayload = {
    sender: DEFAULT_SENDER,
    to: [{ email: recipientEmail }],
    templateId: 5,
    params: {
      hostFirstName: firstName,
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
      `Failed to send email: ${error.response?.data?.message || error.message}`
    );
  }
}

// If this file is run directly, send emails to an array of people.
if (require.main === module) {
  (async function sendEmailsToPeople() {
    // Define an array of people with their first name and email address.

    const people = [
      { firstname: "Shriraj", email: "nykshriraj4nov@gmail.com" },
      { firstname: "Aishwar", email: "aishwar@wilderkeys.in" },
      { firstname: "Atif", email: "atifahmed1441@gmail.com" },
      { firstname: "Jesely", email: "jeselyd@gmail.com" },
      { firstname: "Malvino", email: "ronconpereirarentals@gmail.com" },
      { firstname: "Raj", email: "raj@wilderkeys.in" },
      { firstname: "Bhalchandra", email: "farm51goa@gmail.com" },
      { firstname: "Anthony", email: "joshuapereira56@gmail.com" },
      { firstname: "Sanjiv", email: "sashhospitality@gmail.com" },
      { firstname: "Abhijit", email: "abhijit.naik.vu@gmail.com" },
      { firstname: "Rohit", email: "rohitkumbhar2312@gmail.com" },
      { firstname: "Evianho", email: "evianrodrigues@gmail.com" },
      { firstname: "Viraj", email: "virajambekar194@gmail.com" },
      { firstname: "Nirmalya", email: "sur.samrat1181@gmail.com" },
      { firstname: "Divya", email: "kukinaik29@gmail.com" },
      { firstname: "Vaishali", email: "naikpramila880@gmail.com" },
      { firstname: "Nikhil", email: "naik.nikhil32@gmail.com" },
      { firstname: "Edwin", email: "edwinfernandes1234@gmail.com" },
      { firstname: "Nityanand", email: "nityanandparab2112@gmail.com" },
      { firstname: "Abhishek", email: "abhishek15164091@gmail.com" },
      { firstname: "Ashima", email: "menon1620@gmail.com" },
      { firstname: "John", email: "teamrocket243601@gmail.com" },
      { firstname: "Aditi", email: "aditivats68@gmail.com" },
      { firstname: "Anish", email: "sharmaanish512@gmail.com" },
      { firstname: "Divya", email: "divyayashsaxena2000@gmail.com" },
      { firstname: "Leslie", email: "lesz.dsouza@gmail.com" },
    ];

    // Loop through each person and send the pending KYC email.
    for (const person of people) {
      try {
        await sendPendingKycMail(person.email, person.firstname);
      } catch (error) {
        console.error(
          `Failed to send email to ${person.email}:`,
          error.message
        );
      }
    }
  })();
}

module.exports = {
  sendPendingKycMail,
};

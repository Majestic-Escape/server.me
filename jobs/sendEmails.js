const axios = require("axios");
var sib = require("sib-api-v3-sdk");
var client = sib.ApiClient.instance;
var apiKey = client.authentications["api-key"];

// Set your Brevo (Sendinblue) API key from an environment variable.
apiKey.apiKey = process.env.BREVO_SECRET;

/**
 * Sends an email via Sendinblue/Brevo using the provided template.
 * @param {string} firstName - The user's first name.
 * @param {string} email - The user's email address.
 */
async function sendPendingKYCEmail(firstName, email) {
  if (process.env.NEXT_PUBLIC_ENV === "dev") {
    console.log(`Sending email to ${firstName} (${email})`);
  }
  const templateId = 4;
  const requestPayload = {
    sender: { name: "MaajesticEscape", email: "notify@majesticescape.in" },
    to: [{ email: email }],
    templateId: templateId,
    params: { hostFirstName: firstName, email: email },
  };

  try {
    const response = await axios.post(
      "https://api.sendinblue.com/v3/smtp/email",
      requestPayload,
      {
        headers: { "api-key": apiKey.apiKey },
      }
    );

    if (process.env.NEXT_PUBLIC_ENV === "dev") {
      console.log("Email sent successfully:", response.data);
    }
  } catch (error) {
    console.error(
      "Error sending email:",
      error.response?.data || error.message
    );
  }
}

/**
 * Defines an array of people and sends an email to each one.
 * Two additional random email entries are added to the array.
 */
async function sendEmailsToPeople() {
  // Array of people with pending listing (example data)
  const people = [];

  // Add two additional random email entries
  people.push({ firstname: "Yash", email: "divyayashsaxena2000@gmail.com" });
  people.push({ firstname: "Aditi", email: "aditi1617@icloud.com" });

  // Loop over each person in the array and send the email
  for (const person of people) {
    await sendPendingKYCEmail(person.firstname, person.email);
  }
}

// Execute the function to send emails to the defined people.
sendEmailsToPeople();

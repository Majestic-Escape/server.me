// emailUtils.js
const brevo = require("@sendinblue/client"); // Assuming Brevo SDK

const brevoClient = new brevo.TransactionalEmailsApi();
brevoClient.setApiKey(
  brevo.TransactionalEmailsApiApiKeys.apiKey,
  process.env.BREVO_API_KEY
);

exports.generateOtp = () => {
  return Math.floor(100000 + Math.random() * 900000).toString();
};

exports.sendGuestLoginOtpEmail = async (email, name, otp) => {
  const emailData = {
    to: [{ email, name }],
    sender: { email: "notify@majesticescape.in", name: "Majestic Escape" },
    subject: "Your OTP Code",
    htmlContent: `<p>Hi ${name},</p><p>Your OTP code is <strong>${otp}</strong>. It will expire in 5 minutes.</p>`,
  };

  try {
    await brevoClient.sendTransacEmail(emailData);
    if (process.env.NEXT_PUBLIC_ENV === "dev") {
      console.log("OTP email sent successfully.");
    }
  } catch (error) {
    console.error("Error sending OTP email:", error);
    throw new Error("Failed to send OTP email.");
  }
};

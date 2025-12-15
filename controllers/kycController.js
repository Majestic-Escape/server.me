const axios = require("axios");

const BASE_URL = process.env.DIGITAP_BASE_URL; // Set in .env
const CLIENT_ID = process.env.DIGITAP_CLIENT_ID;
const CLIENT_SECRET = process.env.DIGITAP_CLIENT_SECRET;

// Function to encode client credentials
const getAuthHeader = () => {
  const credentials = `${CLIENT_ID}:${CLIENT_SECRET}`;
  return `Basic ${Buffer.from(credentials).toString("base64")}`;
};

exports.generateKycUrl = async (req, res) => {
  try {
    const {
      redirectionUrl = "https://7127-103-177-203-54.ngrok-free.app/api/v1/kyc/webhook",
      uniqueId = "me001",
      expiryHours = 72,
    } = req.body;

    if (!redirectionUrl || !uniqueId) {
      return res
        .status(400)
        .json({ error: "redirectionUrl and uniqueId are required" });
    }

    const response = await axios.post(
      `https://svc.digitap.ai/kyc-unified/v1/generate-url/`,
      { redirectionUrl, uniqueId, expiryHours },
      {
        headers: {
          Authorization: getAuthHeader(),
          "Content-Type": "application/json",
        },
      }
    );

    res.json(response.data);
  } catch (error) {
    if (process.env.NEXT_PUBLIC_ENV === "dev") {
      console.log(error);
    }
    res.status(error.response?.status || 500).json({ error: error.message });
  }
};

exports.verifyPan = async (req, res) => {
  try {
    const { redirectionUrl, uniqueId, expiryHours = 72 } = req.body;

    if (!redirectionUrl || !uniqueId) {
      return res
        .status(400)
        .json({ error: "redirectionUrl and uniqueId are required" });
    }

    const response = await axios.post(
      `${BASE_URL}/kyc-unified/v1/generate-url/`,
      { redirectionUrl, uniqueId, expiryHours },
      {
        headers: {
          Authorization: getAuthHeader(),
          "Content-Type": "application/json",
        },
      }
    );

    res.json(response.data);
  } catch (error) {
    res.status(error.response?.status || 500).json({ error: error.message });
  }
};

// Get KYC transaction details
exports.getKycDetails = async (req, res) => {
  try {
    const { transactionId } = req.params;

    if (!transactionId) {
      return res.status(400).json({ error: "Transaction ID is required" });
    }

    const response = await axios.get(
      `${BASE_URL}/kyc-unified/v1/${transactionId}/details/`,
      {
        headers: {
          Authorization: getAuthHeader(),
          "Content-Type": "application/json",
        },
      }
    );

    res.json(response.data);
  } catch (error) {
    res.status(error.response?.status || 500).json({ error: error.message });
  }
};

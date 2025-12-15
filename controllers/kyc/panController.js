const axios = require("axios");
require("dotenv").config();

const BASE_URL = "https://svc.digitap.ai/validation/kyc/v1/pan_basic";
const CLIENT_ID = process.env.DIGITAP_CLIENT_ID;
const CLIENT_SECRET = process.env.DIGITAP_CLIENT_SECRET;

const getAuthHeader = () => {
  const credentials = `${CLIENT_ID}:${CLIENT_SECRET}`;
  return `Basic ${Buffer.from(credentials).toString("base64")}`;
};

// Verify PAN API
exports.verifyPan = async (req, res) => {
  try {
    // const { panNumber, name } = req.body;

    if (!panNumber || !name) {
      return res
        .status(400)
        .json({ error: "PAN Number and Name are required" });
    }

    const response = await axios.post(
      "https://svc.digitap.ai/validation/kyc/v1/pan_basic",
      {
        client_ref_num: 10000000003,
        pan: "BEDPY1345E",
        name: "Divya Yash",
        name_match_method: "dg_name_match",
      },

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

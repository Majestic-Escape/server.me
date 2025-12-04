const KycLogs = require("../models/KycLogs");
const User = require("../models/User");
const { v4: uuidv4 } = require("uuid");
const axios = require("axios");
const OCR_API = process.env.OCR_API;
const STATUS_GST = process.env.STATUS_GST;
const AUTH_HEADER = process.env.AUTH_HEADER;
const CLIENT_ID = process.env.DIGITAP_CLIENT_ID;
const CLIENT_SECRET = process.env.DIGITAP_CLIENT_SECRET;
const getAuthHeader = () => {
  const credentials = `${CLIENT_ID}:${CLIENT_SECRET}`;
  console.log("Header", Buffer.from(credentials).toString("base64"));

  return `Basic ${Buffer.from(credentials).toString("base64")}`;
};
function makeClientRefId(prefix) {
  let id = `${prefix}-${uuidv4()}`; // uuidv4 is 36 chars, prefix+dash ~ +4 -> < 45 OK usually
  return id.slice(0, 45);
}
async function performGstCheck(requestData) {
  console.log("gst access");
  try {
    const response = await axios.post(`${STATUS_GST}/gst`, requestData, {
      headers: {
        "Content-Type": "application/json",
        Authorization: getAuthHeader(),
      },
    });
    console.log("gst ", response.data);
    return response.data;
  } catch (error) {
    const errorMessage = error.response?.data
      ? JSON.stringify(error.response.data.error, null, 2)
      : error.message;
    console.log("Gst not validated", errorMessage);
  }
}

async function performPanCheck(requestData) {
  try {
    const response = await axios.post(
      `${STATUS_GST}/gstpansearch`,
      requestData,
      {
        headers: {
          "Content-Type": "application/json",
          Authorization: getAuthHeader(),
        },
      }
    );

    return response.data;
  } catch (error) {
    const errorMessage = error.response?.data
      ? JSON.stringify(error.response.data.error, null, 2)
      : error.message;
    console.log("PAN not validated", errorMessage);

    throw new Error(errorMessage);
  }
}

exports.verifyGst = async (req, res) => {
  try {
    const { userId, panNumber, gstNumber } = req.body;

    if (!userId) return res.status(400).json({ error: "userId required" });
    console.log("midway0");
    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ error: "User not found" });

    const statusClientRefNum = makeClientRefId("PAN");
    const statusLog = await KycLogs.create({
      userId,
      email: user.email,
      type: "Gst Pan",
      requestData: {
        pan: panNumber,
        client_ref_num: statusClientRefNum,
      },
    });
    let statusResult;
    try {
      statusResult = await performPanCheck(statusLog.requestData);
    } catch (err) {
      return res.status(500).json({
        success: false,
        message: "Invalid PAN Number or Network Issue",
      });
    }
    // const statusResult = await performPanCheck(statusLog.requestData);
    if (statusResult?.http_response_code !== 200) {
      return res
        .status(404)
        .json({ success: false, message: "Business PAN not found " });
    }
    console.log("midway1", statusResult);
    statusLog.status = "success";
    statusLog.responseData = statusResult;
    await statusLog.save();

    const list = statusResult?.result?.gstinResList;
    if (!Array.isArray(list)) {
      return res.status(404).json({
        success: false,
        message: "No GST data found for this PAN",
      });
    }

    const filtered = list.filter((item) => item?.gstin == gstNumber);

    if (!filtered?.length) {
      return res.status(404).json({
        success: false,
        message: "GST associated with Business PAN not found",
      });
    }
    const matched = filtered[0];
    // const data = statusResult?.result?.gstinResList.filter(
    //   (item) => item.gstin == gstNumber
    // );
    // console.log("midway2", data);
    // if (!data) {
    //   return res.status(404).json({
    //     success: false,
    //     message: "Gst associated with Business PAN not found ",
    //   });
    // }
    // console.log("midway3", data[0]);
    if (matched.authStatus != "Active") {
      return res.status(404).json({
        success: false,
        message: "Gst associated with Business PAN inactive ",
      });
    }

    const statusGstClientRefNum = makeClientRefId("GST");

    const statusGstLog = await KycLogs.create({
      userId,
      email: user.email,
      type: "Gst",
      requestData: {
        gstin: gstNumber,
        client_ref_num: statusGstClientRefNum,
      },
    });
    let statusGstResult;
    try {
      statusGstResult = await performGstCheck(statusGstLog.requestData);
    } catch (err) {
      return res.status(500).json({
        success: false,
        message: "Failed to verify GST",
      });
    }
    // const statusGstResult = await performGstCheck(statusGstLog.requestData);
    if (statusGstResult.http_response_code !== 200) {
      return res
        .status(404)
        .json({ success: false, message: "Gst data not found " });
    }
    statusGstLog.status = "success";
    statusGstLog.responseData = statusGstResult;
    await statusGstLog.save();

    return res.json({ success: true, data: statusGstResult });
  } catch (error) {
    console.error(
      "verifyGST error:",
      error.response?.data || error.message || error
    );

    return res.status(500).json({
      success: false,
      message: "Incorrect PAN or GST Number" || "Server error",
      details: error.response?.data,
    });
  }
};

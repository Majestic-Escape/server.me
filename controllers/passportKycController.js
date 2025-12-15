// controllers/kycController.js
const KycLogs = require("../models/KycLogs");
const User = require("../models/User");
const { performOCR, performStatusCheck } = require("../services/panKycService");
const { v4: uuidv4 } = require("uuid");

exports.verifyKYC = async (req, res) => {
  try {
    const { email, imageUrl } = req.body;

    // Fetch user
    const user = await User.find({ email: email });

    if (process.env.NEXT_PUBLIC_ENV === "dev") {
      console.log("User", user, email, user.firstName);
    }
    if (!user) return res.status(404).json({ error: "User not found" });

    // OCR Request
    const ocrClientRefId = `OCR-${uuidv4()}`;
    const ocrLog = await KycLogs.create({
      email,
      type: "OCR",
      requestData: { imageUrl, clientRefId: ocrClientRefId },
    });

    try {
      const ocrResult = await performOCR(imageUrl, ocrClientRefId);
      ocrLog.status = "success";
      ocrLog.responseData = ocrResult;
      await ocrLog.save();

      // Extract PAN details
      const panDetails = ocrResult.result[0].details;
      const pan = panDetails.pan_no.value;

      const name = user.firstName + " " + user.lastName;
      // Status Check Request
      const statusClientRefNum = `STATUS-${uuidv4()}`;
      const statusLog = await KycLogs.create({
        email,
        type: "Status",
        requestData: {
          client_ref_num: statusClientRefNum,
          pan,
          name: name,
          name_match_method: "fuzzy",
        },
      });

      try {
        const statusResult = await performStatusCheck(statusLog.requestData);
        statusLog.status = "success";
        statusLog.responseData = statusResult;
        await statusLog.save();

        return res.json({ success: true, statusResult });
      } catch (statusError) {
        statusLog.status = "failed";
        statusLog.error = statusError.message;
        statusLog.retries += 1;
        await statusLog.save();
        throw new Error(`Status check failed: ${statusError.message}`);
      }
    } catch (ocrError) {
      ocrLog.status = "failed";
      ocrLog.error = ocrError.message;
      ocrLog.retries += 1;
      await ocrLog.save();
      throw new Error(`OCR processing failed: ${ocrError.message}`);
    }
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};

// controllers/kycController.js
const kycHostForm = require("../models/KycHostForm");
const KycLogs = require("../models/KycLogs");
const User = require("../models/User");
const mongoose = require("mongoose");
const {
  performOCR,
  performStatusCheck,
  performVoterOCR,
  performVoterStatusCheck,
  performPassportOCR,
  performPassportStatusCheck,
} = require("../services/panKycService");
const { v4: uuidv4 } = require("uuid");

function makeClientRefId(prefix) {
  let id = `${prefix}-${uuidv4()}`; // uuidv4 is 36 chars, prefix+dash ~ +4 -> < 45 OK usually
  return id.slice(0, 45);
}

// exports.verifyKYC = async (req, res) => {
//   try {
//     const { email, imageUrl, userId, doc } = req.body;

//     // Fetch user

//     const user = await User.findById(userId);
//     process.env.ENV === 'dev' && if (process.env.NEXT_PUBLIC_ENV === "dev") {
//   console.log("User", user, email, user.firstName);
// }
//     if (!user) return res.status(404).json({ error: "User not found" });

//     // OCR Request
//     const ocrClientRefId = `OCR-${uuidv4()}`;
//     const ocrLog = await KycLogs.create({
//       userId: userId,
//       email: user?.email,
//       type: "OCR",
//       requestData: { imageUrl, clientRefId: ocrClientRefId },
//     });
//     if (doc == "pan") {
//       try {
//         const ocrResult = await performOCR(imageUrl, ocrClientRefId);
//         ocrLog.status = "success";
//         ocrLog.responseData = ocrResult;
//         await ocrLog.save();

//         // Extract PAN details
//         const panDetails = ocrResult.result[0].details;
//         const pan = panDetails.pan_no.value;

//         const name = user.firstName + " " + user.lastName;
//         // Status Check Request
//         const statusClientRefNum = `STATUS-${uuidv4()}`;
//         const statusLog = await KycLogs.create({
//           email,
//           type: "Status",
//           requestData: {
//             client_ref_num: statusClientRefNum,
//             pan,
//             name: name,
//             name_match_method: "fuzzy",
//           },
//         });

//         try {
//           const statusResult = await performStatusCheck(statusLog.requestData);
//           statusLog.status = "success";
//           statusLog.responseData = statusResult;
//           await statusLog.save();

//           return res.json({ success: true, statusResult });
//         } catch (statusError) {
//           statusLog.status = "failed";
//           statusLog.error = statusError.message;
//           statusLog.retries += 1;
//           await statusLog.save();
//           throw new Error(`Status check failed: ${statusError.message}`);
//         }
//       } catch (ocrError) {
//         ocrLog.status = "failed";
//         ocrLog.error = ocrError.message;
//         ocrLog.retries += 1;
//         await ocrLog.save();
//         throw new Error(`Processing failed: ${ocrError.message}`);
//       }
//     } else if (doc == "voterId") {
//       try {
//         const ocrResult = await performVoterOCR(imageUrl, ocrClientRefId);
//         ocrLog.status = "success";
//         ocrLog.responseData = ocrResult;
//         await ocrLog.save();

//         // Extract PAN details
//         const panDetails = ocrResult.result[0].details;
//         const pan = panDetails.pan_no.value;

//         const name = user.firstName + " " + user.lastName;
//         // Status Check Request
//         const statusClientRefNum = `STATUS-${uuidv4()}`;
//         const statusLog = await KycLogs.create({
//           email,
//           type: "Status",
//           requestData: {
//             client_ref_num: statusClientRefNum,
//             pan,
//             name: name,
//             name_match_method: "fuzzy",
//           },
//         });

//         try {
//           const statusResult = await performVoterStatusCheck(
//             statusLog.requestData
//           );
//           statusLog.status = "success";
//           statusLog.responseData = statusResult;
//           await statusLog.save();

//           return res.json({ success: true, statusResult });
//         } catch (statusError) {
//           statusLog.status = "failed";
//           statusLog.error = statusError.message;
//           statusLog.retries += 1;
//           await statusLog.save();
//           throw new Error(`Status check failed: ${statusError.message}`);
//         }
//       } catch (ocrError) {
//         ocrLog.status = "failed";
//         ocrLog.error = ocrError.message;
//         ocrLog.retries += 1;
//         await ocrLog.save();
//         throw new Error(`Processing failed: ${ocrError.message}`);
//       }
//     } else {
//       try {
//         const ocrResult = await performPassportOCR(imageUrl, ocrClientRefId);
//         ocrLog.status = "success";
//         ocrLog.responseData = ocrResult;
//         await ocrLog.save();

//         // Extract PAN details
//         const panDetails = ocrResult.result[0].details;
//         const pan = panDetails.pan_no.value;

//         const name = user.firstName + " " + user.lastName;
//         // Status Check Request
//         const statusClientRefNum = `STATUS-${uuidv4()}`;
//         const statusLog = await KycLogs.create({
//           email,
//           type: "Status",
//           requestData: {
//             client_ref_num: statusClientRefNum,
//             pan,
//             name: name,
//             name_match_method: "fuzzy",
//           },
//         });

//         try {
//           const statusResult = await performPassportStatusCheck(
//             statusLog.requestData
//           );
//           statusLog.status = "success";
//           statusLog.responseData = statusResult;
//           await statusLog.save();

//           return res.json({ success: true, statusResult });
//         } catch (statusError) {
//           statusLog.status = "failed";
//           statusLog.error = statusError.message;
//           statusLog.retries += 1;
//           await statusLog.save();
//           throw new Error(`Status check failed: ${statusError.message}`);
//         }
//       } catch (ocrError) {
//         ocrLog.status = "failed";
//         ocrLog.error = ocrError.message;
//         ocrLog.retries += 1;
//         await ocrLog.save();
//         throw new Error(`Processing failed: ${ocrError.message}`);
//       }
//     }
//   } catch (error) {
//     res.status(500).json({
//       success: false,
//       error: error.message,
//     });
//   }
// };
exports.verifyKYC = async (req, res) => {
  try {
    const { userId, imageUrl, doc } = req.body;
    if (process.env.NEXT_PUBLIC_ENV === "dev") {
      console.log("document t", doc);
    }
    if (!userId) return res.status(400).json({ error: "userId required" });

    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ error: "User not found" });

    const form = await kycHostForm.findOne({
      hostId: new mongoose.Types.ObjectId(userId),
    });
    if (process.env.NEXT_PUBLIC_ENV === "dev") {
      console.log("this new", form);
    }
    const clientRefId = makeClientRefId("OCR"); // <=45 chars
    const ocrLog = await KycLogs.create({
      userId,
      email: user.email,
      type: "OCR",
      requestData: { imageUrl, clientRefId },
    });

    // choose strategy:
    if (doc == "pan") {
      const ocrResult = await performOCR(imageUrl, clientRefId, doc);

      // handle response, persist
      // ... validate ocrResponse structure before using it
      ocrLog.status = "success";

      if (process.env.NEXT_PUBLIC_ENV === "dev") {
        console.log("mcu", ocrResult.result[0].details);
      }
      ocrLog.responseData = ocrResult;
      await ocrLog.save();

      // Extract PAN details
      const panDetails = ocrResult.result[0].details;
      const pan = panDetails.pan_no.value;

      const name = user.firstName + " " + user.lastName;
      // Status Check Request
      const statusClientRefNum = makeClientRefId("STATUS");
      const statusLog = await KycLogs.create({
        userId,
        email: user.email,
        type: "Status",
        requestData: {
          client_ref_num: statusClientRefNum,
          pan,
          name: name,
          name_match_method: "fuzzy",
        },
      });

      const statusResult = await performStatusCheck(statusLog.requestData, doc);

      if (process.env.NEXT_PUBLIC_ENV === "dev") {
        console.log("Pan status result", statusResult);
      }
      if (!statusResult) {
        return res.status(400).json({
          success: false,
          message: "Status check failed",
        });
      }
      statusLog.status = "success";
      statusLog.responseData = statusResult;
      await statusLog.save();

      return res.json({ success: true, statusResult });
    } else if (doc == "voterId") {
      const ocrResult = await performOCR(imageUrl, clientRefId, doc);

      // handle response, persist
      // ... validate ocrResponse structure before using it
      ocrLog.status = "success";

      if (process.env.NEXT_PUBLIC_ENV === "dev") {
        console.log("mcu2", ocrResult.result[0].details);
      }
      ocrLog.responseData = ocrResult;
      await ocrLog.save();

      const voterDetails = ocrResult.result[0].details;

      const voter = voterDetails?.voterid?.value;

      const statusClientRefNum = makeClientRefId("STATUS");
      const statusLog = await KycLogs.create({
        userId,
        email: user.email,
        type: "Status",
        requestData: {
          client_ref_num: statusClientRefNum,
          epic_number: voter,
        },
      });
      const statusResult = await performStatusCheck(statusLog.requestData, doc);
      if (!statusResult) {
        return res.status(400).json({
          success: false,
          message: "Status check failed",
        });
      }
      statusLog.status = "success";
      statusLog.responseData = statusResult;
      await statusLog.save();

      return res.json({ success: true, statusResult });
    } else {
      const ocrResult = await performOCR(imageUrl, clientRefId, doc);

      // handle response, persist
      // ... validate ocrResponse structure before using it
      ocrLog.status = "success";

      if (process.env.NEXT_PUBLIC_ENV === "dev") {
        console.log("mcu2", ocrResult.result[0].details);
      }
      ocrLog.responseData = ocrResult;
      await ocrLog.save();

      const passportDetails = ocrResult.result[0].details;

      const file_number = passportDetails?.passport_num?.value;
      const dob = passportDetails?.dob?.value;

      const statusClientRefNum = makeClientRefId("STATUS");
      const statusLog = await KycLogs.create({
        userId,
        email: user.email,
        type: "Status",
        requestData: {
          client_ref_num: statusClientRefNum,
          file_number,
          dob,
        },
      });
      const statusResult = await performStatusCheck(statusLog.requestData);
      if (!statusResult) {
        return res.status(400).json({
          success: false,
          message: "Status check failed ",
        });
      }
      statusLog.status = "success";
      statusLog.responseData = statusResult;
      await statusLog.save();

      return res.json({ success: true, statusResult });
    }
  } catch (err) {
    console.error("verifyKYC error:", err.response?.data || err.message || err);
    if (err.status === 413 || err.response?.status === 413) {
      return res.status(413).json({
        success: false,
        message: "Upload file size is more than 4MB",
      });
    }
    if (err.response?.status >= 400 && err.response?.status < 500) {
      return res.status(err.response.status).json({
        success: false,
        message:
          err.response.data?.error ||
          err.response.data?.message ||
          err.message ||
          "Status check failed",
      });
    }
    // return res.status(400).json({
    //   success: false,
    //   message: err.message || "Status check failed",
    // });
    return res.status(500).json({
      success: false,
      message: "Upload Correct Image and check your network" || "Server error",
      details: err.response?.data,
    });
  }
};

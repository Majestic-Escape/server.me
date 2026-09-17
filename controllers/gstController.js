// GST verification for host KYC (optional step).
//
// POST /api/v1/kyc/verify/gst  { userId, panNumber, gstNumber }
//
// Batch A2: authenticated + self-only (routes/kycRoutes.js); input format
// checked before anything is paid for; the abuse guard admits one attempt at
// a time; on a positive verdict (business PAN found, GSTIN listed and
// Active, GST record readable) the server writes gstInfo itself — the
// client's follow-up PATCH can only confirm it.
const KycLogs = require("../models/KycLogs");
const kycHostForm = require("../models/KycHostForm");
const User = require("../models/User");
const provider = require("../services/kycProvider");
const guard = require("../services/kycGuard");
const { v4: uuidv4 } = require("uuid");

const PAN_RE = /^[A-Z]{5}[0-9]{4}[A-Z]$/;
const GSTIN_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

function makeClientRefId(prefix) {
  return `${prefix}-${uuidv4()}`.slice(0, 45);
}
function fail(res, status, code, message, extra = {}) {
  return res.status(status).json({ success: false, code, message, statusCode: status, ...extra });
}
function mask(value) {
  return `******${String(value).slice(-4)}`;
}

exports.verifyGst = async (req, res) => {
  const body = req.body && typeof req.body === "object" ? req.body : {};
  const userId = body.userId;
  const panNumber = String(body.panNumber || "").trim().toUpperCase();
  const gstNumber = String(body.gstNumber || "").trim().toUpperCase();
  if (!userId) return fail(res, 400, "INVALID_ID", "userId required");
  if (!PAN_RE.test(panNumber)) return fail(res, 400, "INVALID_PAN", "Please enter a valid business PAN");
  if (!GSTIN_RE.test(gstNumber)) return fail(res, 400, "INVALID_GSTIN", "Please enter a valid GSTIN");
  if (gstNumber.slice(2, 12) !== panNumber) return fail(res, 400, "GSTIN_PAN_MISMATCH", "The GSTIN does not belong to this PAN");

  const user = await User.findById(userId).select("email").lean();
  if (!user) return fail(res, 404, "USER_NOT_FOUND", "User not found");
  const form = await kycHostForm.findOne({ hostId: user._id }).select("_id").lean();
  if (!form) return fail(res, 409, "KYC_FORM_REQUIRED", "Please complete the personal information step first");

  const slot = await guard.claim(user._id, "gst");
  if (!slot.ok) return guard.rateLimited(res, slot);

  try {
    const panRef = makeClientRefId("PAN");
    const panLog = await KycLogs.create({ userId: user._id, email: user.email, type: "Gst Pan", requestData: { pan: panNumber.slice(-4), client_ref_num: panRef } });
    let panResult;
    try {
      panResult = await provider.gstPanSearch({ pan: panNumber, client_ref_num: panRef });
    } catch (err) {
      await KycLogs.updateOne({ _id: panLog._id }, { $set: { status: "failed", error: String((err && err.message) || err).slice(0, 500) } });
      return fail(res, 502, "PROVIDER_UNAVAILABLE", "Invalid PAN Number or Network Issue");
    }
    if (!panResult || Number(panResult.http_response_code) !== 200) {
      await KycLogs.updateOne({ _id: panLog._id }, { $set: { status: "failed", responseData: panResult } });
      return fail(res, 404, "PAN_NOT_FOUND", "Business PAN not found");
    }
    await KycLogs.updateOne({ _id: panLog._id }, { $set: { status: "success", responseData: panResult } });

    const list = panResult.result && panResult.result.gstinResList;
    if (!Array.isArray(list)) return fail(res, 404, "GST_NOT_FOUND", "No GST data found for this PAN");
    const matched = list.find((item) => item && item.gstin === gstNumber);
    if (!matched) return fail(res, 404, "GST_NOT_FOUND", "GST associated with Business PAN not found");
    if (matched.authStatus !== "Active") return fail(res, 409, "GST_INACTIVE", "GST associated with Business PAN inactive");

    const gstRef = makeClientRefId("GST");
    const gstLog = await KycLogs.create({ userId: user._id, email: user.email, type: "Gst", requestData: { gstin: gstNumber.slice(-4), client_ref_num: gstRef } });
    let gstResult;
    try {
      gstResult = await provider.gstCheck({ gstin: gstNumber, client_ref_num: gstRef });
    } catch (err) {
      await KycLogs.updateOne({ _id: gstLog._id }, { $set: { status: "failed", error: String((err && err.message) || err).slice(0, 500) } });
      return fail(res, 502, "PROVIDER_UNAVAILABLE", "Failed to verify GST");
    }
    if (!gstResult || Number(gstResult.http_response_code) !== 200 || !gstResult.result || !gstResult.result.taxpayerDetails) {
      await KycLogs.updateOne({ _id: gstLog._id }, { $set: { status: "failed", responseData: gstResult } });
      return fail(res, 404, "GST_NOT_FOUND", "Gst data not found");
    }
    await KycLogs.updateOne({ _id: gstLog._id }, { $set: { status: "success", responseData: gstResult } });

    // Positive verdict → the server records it (masked numbers only).
    await kycHostForm.updateOne(
      { _id: form._id },
      { $set: { "gstInfo.gstNumber": mask(gstNumber), "gstInfo.panNumber": mask(panNumber), "gstInfo.isVerified": true, "gstInfo.verifiedLogId": gstLog._id, "gstInfo.verifiedAt": new Date() } },
    );
    return res.json({ success: true, verdict: "verified", data: gstResult });
  } catch (error) {
    console.error("verifyGST error", error && error.message);
    return fail(res, 500, "SERVER_ERROR", "Incorrect PAN or GST Number");
  } finally {
    await guard.release(user._id, "gst");
  }
};

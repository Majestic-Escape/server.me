// Identity document verification (PAN / voter id / passport) for host KYC.
//
// POST /api/v1/pan-kyc/verify  { userId, imageUrl: <base64>, doc }
//
// Batch A2: authenticated + self-only (routes/panKycRoutes.js); cheap
// validation (size, base64, mime) before anything is stored or paid for; a
// DB-backed abuse guard (services/kycGuard.js) admits one attempt at a time
// with a cooldown and a daily ceiling; the provider verdict
// (services/kycVerdict.js) — not the client — decides documentInfo.
const crypto = require("crypto");
const kycHostForm = require("../models/KycHostForm");
const KycLogs = require("../models/KycLogs");
const User = require("../models/User");
const provider = require("../services/kycProvider");
const guard = require("../services/kycGuard");
const { documentVerdict } = require("../services/kycVerdict");
const { rawBase64FromPossibleDataUri, isValidBase64, detectMimeFromBuffer } = require("../utils/ocrHelpers");
const { v4: uuidv4 } = require("uuid");

const DOC_TYPES = ["pan", "voterId", "passport"];
const MAX_UPLOAD_BYTES = 4 * 1024 * 1024; // the site's own limit; the provider rejects more
const MAX_UPLOAD_B64 = Math.ceil(MAX_UPLOAD_BYTES / 3) * 4;
const ALLOWED_MIME = new Set(["image/jpeg", "image/png", "application/pdf"]);

function makeClientRefId(prefix) {
  return `${prefix}-${uuidv4()}`.slice(0, 45);
}
function fail(res, status, code, message, extra = {}) {
  return res.status(status).json({ success: false, code, message, statusCode: status, ...extra });
}
function providerFailure(res, err, fallback) {
  const status = err && err.response && err.response.status;
  console.error("verifyKYC provider error", err && (err.code || status || err.message));
  if (status === 413 || (err && err.status === 413)) return fail(res, 413, "DOCUMENT_TOO_LARGE", "Upload file size is more than 4MB");
  if (status >= 400 && status < 500) {
    const data = err.response.data || {};
    return fail(res, status, "PROVIDER_REJECTED", data.error || data.message || fallback);
  }
  return fail(res, 502, "PROVIDER_UNAVAILABLE", fallback);
}

// Status-check request per document type, from the OCR extraction.
function buildStatusRequest(doc, details, user, clientRef) {
  if (doc === "pan") {
    const pan = details && details.pan_no && details.pan_no.value;
    if (!pan) return null;
    return { client_ref_num: clientRef, pan, name: `${user.firstName || ""} ${user.lastName || ""}`.trim(), name_match_method: "fuzzy" };
  }
  if (doc === "voterId") {
    const epic = details && details.voterid && details.voterid.value;
    if (!epic) return null;
    return { client_ref_num: clientRef, epic_number: epic };
  }
  const fileNumber = details && details.passport_num && details.passport_num.value;
  const dob = details && details.dob && details.dob.value;
  if (!fileNumber) return null;
  return { client_ref_num: clientRef, file_number: fileNumber, dob };
}

exports.verifyKYC = async (req, res) => {
  const body = req.body && typeof req.body === "object" ? req.body : {};
  const { userId, imageUrl, doc } = body;
  if (!userId) return fail(res, 400, "INVALID_ID", "userId required");
  if (!DOC_TYPES.includes(doc)) return fail(res, 400, "INVALID_DOCUMENT_TYPE", "doc must be one of pan, voterId, passport");

  // 1. Cheap validation — nothing below is stored or paid for until this passes.
  const b64 = typeof imageUrl === "string" ? rawBase64FromPossibleDataUri(imageUrl.replace(/\s+/g, "")) : null;
  if (!b64) return fail(res, 400, "IMAGE_REQUIRED", "A document image is required");
  if (b64.length > MAX_UPLOAD_B64) return fail(res, 413, "DOCUMENT_TOO_LARGE", "Upload file size is more than 4MB");
  if (!isValidBase64(b64)) return fail(res, 422, "DOCUMENT_UNREADABLE", "The uploaded file could not be read");
  const buffer = Buffer.from(b64, "base64");
  if (!buffer.length) return fail(res, 422, "DOCUMENT_UNREADABLE", "The uploaded file is empty");
  if (buffer.length > MAX_UPLOAD_BYTES) return fail(res, 413, "DOCUMENT_TOO_LARGE", "Upload file size is more than 4MB");
  const mime = detectMimeFromBuffer(buffer);
  if (!ALLOWED_MIME.has(mime)) return fail(res, 415, "UNSUPPORTED_DOCUMENT", "Please upload a JPG, PNG or PDF");
  const fingerprint = crypto.createHash("sha256").update(buffer).digest("hex");

  const user = await User.findById(userId).select("firstName lastName email").lean();
  if (!user) return fail(res, 404, "USER_NOT_FOUND", "User not found");
  const form = await kycHostForm.findOne({ hostId: user._id }).select("documentInfo").lean();
  if (!form) return fail(res, 409, "KYC_FORM_REQUIRED", "Please complete the personal information step first");

  // 2. One attempt at a time, cooldown, daily ceiling.
  const slot = await guard.claim(user._id, "ocr");
  if (!slot.ok) return guard.rateLimited(res, slot);

  const now = new Date();
  try {
    // A different document than the last one is unverified until it passes on
    // its own; a retry of the same bytes keeps whatever state it already has.
    const previous = form.documentInfo || {};
    const replaced = !!previous.fingerprint && previous.fingerprint !== fingerprint;
    if (replaced) {
      await kycHostForm.updateOne(
        { _id: form._id },
        { $set: { "documentInfo.isVerified": false, "documentInfo.reviewStatus": "unverified", "documentInfo.reviewReason": "REPLACED", "documentInfo.verifiedLogId": null, "documentInfo.verifiedAt": null, "documentInfo.fingerprint": fingerprint, "documentInfo.documentType": doc, "documentInfo.lastAttemptAt": now } },
      );
    }

    const clientRefId = makeClientRefId("OCR");
    const ocrLog = await KycLogs.create({
      userId: user._id,
      email: user.email,
      type: "OCR",
      requestData: { imageUrl: b64, clientRefId, doc, mime, bytes: buffer.length },
    });

    let ocrResult;
    try {
      ocrResult = await provider.ocr(b64, clientRefId, doc);
    } catch (err) {
      await KycLogs.updateOne({ _id: ocrLog._id }, { $set: { status: "failed", error: String((err && err.message) || err).slice(0, 500) } });
      return providerFailure(res, err, "The document could not be read right now. Please try again.");
    }
    await KycLogs.updateOne({ _id: ocrLog._id }, { $set: { status: "success", responseData: ocrResult } });

    const details = ocrResult && Array.isArray(ocrResult.result) && ocrResult.result[0] ? ocrResult.result[0].details : null;
    const statusClientRef = makeClientRefId("STATUS");
    const statusRequest = buildStatusRequest(doc, details, user, statusClientRef);
    const setOutcome = (verdict) =>
      kycHostForm.updateOne(
        { _id: form._id },
        {
          $set: {
            "documentInfo.documentType": doc,
            "documentInfo.isVerified": verdict.verdict === "verified",
            "documentInfo.reviewStatus": verdict.verdict,
            "documentInfo.reviewReason": verdict.reason || "",
            "documentInfo.verifiedLogId": ocrLog._id,
            "documentInfo.verifiedAt": verdict.verdict === "verified" ? now : null,
            "documentInfo.fingerprint": fingerprint,
            "documentInfo.lastAttemptAt": now,
          },
        },
      );

    if (!statusRequest) {
      await setOutcome({ verdict: "failed", reason: "DOCUMENT_UNREADABLE" });
      return fail(res, 422, "DOCUMENT_NOT_VERIFIED", "The document number could not be read from the image. Please upload a clearer copy.");
    }

    const statusLog = await KycLogs.create({ userId: user._id, email: user.email, type: "Status", requestData: statusRequest });
    let statusResult;
    try {
      statusResult = await provider.statusCheck(statusRequest, doc);
    } catch (err) {
      await KycLogs.updateOne({ _id: statusLog._id }, { $set: { status: "failed", error: String((err && err.message) || err).slice(0, 500) } });
      return providerFailure(res, err, "The document could not be verified right now. Please try again.");
    }
    await KycLogs.updateOne({ _id: statusLog._id }, { $set: { status: statusResult ? "success" : "failed", responseData: statusResult } });

    const accountName = `${user.firstName || ""} ${user.lastName || ""}`.trim();
    const ocrName = details && details.name && details.name.value;
    const verdict = documentVerdict(statusResult, { doc, accountName, ocrName });
    await setOutcome(verdict);

    if (verdict.verdict === "failed") return fail(res, 422, "DOCUMENT_NOT_VERIFIED", verdict.message || "The document could not be verified", { reason: verdict.reason });
    return res.json({
      success: true,
      verdict: verdict.verdict,
      reason: verdict.reason,
      message:
        verdict.verdict === "verified"
          ? "Document verified"
          : "Check completed — your document needs a manual review by our team. You can continue with the next steps.",
      statusResult,
    });
  } catch (err) {
    console.error("verifyKYC error", err && err.message);
    return fail(res, 500, "SERVER_ERROR", "Upload Correct Image and check your network");
  } finally {
    await guard.release(user._id, "ocr");
  }
};

exports.__test = { buildStatusRequest, MAX_UPLOAD_BYTES, MAX_UPLOAD_B64 };

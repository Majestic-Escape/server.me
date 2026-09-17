// Admin user management (/api/v1/guests). Every admin route here is gated by
// [authMiddleware, requireAdmin] (routes/guestRoutes.js); the two
// self-service reads (guest-by-id, info/:userId) are authenticated only.
//
// Batch A2 additions: the Users page lists every non-privileged account,
// admins can rename a user (transactional, audited, optimistic concurrency)
// and review the identity documents a host uploaded for KYC (served only
// through this API, audited per view/download), including marking a
// "needs review" upload as verified.
const mongoose = require("mongoose");
const ListingProperty = require("../models/ListingProperty");
const User = require("../models/User");
const KycHostData = require("../models/KycHostForm");
const KycLogs = require("../models/KycLogs");
const AdminAuditLog = require("../models/AdminAuditLog");
const { SAFE_HOST_SELECT } = require("../utils/sanitizeResponse");
const { normalizeName, validateName } = require("../utils/names");
const { rawBase64FromPossibleDataUri, isValidBase64, detectMimeFromBuffer } = require("../utils/ocrHelpers");
const { privilegedExclusion, isPrivilegedUser } = require("../services/privileged");
const adminAudit = require("../services/adminAudit");
const { completeKycForm } = require("./kyc/hostFormController");
const { rejectInvalidId } = require("../middleware/validateObjectId");

function fail(res, status, code, message, extra = {}) {
  return res.status(status).json({ success: false, code, message, statusCode: status, ...extra });
}
function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function isTransient(err) {
  return !!(err && typeof err.hasErrorLabel === "function" && (err.hasErrorLabel("TransientTransactionError") || err.hasErrorLabel("UnknownTransactionCommitResult")));
}

// GET /guests/?search=&limit=&skip= — every non-privileged account, hosts
// flagged (isHost/totalProperties), newest activity first.
exports.getGuests = async (req, res) => {
  try {
    const { search } = req.query;
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 10, 1), 100);
    const skip = Math.max(parseInt(req.query.skip, 10) || 0, 0);

    const matchStage = await privilegedExclusion();
    if (search && String(search).trim() !== "") {
      const term = escapeRegex(String(search).trim()).slice(0, 100);
      matchStage.$or = [
        { firstName: { $regex: term, $options: "i" } },
        { lastName: { $regex: term, $options: "i" } },
        { email: { $regex: term, $options: "i" } },
        { $expr: { $regexMatch: { input: { $toString: { $ifNull: ["$phoneNumber", ""] } }, regex: term } } },
        { $expr: { $regexMatch: { input: { $concat: [{ $ifNull: ["$firstName", ""] }, " ", { $ifNull: ["$lastName", ""] }] }, regex: term, options: "i" } } },
      ];
    }

    const pipeline = [
      { $match: matchStage },
      { $lookup: { from: "listingproperties", localField: "_id", foreignField: "host", as: "properties" } },
      { $addFields: { totalProperties: { $size: "$properties" } } },
      { $addFields: { isHost: { $gt: ["$totalProperties", 0] } } },
      { $lookup: { from: "reviews", localField: "_id", foreignField: "hostId", as: "reviews" } },
      {
        $addFields: {
          totalReviews: { $size: "$reviews" },
          averageRating: { $cond: [{ $gt: [{ $size: "$reviews" }, 0] }, { $avg: "$reviews.rating" }, 0] },
        },
      },
      { $project: { password: 0, properties: 0, reviews: 0, otp: 0, otpRetries: 0, lockUntil: 0, tokenVersion: 0 } },
      { $sort: { updatedAt: -1, _id: -1 } },
      { $facet: { data: [{ $skip: skip }, { $limit: limit }], totalCount: [{ $count: "count" }] } },
    ];

    const result = await User.aggregate(pipeline);
    const data = result[0].data;
    const total = result[0].totalCount[0]?.count || 0;
    res.status(200).json({ data, total, limit, skip, hasMore: skip + limit < total });
  } catch (err) {
    console.error("getGuests error", err && err.message);
    res.status(500).json({ error: "Failed to fetch users" });
  }
};

// GET /guests/kyc?id=<hostId> — the steps table only needs these fields.
exports.getKycDetails = async (req, res) => {
  const { id } = req.query;
  if (rejectInvalidId(res, String(id || ""), "id")) return;
  const data = await KycHostData.find({ hostId: id })
    .select("status documentInfo.documentType documentInfo.isVerified documentInfo.reviewStatus gstInfo.isVerified acceptedTerms personalInfo.address.pincode hostEmail createdAt updatedAt")
    .lean();
  return res.status(200).json({ data });
};

exports.getGuestsById = async (req, res) => {
  try {
    const { userId } = req.query;
    if (rejectInvalidId(res, String(userId || ""), "userId")) return;
    // Only select safe fields to prevent PII leakage
    const users = await User.findById(userId).select(SAFE_HOST_SELECT).lean();
    res.json(users);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch users" });
  }
};

// Get user information by ID - returns only safe fields to prevent PII leakage
exports.getUserInfo = async (req, res) => {
  const { userId } = req.params;
  if (rejectInvalidId(res, userId, "userId")) return;
  try {
    const user = await User.findById(userId).select(SAFE_HOST_SELECT).lean();
    if (!user) return res.status(404).json({ message: "User not found" });
    res.status(200).json({ message: "User information retrieved successfully", user });
  } catch (err) {
    res.status(500).json({ error: "Error fetching user information", details: err.message });
  }
};

// PATCH /guests/name/:userId  { firstName, lastName, expected: { firstName, lastName } }
exports.renameUser = async (req, res) => {
  const body = req.body && typeof req.body === "object" ? req.body : {};
  const firstName = normalizeName(body.firstName);
  const lastName = normalizeName(body.lastName);
  const firstError = validateName(firstName, { required: true, label: "First name" });
  if (firstError) return fail(res, 400, "INVALID_NAME", firstError, { field: "firstName" });
  const lastError = validateName(lastName, { required: false, label: "Last name" });
  if (lastError) return fail(res, 400, "INVALID_NAME", lastError, { field: "lastName" });
  const expected = body.expected && typeof body.expected === "object" ? body.expected : null;
  if (!expected || typeof expected.firstName !== "string") return fail(res, 400, "EXPECTED_REQUIRED", "expected.firstName and expected.lastName are required");

  const session = await mongoose.startSession();
  let outcome;
  try {
    await session.withTransaction(async () => {
      outcome = null;
      const user = await User.findById(req.params.userId).select("firstName lastName role email").session(session);
      if (!user) {
        outcome = { status: 404, code: "USER_NOT_FOUND", message: "User not found" };
        return;
      }
      if (await isPrivilegedUser(user, { session })) {
        outcome = { status: 403, code: "PRIVILEGED_TARGET", message: "Administrator accounts cannot be renamed here" };
        return;
      }
      const currentLast = user.lastName || "";
      if (user.firstName === firstName && currentLast === lastName) {
        outcome = { status: 200, body: { success: true, changed: false, data: { _id: user._id, firstName: user.firstName, lastName: currentLast } } };
        return;
      }
      const expectedLast = typeof expected.lastName === "string" ? expected.lastName : "";
      const match = {
        _id: user._id,
        firstName: expected.firstName,
        $or: expectedLast === "" ? [{ lastName: "" }, { lastName: null }, { lastName: { $exists: false } }] : [{ lastName: expectedLast }],
      };
      const updated = await User.updateOne(match, { $set: { firstName, lastName } }, { session });
      if (updated.matchedCount === 0) {
        outcome = { status: 409, code: "NAME_CHANGED", message: "This user's name was changed by someone else. Refresh and try again.", extra: { data: { _id: user._id, firstName: user.firstName, lastName: currentLast } } };
        // Abort: nothing else must be written.
        throw Object.assign(new Error("NAME_CHANGED"), { abort: true });
      }
      await adminAudit.record(req, "user.rename", { targetType: "User", targetId: user._id }, { before: { firstName: user.firstName, lastName: currentLast }, after: { firstName, lastName } }, { session });
      outcome = { status: 200, body: { success: true, changed: true, data: { _id: user._id, firstName, lastName } } };
    });
  } catch (err) {
    if (!(err && err.abort)) {
      console.error("renameUser error", err && err.message);
      return fail(res, 503, "AUDIT_UNAVAILABLE", "The change could not be recorded. Nothing was saved — please try again.");
    }
  } finally {
    await session.endSession().catch(() => {});
  }
  if (!outcome) return fail(res, 500, "SERVER_ERROR", "Rename failed");
  if (outcome.body) return res.status(outcome.status).json(outcome.body);
  return fail(res, outcome.status, outcome.code, outcome.message, outcome.extra || {});
};

// PATCH /guests/ban/:userId  { active } — active=true bans, false unbans.
exports.banUser = async (req, res) => {
  const { userId } = req.params;
  const { active } = req.body || {};
  try {
    const user = await User.findById(userId);
    if (!user) return fail(res, 404, "USER_NOT_FOUND", "User not found");
    if (active) {
      user.status.active = false;
      user.status.banned = true;
      user.tokenVersion += 1;
      await ListingProperty.updateMany({ host: userId, status: "active" }, { status: "inactive", ban: true });
    } else {
      user.status.active = true;
      user.status.banned = false;
      await ListingProperty.updateMany({ host: userId, ban: true }, { status: "active", ban: false });
    }
    await user.save();
    res.status(200).json({ success: true, message: active ? "User banned successfully" : "User unbanned successfully", data: { _id: user._id, status: user.status } });
  } catch (err) {
    console.error("banUser error", err && err.message);
    fail(res, 500, "SERVER_ERROR", "Error updating user status");
  }
};

// --- KYC documents ---------------------------------------------------------
const MAX_KYC_BYTES = 8 * 1024 * 1024;
const MAX_KYC_B64 = Math.ceil(MAX_KYC_BYTES / 3) * 4;
const DOC_LABEL = { pan: "PAN card", voterId: "Voter ID", passport: "Passport" };
const FILE_STEM = { pan: "pan", voterId: "voter-id", passport: "passport" };
const EXT = { "image/jpeg": "jpg", "image/png": "png", "application/pdf": "pdf" };

function sniffHead(head) {
  if (typeof head !== "string" || !head) return "application/octet-stream";
  const raw = rawBase64FromPossibleDataUri(head) || "";
  const chunk = raw.replace(/[^A-Za-z0-9+/=]/g, "").slice(0, 16);
  if (chunk.length < 8) return "application/octet-stream";
  return detectMimeFromBuffer(Buffer.from(chunk, "base64"));
}
function docTypeFromOcr(row) {
  if (row.pan) return "pan";
  if (row.voter) return "voterId";
  if (row.passport) return "passport";
  return row.doc || null;
}
function reviewStatusOf(documentInfo) {
  if (!documentInfo) return "unverified";
  if (documentInfo.reviewStatus) return documentInfo.reviewStatus;
  return documentInfo.isVerified ? "verified" : "unverified";
}

// GET /guests/kyc-documents/:hostId
exports.listKycDocuments = async (req, res) => {
  try {
    const hostId = new mongoose.Types.ObjectId(req.params.hostId);
    const user = await User.findById(hostId).select("firstName lastName email").lean();
    if (!user) return fail(res, 404, "USER_NOT_FOUND", "User not found");
    const form = await KycHostData.findOne({ hostId }).select("documentInfo status").lean();
    const rows = await KycLogs.aggregate([
      { $match: { userId: hostId, type: "OCR" } },
      { $sort: { createdAt: -1 } },
      { $limit: 21 },
      { $addFields: { first: { $arrayElemAt: ["$responseData.result", 0] } } },
      {
        $project: {
          createdAt: 1,
          status: 1,
          doc: "$requestData.doc",
          head: { $cond: [{ $eq: [{ $type: "$requestData.imageUrl" }, "string"] }, { $substrCP: ["$requestData.imageUrl", 0, 96] }, null] },
          len: { $cond: [{ $eq: [{ $type: "$requestData.imageUrl" }, "string"] }, { $strLenBytes: "$requestData.imageUrl" }, 0] },
          tail: { $cond: [{ $gt: [{ $strLenBytes: { $ifNull: ["$requestData.imageUrl", ""] } }, 2] }, { $substrBytes: ["$requestData.imageUrl", { $subtract: [{ $strLenBytes: "$requestData.imageUrl" }, 2] }, 2] }, ""] },
          pan: "$first.details.pan_no.value",
          voter: "$first.details.voterid.value",
          passport: "$first.details.passport_num.value",
          name: "$first.details.name.value",
        },
      },
    ]);
    const hasMore = rows.length > 20;
    const info = (form && form.documentInfo) || null;
    const verifiedLogId = info && info.verifiedLogId ? String(info.verifiedLogId) : null;
    const reviewStatus = reviewStatusOf(info);
    const documents = rows.slice(0, 20).map((row) => {
      const type = docTypeFromOcr(row) || (info && info.documentType) || null;
      const number = row.pan || row.voter || row.passport || null;
      const isCurrent = verifiedLogId === String(row._id);
      return {
        _id: row._id,
        createdAt: row.createdAt,
        status: row.status,
        mime: sniffHead(row.head),
        sizeBytes: row.len ? Math.max(0, Math.floor((row.len * 3) / 4) - ((String(row.tail || "").match(/=/g) || []).length)) : 0,
        documentType: DOC_LABEL[type] || "Document",
        nameOnDocument: typeof row.name === "string" ? row.name : null,
        numberMasked: number ? `••••${String(number).slice(-4)}` : null,
        isCurrent,
        isVerified: isCurrent && reviewStatus === "verified",
        needsReview: isCurrent && reviewStatus === "needs_review",
      };
    });
    return res.status(200).json({
      success: true,
      data: {
        user: { _id: user._id, firstName: user.firstName, lastName: user.lastName || "", email: user.email },
        form: form
          ? {
              status: form.status,
              documentType: DOC_LABEL[info && info.documentType] || (info && info.documentType) || "",
              isVerified: !!(info && info.isVerified),
              reviewStatus,
              reviewReason: (info && info.reviewReason) || "",
              verifiedLogId,
            }
          : null,
        documents,
        hasMore,
      },
    });
  } catch (err) {
    console.error("listKycDocuments error", err && err.message);
    return fail(res, 500, "SERVER_ERROR", "Failed to load KYC documents");
  }
};

// GET /guests/kyc-documents/:hostId/:logId/file?mode=view|download
exports.getKycDocumentFile = async (req, res) => {
  const mode = req.query.mode;
  if (mode !== "view" && mode !== "download") return fail(res, 400, "INVALID_MODE", "mode must be view or download");
  try {
    const log = await KycLogs.findOne({ _id: req.params.logId, userId: req.params.hostId, type: "OCR" }).select("requestData.imageUrl requestData.doc createdAt").lean();
    if (!log) return fail(res, 404, "NOT_FOUND", "Document not found");
    const raw = log.requestData && log.requestData.imageUrl;
    const b64 = typeof raw === "string" ? rawBase64FromPossibleDataUri(raw.replace(/\s+/g, "")) : null;
    if (!b64) return fail(res, 422, "DOCUMENT_UNREADABLE", "This upload holds no readable document");
    if (b64.length > MAX_KYC_B64) return fail(res, 413, "DOCUMENT_TOO_LARGE", "This document is too large to preview");
    if (!isValidBase64(b64)) return fail(res, 422, "DOCUMENT_UNREADABLE", "This upload holds no readable document");
    const buf = Buffer.from(b64, "base64");
    if (!buf.length) return fail(res, 422, "DOCUMENT_UNREADABLE", "This upload is empty");
    if (buf.length > MAX_KYC_BYTES) return fail(res, 413, "DOCUMENT_TOO_LARGE", "This document is too large to preview");
    const mime = detectMimeFromBuffer(buf);
    const previewable = !!EXT[mime];

    // The document will be sent: record who is reading it first (fail-closed).
    try {
      await adminAudit.record(req, mode === "download" ? "kyc.document.download" : "kyc.document.view", { targetType: "KycLogs", targetId: log._id }, { hostId: req.params.hostId, mime, bytes: buf.length });
    } catch (err) {
      console.error("kyc document audit failed", err && err.message);
      return fail(res, 503, "AUDIT_UNAVAILABLE", "Document access could not be recorded; nothing was sent");
    }

    const stem = FILE_STEM[log.requestData && log.requestData.doc] || "document";
    const day = new Date(log.createdAt || Date.now()).toISOString().slice(0, 10).replace(/-/g, "");
    const filename = `kyc-${stem}-${day}.${EXT[mime] || "bin"}`;
    const disposition = previewable && mode === "view" ? "inline" : "attachment";
    res.status(200);
    res.set({
      "Content-Type": previewable ? mime : "application/octet-stream",
      "Content-Length": String(buf.length),
      "Content-Disposition": `${disposition}; filename="${filename}"`,
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "private, no-store",
      "Cross-Origin-Resource-Policy": "same-site",
      "Referrer-Policy": "no-referrer",
    });
    return res.end(buf);
  } catch (err) {
    console.error("getKycDocumentFile error", err && err.message);
    if (!res.headersSent) return fail(res, 500, "SERVER_ERROR", "Failed to load the document");
  }
};

// PATCH /guests/admin/kyc/:hostId/document-verified  { logId }
// Only the current attempt awaiting review can be promoted.
exports.manualVerifyKycDocument = async (req, res) => {
  const logId = req.body && req.body.logId;
  if (rejectInvalidId(res, String(logId || ""), "logId")) return;
  const hostId = new mongoose.Types.ObjectId(req.params.hostId);
  const session = await mongoose.startSession();
  let outcome;
  let formForCompletion = null;
  try {
    await session.withTransaction(async () => {
      outcome = null;
      formForCompletion = null;
      const form = await KycHostData.findOne({ hostId }).session(session);
      if (!form) {
        outcome = { status: 404, code: "NOT_FOUND", message: "KYC form not found" };
        return;
      }
      const info = form.documentInfo || {};
      if (!info.verifiedLogId || String(info.verifiedLogId) !== String(logId) || reviewStatusOf(info) !== "needs_review") {
        outcome = { status: 409, code: "NOT_REVIEWABLE", message: "Only the current upload that is awaiting review can be marked as verified" };
        return;
      }
      const log = await KycLogs.exists({ _id: logId, userId: hostId, type: "OCR" }).session(session);
      if (!log) {
        outcome = { status: 404, code: "NOT_FOUND", message: "Document not found" };
        return;
      }
      const now = new Date();
      await KycHostData.updateOne(
        { _id: form._id },
        { $set: { "documentInfo.isVerified": true, "documentInfo.reviewStatus": "verified", "documentInfo.reviewReason": "MANUAL", "documentInfo.verifiedAt": now } },
        { session },
      );
      await adminAudit.record(req, "kyc.document.manual_verify", { targetType: "KycLogs", targetId: log._id }, { hostId: String(hostId), previousReason: info.reviewReason || "" }, { session });
      // The host already accepted the terms → complete their KYC now.
      if (form.acceptedTerms && form.acceptedTerms.general && form.status !== "completed") {
        await KycHostData.updateOne({ _id: form._id }, { $set: { status: "completed" } }, { session });
        formForCompletion = form;
      }
      outcome = { status: 200, body: { success: true, data: { verifiedLogId: String(logId), reviewStatus: "verified", completed: !!formForCompletion } } };
    });
  } catch (err) {
    console.error("manualVerifyKycDocument error", err && err.message);
    return fail(res, 503, "AUDIT_UNAVAILABLE", "The change could not be recorded. Nothing was saved — please try again.");
  } finally {
    await session.endSession().catch(() => {});
  }
  if (!outcome) return fail(res, 500, "SERVER_ERROR", "Verification failed");
  if (outcome.body) {
    if (formForCompletion) await completeKycForm(formForCompletion);
    return res.status(outcome.status).json(outcome.body);
  }
  return fail(res, outcome.status, outcome.code, outcome.message);
};

exports.__test = { MAX_KYC_BYTES, MAX_KYC_B64, isTransient };

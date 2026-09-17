// Host KYC form (KycHostData). Routes are authenticated and owner-scoped
// (routes/kycRoutes.js). Since Batch A2 the verification blocks
// (documentInfo, gstInfo) are server-owned: they are written by the
// verification endpoints from the provider verdict, or by an admin's audited
// manual verification, never from a client body.
const kycHostForm = require("../../models/KycHostForm");
const User = require("../../models/User");
const mongoose = require("mongoose");
const { changeToUpperCase } = require("../../utils/convertToUpperCase");
const { sendEmail } = require("../../utils/sendEmail");
const ListingProperty = require("../../models/ListingProperty");
const authz = require("../../middleware/authz");
require("dotenv").config();

const STATUSES = ["pending", "processing", "completed"];

function fail(res, status, code, message, extra = {}) {
  return res.status(status).json({ success: false, code, message, statusCode: status, ...extra });
}

function str(v, max = 200) {
  if (v === undefined || v === null) return undefined;
  return String(v).trim().slice(0, max);
}

// Only the fields a host may set on their own form.
function pickPersonalInfo(input) {
  if (!input || typeof input !== "object") return undefined;
  const out = {};
  if (input.fatherName !== undefined) out.fatherName = str(input.fatherName, 100);
  if (input.dob !== undefined) out.dob = str(input.dob, 40);
  if (input.address && typeof input.address === "object") {
    out.address = {};
    for (const key of ["line1", "line2", "city", "state", "pincode", "country"]) {
      if (input.address[key] !== undefined) out.address[key] = str(input.address[key], 200);
    }
  }
  return out;
}
function pickAcceptedTerms(input) {
  if (!input || typeof input !== "object") return undefined;
  const out = {};
  if (input.general !== undefined) out.general = input.general === true || input.general === "true";
  return out;
}

// Completing KYC marks the host and their listings; used by the host's own
// Publish and by an admin's manual verification when the host has already
// accepted the terms. Emails are best-effort.
async function completeKycForm(form) {
  const host = await User.findByIdAndUpdate(form.hostId, { kyc: true }, { new: true });
  if (!host) return;
  await ListingProperty.updateMany({ host: host._id }, { $set: { kycStatus: "completed" } });
  try {
    const adminEmail = String(process.env.ADMIN_EMAIL || "").split(",").filter(Boolean);
    const params = {
      hostName: changeToUpperCase(`${host.firstName} ${host.lastName || ""}`),
      hostEmail: host.email,
      hostContact: host.phone || host.email,
      kycDate: new Date().toLocaleDateString(),
    };
    await sendEmail(host.email, host.hostOffer === true ? 47 : 45, params);
    await Promise.all(adminEmail.map((email) => sendEmail(email.trim(), 4, params)));
  } catch (err) {
    console.error("KYC completion emails failed", err && err.message);
  }
}

// POST /kyc/form — idempotent: a host has at most one form.
exports.createhostKycForm = async (req, res) => {
  try {
    const actor = await authz.resolveActor(req);
    if (!actor) return fail(res, 401, "AUTH_REQUIRED", "Authentication required");
    const body = req.body && typeof req.body === "object" ? req.body : {};
    let hostId = actor.id;
    let hostEmail = actor.user && actor.user.email;
    if (authz.isAdmin(actor)) {
      if (!mongoose.isValidObjectId(String(body.hostId || ""))) return fail(res, 400, "INVALID_ID", "Invalid hostId");
      const host = await User.findById(body.hostId).select("email").lean();
      if (!host) return fail(res, 404, "USER_NOT_FOUND", "User not found");
      hostId = String(host._id);
      hostEmail = host.email;
    }
    const existing = await kycHostForm.findOne({ hostId });
    if (existing) return res.status(200).json({ success: true, data: existing, existing: true });
    const kyc = new kycHostForm({
      hostId,
      hostEmail,
      personalInfo: pickPersonalInfo(body.personalInfo) || {},
      acceptedTerms: pickAcceptedTerms(body.acceptedTerms) || {},
      status: "processing",
    });
    await kyc.save();
    res.status(200).json({ success: true, data: kyc });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
};

// PUT /kyc/update-form/:id — personal info, terms and status only.
// status "completed" requires a server-verified document; otherwise the
// submitted fields are saved with status "pending" and the host is told the
// document is under review (an admin's manual verification then completes
// the KYC automatically).
exports.updatehostKycForm = async (req, res) => {
  try {
    const form = req.kycForm || (await kycHostForm.findById(req.params.id));
    if (!form) return res.status(404).json({ message: "KYC form not found" });
    const body = req.body && typeof req.body === "object" ? req.body : {};

    const current = form.toObject();
    const personalInfo = pickPersonalInfo(body.personalInfo);
    if (personalInfo) {
      const { address, ...rest } = personalInfo;
      form.set("personalInfo", {
        ...(current.personalInfo || {}),
        ...rest,
        address: { ...((current.personalInfo && current.personalInfo.address) || {}), ...(address || {}) },
      });
    }
    const acceptedTerms = pickAcceptedTerms(body.acceptedTerms);
    if (acceptedTerms && acceptedTerms.general !== undefined) form.set("acceptedTerms", { ...(current.acceptedTerms || {}), ...acceptedTerms });

    let status = body.status === undefined ? undefined : String(body.status);
    if (status !== undefined && !STATUSES.includes(status)) return fail(res, 400, "INVALID_STATUS", "Invalid status");

    let underReview = false;
    const wantsCompletion = status === "completed";
    if (wantsCompletion) {
      if (!(form.acceptedTerms && form.acceptedTerms.general)) return fail(res, 409, "KYC_INCOMPLETE", "Please accept the terms to complete your KYC");
      if (!(form.documentInfo && form.documentInfo.isVerified)) {
        underReview = true;
        status = "pending";
      }
    }
    if (status !== undefined) form.status = status;
    await form.save();

    if (wantsCompletion && !underReview && form.status === "completed") await completeKycForm(form);

    if (underReview) {
      const reviewStatus = form.documentInfo && form.documentInfo.reviewStatus;
      const message =
        reviewStatus === "needs_review"
          ? "Your identity document is under manual review. Your KYC will be completed automatically once our team approves it."
          : "Please verify your identity document before completing your KYC.";
      return fail(res, 409, "KYC_INCOMPLETE", message, { data: form });
    }
    return res.status(200).json(form);
  } catch (error) {
    return res.status(400).json({ message: error.message });
  }
};

// PATCH /kyc/verify-status — confirm-only: the body cannot promote a document.
exports.updatehostKycFormStatus = async (req, res) => {
  try {
    const form = await kycHostForm.findOne({ hostId: req.body.userId }).select("documentInfo").lean();
    if (!form) return fail(res, 404, "NOT_FOUND", "KYC form not found");
    if (!form.documentInfo || !form.documentInfo.isVerified) {
      return fail(res, 409, "VERIFICATION_NOT_FOUND", "The identity document has not been verified yet", { data: form.documentInfo || null });
    }
    res.status(200).json({ success: true, data: form.documentInfo });
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
};

// PATCH /kyc/verify-gst-status — confirm-only.
exports.updatehostKycFormGstStatus = async (req, res) => {
  try {
    const form = await kycHostForm.findOne({ hostId: req.body.userId }).select("gstInfo").lean();
    if (!form) return fail(res, 404, "NOT_FOUND", "KYC form not found");
    if (!form.gstInfo || !form.gstInfo.isVerified) {
      return fail(res, 409, "VERIFICATION_NOT_FOUND", "GST has not been verified yet", { data: form.gstInfo || null });
    }
    res.status(200).json({ success: true, data: form.gstInfo });
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
};

exports.fetchhostKycForm = async (req, res) => {
  try {
    const { id } = req.params;
    const data = await kycHostForm.findOne({ hostId: new mongoose.Types.ObjectId(id) });
    if (!data) return res.status(404).json({ message: "Property not found or unauthorized to update" });
    res.status(200).json({ success: true, data });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
};

exports.fetchhostKycFormById = async (req, res) => {
  try {
    const data = req.kycForm || (await kycHostForm.findById(req.params.id));
    if (!data) return res.status(404).json({ message: "Property not found or unauthorized to update" });
    res.status(200).json({ success: true, data });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
};

exports.fetchhostKycFormByUserId = async (req, res) => {
  try {
    const { id } = req.params;
    const data = await kycHostForm.findOne({ hostId: new mongoose.Types.ObjectId(id) });
    if (!data) return res.status(404).json({ message: "Property not found or unauthorized to update" });
    res.status(200).json({ success: true, data });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
};

exports.completeKycForm = completeKycForm;

const mongoose = require("mongoose");

const addressSchema = {
  line1: { type: String, default: "" },
  line2: { type: String, default: "" },
  city: { type: String, default: "" },
  state: { type: String, default: "" },
  pincode: { type: String, default: "" },
  country: { type: String, default: "India" },
};

const personalInfoSchema = {
  fatherName: { type: String, default: "" },
  dob: { type: String, default: "" }, // You can change to Date if storing real DOB
  address: addressSchema,
};

// Server-owned since Batch A2: written only by the verification endpoints
// (provider verdict) or an admin's audited manual verification — never from
// a client body. reviewStatus: unverified | verified | needs_review | failed.
const documentInfoSchema = {
  documentType: { type: String, default: "" },
  isVerified: { type: Boolean, default: false },
  reviewStatus: { type: String, enum: ["unverified", "verified", "needs_review", "failed"], default: "unverified" },
  reviewReason: { type: String, default: "" },
  verifiedLogId: { type: mongoose.Schema.Types.ObjectId, ref: "KycLogs", default: null },
  verifiedAt: { type: Date, default: null },
  fingerprint: { type: String, default: "" }, // sha256 of the last submitted document bytes
  lastAttemptAt: { type: Date, default: null },
};

const gstInfoSchema = {
  gstNumber: { type: String, default: "" },
  panNumber: { type: String, default: "" },
  isVerified: { type: Boolean, default: false },
  verifiedLogId: { type: mongoose.Schema.Types.ObjectId, ref: "KycLogs", default: null },
  verifiedAt: { type: Date, default: null },
};

// Provider abuse/cost guard state (services/kycGuard.js); absent on legacy
// forms until their first attempt after Batch A2.
const guardSchema = {
  windowStart: { type: Date, default: null },
  count: { type: Number, default: 0 },
  lastAt: { type: Date, default: null },
  inFlightUntil: { type: Date, default: null },
};

const acceptedTermsSchema = {
  general: { type: Boolean, default: false },
  // goa: { type: Boolean, default: false },
};

const kycHostSchema = new mongoose.Schema(
  {
    hostId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },
    personalInfo: personalInfoSchema,
    documentInfo: documentInfoSchema,
    gstInfo: gstInfoSchema,
    acceptedTerms: acceptedTermsSchema,
    status: {
      type: String,
      enum: ["pending", "processing", "completed"],
      default: "pending",
    },
    hostEmail: { type: String }, // Ensure it's set from auth.user.email
    verification: {
      ocr: { type: guardSchema, default: undefined },
      gst: { type: guardSchema, default: undefined },
    },
  },
  { timestamps: true }
);

const kycHostForm = mongoose.model("KycHostData", kycHostSchema);

module.exports = kycHostForm;

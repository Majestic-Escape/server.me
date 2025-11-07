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

const documentInfoSchema = {
  documentType: { type: String, default: "" },
  // documentSize: {
  //   type: Number,
  //   default: null,
  //   max: 5000000,
  // },
  // documentNumber: { type: String, default: null },
  // documentFile: { type: String, default: null }, // Assuming you store file URL or path
  isVerified: { type: Boolean, default: false },
};

const gstInfoSchema = {
  gstNumber: { type: String, default: "" },
  panNumber: { type: String, default: "" },
  isVerified: { type: Boolean, default: false },
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
  },
  { timestamps: true }
);

const kycHostForm = mongoose.model("KycHostData", kycHostSchema);

module.exports = kycHostForm;

const mongoose = require("mongoose");

// Define User Schema
const adminSchema = new mongoose.Schema(
  {
    firstName: { type: String, trim: true, required: true },
    lastName: { type: String, trim: true },
    email: {
      type: String,
      lowercase: true,
      trim: true,
      unique: true,
      required: true,
    },
    isVerified: { type: Boolean, default: false },
    role: { type: String, enum: ["user", "host", "admin"], default: "admin" },
    otp: {
      value: { type: String },
      expiry: { type: Date },
    },
    otpRetries: { type: Number, default: 0 }, // Track OTP retries
    lockUntil: { type: Date }, // Track when to unlock OTP attempts
    phoneNumber: { type: String, trim: true, unique: true },
    countryCode: { type: String, default: "+91" },
    profilePicture: { type: String },
    dob: { type: Date },
    gender: {
      type: String,
      enum: ["male", "female", "other", "prefer_not_to_say"],
    },
    status: {
      active: { type: Boolean, default: true },
      banned: { type: Boolean, default: false },
      bannedReason: { type: String },
    },

    verification: {
      emailVerified: { type: Boolean, default: false },
      phoneVerified: { type: Boolean, default: false },
      idVerified: { type: Boolean, default: false },
      socialAccounts: [
        {
          platform: { type: String },
          verified: { type: Boolean, default: false },
        },
      ],
    },
    preferences: {
      language: { type: String, default: "en-IN" },
      currency: { type: String, default: "INR" },
      theme: {
        type: String,
        enum: ["light", "dark", "auto"],
        default: "light",
      },
      notificationSettings: {
        email: { type: Boolean, default: true },
        sms: { type: Boolean, default: true },
        push: { type: Boolean, default: true },
      },
    },

    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now },
  },

  {
    collection: "admins",
    timestamps: true,
    toObject: { virtuals: true },
    toJSON: { virtuals: true },
  }
);

adminSchema.methods.isLocked = function () {
  return this.lockUntil && this.lockUntil > Date.now();
};
// Create User Model
const Admin = mongoose.model("Admin", adminSchema);

module.exports = Admin;

const mongoose = require("mongoose");

// Define User Schema
const userSchema = new mongoose.Schema(
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
    about: { type: String },
    languages: { type: [String], default: [] },
    isVerified: { type: Boolean, default: false },
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
    bio: { type: String },
    role: { type: String, enum: ["user", "host", "admin"], default: "user" },
    status: {
      active: { type: Boolean, default: true },
      banned: { type: Boolean, default: false },
      bannedReason: { type: String },
    },
    kyc: {
      govDoc: {
        docType: { type: String, enum: ["pan", "voterId", "passport"] },
        docInfo: { type: Object },
      },
      isVerified: { type: Boolean, default: false },
      verifiedAt: { type: Date, default: Date.now },
      verificationRequestId: { type: String },
    },
    address: {
      street: String,
      city: String,
      state: String,
      postalCode: String,
      country: String,
      geoLocation: {
        type: { type: String, enum: ["Point"], default: "Point" },
        coordinates: { type: [Number], index: "2dsphere" },
      },
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
    averageRating: { type: Number, default: 0 },
    reviewCount: { type: Number, default: 0 },
    avgPropertyRating: { type: Number, default: 0 },
    propertyReviewCount: { type: Number, default: 0 },
    wishlist: [
      {
        propertyId: { type: mongoose.Schema.Types.ObjectId, ref: "Property" },
        addedAt: { type: Date, default: Date.now },
      },
    ],
    bookings: [
      {
        bookingId: { type: mongoose.Schema.Types.ObjectId, ref: "Booking" },
        status: { type: String, enum: ["completed", "pending", "cancelled"] },
        checkIn: Date,
        checkOut: Date,
        price: Number,
        currency: String,
        createdAt: { type: Date, default: Date.now },
      },
    ],
  },

  {
    collection: "users",
    timestamps: true,
    toObject: { virtuals: true },
    toJSON: { virtuals: true },
  }
);

userSchema.methods.isLocked = function () {
  return this.lockUntil && this.lockUntil > Date.now();
};
// Create User Model
const User = mongoose.model("User", userSchema);

module.exports = User;

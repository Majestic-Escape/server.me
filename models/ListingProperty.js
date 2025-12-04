const mongoose = require("mongoose");
const safetyFeatureSchema = new mongoose.Schema({
  checked: Boolean,
  description: String,
});

const propertySchema = new mongoose.Schema({
  propertyType: {
    type: String,
  },
  placeType: {
    type: String,
    enum: ["entire", "room", "private", "shared"],
    default: "entire",
  },
  title: {
    type: String,
  },
  description: {
    type: String,
  },
  occupancy: {
    type: [String],
    enum: ["self-check-in", "me", "family", "guests", "flatmates"],
    default: [],
  },
  ban: {
    type: Boolean,
    default: false,
  },
  guests: {
    type: Number,
    min: 1,
    default: 1,
  },
  bedrooms: {
    type: Number,
    min: 1,
    default: 1,
  },
  beds: {
    type: Number,
    min: 1,
    default: 1,
  },
  line1: String,
  line2: String,
  bathrooms: {
    type: Number,
    min: 1,
    default: 1,
  },
  delist: {
    type: String,
    enum: ["host", "admin"],
  },
  photos: [String],
  address: {
    registrationNumber: String,
    street: String,
    district: String,

    city: String,
    state: String,
    pincode: String,

    country: {
      type: String,
      default: "India - IN",
    },
    latitude: Number,
    longitude: Number,
  },

  validRegistrationNo: {
    type: Boolean,
    default: false,
  },
  bankDetails: {
    type: Boolean,
    default: false,
  },
  bathroomTypes: {
    private: {
      type: Number,
      default: 0,
    },
    shared: {
      type: Number,
      default: 0,
    },
    dedicated: {
      type: Number,
      default: 0,
    },
  },
  amenities: [String],
  basePrice: {
    type: Number,
  },
  discounts: {
    type: [String],
    enum: ["new-listing", "weekly", "monthly", "fifer", "extended"],
    default: [],
  },
  bookingType: {
    manual: {
      type: Boolean,
      default: true,
    },
    instantBook: {
      type: Boolean,
      default: false,
    },
    flashBook: {
      type: Boolean,
      default: false,
    },
  },
  cancellationType: {
    moderate: {
      type: Boolean,
      default: true,
    },
    flexible: {
      type: Boolean,
      default: false,
    },
    strict: {
      type: Boolean,
      default: false,
    },
  },
  status: {
    type: String,
    enum: ["incomplete", "processing", "inactive", "active"],
    default: "incomplete",
  },

  host: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
  },
  hostEmail: {
    type: String,
  },
  checkinTime: {
    type: String,
  },
  checkoutTime: {
    type: String,
  },
  selectedRules: [String],
  customRules: [String],
  createdAt: {
    type: Date,
    default: Date.now,
  },
  kycStatus: {
    type: String,
    enum: ["completed", "pending"],
    default: "pending",
  },
  safetyFeatures: {
    exteriorCamera: safetyFeatureSchema,
    noiseMonitor: safetyFeatureSchema,
    weapons: safetyFeatureSchema,
  },
  averageRating: {
    type: Number,
    default: 0,
  },
  reviewCount: {
    type: Number,
    default: 0,
  },
  updatedAt: {
    type: Date,
    default: Date.now,
  },
});

const ListingProperty = mongoose.model("ListingProperty", propertySchema);

module.exports = ListingProperty;

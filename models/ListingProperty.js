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

// Public catalogue reads: {status, createdAt:-1} backs the home/search lists,
// host / hostEmail back the host dashboard lookups. autoIndex is off in
// production — scripts/ensure-indexes.js creates them (create-only).
propertySchema.index({ status: 1, createdAt: -1, _id: -1 }); // _id: deterministic pages, no in-memory sort
propertySchema.index({ host: 1 });
propertySchema.index({ hostEmail: 1 });

// The chat widget stores a 3072-float vector on every listing (`embedding`,
// plus `embeddingUpdatedAt` / `embeddingVersion`) with the raw driver and
// reads it back with $vectorSearch. The API never uses it, and it is 93% of
// a listing's bytes, so every query — lean or hydrated, and every
// populate("propertyId") — leaves it out unless a caller asks for it with
// "+embedding". The paths stay undeclared on purpose: strict mode keeps
// dropping them from $set / new Model(body), so no request body can ever
// write (or null) the widget's vector.
const EMBEDDING_PATHS = ["embedding", "embeddingUpdatedAt", "embeddingVersion"];
propertySchema.pre(/^find/, function excludeEmbedding() {
  if (this.selectedInclusively()) return; // an inclusive projection omits them already
  const asked = Object.keys(this._fields || {});
  if (asked.some((k) => k === "+embedding" || k === "embedding")) return; // caller opted in
  this.select(EMBEDDING_PATHS.map((p) => "-" + p).join(" "));
});
propertySchema.statics.EMBEDDING_PATHS = EMBEDDING_PATHS;
// Exclusion object for aggregation pipelines, which bypass query middleware.
propertySchema.statics.EMBEDDING_PROJECTION = Object.fromEntries(EMBEDDING_PATHS.map((p) => [p, 0]));

const ListingProperty = mongoose.model("ListingProperty", propertySchema);

module.exports = ListingProperty;

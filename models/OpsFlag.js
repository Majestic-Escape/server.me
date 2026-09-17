const mongoose = require("mongoose");

// Tiny operator-controlled switches read by the backend at request time
// (services/maintenance.js). Written only by scripts/booking-gate.js.
const opsFlagSchema = new mongoose.Schema(
  {
    _id: { type: String },
    enabled: { type: Boolean, default: false },
    reason: { type: String, default: "" },
    updatedAt: { type: Date, default: Date.now },
  },
  { collection: "opsflags", versionKey: false },
);

module.exports = mongoose.model("OpsFlag", opsFlagSchema);

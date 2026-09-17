// models/Log.js
const mongoose = require("mongoose");

const logSchema = new mongoose.Schema({
  //   userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  email: { type: String, required: true },
  type: {
    type: String,
    enum: ["OCR", "Status", "Gst", "Gst Pan"],
    required: true,
  },
  status: {
    type: String,
    enum: ["pending", "success", "failed"],
    default: "pending",
  },
  requestData: { type: mongoose.Schema.Types.Mixed },
  responseData: { type: mongoose.Schema.Types.Mixed },
  error: { type: String },
  retries: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

// Admin KYC document reads (Batch A2) query {userId, type} newest-first;
// without this index each read would COLLSCAN documents that carry multi-MB
// base64 payloads. Created explicitly (autoIndex is off): scripts/ensure-indexes.js
logSchema.index({ userId: 1, type: 1, createdAt: -1 });

module.exports = mongoose.model("KycLogs", logSchema);

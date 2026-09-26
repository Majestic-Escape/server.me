// Site-wide settings the admin manages without a deploy (docs/site-hero.md).
// One document per setting with a string _id, like OpsFlag. Today only
// "home_hero": the homepage banner — live desktop/mobile artwork + one
// shared description, the drafts being prepared, retired objects waiting
// for the sweep, the operation receipts that make admin actions safe to
// retry, and the lease that admits one image job at a time.
//
// Every write is a compare-and-set done by services/siteHero.js (on
// `version`, a draft's opId or the lease token) through the native
// collection; this schema documents the shape and serves reads.
const mongoose = require("mongoose");
const { Schema } = mongoose;

const source = new Schema({ width: Number, height: Number, bytes: Number, clientReencoded: Boolean }, { _id: false });
const artwork = {
  url: { type: String, required: true }, // the JPEG master (renditions derive from it)
  width: { type: Number, required: true },
  height: { type: Number, required: true },
  lqip: { type: String, default: "" }, // tiny WebP data URI placeholder
  source: { type: source, default: undefined }, // what was uploaded (informational)
};
const slot = new Schema({ ...artwork, publishedAt: Date }, { _id: false });
const draft = new Schema(
  {
    ...artwork,
    opId: { type: String, required: true },
    stagedBy: Schema.Types.ObjectId,
    stagedAt: Date,
    expiresAt: Date,
    notices: [String],
  },
  { _id: false },
);
const retired = new Schema({ masterKeys: [String], retiredAt: Date }, { _id: false });
// An image job's master key, recorded before its first upload and cleared by
// the install: what remains belongs to a job that never installed.
const pending = new Schema({ masterKey: String, at: Date }, { _id: false });
const receipt = new Schema(
  {
    opId: String,
    actorId: Schema.Types.ObjectId,
    action: String,
    target: String,
    fingerprint: String,
    status: { type: String, enum: ["completed", "failed"] },
    result: Schema.Types.Mixed,
    at: Date,
  },
  { _id: false },
);
const lease = new Schema({ token: String, opId: String, actorId: Schema.Types.ObjectId, until: Date }, { _id: false });

const siteSettingSchema = new Schema(
  {
    _id: { type: String },
    version: { type: Number, default: 0 },
    alt: { type: String, default: null },
    desktop: { type: slot, default: null },
    mobile: { type: slot, default: null },
    draft: {
      desktop: { type: draft, default: null },
      mobile: { type: draft, default: null },
    },
    retired: { type: [retired], default: [] },
    pending: { type: [pending], default: [] },
    receipts: { type: [receipt], default: [] },
    lease: { type: lease, default: null },
    lastSweepAt: { type: Date, default: null },
    updatedBy: { type: Schema.Types.ObjectId, default: null },
    updatedAt: { type: Date, default: null },
  },
  { collection: "sitesettings", versionKey: false },
);

module.exports = mongoose.model("SiteSetting", siteSettingSchema);

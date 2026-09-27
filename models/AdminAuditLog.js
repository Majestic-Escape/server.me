// Restricted audit trail of admin actions (Batch A2). One row per admin
// mutation or sensitive read, written in the same transaction as the change
// (rename, delete) or before the bytes leave the server (KYC documents).
//
// PII policy: ids, the before/after names of a rename (that *is* the audit),
// a deleted listing's title/host id/photo keys and the KYC log id — never
// emails, document bytes or full URLs. Console logs never carry any of it.
const mongoose = require("mongoose");

const ACTIONS = [
  "user.rename",
  "listing.delete",
  "kyc.document.view",
  "kyc.document.download",
  "kyc.document.manual_verify",
  "admin.create",
  // an admin renaming their own account (PATCH /admin/me/name); target: Admin, or User for a role-admin user
  "admin.rename",
  // homepage hero (services/siteHero.js); target: SiteSetting "home_hero"
  "site.hero.stage",
  "site.hero.discard",
  "site.hero.publish",
  "site.hero.alt",
  "site.hero.reset",
  "site.hero.draft_expire",
];
// Targets that are singleton documents with a string id instead of an ObjectId.
const KEYED_TARGETS = ["SiteSetting"];

const adminAuditLogSchema = new mongoose.Schema(
  {
    // "system": scheduled maintenance (a hero draft expiring) — no person acted
    actorId: { type: mongoose.Schema.Types.ObjectId, required: function () { return this.actorKind !== "system"; } },
    actorKind: { type: String, enum: ["admin", "host", "system"], default: "admin" },
    action: { type: String, enum: ACTIONS, required: true },
    targetType: { type: String, required: true },
    targetId: { type: mongoose.Schema.Types.ObjectId, required: function () { return !KEYED_TARGETS.includes(this.targetType); } },
    targetKey: { type: String },
    details: { type: mongoose.Schema.Types.Mixed },
    createdAt: { type: Date, default: Date.now },
  },
  { versionKey: false },
);

adminAuditLogSchema.index({ targetId: 1, createdAt: -1 });
adminAuditLogSchema.index({ action: 1, createdAt: -1 });

const AdminAuditLog = mongoose.model("AdminAuditLog", adminAuditLogSchema);
AdminAuditLog.ACTIONS = ACTIONS;
module.exports = AdminAuditLog;

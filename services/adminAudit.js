// Writes AdminAuditLog rows. Throws on failure — callers decide whether the
// action is fail-closed (KYC document access, rename/delete inside their
// transaction) — nothing here is best-effort.
const AdminAuditLog = require("../models/AdminAuditLog");
const authz = require("../middleware/authz");

async function record(req, action, { targetType, targetId, targetKey }, details = {}, { session } = {}) {
  const actor = await authz.resolveActor(req);
  if (!actor || actor.kind !== "admin") throw new Error("audit: admin actor required");
  const rows = await AdminAuditLog.create(
    [{ actorId: actor.id, actorKind: "admin", action, targetType, targetId, targetKey, details }],
    session ? { session } : {},
  );
  return rows[0];
}

// Scheduled maintenance (no person acted): actorKind "system", no actorId.
async function recordSystem(action, { targetType, targetId, targetKey }, details = {}, { session } = {}) {
  const rows = await AdminAuditLog.create([{ actorKind: "system", action, targetType, targetId, targetKey, details }], session ? { session } : {});
  return rows[0];
}

module.exports = { record, recordSystem };

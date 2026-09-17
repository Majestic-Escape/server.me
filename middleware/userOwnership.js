// Ownership guards for user-scoped resources (profile, KYC form, uploads):
// the caller must be the user the request is about, or an admin. Same shape
// as listingOwnership.js. Admin identity comes from authz.resolveActor (a DB
// fact, never a JWT claim).
const KycHostData = require("../models/KycHostForm");
const authz = require("./authz");
const { isObjectId } = require("./validateObjectId");

function deny(res, status, code, message) {
  return res.status(status).json({ success: false, code, message, statusCode: status });
}

async function actorOrDeny(req, res) {
  const actor = await authz.resolveActor(req);
  if (!actor) {
    deny(res, 401, "AUTH_REQUIRED", "Authentication required");
    return null;
  }
  return actor;
}

// ?email= must be the caller's own email (accounts).
async function requireSelfEmailQueryOrAdmin(req, res, next) {
  try {
    const actor = await actorOrDeny(req, res);
    if (!actor) return;
    if (authz.isAdmin(actor)) return next();
    const own = actor.user && actor.user.email;
    const wanted = req.query && req.query.email;
    if (!own || !wanted || String(wanted).trim().toLowerCase() !== String(own).toLowerCase()) {
      return deny(res, 403, "FORBIDDEN", "You can only access your own profile");
    }
    next();
  } catch (err) {
    next(err);
  }
}

// ?<param>= is a user id that must be the caller (profile picture upload).
function requireSelfUserIdQueryOrAdmin(param = "userId") {
  return async (req, res, next) => {
    try {
      const actor = await actorOrDeny(req, res);
      if (!actor) return;
      if (authz.isAdmin(actor)) return next();
      const id = req.query && req.query[param];
      if (!isObjectId(String(id || ""))) return deny(res, 400, "INVALID_ID", `Invalid ${param}`);
      if (!authz.sameId(actor.id, id)) return deny(res, 403, "FORBIDDEN", "Not allowed");
      next();
    } catch (err) {
      next(err);
    }
  };
}

// body.<field> is a user id that must be the caller (KYC verification calls).
function requireSelfBodyUserIdOrAdmin(field = "userId") {
  return async (req, res, next) => {
    try {
      const actor = await actorOrDeny(req, res);
      if (!actor) return;
      if (authz.isAdmin(actor)) return next();
      const id = req.body && req.body[field];
      if (!isObjectId(String(id || ""))) return deny(res, 400, "INVALID_ID", `Invalid ${field}`);
      if (!authz.sameId(actor.id, id)) return deny(res, 403, "FORBIDDEN", "Not allowed");
      next();
    } catch (err) {
      next(err);
    }
  };
}

// :param is a KYC form id; the caller must be its host (or an admin). Sets
// req.kycForm.
function requireKycFormOwnerOrAdmin(param = "id") {
  return async (req, res, next) => {
    try {
      const actor = await actorOrDeny(req, res);
      if (!actor) return;
      const id = req.params[param];
      if (!isObjectId(id)) return deny(res, 404, "NOT_FOUND", "Not found");
      const form = await KycHostData.findById(id);
      if (!form) return deny(res, 404, "NOT_FOUND", "KYC form not found");
      if (!authz.isAdmin(actor) && !authz.sameId(actor.id, form.hostId)) return deny(res, 403, "FORBIDDEN", "Not allowed");
      req.kycForm = form;
      next();
    } catch (err) {
      next(err);
    }
  };
}

module.exports = {
  requireSelfEmailQueryOrAdmin,
  requireSelfUserIdQueryOrAdmin,
  requireSelfBodyUserIdOrAdmin,
  requireKycFormOwnerOrAdmin,
};

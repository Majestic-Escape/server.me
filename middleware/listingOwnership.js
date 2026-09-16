// Listing mutations decide bookability and price, so they are part of the
// booking trust boundary: only the listing's host (or an admin) may change a
// listing. Reads stay public.
const ListingProperty = require("../models/ListingProperty");
const authz = require("./authz");
const { isObjectId } = require("./validateObjectId");

function deny(res, status, code, message) {
  return res.status(status).json({ success: false, code, message, statusCode: status });
}

// :param is a listing id; the actor must be its host or an admin.
function requireListingHostOrAdmin(param = "id") {
  return async (req, res, next) => {
    try {
      const actor = await authz.resolveActor(req);
      if (!actor) return deny(res, 401, "AUTH_REQUIRED", "Authentication required");
      if (authz.isAdmin(actor)) return next();
      const id = req.params[param];
      if (!isObjectId(String(id))) return deny(res, 404, "NOT_FOUND", "Not found");
      const listing = await ListingProperty.findById(id).select("host").lean();
      if (!listing) return deny(res, 404, "NOT_FOUND", "Listing not found");
      if (!authz.isListingHost(actor, listing)) return deny(res, 403, "FORBIDDEN", "Only the listing host can do this");
      req.listing = listing;
      next();
    } catch (err) {
      next(err);
    }
  };
}

// body.propertyId is a listing id (timings).
async function requireBodyListingHostOrAdmin(req, res, next) {
  try {
    const actor = await authz.resolveActor(req);
    if (!actor) return deny(res, 401, "AUTH_REQUIRED", "Authentication required");
    if (authz.isAdmin(actor)) return next();
    const id = req.body && req.body.propertyId;
    if (!isObjectId(String(id))) return deny(res, 400, "INVALID_ID", "Invalid propertyId");
    const listing = await ListingProperty.findById(id).select("host").lean();
    if (!listing) return deny(res, 404, "NOT_FOUND", "Listing not found");
    if (!authz.isListingHost(actor, listing)) return deny(res, 403, "FORBIDDEN", "Only the listing host can do this");
    next();
  } catch (err) {
    next(err);
  }
}

// create-listing-property: the listing is created for body.hostEmail — it
// must be the caller's own email (admins may create for anyone).
async function requireSelfHostEmailOrAdmin(req, res, next) {
  try {
    const actor = await authz.resolveActor(req);
    if (!actor) return deny(res, 401, "AUTH_REQUIRED", "Authentication required");
    if (authz.isAdmin(actor)) return next();
    const email = actor.user && actor.user.email;
    const wanted = req.body && req.body.hostEmail;
    if (!email || !wanted || String(wanted).toLowerCase() !== String(email).toLowerCase()) {
      return deny(res, 403, "FORBIDDEN", "You can only create listings for your own account");
    }
    next();
  } catch (err) {
    next(err);
  }
}

// :param is a *host* user id (update-kyc-property): must be the caller.
function requireSelfUserIdOrAdmin(param = "id") {
  return async (req, res, next) => {
    try {
      const actor = await authz.resolveActor(req);
      if (!actor) return deny(res, 401, "AUTH_REQUIRED", "Authentication required");
      if (authz.isAdmin(actor)) return next();
      if (!authz.sameId(actor.id, req.params[param])) return deny(res, 403, "FORBIDDEN", "Not allowed");
      next();
    } catch (err) {
      next(err);
    }
  };
}

module.exports = {
  requireListingHostOrAdmin,
  requireBodyListingHostOrAdmin,
  requireSelfHostEmailOrAdmin,
  requireSelfUserIdOrAdmin,
};

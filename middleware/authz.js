// Authorization helpers. authMiddleware only proves *who* the caller is;
// nothing here existed before, which is why any authenticated user could
// confirm, cancel, refund or edit any booking.
//
// Actor resolution: user tokens (admin claim 0) already arrive as a User
// document in req.user. Any other token (admin login tokens carry no claim
// at all) is only accepted as an admin if its id is a real, non-banned Admin
// record — or a User with role "admin" — in the database. A bare JWT claim
// never grants authority on its own.
const mongoose = require("mongoose");
const Admin = require("../models/Admin");
const User = require("../models/User");

function idOf(value) {
  if (!value) return null;
  if (typeof value === "object" && value._id) return String(value._id);
  return String(value);
}

function sameId(a, b) {
  const x = idOf(a);
  const y = idOf(b);
  return !!x && !!y && x === y;
}

async function resolveActor(req) {
  if (req.actor) return req.actor;
  const u = req.user;
  if (!u) return null;
  let actor = null;
  if (u instanceof mongoose.Model || (u._doc && u.email)) {
    // DB-verified user path from authMiddleware.
    actor = { kind: u.role === "admin" ? "admin" : "user", id: String(u._id), user: u };
  } else if (u.userId && mongoose.isValidObjectId(u.userId)) {
    const admin = await Admin.findById(u.userId).select("status role").lean();
    if (admin && !(admin.status && admin.status.banned)) {
      actor = { kind: "admin", id: String(admin._id), admin };
    } else {
      const user = await User.findById(u.userId);
      if (user && !(user.status && user.status.banned)) {
        actor = { kind: user.role === "admin" ? "admin" : "user", id: String(user._id), user };
      }
    }
  }
  req.actor = actor;
  return actor;
}

function forbid(res, message = "You are not allowed to perform this action") {
  return res.status(403).json({ success: false, code: "FORBIDDEN", message, statusCode: 403 });
}

// Route-level guards ------------------------------------------------------

const requireActor = async (req, res, next) => {
  const actor = await resolveActor(req);
  if (!actor) {
    return res.status(401).json({ success: false, code: "AUTH_REQUIRED", message: "Authentication required", statusCode: 401 });
  }
  next();
};

const requireAdmin = async (req, res, next) => {
  const actor = await resolveActor(req);
  if (!actor) return res.status(401).json({ success: false, code: "AUTH_REQUIRED", message: "Authentication required", statusCode: 401 });
  if (actor.kind !== "admin") return forbid(res, "Admin access required");
  next();
};

// Non-admins must be a real user record (hosts are users); admins pass.
const requireUser = async (req, res, next) => {
  const actor = await resolveActor(req);
  if (!actor) return res.status(401).json({ success: false, code: "AUTH_REQUIRED", message: "Authentication required", statusCode: 401 });
  if (actor.kind === "user" && !actor.user) return forbid(res);
  next();
};

// Object-level checks (call after the booking/listing is loaded) ----------

function isAdmin(actor) {
  return !!actor && actor.kind === "admin";
}
function isBookingGuest(actor, booking) {
  return !!actor && actor.kind === "user" && sameId(actor.id, booking.userId);
}
function isBookingHost(actor, booking) {
  return !!actor && actor.kind === "user" && sameId(actor.id, booking.hostId);
}
function isListingHost(actor, listing) {
  return !!actor && actor.kind === "user" && sameId(actor.id, listing.host);
}

module.exports = {
  resolveActor,
  requireActor,
  requireAdmin,
  requireUser,
  forbid,
  isAdmin,
  isBookingGuest,
  isBookingHost,
  isListingHost,
  sameId,
  idOf,
};

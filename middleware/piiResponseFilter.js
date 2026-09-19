// Defence in depth for the contact lock-down: every JSON response that is not
// addressed to an admin is walked once before it leaves the server, and any
// user-shaped object that is not the caller keeps only its public fields,
// the caller's own record loses its secrets, a listing that is not the
// caller's loses its owner-only fields, and payment customer details are
// dropped. The controllers' projections are the primary control
// (utils/sanitizeResponse.js); this catches the endpoint someone forgets.
//
// Fail closed: if the walk throws, nothing of the original body is written —
// a redacted security log line and a generic 500 instead. One failed request
// is preferable to one leaked record.
const mongoose = require("mongoose");
const { PUBLIC_USER_FIELDS, SELF_USER_FIELDS } = require("../utils/sanitizeResponse");

const MAX_DEPTH = 16;
const PUBLIC = new Set(PUBLIC_USER_FIELDS);
const SELF = new Set(SELF_USER_FIELDS);
const OWNER_ONLY_LISTING_FIELDS = ["hostEmail", "validRegistrationNo", "bankDetails"];

function isLeaf(value) {
  return (
    value === null ||
    typeof value !== "object" ||
    value instanceof Date ||
    Buffer.isBuffer(value) ||
    value instanceof mongoose.Types.ObjectId ||
    typeof value.toHexString === "function" ||
    value instanceof RegExp
  );
}

function idOf(value) {
  if (!value) return null;
  if (typeof value === "string") return value;
  if (typeof value.toHexString === "function") return value.toHexString();
  if (typeof value === "object" && value._id) return idOf(value._id);
  return String(value);
}

function isUserShaped(obj) {
  return typeof obj.firstName === "string" && (obj._id !== undefined || obj.id !== undefined) && !("hostId" in obj && "propertyId" in obj);
}

function isListingShaped(obj) {
  return ("hostEmail" in obj || "validRegistrationNo" in obj) && ("title" in obj || "host" in obj || "address" in obj);
}

/**
 * Walk a plain (already-serialised) value. Returns the sanitised value.
 * @param {*} value
 * @param {{ selfId: string|null }} ctx
 * @param {number} depth
 * @param {WeakSet} seen
 */
function walk(value, ctx, depth, ancestors) {
  if (isLeaf(value)) return value;
  if (depth > MAX_DEPTH) throw new Error("response nesting too deep");
  // A Mongoose document nested anywhere serialises through toJSON — walk that.
  if (typeof value.toJSON === "function" && !Array.isArray(value)) value = value.toJSON();
  if (isLeaf(value)) return value;
  // A cycle (the object is its own ancestor) cannot be serialised; a shared
  // reference (the same populated host under two bookings) is fine and is
  // simply walked twice.
  if (ancestors.has(value)) throw new Error("cyclic response");
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) value[i] = walk(value[i], ctx, depth + 1, ancestors);
      return value;
    }

  if (isUserShaped(value)) {
    const self = ctx.selfId && idOf(value._id !== undefined ? value._id : value.id) === ctx.selfId;
    const allowed = self ? SELF : PUBLIC;
    for (const key of Object.keys(value)) {
      if (!allowed.has(key)) delete value[key];
    }
  }
  if (isListingShaped(value)) {
    const owner = ctx.selfId && idOf(value.host) === ctx.selfId;
    if (!owner) {
      for (const key of OWNER_ONLY_LISTING_FIELDS) delete value[key];
      if (value.address && typeof value.address === "object" && !isLeaf(value.address)) delete value.address.registrationNumber;
    }
    if (value.host && typeof value.host === "object" && value.host.contact && typeof value.host.contact === "object") {
      delete value.host.contact.phone;
      delete value.host.contact.email;
    }
  }
    if ("customerDetails" in value) delete value.customerDetails;

    for (const key of Object.keys(value)) value[key] = walk(value[key], ctx, depth + 1, ancestors);
    return value;
  } finally {
    ancestors.delete(value);
  }
}

/** Convert Mongoose documents to plain JSON-ready objects before walking. */
function toPlain(body) {
  if (body === null || typeof body !== "object") return body;
  if (typeof body.toJSON === "function" && !(body instanceof Date) && typeof body.toHexString !== "function") return body.toJSON();
  if (Array.isArray(body)) return body.map(toPlain);
  const out = {};
  for (const key of Object.keys(body)) {
    const v = body[key];
    out[key] = v !== null && typeof v === "object" && typeof v.toJSON === "function" && !(v instanceof Date) && typeof v.toHexString !== "function" ? v.toJSON() : v;
  }
  return out;
}

function actorOf(req) {
  const actor = req.actor;
  if (actor) return { isAdmin: actor.kind === "admin", selfId: actor.id ? String(actor.id) : null };
  const u = req.user;
  if (u && u._id) return { isAdmin: u.role === "admin", selfId: String(u._id) };
  return { isAdmin: false, selfId: null };
}

/** Exposed for tests. */
function sanitizeBody(body, { isAdmin, selfId }) {
  if (isAdmin) return body;
  if (body === null || typeof body !== "object") return body;
  const plainBody = toPlain(body);
  return walk(plainBody, { selfId }, 0, new Set());
}

function piiResponseFilter(req, res, next) {
  const originalJson = res.json.bind(res);
  res.json = function filteredJson(body) {
    let safe;
    try {
      safe = sanitizeBody(body, actorOf(req));
    } catch (error) {
      console.error("pii_filter_error", { path: req.originalUrl, method: req.method, error: error && error.name });
      if (res.headersSent) return res;
      res.status(500);
      return originalJson({ success: false, code: "RESPONSE_FILTER_ERROR", message: "The response could not be prepared safely. Please try again.", statusCode: 500 });
    }
    return originalJson(safe);
  };
  next();
}

module.exports = { piiResponseFilter, sanitizeBody, walk, toPlain };

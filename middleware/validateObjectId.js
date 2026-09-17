// Malformed ids used to reach Mongoose and surface as CastError 500s
// ("Cast to ObjectId failed …"). A value that cannot be an ObjectId can never
// match a document, so it is answered up front: 404 for resource paths
// (`/properties/:id`), 400 for ids inside request bodies/queries.
const mongoose = require("mongoose");

const OBJECT_ID = /^[0-9a-fA-F]{24}$/;

function isObjectId(value) {
  return typeof value === "string" && OBJECT_ID.test(value) && mongoose.isValidObjectId(value);
}

// Express param guard: validateParam("id") → 404 when :id is not an ObjectId.
function validateParam(name, { status = 404 } = {}) {
  return (req, res, next) => {
    const value = req.params[name];
    if (!isObjectId(value)) {
      return res.status(status).json({
        success: false,
        code: status === 404 ? "NOT_FOUND" : "INVALID_ID",
        message: status === 404 ? "Not found" : `Invalid ${name}`,
        statusCode: status,
      });
    }
    next();
  };
}

// In-controller guard: returns true when the response has been sent.
function rejectInvalidId(res, value, name = "id") {
  if (isObjectId(value)) return false;
  res.status(400).json({ success: false, code: "INVALID_ID", message: `Invalid ${name}`, statusCode: 400 });
  return true;
}

module.exports = { isObjectId, validateParam, rejectInvalidId };

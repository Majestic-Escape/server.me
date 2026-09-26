// Multipart uploads (multer 2.x): explicit limits + 4xx answers.
//
// 1. Limits. multer's defaults for the number of text fields, field-name
//    nesting and numeric array indexes in field names are all Infinity; the
//    DoS advisories about those (GHSA-535w-7cp7-47q4 oversized array index,
//    GHSA-72gw-mp4g-v24j deep nesting) are only closed when the limits are
//    set. No client of these routes sends text fields at all (site, admin
//    and mobile app post file parts only), so the bounds below are generous
//    for real traffic and tight for crafted bodies.
// 2. Errors. multer runs as route middleware, so its errors (file too large,
//    too many files, a crafted or truncated body, the fileFilter refusal)
//    used to fall through to the global handler as 500 SERVER_ERROR. They are
//    answered here in the API's error shape: 413 for size, 415 for a refused
//    type, 400 for everything else about the request.
const multer = require("multer");

const FIELD_LIMITS = Object.freeze({
  fields: 10,
  fieldNameSize: 100,
  fieldSize: 16 * 1024,
  fieldNestingDepth: 1,
  fieldArrayIndexLimit: 20,
});

// Limits for a route that accepts `files` file parts of at most `fileSize`
// bytes each (plus FIELD_LIMITS, which a route may tighten).
function uploadLimits({ fileSize, files, ...overrides }) {
  if (!Number.isInteger(fileSize) || !Number.isInteger(files)) throw new Error("uploadLimits: integer fileSize and files are required");
  const merged = { ...FIELD_LIMITS, ...overrides, fileSize, files };
  return { ...merged, parts: merged.files + merged.fields };
}

// fileFilter refusals: cb(rejectFile("…")) keeps the 415 + code through the
// error handler below.
function rejectFile(message, code = "UNSUPPORTED_FILE_TYPE", status = 415) {
  return Object.assign(new Error(message), { uploadRejected: true, code, status });
}

const MESSAGES = {
  LIMIT_FILE_COUNT: "Too many files in one upload",
  LIMIT_UNEXPECTED_FILE: "Unexpected file field",
  LIMIT_PART_COUNT: "Too many parts in the upload",
  LIMIT_FIELD_COUNT: "Too many fields in the upload",
  LIMIT_FIELD_KEY: "A field name is too long",
  LIMIT_FIELD_VALUE: "A field value is too long",
  LIMIT_FIELD_NESTING: "A field name is nested too deeply",
  LIMIT_FIELD_ARRAY_INDEX: "A field name uses an array index that is too large",
  MISSING_FIELD_NAME: "A field has no name",
  INVALID_FIELD_NAME: "A field name is invalid",
};

function rejectionFor(err) {
  if (err instanceof multer.MulterError) {
    if (err.code === "LIMIT_FILE_SIZE") return { status: 413, code: "FILE_TOO_LARGE", message: "The file is too large" };
    return { status: 400, code: "UPLOAD_REJECTED", message: MESSAGES[err.code] || "The upload was rejected", reason: err.code };
  }
  if (err && err.uploadRejected) return { status: err.status, code: err.code, message: err.message };
  // busboy / stream failures: a malformed, truncated or aborted body
  return { status: 400, code: "MALFORMED_UPLOAD", message: "The upload could not be read" };
}

// Wraps a multer middleware (upload.single(...), upload.array(...), …).
function handleUpload(middleware) {
  return (req, res, next) =>
    middleware(req, res, (err) => {
      if (!err) return next();
      const r = rejectionFor(err);
      console.warn("upload refused", r.code, r.reason || (err && err.code) || "");
      if (res.headersSent) return undefined;
      return res.status(r.status).json({ success: false, code: r.code, message: r.message, statusCode: r.status, ...(r.reason ? { reason: r.reason } : {}) });
    });
}

module.exports = { FIELD_LIMITS, uploadLimits, rejectFile, rejectionFor, handleUpload };

// Public images (listing photos, profile pictures) are re-encoded before they
// reach the bucket (contact lock-down):
//  - every byte of metadata is dropped — EXIF GPS in a photo taken at the
//    villa would give away the exact location the API now hides; device,
//    date and author tags go with it. The EXIF orientation is baked into the
//    pixels first so the picture still shows the right way up;
//  - a QR code anywhere in the picture (a phone number / UPI / link in
//    disguise) is refused;
//  - the file must decode as an image: a renamed non-image is refused.
// Visible text inside a picture is NOT read (no OCR — see the closure report);
// the admin's listing approval remains the manual control for that.
const sharp = require("sharp");
const jsQR = require("jsqr");

const MAX_DIMENSION = 6000; // pixels; larger images are scaled down
const QR_SCAN_MAX = 1200; // pixels; the QR scan runs on a downscaled copy

class ImageRejected extends Error {
  constructor(code, message, status = 422) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

/**
 * @param {Buffer} buffer the uploaded bytes
 * @param {string} mimetype as declared by the client (only a hint)
 * @returns {Promise<{ buffer: Buffer, mimetype: string, extension: string, width: number, height: number }>}
 */
async function sanitizeImage(buffer, mimetype) {
  let meta;
  try {
    meta = await sharp(buffer, { failOn: "error" }).metadata();
  } catch {
    throw new ImageRejected("INVALID_IMAGE", "The file is not a valid image", 400);
  }
  if (!meta.width || !meta.height) throw new ImageRejected("INVALID_IMAGE", "The file is not a valid image", 400);

  // QR detection on a bounded raster (the decode also proves the image is real)
  const scan = sharp(buffer, { failOn: "error" }).rotate().resize({ width: QR_SCAN_MAX, height: QR_SCAN_MAX, fit: "inside", withoutEnlargement: true }).ensureAlpha().raw();
  const { data, info } = await scan.toBuffer({ resolveWithObject: true });
  const qr = jsQR(new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength), info.width, info.height, { inversionAttempts: "attemptBoth" });
  if (qr) throw new ImageRejected("IMAGE_NOT_ALLOWED", "Images with QR codes aren't allowed");

  // Re-encode without metadata (sharp strips it unless withMetadata() is called)
  const format = meta.format === "png" ? "png" : meta.format === "webp" ? "webp" : "jpeg";
  let pipeline = sharp(buffer, { failOn: "error" }).rotate();
  if (meta.width > MAX_DIMENSION || meta.height > MAX_DIMENSION) pipeline = pipeline.resize({ width: MAX_DIMENSION, height: MAX_DIMENSION, fit: "inside" });
  if (format === "png") pipeline = pipeline.png({ compressionLevel: 8 });
  else if (format === "webp") pipeline = pipeline.webp({ quality: 85 });
  else pipeline = pipeline.jpeg({ quality: 85, mozjpeg: true });
  const { data: out, info: outInfo } = await pipeline.toBuffer({ resolveWithObject: true });
  return {
    buffer: out,
    mimetype: `image/${format}`,
    extension: format === "jpeg" ? "jpg" : format,
    width: outInfo.width,
    height: outInfo.height,
  };
}

/** True when a buffer carries EXIF/XMP/IPTC/ICC metadata (used by tests and the scan script). */
async function hasMetadata(buffer) {
  const meta = await sharp(buffer).metadata();
  return !!(meta.exif || meta.xmp || meta.iptc);
}

/** The file name the object is stored under: original base name, sanitised extension. */
function outputName(originalname, extension) {
  const base = String(originalname || "image").replace(/\.[a-z0-9]+$/i, "");
  return `${base}.${extension}`;
}

module.exports = { sanitizeImage, hasMetadata, outputName, ImageRejected };

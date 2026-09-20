// Public images (listing photos, profile pictures) are re-encoded before they
// reach the bucket (contact lock-down):
//  - every byte of metadata is dropped — EXIF GPS in a photo taken at the
//    villa would give away the exact location the API now hides; device,
//    date and author tags go with it. The EXIF orientation is baked into the
//    pixels first so the picture still shows the right way up;
//  - a QR code anywhere in the picture (a phone number / UPI / link in
//    disguise) is refused;
//  - the file must decode as an image: a renamed non-image is refused;
//  - the decoded raster is bounded (a "decompression bomb" — a tiny PNG that
//    decodes to gigabytes — is refused before it is decoded).
// Visible text inside a picture is NOT read (no OCR — see the closure report);
// the admin's listing approval remains the manual control for that.
//
// Image pipeline: from the sanitised master, makeVariants() renders the fixed
// set of WebP display sizes the site serves straight from the CDN
// (services/storage.js VARIANT_WIDTHS). Variants are made from the master
// only — the same clean pixels, no metadata, never upscaled — so every public
// byte of a photo descends from one sanitised source.
const sharp = require("sharp");
const jsQR = require("jsqr");
const { VARIANT_WIDTHS } = require("./storage");

const MAX_DIMENSION = 6000; // pixels; larger images are scaled down
const QR_SCAN_MAX = 1200; // pixels; the QR scan runs on a downscaled copy
// Decoded-raster ceiling. A 5 MB JPEG is at most ~24 megapixels; 40 MP leaves
// headroom for every phone camera while a crafted 20000×20000 PNG (a few
// hundred KB on disk, 1.6 GB decoded) is refused before libvips allocates.
const MAX_INPUT_PIXELS = 40_000_000;

// WebP display variants. Measured against the master (SSIM / PSNR, 40
// production photos, docs/image-pipeline.md): the optimizer this replaces
// served q70–75 (mean PSNR 39 dB, low-light photos 35 dB); q85 gives +3 dB
// at 1.5× the bytes, q90 +5 dB at 2×. Sizes from 1920 px up are only ever
// viewed downscaled on high-DPR screens, where q82 (+2 dB) is
// indistinguishable and the bytes matter most. Effort 3 encodes at the same
// quality as libwebp's default 4 for ~25% less CPU; "smart" chroma
// subsampling costs +60% CPU for no luma gain and is not used.
function variantQuality(width) {
  return width >= 1920 ? 82 : 85;
}
const VARIANT_EFFORT = 3;
function variantWebp(width) {
  return { quality: variantQuality(width), effort: VARIANT_EFFORT };
}

// Serverless settings: no cross-request pixel cache (every upload is unique
// and the cache only raises resident memory) and bounded libvips threads.
sharp.cache(false);
sharp.concurrency(Math.max(1, Math.min(2, sharp.concurrency())));

class ImageRejected extends Error {
  constructor(code, message, status = 422) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

function open(buffer, limitInputPixels = MAX_INPUT_PIXELS) {
  return sharp(buffer, { failOn: "error", limitInputPixels });
}

function rejectFor(err) {
  if (/pixel limit/i.test(String(err && err.message))) return new ImageRejected("IMAGE_TOO_LARGE", "The image has too many pixels", 413);
  return new ImageRejected("INVALID_IMAGE", "The file is not a valid image", 400);
}

/**
 * @param {Buffer} buffer the uploaded bytes
 * @param {string} mimetype as declared by the client (only a hint)
 * @returns {Promise<{ buffer: Buffer, mimetype: string, extension: string, width: number, height: number }>}
 */
async function sanitizeImage(buffer, mimetype) {
  let meta;
  try {
    meta = await open(buffer).metadata();
  } catch (err) {
    throw rejectFor(err);
  }
  if (!meta.width || !meta.height) throw new ImageRejected("INVALID_IMAGE", "The file is not a valid image", 400);
  if (meta.width * meta.height > MAX_INPUT_PIXELS) throw new ImageRejected("IMAGE_TOO_LARGE", "The image has too many pixels", 413);

  let data;
  let info;
  try {
    // QR detection on a bounded raster (the decode also proves the image is real)
    const scan = open(buffer).rotate().resize({ width: QR_SCAN_MAX, height: QR_SCAN_MAX, fit: "inside", withoutEnlargement: true }).ensureAlpha().raw();
    ({ data, info } = await scan.toBuffer({ resolveWithObject: true }));
  } catch (err) {
    throw rejectFor(err);
  }
  const qr = jsQR(new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength), info.width, info.height, { inversionAttempts: "attemptBoth" });
  if (qr) throw new ImageRejected("IMAGE_NOT_ALLOWED", "Images with QR codes aren't allowed");

  // Re-encode without metadata (sharp strips it unless withMetadata() is called)
  const format = meta.format === "png" ? "png" : meta.format === "webp" ? "webp" : "jpeg";
  let pipeline = open(buffer).rotate();
  if (meta.width > MAX_DIMENSION || meta.height > MAX_DIMENSION) pipeline = pipeline.resize({ width: MAX_DIMENSION, height: MAX_DIMENSION, fit: "inside" });
  if (format === "png") pipeline = pipeline.png({ compressionLevel: 8 });
  else if (format === "webp") pipeline = pipeline.webp({ quality: 85 });
  else pipeline = pipeline.jpeg({ quality: 85, mozjpeg: true });
  let out;
  let outInfo;
  try {
    ({ data: out, info: outInfo } = await pipeline.toBuffer({ resolveWithObject: true }));
  } catch (err) {
    throw rejectFor(err);
  }
  return {
    buffer: out,
    mimetype: `image/${format}`,
    extension: format === "jpeg" ? "jpg" : format,
    width: outInfo.width,
    height: outInfo.height,
  };
}

/**
 * Display variants of a sanitised master: one WebP per configured width,
 * rendered sequentially (bounded memory), never wider than the master
 * (`withoutEnlargement`), aspect ratio and transparency preserved, no
 * metadata. Widths the master cannot fill reuse the previous render (same
 * pixels, no second encode) so every variant key exists for every image.
 * @param {Buffer} master the sanitised master bytes
 * @param {{ widths?: number[], onVariant?: (v: object) => Promise<void>, limitInputPixels?: number }} [opts]
 *   onVariant is awaited per variant as soon as it is rendered (upload while
 *   the next one encodes); a throw from it is recorded, not fatal.
 *   limitInputPixels: the upload guard by default; the owner-run backfill
 *   raises it for legacy masters that predate the guard.
 * @returns {Promise<{ variants: Array<{ width: number, buffer: Buffer, actualWidth: number, height: number }>, errors: Array<{ width: number, error: string }> }>}
 */
async function makeVariants(master, { widths = VARIANT_WIDTHS, onVariant, limitInputPixels = MAX_INPUT_PIXELS } = {}) {
  const meta = await open(master, limitInputPixels).metadata();
  const variants = [];
  const errors = [];
  let previous = null;
  for (const width of [...widths].sort((a, b) => a - b)) {
    let v;
    try {
      if (previous && previous.actualWidth < previous.width) {
        // the master was already narrower than the previous width: same pixels
        v = { width, buffer: previous.buffer, actualWidth: previous.actualWidth, height: previous.height, reused: true };
      } else {
        const { data, info } = await open(master, limitInputPixels)
          .rotate()
          .resize({ width, withoutEnlargement: true, kernel: "lanczos3", fastShrinkOnLoad: true })
          .webp(variantWebp(width))
          .toBuffer({ resolveWithObject: true });
        v = { width, buffer: data, actualWidth: info.width, height: info.height, reused: false };
      }
    } catch (err) {
      errors.push({ width, error: String((err && err.message) || err) });
      continue;
    }
    previous = v;
    variants.push(v);
    if (onVariant) {
      try {
        await onVariant(v);
      } catch (err) {
        errors.push({ width, error: String((err && err.message) || err) });
      }
    }
  }
  return { variants, errors, master: { width: meta.width, height: meta.height, format: meta.format } };
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

module.exports = { sanitizeImage, makeVariants, hasMetadata, outputName, ImageRejected, MAX_INPUT_PIXELS, variantQuality, variantWebp, VARIANT_EFFORT };

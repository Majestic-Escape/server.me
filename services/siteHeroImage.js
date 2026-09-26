// Homepage hero images (docs/site-hero.md): identification, the crop to the
// slot's box, ONE prepared raster, and every output encoded from it.
//
// Quality (measured, docs/site-hero.md): AVIF effort 4 is the primary
// format — q60 from 1920 px up, higher on the smaller widths (AVIF_QUALITY),
// so every delivered width meets the plan's bars and beats today's static
// hero — with WebP (the listing quality policy + smart chroma, which keeps
// the banner's lettering clean) for browsers without AVIF, and a JPEG q95
// 4:4:4 master kept as the long-term source and the fallback of last resort.
// All of them come from one decoded, upright, cropped, flattened sRGB
// raster: a single lossy generation (listing variants are encoded from a
// re-encoded master — two).
//
// Refusals mirror the listing sanitiser (bounded decode, no metadata in any
// output, QR codes refused with the very same detector) plus an allow-list
// of decoded formats: sharp also decodes SVG, TIFF, PDF, JPEG 2000… which
// have no place in a banner.
const sharp = require("sharp");
const { ImageRejected, detectQr, variantWebp } = require("./imageSanitizer");
const storage = require("./storage");

// The two boxes the site renders (user.website hero-section): desktop from
// 768 px up, mobile below. `cap` bounds the master (the long-term source);
// `renditionCap` bounds what browsers are offered. Desktop renditions stop
// at 2560 px — the widest file the static hero ever had — so a 2× laptop
// (1440 px → 2880 needed) gets the same 2560 px it gets today and the byte
// budget (≤ today + 20%) holds; a wider rendition cost +33% for the pixels
// that 2560 → 2880 upscaling adds back.
const SLOTS = Object.freeze({
  desktop: Object.freeze({ ratio: 1920 / 740, box: [1920, 740], min: [1920, 740], cap: 3840, renditionCap: 2560, renditionMin: 768, recommended: [2880, 1110] }),
  mobile: Object.freeze({ ratio: 530 / 720, box: [530, 720], min: [530, 720], cap: 1600, renditionCap: 1600, renditionMin: 0, recommended: [1060, 1440] }),
});
const SLOT_NAMES = Object.freeze(["desktop", "mobile"]);
const MAX_INPUT_PIXELS = 25_000_000; // a 6000×4166 export; the heavier listing guard is 40 MP
const RATIO_TOLERANCE = 0.01; // within 1% of the box: used whole (object-cover trims the rest)
const RATIO_CONFIRM = 0.35; // beyond 35%: only with the admin's explicit "use anyway"
const RENDITION_STEPS = Object.freeze([640, 960, 1280, 1600, 1920, 2560, 3840]);
const AVIF = Object.freeze({ quality: 60, effort: 4 });
// Smaller renditions carry more detail per pixel: q60 — measured best from
// 1920 px up — misses the plan's bars below it (SSIM-Y p1 ≥ 0.94, chroma
// ≥ 43 dB; mobile SSIM-Y ≥ 0.988; WebP SSIM-Y ≥ 0.985). Measured on both
// designer artworks (tests/pw-final/evidence/audit/quality-tune.json): the
// lowest quality that meets them at each width. w1280 at q64 costs +9% bytes
// over q60 (the one width where the bars and "≤ today + 20%" at that
// viewport can't both hold — see the audit report).
const AVIF_QUALITY = Object.freeze({ desktop: Object.freeze({ 960: 76, 1280: 64, 1600: 64 }), mobile: Object.freeze({ 640: 72 }) });
const WEBP_BOOST = Object.freeze({ desktop: Object.freeze({ 960: 4 }), mobile: Object.freeze({}) });
function avifFor(width, slot) {
  return { ...AVIF, quality: AVIF_QUALITY[slot][width] || AVIF.quality };
}
function webpFor(width, slot) {
  const base = variantWebp(width);
  return { ...base, quality: Math.min(100, base.quality + (WEBP_BOOST[slot][width] || 0)), smartSubsample: true };
}
// q95 4:4:4: SSIM ≥ 0.995 against the raster on both real banners (q92 gave
// 0.9933 on the detailed mobile art). Never sent to modern browsers — it is
// the long-term source for future renditions and the last-resort fallback.
const MASTER_JPEG = Object.freeze({ quality: 95, mozjpeg: true, chromaSubsampling: "4:4:4" });
const LQIP_WIDTH = 24;
const LQIP_MAX_CHARS = 600;
const RENDITION_TYPES = Object.freeze({ avif: "image/avif", webp: "image/webp" });

const HEIC_BRANDS = new Set(["heic", "heix", "hevc", "hevx", "heim", "heis", "hevm", "hevs"]);
const AVIF_BRANDS = new Set(["avif", "avis"]);

function isSlot(s) {
  return s === "desktop" || s === "mobile";
}

// Actual pixel widths of the renditions of a master `masterWidth` px wide:
// the standard steps below the (rendition-capped) master width, plus that
// width itself. Never empty (a 530 px master → [530]), never wider than the
// master.
function heroRenditionWidths(masterWidth, slot) {
  const top = Math.min(Math.floor(Number(masterWidth) || 0), SLOTS[slot].renditionCap);
  if (top < 1) return [];
  // nothing narrower than the slot is ever shown at (desktop art: from 768 px)
  const widths = RENDITION_STEPS.filter((w) => w < top && w >= SLOTS[slot].renditionMin);
  widths.push(top);
  return widths;
}
// The storage key width a rendition lives under: the smallest standard
// variant width that is at least as wide (a 1060 px rendition → w1280).
// Unique per rendition by construction: every step below the top maps to
// itself, the top to a key above all of them.
function renditionKeyWidth(width) {
  return storage.variantWidthFor(width);
}
function renditionKey(masterKey, width, format) {
  return `${masterKey}/${storage.VARIANT_SET}/w${renditionKeyWidth(width)}.${format}`;
}

// How far a width×height image is from the slot's box ratio, symmetric:
// 0 = exact, 0.35 = 1.35× too wide or too tall.
function ratioDeviation(width, height, slot) {
  const r = width / height;
  const R = SLOTS[slot].ratio;
  return Math.max(r / R, R / r) - 1;
}

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

// The region of an upright width×height image that fills the slot's box,
// centred on the focal point (0–1 each way, clamped inside the image).
// Integer, always inside the image. Shared with the admin through
// tests/batch-s/fixtures/hero-crop-vectors.json.
function cropRegion(width, height, slot, focal = { x: 0.5, y: 0.5 }) {
  const R = SLOTS[slot].ratio;
  const deviation = ratioDeviation(width, height, slot);
  const fx = Number.isFinite(focal && focal.x) ? clamp(focal.x, 0, 1) : 0.5;
  const fy = Number.isFinite(focal && focal.y) ? clamp(focal.y, 0, 1) : 0.5;
  if (deviation <= RATIO_TOLERANCE) return { left: 0, top: 0, width, height, cropped: false, deviation };
  if (width / height > R) {
    const w = clamp(Math.round(height * R), 1, width);
    const left = clamp(Math.round(fx * width - w / 2), 0, width - w);
    return { left, top: 0, width: w, height, cropped: true, deviation };
  }
  const h = clamp(Math.round(width / R), 1, height);
  const top = clamp(Math.round(fy * height - h / 2), 0, height - h);
  return { left: 0, top, width, height: h, cropped: true, deviation };
}

// Width × height of the master a region becomes (capped, ratio kept).
function outputSize(region, slot) {
  const width = Math.min(region.width, SLOTS[slot].cap);
  const height = Math.max(1, Math.round((width * region.height) / region.width));
  return { width, height };
}

// A region narrower than the box would be upscaled on the screens that show
// it at 1×: refused. The width is exact (the box fills the screen's width);
// the height keeps the 1% slack of the uncropped ratio tolerance (a 1920×735
// image is used whole — object-cover trims the rest).
function tooSmall(region, slot) {
  const [mw, mh] = SLOTS[slot].min;
  return region.width < mw || region.height < Math.floor(mh * (1 - RATIO_TOLERANCE));
}

function heicError() {
  return new ImageRejected("HEIC_NOT_SUPPORTED", "iPhone HEIC photos can't be used — export the banner as JPEG and upload that", 415);
}
function unsupportedError() {
  return new ImageRejected("UNSUPPORTED_FORMAT", "Use a JPEG, PNG, WebP or AVIF image", 415);
}
function pixelsError() {
  return new ImageRejected("IMAGE_TOO_LARGE", "The image has too many pixels (at most 25 megapixels)", 413);
}

// ISO-BMFF brands (HEIF / AVIF containers): the major brand and the
// compatible brands of the ftyp box, bounded to its first 64 bytes.
function ftypBrands(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 16 || buffer.toString("latin1", 4, 8) !== "ftyp") return null;
  const size = buffer.readUInt32BE(0);
  const end = Math.min(Math.max(size, 16), 64, buffer.length);
  const brands = [buffer.toString("latin1", 8, 12)];
  for (let i = 16; i + 4 <= end; i += 4) brands.push(buffer.toString("latin1", i, i + 4));
  return brands;
}

function open(buffer, extra = {}) {
  return sharp(buffer, { failOn: "error", limitInputPixels: MAX_INPUT_PIXELS, ...extra });
}

/**
 * What the upload is, from its header only (nothing is decoded).
 * @returns {Promise<{ format: string, width: number, height: number, animated: boolean }>} width/height upright
 */
async function identify(buffer) {
  // The brand check comes first: a HEIC the build cannot read may make
  // metadata() throw, and the admin should still hear "export as JPEG".
  const brands = ftypBrands(buffer);
  if (brands && brands.some((b) => HEIC_BRANDS.has(b)) && !brands.some((b) => AVIF_BRANDS.has(b))) throw heicError();
  let meta;
  try {
    meta = await open(buffer).metadata();
  } catch (err) {
    if (/pixel limit/i.test(String(err && err.message))) throw pixelsError();
    throw unsupportedError();
  }
  if (meta.format === "heif" && meta.compression !== "av1") throw heicError();
  const allowed = ["jpeg", "png", "webp", "gif"].includes(meta.format) || (meta.format === "heif" && meta.compression === "av1");
  if (!allowed) throw unsupportedError();
  if (!meta.width || !meta.height) throw new ImageRejected("INVALID_IMAGE", "The file is not a valid image", 400);
  if (meta.width * meta.height > MAX_INPUT_PIXELS) throw pixelsError();
  const upright = meta.autoOrient && meta.autoOrient.width ? meta.autoOrient : { width: meta.width, height: meta.height };
  return { format: meta.format, width: upright.width, height: upright.height, animated: (meta.pages || 1) > 1 };
}

function secondsLeft(deadline) {
  return Math.max(1, Math.ceil((deadline - Date.now()) / 1000));
}
function checkAbort(signal) {
  if (signal && signal.aborted) throw Object.assign(new Error("hero processing timed out"), { name: "AbortError", code: "HERO_TIMEOUT" });
}
// sharp failures while encoding: its own timeout, the pixel limit, or a
// corrupt stream the header did not reveal.
function encodeError(err) {
  const msg = String(err && err.message);
  if (/timeout/i.test(msg)) return Object.assign(new Error("hero processing timed out"), { name: "AbortError", code: "HERO_TIMEOUT" });
  if (/pixel limit/i.test(msg)) return pixelsError();
  return new ImageRejected("INVALID_IMAGE", "The file is not a valid image", 400);
}

/**
 * The one raster every output is encoded from: first frame, EXIF
 * orientation applied at input (so the crop is in upright coordinates),
 * cropped to the slot's ratio, capped, alpha flattened on white, sRGB
 * (an embedded profile is honoured), 8-bit, 3 channels.
 */
async function prepareRaster(buffer, region, slot, { deadline, signal } = {}) {
  checkAbort(signal);
  const out = outputSize(region, slot);
  let img = open(buffer, { autoOrient: true, pages: 1 });
  if (region.cropped) img = img.extract({ left: region.left, top: region.top, width: region.width, height: region.height });
  if (out.width !== region.width) img = img.resize({ width: out.width, height: out.height, fit: "fill", kernel: "lanczos3", fastShrinkOnLoad: false });
  try {
    const { data, info } = await img
      .flatten({ background: "#ffffff" })
      .toColourspace("srgb")
      .raw({ depth: "uchar" })
      .timeout({ seconds: secondsLeft(deadline || Date.now() + 120000) })
      .toBuffer({ resolveWithObject: true });
    if (info.channels !== 3) throw new Error(`unexpected channel count ${info.channels}`);
    return { data, width: info.width, height: info.height };
  } catch (err) {
    throw encodeError(err);
  }
}

function fromRaster(raster) {
  return sharp(raster.data, { raw: { width: raster.width, height: raster.height, channels: 3 } });
}

async function hasQrCode(raster) {
  return detectQr(fromRaster(raster), { requirePayload: true });
}

/**
 * Encodes the master, the placeholder and every rendition from the raster,
 * handing each to `onOutput` as soon as it exists (uploads overlap encodes).
 * AVIF and WebP for every rendition width; nothing wider than the raster.
 */
async function renderOutputs(raster, slot, onOutput, { deadline, signal } = {}) {
  const limit = () => ({ seconds: secondsLeft(deadline || Date.now() + 120000) });
  const encode = async (pipeline) => {
    checkAbort(signal);
    try {
      return await pipeline.timeout(limit()).toBuffer();
    } catch (err) {
      throw encodeError(err);
    }
  };
  const master = await encode(fromRaster(raster).jpeg(MASTER_JPEG));
  await onOutput({ kind: "master", format: "jpeg", width: raster.width, buffer: master });
  const lqipBuf = await encode(fromRaster(raster).resize({ width: LQIP_WIDTH }).webp({ quality: 40 }));
  const lqip = `data:image/webp;base64,${lqipBuf.toString("base64")}`;
  const widths = heroRenditionWidths(raster.width, slot);
  for (const width of widths) {
    for (const format of ["avif", "webp"]) {
      let p = fromRaster(raster);
      if (width < raster.width) p = p.resize({ width, kernel: "lanczos3" });
      p = format === "avif" ? p.avif(avifFor(width, slot)) : p.webp(webpFor(width, slot));
      const buffer = await encode(p);
      await onOutput({ kind: "rendition", format, width, keyWidth: renditionKeyWidth(width), buffer });
    }
  }
  return { lqip: lqip.length <= LQIP_MAX_CHARS ? lqip : "", widths };
}

module.exports = {
  SLOTS,
  SLOT_NAMES,
  MAX_INPUT_PIXELS,
  RATIO_TOLERANCE,
  RATIO_CONFIRM,
  RENDITION_STEPS,
  RENDITION_TYPES,
  AVIF,
  AVIF_QUALITY,
  avifFor,
  webpFor,
  MASTER_JPEG,
  isSlot,
  heroRenditionWidths,
  renditionKeyWidth,
  renditionKey,
  ratioDeviation,
  cropRegion,
  outputSize,
  tooSmall,
  ftypBrands,
  identify,
  prepareRaster,
  hasQrCode,
  renderOutputs,
};

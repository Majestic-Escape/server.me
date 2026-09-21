#!/usr/bin/env node
// Contact lock-down — legacy public images (release gate).
//
// New uploads are re-encoded without metadata (services/imageSanitizer.js).
// This script covers the images already in the bucket: every listing photo
// and profile picture referenced in the database is fetched from its public
// URL, inspected for EXIF / XMP / IPTC (GPS in particular) and, with --apply,
// re-encoded in place under the same key (same URL) with metadata stripped
// and the EXIF orientation baked in. QR codes are reported, not removed.
//
// Dry run (default) prints counts and the ids of listings/users whose images
// carry metadata — never the coordinates themselves. After --apply, purge the
// CDN cache for the bucket (DigitalOcean → Spaces → Settings → Purge cache)
// or wait for the edge TTL; the script re-fetches each rewritten URL and
// reports whether the CDN still serves the old bytes.
//
//   node scripts/strip-image-metadata.js --uri="<DB_URI>" [--apply] [--limit=N]
//   env: DO_SPACES_KEY / DO_SPACES_SECRET / DO_SPACES_ENDPOINT / DO_SPACES_BUCKET / REGION (only for --apply)
require("dotenv").config();
const mongoose = require("mongoose");
const sharp = require("sharp");
const jsQR = require("jsqr");
const storage = require("../services/storage");
const { sanitizeImage, stripJpegMetadataLossless } = require("../services/imageSanitizer");

const args = process.argv.slice(2);
const opt = (name) => {
  const a = args.find((x) => x.startsWith(`--${name}=`));
  return a ? a.slice(name.length + 3) : undefined;
};
const APPLY = args.includes("--apply");
const LIMIT = Number(opt("limit") || 0);

async function fetchBytes(url) {
  const res = await fetch(url, { headers: { "cache-control": "no-cache" } });
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return Buffer.from(await res.arrayBuffer());
}

// A public 403 from Spaces means "missing" or "not public-read"; with
// credentials a signed HEAD tells the two apart (read-only).
async function headClass(key) {
  if (!process.env.DO_SPACES_KEY || !process.env.DO_SPACES_SECRET) return "unverified (no Spaces credentials for a signed HEAD)";
  try {
    const s3 = require("../config/digitalOcean.config");
    const h = await s3.headObject({ Bucket: process.env.DO_SPACES_BUCKET, Key: key }).promise();
    return `exists but not public (${h.ContentLength} bytes) — make public-read after sanitising, or remove the reference`;
  } catch (e) {
    if (e.statusCode === 404 || e.code === "NotFound" || e.code === "NoSuchKey") return "missing — dangling reference (no object, nothing exposed; cleanup candidate)";
    return `HEAD failed (${e.code || e.statusCode})`;
  }
}

// What a QR code encodes — its kind only, never the payload.
function qrKind(data) {
  const d = String(data || "");
  if (!d.length) return "empty payload";
  if (/^https?:\/\//i.test(d)) {
    let host = "";
    try { host = new URL(d).hostname; } catch {}
    return /wa\.me|whatsapp|t\.me|instagram|facebook/i.test(host) ? `social link (${host})` : `external link (${host})`;
  }
  if (/^upi:\/\//i.test(d) || /@(ybl|oksbi|okaxis|okhdfcbank|okicici|paytm|upi|apl|ibl|axl)/i.test(d)) return "UPI / payment";
  if (/^tel:|^\+?\d[\d\s-]{8,}$/i.test(d)) return "phone";
  if (/^mailto:|@[a-z0-9.-]+\.[a-z]{2,}/i.test(d)) return "e-mail";
  return `text (${d.length} chars)`;
}

async function inspect(buffer) {
  const meta = await sharp(buffer).metadata();
  const hasGps = !!(meta.exif && meta.exif.includes(Buffer.from("GPS")));
  const hasMeta = !!(meta.exif || meta.xmp || meta.iptc);
  let qr = false;
  let qrPayload = "";
  try {
    const { data, info } = await sharp(buffer).rotate().resize({ width: 1200, height: 1200, fit: "inside", withoutEnlargement: true }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const code = jsQR(new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength), info.width, info.height);
    qr = !!code;
    if (code) qrPayload = qrKind(code.data);
  } catch {
    /* undecodable raster: reported as invalid below */
  }
  return { hasMeta, hasGps, qr, qrPayload, format: meta.format, orientation: meta.orientation || 1 };
}

async function main() {
  const uri = opt("uri") || process.env.DB_URI;
  if (!uri) throw new Error("--uri or DB_URI required");
  await mongoose.connect(uri);
  const ListingProperty = require("../models/ListingProperty");
  const User = require("../models/User");
  const refs = [];
  for (const l of await ListingProperty.find({ photos: { $exists: true, $ne: [] } }).select("photos status").lean()) for (const url of l.photos || []) refs.push({ owner: `listing ${l._id} (${l.status})`, url });
  for (const u of await User.find({ profilePicture: { $exists: true, $ne: null } }).select("profilePicture").lean()) if (u.profilePicture) refs.push({ owner: `user ${u._id}`, url: u.profilePicture });
  const unique = [...new Map(refs.map((r) => [r.url, r])).values()].filter((r) => storage.keyFromUrl(r.url));
  console.log(`[images] ${refs.length} references, ${unique.length} unique objects in our bucket${LIMIT ? `, scanning ${LIMIT}` : ""}`);
  const stats = { scanned: 0, withMetadata: 0, withGps: 0, qr: 0, invalid: 0, rewritten: 0, cdnStale: 0 };
  const flagged = [];
  const invalid = [];
  for (const ref of LIMIT ? unique.slice(0, LIMIT) : unique) {
    let bytes;
    try {
      bytes = await fetchBytes(ref.url);
    } catch (err) {
      stats.invalid += 1;
      const key = storage.keyFromUrl(ref.url);
      const status = err.status;
      const cls = status === 404 || status === 410 ? "missing — dangling reference (404)" : status === 403 ? await headClass(key) : `unreachable (${status || err.message}) — transient? re-run`;
      invalid.push({ owner: ref.owner, key, cls });
      continue;
    }
    stats.scanned += 1;
    let info;
    try {
      info = await inspect(bytes);
    } catch {
      stats.invalid += 1;
      invalid.push({ owner: ref.owner, key: storage.keyFromUrl(ref.url), cls: "public but not a decodable image — inspect by hand" });
      continue;
    }
    if (info.hasMeta) stats.withMetadata += 1;
    if (info.hasGps) stats.withGps += 1;
    if (info.qr) stats.qr += 1;
    if (info.hasMeta || info.qr) flagged.push({ owner: ref.owner, key: storage.keyFromUrl(ref.url), gps: info.hasGps, qr: info.qr, qrPayload: info.qrPayload });
    if (APPLY && info.hasMeta) {
      const key = storage.keyFromUrl(ref.url);
      // An upright JPEG is cleaned losslessly (metadata segments dropped,
      // pixels byte-identical); anything else goes through the sanitiser.
      const lossless = info.format === "jpeg" ? stripJpegMetadataLossless(bytes, info.orientation) : null;
      let clean = null;
      if (lossless && !(await inspect(lossless)).hasMeta) clean = { buffer: lossless, mimetype: "image/jpeg", lossless: true };
      else clean = await sanitizeImage(bytes, `image/${info.format}`).catch(() => null);
      if (!clean) {
        stats.invalid += 1;
        continue;
      }
      await storage.putObject(key, clean.buffer, clean.mimetype);
      stats.rewritten += 1;
      if (clean.lossless) stats.lossless = (stats.lossless || 0) + 1;
      const after = await fetchBytes(ref.url).catch(() => null);
      if (after && (await inspect(after)).hasMeta) stats.cdnStale += 1;
    }
  }
  console.log(`[images] scanned ${stats.scanned}, with metadata ${stats.withMetadata}, with GPS ${stats.withGps}, with QR ${stats.qr}, invalid/unreachable ${stats.invalid}`);
  if (APPLY) console.log(`[images] rewritten ${stats.rewritten} (${stats.lossless || 0} losslessly — pixels untouched); CDN still serving old bytes for ${stats.cdnStale} (purge the CDN cache)`);
  for (const f of flagged) console.log(`  · ${f.owner} ${f.key}${f.gps ? " GPS" : ""}${f.qr ? ` QR (${f.qrPayload})` : ""}`);
  if (invalid.length) {
    const byClass = {};
    for (const i of invalid) byClass[i.cls] = (byClass[i.cls] || 0) + 1;
    console.log(`[images] invalid/unreachable by class: ${Object.entries(byClass).map(([k, n]) => `${n} × ${k}`).join("; ")}`);
    for (const i of invalid) console.log(`  · ${i.owner} ${i.key} → ${i.cls}`);
  }
  if (!APPLY && stats.withMetadata) console.log("[images] release gate: re-run with --apply (Spaces credentials in the environment) before promoting to production, then purge the CDN cache");
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});

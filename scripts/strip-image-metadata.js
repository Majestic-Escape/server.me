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
const { sanitizeImage } = require("../services/imageSanitizer");

const args = process.argv.slice(2);
const opt = (name) => {
  const a = args.find((x) => x.startsWith(`--${name}=`));
  return a ? a.slice(name.length + 3) : undefined;
};
const APPLY = args.includes("--apply");
const LIMIT = Number(opt("limit") || 0);

async function fetchBytes(url) {
  const res = await fetch(url, { headers: { "cache-control": "no-cache" } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

async function inspect(buffer) {
  const meta = await sharp(buffer).metadata();
  const hasGps = !!(meta.exif && meta.exif.includes(Buffer.from("GPS")));
  const hasMeta = !!(meta.exif || meta.xmp || meta.iptc);
  let qr = false;
  try {
    const { data, info } = await sharp(buffer).rotate().resize({ width: 1200, height: 1200, fit: "inside", withoutEnlargement: true }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    qr = !!jsQR(new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength), info.width, info.height);
  } catch {
    /* undecodable raster: reported as invalid below */
  }
  return { hasMeta, hasGps, qr, format: meta.format };
}

async function main() {
  const uri = opt("uri") || process.env.DB_URI;
  if (!uri) throw new Error("--uri or DB_URI required");
  await mongoose.connect(uri);
  const ListingProperty = require("../models/ListingProperty");
  const User = require("../models/User");
  const refs = [];
  for (const l of await ListingProperty.find({ photos: { $exists: true, $ne: [] } }).select("photos").lean()) for (const url of l.photos || []) refs.push({ owner: `listing ${l._id}`, url });
  for (const u of await User.find({ profilePicture: { $exists: true, $ne: null } }).select("profilePicture").lean()) if (u.profilePicture) refs.push({ owner: `user ${u._id}`, url: u.profilePicture });
  const unique = [...new Map(refs.map((r) => [r.url, r])).values()].filter((r) => storage.keyFromUrl(r.url));
  console.log(`[images] ${refs.length} references, ${unique.length} unique objects in our bucket${LIMIT ? `, scanning ${LIMIT}` : ""}`);
  const stats = { scanned: 0, withMetadata: 0, withGps: 0, qr: 0, invalid: 0, rewritten: 0, cdnStale: 0 };
  const flagged = [];
  for (const ref of LIMIT ? unique.slice(0, LIMIT) : unique) {
    let bytes;
    try {
      bytes = await fetchBytes(ref.url);
    } catch (err) {
      stats.invalid += 1;
      continue;
    }
    stats.scanned += 1;
    let info;
    try {
      info = await inspect(bytes);
    } catch {
      stats.invalid += 1;
      continue;
    }
    if (info.hasMeta) stats.withMetadata += 1;
    if (info.hasGps) stats.withGps += 1;
    if (info.qr) stats.qr += 1;
    if (info.hasMeta || info.qr) flagged.push({ owner: ref.owner, key: storage.keyFromUrl(ref.url), gps: info.hasGps, qr: info.qr });
    if (APPLY && info.hasMeta) {
      const key = storage.keyFromUrl(ref.url);
      const clean = await sanitizeImage(bytes, `image/${info.format}`).catch(() => null);
      if (!clean) {
        stats.invalid += 1;
        continue;
      }
      await storage.putObject(key, clean.buffer, clean.mimetype);
      stats.rewritten += 1;
      const after = await fetchBytes(ref.url).catch(() => null);
      if (after && (await inspect(after)).hasMeta) stats.cdnStale += 1;
    }
  }
  console.log(`[images] scanned ${stats.scanned}, with metadata ${stats.withMetadata}, with GPS ${stats.withGps}, with QR ${stats.qr}, invalid/unreachable ${stats.invalid}`);
  if (APPLY) console.log(`[images] rewritten ${stats.rewritten}; CDN still serving old bytes for ${stats.cdnStale} (purge the CDN cache)`);
  for (const f of flagged) console.log(`  · ${f.owner} ${f.key}${f.gps ? " GPS" : ""}${f.qr ? " QR" : ""}`);
  if (!APPLY && stats.withMetadata) console.log("[images] release gate: re-run with --apply (Spaces credentials in the environment) before promoting to production, then purge the CDN cache");
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});

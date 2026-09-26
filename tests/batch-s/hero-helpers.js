// Shared helpers for the homepage-hero suites (site-hero*.test.js): photo-like
// fixtures, SSIM, and thin wrappers over the admin API.
const sharp = require("sharp");
const h = require("./setup");

// A photo-like banner: a gradient sky, soft shapes, big lettering (the
// banners carry text) and, when asked (grain > 0), sensor-like grain — compressible like real art, with
// edges that show chroma and ringing problems. Deterministic per `hue`.
async function photo(width, height, { format = "jpeg", hue = 30, text = "RANN UTSAV", alpha = false, quality = 92, grain = 0 } = {}) {
  const fs = Math.round(Math.min(width / 6, height / 3));
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
    <defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="hsl(${hue},55%,28%)"/><stop offset="0.6" stop-color="hsl(${hue + 40},60%,70%)"/><stop offset="1" stop-color="hsl(${hue + 80},20%,92%)"/>
    </linearGradient></defs>
    <rect width="100%" height="100%" fill="url(#g)"/>
    <circle cx="${Math.round(width * 0.22)}" cy="${Math.round(height * 0.62)}" r="${Math.round(Math.min(width, height) * 0.22)}" fill="hsl(${hue + 180},70%,40%)"/>
    <rect x="${Math.round(width * 0.55)}" y="${Math.round(height * 0.55)}" width="${Math.round(width * 0.3)}" height="${Math.round(height * 0.3)}" fill="hsl(${hue + 120},65%,45%)"/>
    <text x="50%" y="38%" font-family="Arial, Helvetica, sans-serif" font-weight="900" font-size="${fs}" text-anchor="middle" fill="#f6f1b8">${text}</text>
  </svg>`;
  const base = await sharp(Buffer.from(svg)).resize(width, height).png().toBuffer();
  const noise = await sharp({ create: { width, height, channels: 3, background: { r: 128, g: 128, b: 128 }, noise: { type: "gaussian", mean: 128, sigma: grain } } }).png().toBuffer();
  let img = sharp(base).composite([{ input: noise, blend: "soft-light" }]);
  if (alpha) {
    const mask = await sharp({ create: { width, height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
      .composite([{ input: await sharp({ create: { width: Math.ceil(width / 2), height, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 1 } } }).png().toBuffer(), left: Math.floor(width / 2), top: 0 }])
      .png()
      .toBuffer();
    img = sharp(await img.png().toBuffer()).ensureAlpha().composite([{ input: mask, blend: "dest-in" }]);
  }
  if (format === "png") return img.png().toBuffer();
  if (format === "webp") return img.webp({ quality }).toBuffer();
  if (format === "avif") return img.avif({ quality: 70 }).toBuffer();
  return img.jpeg({ quality }).toBuffer();
}

// Luma SSIM (8×8 windows, stride 4) → { mean, p1 }; chroma PSNR (dB): the
// very functions the server decides with (services/imageQuality.js).
const { planes, ssim, psnr } = require("../../services/imageQuality");
async function rawOf(input, width, height) {
  let p = sharp(input);
  if (width) p = p.resize(width, height, { fit: "fill", kernel: "lanczos3" });
  const { data, info } = await p.removeAlpha().toColourspace("srgb").raw().toBuffer({ resolveWithObject: true });
  return { data, info };
}
// Quality of `encoded` against a lossless reference raster of the same size.
async function quality(encoded, reference) {
  const ref = planes(reference.data, reference.info.channels);
  const { data, info } = await rawOf(encoded, reference.info.width, reference.info.height);
  const got = planes(data, info.channels);
  const s = ssim(ref.Y, got.Y, reference.info.width, reference.info.height);
  return { ssim: s.mean, p1: s.p1, chroma: (psnr(ref.Cb, got.Cb) + psnr(ref.Cr, got.Cr)) / 2 };
}
// Mean absolute difference between two images at a small common size.
async function meanAbsDiff(a, b, width = 64) {
  const ma = await sharp(a).resize({ width }).removeAlpha().toColourspace("srgb").raw().toBuffer({ resolveWithObject: true });
  const mb = await sharp(b).resize(ma.info.width, ma.info.height, { fit: "fill" }).removeAlpha().toColourspace("srgb").raw().toBuffer();
  let sum = 0;
  for (let i = 0; i < ma.data.length; i += 1) sum += Math.abs(ma.data[i] - mb[i]);
  return sum / ma.data.length;
}

// Mean signed difference per channel (R, G, B) at a small common size: a
// colour drift between two renderings of the same picture shows up here.
async function meanSignedDiff(a, b, width = 64) {
  const ma = await sharp(a).resize({ width }).removeAlpha().toColourspace("srgb").raw().toBuffer({ resolveWithObject: true });
  const mb = await sharp(b).resize(ma.info.width, ma.info.height, { fit: "fill" }).removeAlpha().toColourspace("srgb").raw().toBuffer();
  const sums = [0, 0, 0];
  for (let i = 0; i < ma.data.length; i += 3) for (let c = 0; c < 3; c += 1) sums[c] += ma.data[i + c] - mb[i + c];
  return sums.map((s) => s / (ma.data.length / 3));
}

// A PNG whose pixel values ARE Display-P3 numbers, tagged with the P3 profile
// (sharp's withIccProfile would first convert the values — not wanted here).
async function p3Tagged(rgb, width, height) {
  const zlib = require("zlib");
  const icc = (await sharp(await sharp({ create: { width: 2, height: 2, channels: 3, background: "#808080" } }).withIccProfile("p3").png().toBuffer()).metadata()).icc;
  const png = await sharp({ create: { width, height, channels: 3, background: { r: rgb[0], g: rgb[1], b: rgb[2] } } }).png().toBuffer();
  const data = Buffer.concat([Buffer.from("P3\0\0", "latin1"), zlib.deflateSync(icc)]);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from("iCCP", "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(body) >>> 0);
  return Buffer.concat([png.subarray(0, 33), len, body, crc, png.subarray(33)]); // right after IHDR
}
// Display-P3 → sRGB, relative colorimetric (D65, sRGB transfer curve).
function p3ToSrgb(rgb) {
  const lin = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const enc = (c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);
  const toXyz = [[0.4865709, 0.2656677, 0.1982173], [0.2289746, 0.6917385, 0.0792869], [0, 0.0451134, 1.0439444]];
  const toSrgb = [[3.2404542, -1.5371385, -0.4985314], [-0.969266, 1.8760108, 0.041556], [0.0556434, -0.2040259, 1.0572252]];
  const mul = (m, v) => m.map((r) => r[0] * v[0] + r[1] * v[1] + r[2] * v[2]);
  return mul(toSrgb, mul(toXyz, rgb.map((c) => lin(c / 255)))).map((c) => Math.round(255 * enc(Math.min(1, Math.max(0, c)))));
}

// --- API wrappers ----------------------------------------------------------------
async function adminState(token) {
  const r = await h.api("GET", "/site/admin/hero", { token });
  if (r.status !== 200) throw new Error(`admin state ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
}
async function multipart(path, { token, fields = {}, file, fileField = "image", method = "POST" } = {}) {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) if (v !== undefined) form.append(k, String(v));
  if (file) form.append(fileField, new Blob([file.buf], { type: file.type || "image/jpeg" }), file.name || "banner.jpg");
  const res = await fetch(`${h.baseUrl()}${path}`, { method, headers: token ? { authorization: `Bearer ${token}` } : {}, body: form });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = { raw: text };
  }
  return { status: res.status, body, headers: Object.fromEntries(res.headers.entries()) };
}
// Prepare a draft the way the admin UI does: fresh state → token + the draft it expects to replace.
async function stage(token, slot, buf, { type = "image/jpeg", name = "banner.jpg", fields = {}, opToken, expectedDraftOpId } = {}) {
  let st = null;
  if (opToken === undefined || expectedDraftOpId === undefined) st = await adminState(token);
  const expected = expectedDraftOpId !== undefined ? expectedDraftOpId : st.draft[slot] ? st.draft[slot].opId : "";
  return multipart(`/site/admin/hero/${slot}/draft`, {
    token,
    fields: { opToken: opToken !== undefined ? opToken : st.opToken, expectedDraftOpId: expected === null ? undefined : expected, ...fields },
    file: buf ? { buf, type, name } : undefined,
  });
}
async function publish(token, { slots, alt = "Rann Utsav — the white desert of Kutch", opToken, expectedVersion } = {}) {
  const st = await adminState(token);
  const body = {
    opToken: opToken !== undefined ? opToken : st.opToken,
    expectedVersion: expectedVersion !== undefined ? expectedVersion : st.version,
    slots: slots || { desktop: st.draft.desktop && st.draft.desktop.opId, mobile: st.draft.mobile && st.draft.mobile.opId },
    alt,
  };
  return h.api("POST", "/site/admin/hero/publish", { token, body });
}

module.exports = { photo, planes, ssim, psnr, rawOf, quality, meanAbsDiff, meanSignedDiff, p3Tagged, p3ToSrgb, adminState, multipart, stage, publish };

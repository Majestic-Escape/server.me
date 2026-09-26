// Homepage banner — the remaining image-corpus gaps (closure audit I2):
//  - QR detection floor on full-size 3840 px banners (the plan's largest input),
//  - animated AVIF (a real image sequence) and corrupt ICC profiles,
//  - listing and profile uploads byte-identical to origin/dev (vendored baseline,
//    compared live, so the check holds on any platform and libvips build).
process.env.SPACES_MOCK = "1";
const test = require("node:test");
const assert = require("node:assert/strict");
const sharp = require("sharp");
const hh = require("./hero-helpers");
const img = require("../../services/siteHeroImage");
const NOW = require("../../services/imageSanitizer");
const BASE = require("./fixtures/imageSanitizer.origin-dev");

async function throughPipeline(buffer, slot) {
  const info = await img.identify(buffer);
  const raster = await img.prepareRaster(buffer, img.cropRegion(info.width, info.height, slot), slot);
  return { info, raster };
}

test("QR on a 3840 × 1480 banner: large codes are always found (refused); the detection floor is recorded", async () => {
  const QRCode = require("qrcode");
  const floor = [];
  const found = {};
  for (const size of [960, 640, 480, 320, 240, 160]) {
    const qr = await QRCode.toBuffer("https://wa.me/919876543210", { type: "png", width: size, margin: 2 });
    const banner = await sharp(await hh.photo(3840, 1480)).composite([{ input: qr, left: 2600, top: 200 }]).jpeg({ quality: 92 }).toBuffer();
    const { raster } = await throughPipeline(banner, "desktop");
    found[size] = await img.hasQrCode(raster);
    floor.push(`${size}px: ${found[size] ? "found" : "missed"}`);
  }
  console.log(`[site-hero] QR detection on a 3840 px banner (scan at ≤ 1200 px) — ${floor.join(", ")}`);
  // A code a quarter of the banner's height or more is always refused.
  assert.equal(found[960], true, "960 px QR on 3840 art");
  assert.equal(found[640], true, "640 px QR on 3840 art");
  // no false positive on the same art without a code
  const { raster } = await throughPipeline(await sharp(await hh.photo(3840, 1480)).jpeg({ quality: 92 }).toBuffer(), "desktop");
  assert.equal(await img.hasQrCode(raster), false, "clean 3840 art");
});

test("animated AVIF (an image sequence, brand avis) is refused with a specific reason — this sharp build can't decode one", async () => {
  // a real animated AVIF (fixtures/README.md); relabelling a still AVIF's brand does not make a valid sequence
  const avis = require("fs").readFileSync(require("path").join(__dirname, "fixtures", "star-8bpc.avifs"));
  assert.ok(img.ftypBrands(avis).includes("avis"));
  await assert.rejects(img.identify(avis), (err) => err.code === "ANIMATED_AVIF_NOT_SUPPORTED" && err.status === 415 && /still image/.test(err.message));
  // a still AVIF is still accepted
  const still = await sharp(await hh.photo(1920, 740)).avif({ quality: 70 }).toBuffer();
  const info = await img.identify(still);
  assert.equal(info.width, 1920);
});

test("corrupt ICC profiles: refused with a clear 4xx, or prepared with correct colours — never a crash", async () => {
  const jpg = await sharp({ create: { width: 1920, height: 740, channels: 3, background: { r: 200, g: 100, b: 30 } } }).jpeg({ quality: 90 }).toBuffer();
  const variants = {
    garbage: Buffer.alloc(600, 0x41),
    "truncated header": Buffer.concat([Buffer.from([0, 0, 2, 0x30]), Buffer.from("lcmsmntrRGB XYZ "), Buffer.alloc(40, 0)]),
  };
  for (const [label, payload] of Object.entries(variants)) {
    const body = Buffer.concat([Buffer.from("ICC_PROFILE\0", "latin1"), Buffer.from([1, 1]), payload]);
    const len = Buffer.alloc(2);
    len.writeUInt16BE(body.length + 2);
    const bad = Buffer.concat([jpg.subarray(0, 2), Buffer.from([0xff, 0xe2]), len, body, jpg.subarray(2)]);
    try {
      const { raster } = await throughPipeline(bad, "desktop");
      const px = [...raster.data.subarray(0, 3)];
      assert.ok(Math.abs(px[0] - 200) <= 6 && Math.abs(px[1] - 100) <= 6 && Math.abs(px[2] - 30) <= 6, `${label}: colours kept ${px}`);
    } catch (err) {
      assert.ok(err && err.status >= 400 && err.status < 500 && typeof err.code === "string", `${label}: refused cleanly, got ${err && (err.code || err.message)}`);
    }
  }
});

test("listing and profile uploads are byte-identical to origin/dev: master, MIME type and every variant", async () => {
  const base = sharp({ create: { width: 2400, height: 1600, channels: 4, background: { r: 30, g: 120, b: 200, alpha: 0.8 } } }).composite([{ input: { create: { width: 800, height: 400, channels: 3, background: "#e33" } }, left: 300, top: 300 }]);
  const png = await base.clone().png().toBuffer();
  const photo = await hh.photo(3000, 2000, { grain: 6 });
  const inputs = {
    jpeg: await sharp(png).flatten({ background: "#fff" }).jpeg({ quality: 90 }).toBuffer(),
    "jpeg EXIF orientation 6": await sharp(png).flatten({ background: "#fff" }).jpeg({ quality: 90 }).withMetadata({ orientation: 6 }).toBuffer(),
    "photo with grain": photo,
    "png with alpha": png,
    webp: await sharp(png).webp({ quality: 90 }).toBuffer(),
    gif: await sharp(png).gif().toBuffer(),
    avif: await sharp(png).avif({ quality: 60 }).toBuffer(),
    "7000 px jpeg": await sharp({ create: { width: 7000, height: 1000, channels: 3, background: "#456" } }).jpeg().toBuffer(),
  };
  for (const [name, buf] of Object.entries(inputs)) {
    const a = await BASE.sanitizeImage(buf, "image/jpeg");
    const b = await NOW.sanitizeImage(buf, "image/jpeg");
    assert.equal(b.mimetype, a.mimetype, `${name}: MIME type`);
    assert.ok(b.buffer.equals(a.buffer), `${name}: master bytes`);
    const va = await BASE.makeVariants(a.buffer);
    const vb = await NOW.makeVariants(b.buffer);
    assert.equal(vb.variants.length, va.variants.length, `${name}: variant count`);
    va.variants.forEach((v, i) => assert.ok(vb.variants[i].buffer.equals(v.buffer), `${name}: variant ${i} bytes`));
  }
  // QR refusal unchanged for listings
  const QRCode = require("qrcode");
  const qr = await QRCode.toBuffer("upi://pay?pa=x@y", { type: "png", width: 300 });
  const withQr = await sharp({ create: { width: 1200, height: 800, channels: 3, background: "#fff" } }).composite([{ input: qr, left: 100, top: 100 }]).jpeg().toBuffer();
  const verdict = async (m) => m.sanitizeImage(withQr, "image/jpeg").then(() => "accepted", (e) => e.code || e.message);
  assert.equal(await verdict(NOW), await verdict(BASE));
});

// Homepage hero — admin-managed banner (docs/site-hero.md): public read,
// authorization, draft preparation (formats, crop, orientation, colour,
// QR, consistency, quality), publication semantics, alt text, restore,
// isolation of the protected namespace, notifications and cost.
// Real app on the replica-set harness with the in-memory Spaces fake.
const test = require("node:test");
const assert = require("node:assert/strict");
const sharp = require("sharp");
const h = require("./setup");
const hh = require("./hero-helpers");

const storage = () => require("../../services/storage");
const SiteSetting = () => require("../../models/SiteSetting");
const AdminAuditLog = () => require("../../models/AdminAuditLog");
const heroImage = () => require("../../services/siteHeroImage");
const changed = () => require("../../services/listingChanged");

let ADMIN, AT, ADMIN2, AT2, G, GT, HOST, HT, BANNED, BT, RA, RAT;
let DESK, MOB; // valid banners (desktop 2000×771, mobile 600×815)

const objects = (prefix = "site/hero/") => [...storage().__mock.objects.keys()].filter((k) => k.startsWith(prefix));
const audits = (action) => AdminAuditLog().find({ action }).lean();
const heroDoc = () => SiteSetting().collection.findOne({ _id: "home_hero" });
let notifyMock = { calls: [] };
async function reset() {
  await SiteSetting().collection.deleteMany({});
  storage().resetMock();
  notifyMock = { calls: [] };
  changed().__setMock(notifyMock);
}

test.before(async () => {
  await h.start();
  ADMIN = await h.makeAdmin();
  AT = h.adminToken(ADMIN);
  ADMIN2 = await h.makeAdmin();
  AT2 = h.adminToken(ADMIN2);
  G = await h.makeUser();
  GT = h.userToken(G);
  HOST = await h.makeUser({ role: "host" });
  HT = h.userToken(HOST);
  BANNED = await h.makeAdmin({ status: { active: false, banned: true } });
  BT = h.adminToken(BANNED);
  RA = await h.makeUser({ role: "admin" });
  RAT = h.userToken(RA);
  DESK = await hh.photo(2000, 771, { hue: 20 });
  MOB = await hh.photo(600, 815, { hue: 200 });
});
test.after(async () => h.stop());
test.beforeEach(reset);

// ---------------------------------------------------------------------------
test("public GET: anonymous 200 with no banner; edge-cached under the site-hero tag; ?fresh needs the secret", async () => {
  const r = await h.api("GET", "/site/hero");
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { version: 0, alt: null, desktop: null, mobile: null });
  const res = await fetch(`${h.baseUrl()}/site/hero`);
  assert.match(res.headers.get("cdn-cache-control") || "", /s-maxage=300/);
  assert.equal(res.headers.get("vercel-cache-tag"), "site-hero");
  const noSecret = await h.api("GET", "/site/hero?fresh=1");
  assert.equal(noSecret.status, 400);
  assert.equal(noSecret.body.code, "FRESH_NOT_ALLOWED");
  const fresh = await fetch(`${h.baseUrl()}/site/hero?fresh=1`, { headers: { "x-catalogue-fresh": process.env.CATALOGUE_FRESH_SECRET } });
  assert.equal(fresh.status, 200);
  assert.equal(fresh.headers.get("cache-control"), "no-store");
});

test("authorization: every admin route refuses anonymous (401), guests and hosts (403), banned or deleted admins (401); admins get no-store", async () => {
  const ghost = require("jsonwebtoken").sign({ userId: "64b000000000000000000002", firstName: "Ghost" }, process.env.JWT_SECRET, { expiresIn: "1h" });
  const routes = [
    ["GET", "/site/admin/hero"],
    ["GET", "/site/admin/hero/ops/6f2c1f8e-1b1d-4a57-9b2a-111111111111"],
    ["POST", "/site/admin/hero/publish"],
    ["PATCH", "/site/admin/hero/alt"],
    ["POST", "/site/admin/hero/restore-default"],
    ["DELETE", "/site/admin/hero/desktop/draft"],
  ];
  for (const [method, path] of routes) {
    for (const [label, token, status] of [["anonymous", undefined, 401], ["guest", GT, 403], ["host", HT, 403], ["banned admin", BT, 401], ["deleted admin", ghost, 401]]) {
      const r = await h.api(method, path, { token, body: method === "GET" ? undefined : {} });
      assert.equal(r.status, status, `${method} ${path} as ${label}: ${JSON.stringify(r.body)}`);
    }
  }
  // the multipart route: refused before the body is parsed or anything stored
  for (const [label, token, status] of [["anonymous", undefined, 401], ["guest", GT, 403], ["host", HT, 403], ["banned admin", BT, 401]]) {
    const r = await hh.multipart("/site/admin/hero/desktop/draft", { token, fields: { opToken: "x" }, file: { buf: Buffer.alloc(3 * 1024 * 1024, 1) } });
    assert.equal(r.status, status, `draft as ${label}`);
  }
  assert.equal(storage().__mock.uploaded.length, 0, "nothing stored");
  const ok = await fetch(`${h.baseUrl()}/site/admin/hero`, { headers: { authorization: `Bearer ${AT}` } });
  assert.equal(ok.status, 200);
  assert.match(ok.headers.get("cache-control"), /no-store/);
  const body = await ok.json();
  assert.ok(body.opToken && body.spec && body.spec.slots.desktop.min[0] === 1920);
  // a user whose role is admin is an admin (existing semantics)
  assert.equal((await h.api("GET", "/site/admin/hero", { token: RAT })).status, 200);
});

test("draft: desktop and mobile — JPEG master + AVIF/WebP renditions at the derived widths, placeholder, no metadata, immutable caching, audit", async () => {
  const d = await hh.stage(AT, "desktop", DESK);
  assert.equal(d.status, 201, JSON.stringify(d.body));
  const draft = d.body.state.draft.desktop;
  assert.equal(draft.width, 2000);
  assert.equal(draft.height, 771);
  assert.deepEqual(draft.renditions.map((r) => r.width), [640, 960, 1280, 1600, 1920, 2000]);
  assert.match(draft.lqip, /^data:image\/webp;base64,/);
  assert.ok(draft.lqip.length <= 600);
  assert.ok(d.body.opToken, "a fresh token for the next action");
  const masterKey = storage().keyFromUrl(draft.url);
  assert.match(masterKey, /^site\/hero\/desktop\/[0-9a-f-]{36}\.jpg$/);
  const keys = objects().sort();
  assert.equal(keys.length, 1 + 6 * 2, keys.join("\n"));
  for (const k of keys) {
    const o = storage().__mock.objects.get(k);
    assert.equal(o.cacheControl, storage().IMMUTABLE_CACHE_CONTROL);
    const meta = await sharp(o.body).metadata();
    assert.ok(!meta.exif && !meta.xmp && !meta.iptc, `no metadata in ${k}`);
    if (k === masterKey) {
      assert.equal(o.contentType, "image/jpeg");
      assert.equal(meta.width, 2000);
      continue;
    }
    const m = k.match(/\/v1\/w(\d+)\.(avif|webp)$/);
    assert.ok(m, k);
    assert.equal(o.contentType, `image/${m[2]}`);
    assert.equal(meta.format, m[2] === "avif" ? "heif" : "webp");
    assert.ok(meta.width <= 2000);
  }
  // the 2000 px rendition lives under the w3840 key? no: under the smallest standard width ≥ 2000
  assert.ok(storage().__mock.objects.has(`${masterKey}/v1/w2560.avif`), "2000 px rendition under w2560");
  const rows = await audits("site.hero.stage");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].targetType, "SiteSetting");
  assert.equal(rows[0].targetKey, "home_hero");
  assert.equal(String(rows[0].actorId), String(ADMIN._id));

  const m = await hh.stage(AT, "mobile", MOB);
  assert.equal(m.status, 201, JSON.stringify(m.body));
  assert.deepEqual(m.body.state.draft.mobile.renditions.map((r) => r.width), [600]);
  const doc = await heroDoc();
  assert.equal(doc.lease, null, "lease released");
  assert.equal(doc.receipts.length, 2);
  assert.equal(doc.version, 0, "drafts do not change the live banner");
  assert.deepEqual((await h.api("GET", "/site/hero")).body.desktop, null, "nothing public yet");
});

test("publish: the first custom banner needs both drafts; the pair goes live with one description; audit + site-hero notification", async () => {
  await hh.stage(AT, "desktop", DESK);
  const only = await hh.publish(AT, { slots: { desktop: (await hh.adminState(AT)).draft.desktop.opId } });
  assert.equal(only.status, 400);
  assert.equal(only.body.code, "HERO_BOTH_SLOTS_REQUIRED");
  await hh.stage(AT, "mobile", MOB);
  const p = await hh.publish(AT, { alt: "  Rann Utsav —\u0007 the white desert  " });
  assert.equal(p.status, 200, JSON.stringify(p.body));
  assert.equal(p.body.version, 1);
  assert.equal(p.body.state.alt, "Rann Utsav — the white desert", "trimmed, control characters removed");
  assert.equal(p.body.state.draft.desktop, null);
  assert.deepEqual(p.body.notified, { site: "mocked", cdn: "mocked" });
  const pub = await h.api("GET", "/site/hero");
  assert.equal(pub.body.version, 1);
  assert.equal(pub.body.alt, "Rann Utsav — the white desert");
  assert.equal(pub.body.desktop.width, 2000);
  assert.equal(pub.body.mobile.width, 600);
  assert.deepEqual(Object.keys(pub.body.desktop).sort(), ["height", "lqip", "url", "width"], "public data only");
  const rows = await audits("site.hero.publish");
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].details.slots, ["desktop", "mobile"]);
  assert.deepEqual(notifyMock.calls.map((c) => c.tags), [["site-hero"]], "the site is told once, by tag");
});

// ---------------------------------------------------------------------------
async function expectRefused(r, status, code, label, before = []) {
  assert.equal(r.status, status, `${label}: ${JSON.stringify(r.body)}`);
  if (code) assert.equal(r.body.code, code, label);
  assert.deepEqual(objects().sort(), [...before].sort(), `${label}: nothing of this attempt left in storage`);
  const doc = await heroDoc();
  assert.ok(!doc || doc.lease === null, `${label}: lease released`);
}

test("draft inputs: PNG, WebP, AVIF and animated WebP/GIF (first frame, noted) are accepted", async () => {
  for (const [format, type] of [["png", "image/png"], ["webp", "image/webp"], ["avif", "image/avif"]]) {
    await reset();
    const r = await hh.stage(AT, "desktop", await hh.photo(2000, 771, { format }), { type, name: `b.${format}` });
    assert.equal(r.status, 201, `${format}: ${JSON.stringify(r.body)}`);
  }
  const frames = [await hh.photo(1920, 740, { format: "png", hue: 10 }), await hh.photo(1920, 740, { format: "png", hue: 250 })];
  for (const [format, type] of [["webp", "image/webp"], ["gif", "image/gif"]]) {
    await reset();
    let anim = sharp(frames, { join: { animated: true } });
    anim = format === "gif" ? anim.gif() : anim.webp({ quality: 85 });
    const buf = await anim.toBuffer();
    assert.ok(((await sharp(buf).metadata()).pages || 1) > 1, `${format} fixture is animated`);
    const r = await hh.stage(AT, "desktop", buf, { type, name: `a.${format}` });
    assert.equal(r.status, 201, `${format}: ${JSON.stringify(r.body)}`);
    const d = r.body.state.draft.desktop;
    assert.ok(d.notices.includes("ANIMATION_FIRST_FRAME"));
    const master = storage().__mock.objects.get(storage().keyFromUrl(d.url)).body;
    assert.ok((await hh.meanAbsDiff(master, frames[0])) < (await hh.meanAbsDiff(master, frames[1])), `${format}: the first frame was used`);
  }
});

test("draft inputs: HEIC (by brand, even undecodable) 415; SVG/TIFF/PDF/text 415; a truncated JPEG 400; nothing stored, lease released, failure recorded", async () => {
  const heic = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypheic"), Buffer.from([0, 0, 0, 0]), Buffer.from("mif1heic"), Buffer.alloc(512, 7)]);
  await expectRefused(await hh.stage(AT, "desktop", heic, { type: "image/heic", name: "IMG_0001.HEIC" }), 415, "HEIC_NOT_SUPPORTED", "heic");
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="2000" height="771"><rect width="100%" height="100%" fill="red"/></svg>');
  await expectRefused(await hh.stage(AT, "desktop", svg, { type: "image/svg+xml", name: "b.svg" }), 415, "UNSUPPORTED_FILE_TYPE", "svg (declared)");
  await expectRefused(await hh.stage(AT, "desktop", svg, { type: "application/octet-stream", name: "b.bin" }), 415, "UNSUPPORTED_FORMAT", "svg (disguised)");
  const tiff = await sharp(DESK).tiff().toBuffer();
  await expectRefused(await hh.stage(AT, "desktop", tiff, { type: "application/octet-stream" }), 415, "UNSUPPORTED_FORMAT", "tiff");
  await expectRefused(await hh.stage(AT, "desktop", Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(2048, 3)]), { type: "application/octet-stream" }), 415, "UNSUPPORTED_FORMAT", "pdf");
  await expectRefused(await hh.stage(AT, "desktop", Buffer.from("just some text, not an image"), { type: "image/jpeg" }), 415, "UNSUPPORTED_FORMAT", "text");
  await expectRefused(await hh.stage(AT, "desktop", DESK.subarray(0, Math.floor(DESK.length / 3)), { type: "image/jpeg" }), 400, "INVALID_IMAGE", "truncated jpeg");
  const doc = await heroDoc();
  assert.ok(doc.receipts.filter((r) => r.status === "failed").length >= 5, "failures after the lease was taken are recorded");
});

test("draft limits: the 25 MP cap ±1 px (header only); 4 MB exactly passes the parser, 4 MB + 1 byte is 413", async () => {
  const at = await sharp({ create: { width: 5001, height: 4999, channels: 3, background: "#345" } }).png({ compressionLevel: 9 }).toBuffer();
  const over = await sharp({ create: { width: 5000, height: 5001, channels: 3, background: "#345" } }).png({ compressionLevel: 9 }).toBuffer();
  const ok = await heroImage().identify(at);
  assert.equal(ok.width * ok.height, 24999999);
  await assert.rejects(() => heroImage().identify(over), (e) => e.code === "IMAGE_TOO_LARGE" && e.status === 413);
  await expectRefused(await hh.stage(AT, "desktop", over, { type: "image/png" }), 413, "IMAGE_TOO_LARGE", "25 MP + 5000 px");
  const LIMIT = 4 * 1024 * 1024;
  await expectRefused(await hh.stage(AT, "desktop", Buffer.alloc(LIMIT, 1), { type: "application/octet-stream" }), 415, "UNSUPPORTED_FORMAT", "exactly 4 MB reached the image check");
  const r = await hh.stage(AT, "desktop", Buffer.alloc(LIMIT + 1, 1), { type: "application/octet-stream" });
  assert.equal(r.status, 413, JSON.stringify(r.body));
  assert.equal(r.body.code, "FILE_TOO_LARGE");
});

test("draft fields: unknown, duplicated or bracketed field names, a missing file and bad values are 400", async () => {
  const st = await hh.adminState(AT);
  const send = (fields, file = { buf: DESK }) => hh.multipart("/site/admin/hero/desktop/draft", { token: AT, fields, file });
  assert.equal((await send({ opToken: st.opToken, extra: "1" })).body.code, "INVALID_FIELDS");
  assert.equal((await send({ opToken: st.opToken, "focalX[0]": "1" })).status, 400);
  const form = new FormData();
  form.append("opToken", st.opToken);
  form.append("focalX", "0.5");
  form.append("focalX", "0.6");
  form.append("image", new Blob([DESK], { type: "image/jpeg" }), "b.jpg");
  const dup = await fetch(`${h.baseUrl()}/site/admin/hero/desktop/draft`, { method: "POST", headers: { authorization: `Bearer ${AT}` }, body: form });
  assert.equal(dup.status, 400, "duplicate field");
  assert.equal((await send({ opToken: st.opToken }, null)).body.code, "FILE_REQUIRED");
  for (const [fields, code] of [[{ opToken: st.opToken, focalX: "" }, "INVALID_FOCAL"], [{ opToken: st.opToken, focalX: "1.5" }, "INVALID_FOCAL"], [{ opToken: st.opToken, focalY: "NaN" }, "INVALID_FOCAL"], [{ opToken: st.opToken, acceptRatio: "maybe" }, "INVALID_FIELDS"], [{ opToken: st.opToken, expectedDraftOpId: "not-an-id" }, "INVALID_FIELDS"], [{}, "OP_TOKEN_REQUIRED"]]) {
    const r = await send(fields);
    assert.equal(r.status, 400, `${JSON.stringify(fields)} → ${JSON.stringify(r.body)}`);
    assert.equal(r.body.code, code);
  }
  assert.equal((await hh.multipart("/site/admin/hero/tablet/draft", { token: AT, fields: { opToken: st.opToken }, file: { buf: DESK } })).body.code, "INVALID_SLOT");
  assert.deepEqual(objects(), []);
});

test("draft crop: cut to the exact box around the focal point; within 1% used whole; beyond 35% only with acceptRatio; too small → 422 with sizes", async () => {
  // left half red, right half blue, 3000×740 (1.56× too wide)
  const halves = await sharp({ create: { width: 3000, height: 740, channels: 3, background: "#ff0000" } })
    .composite([{ input: await sharp({ create: { width: 1500, height: 740, channels: 3, background: "#0000ff" } }).png().toBuffer(), left: 1500, top: 0 }])
    .jpeg({ quality: 95 })
    .toBuffer();
  const confirm = await hh.stage(AT, "desktop", halves);
  assert.equal(confirm.status, 422);
  assert.equal(confirm.body.code, "HERO_RATIO_CONFIRM");
  assert.ok(confirm.body.expectedRatio > 2.59 && confirm.body.actualRatio > 4);
  const mean = async (url) => {
    const s = await sharp(storage().__mock.objects.get(storage().keyFromUrl(url)).body).stats();
    return { r: s.channels[0].mean, b: s.channels[2].mean, w: (await sharp(storage().__mock.objects.get(storage().keyFromUrl(url)).body).metadata()).width };
  };
  const left = await hh.stage(AT, "desktop", halves, { fields: { focalX: "0", acceptRatio: "true" } });
  assert.equal(left.status, 201, JSON.stringify(left.body));
  const L = await mean(left.body.state.draft.desktop.url);
  assert.equal(L.w, 1920);
  assert.equal(left.body.state.draft.desktop.height, 740);
  assert.ok(L.r > L.b, "focal left keeps the red half");
  assert.ok(left.body.state.draft.desktop.notices.includes("CROPPED") && left.body.state.draft.desktop.notices.includes("RATIO_ACCEPTED"));
  const right = await hh.stage(AT, "desktop", halves, { fields: { focalX: "1", acceptRatio: "1" } });
  const R = await mean(right.body.state.draft.desktop.url);
  assert.ok(R.b > R.r, "focal right keeps the blue half");
  // moderately wide (≤ 35%): cropped without a confirmation
  await reset();
  const wide = await hh.stage(AT, "desktop", await hh.photo(2400, 740));
  assert.equal(wide.status, 201, JSON.stringify(wide.body));
  assert.equal(wide.body.state.draft.desktop.width, 1920);
  // within 1%: the whole image (the real 2805×1080 art)
  await reset();
  const whole = await hh.stage(AT, "desktop", await hh.photo(2805, 1080));
  assert.deepEqual([whole.body.state.draft.desktop.width, whole.body.state.draft.desktop.height], [2805, 1080]);
  assert.ok(!whole.body.state.draft.desktop.notices.includes("CROPPED"));
  // too tall for desktop → cut vertically around focal y
  await reset();
  const tall = await hh.stage(AT, "desktop", await hh.photo(1920, 1000), { fields: { focalY: "0", acceptRatio: "1" } });
  assert.deepEqual([tall.body.state.draft.desktop.width, tall.body.state.draft.desktop.height], [1920, 740]);
  // the minimum, ±1 px (1% slack for the uncropped tolerance): desktop 1900×732 / mobile 524×712
  await reset();
  assert.equal((await hh.stage(AT, "desktop", await hh.photo(1900, 732))).status, 201);
  let before = objects();
  const small = await hh.stage(AT, "desktop", await hh.photo(1899, 732));
  await expectRefused(small, 422, "HERO_TOO_SMALL", "1899 px", before);
  assert.deepEqual(small.body.required, { width: 1920, height: 740 });
  assert.deepEqual(small.body.actual, { width: 1899, height: 732 });
  assert.equal((await hh.stage(AT, "mobile", await hh.photo(524, 712))).status, 201);
  before = objects();
  await expectRefused(await hh.stage(AT, "mobile", await hh.photo(523, 712)), 422, "HERO_TOO_SMALL", "523 px mobile", before);
  // desktop art in the mobile slot: needs the explicit confirmation
  const wrongSlot = await hh.stage(AT, "mobile", DESK);
  assert.equal(wrongSlot.body.code, "HERO_RATIO_CONFIRM");
});

test("draft orientation: EXIF orientations 1–8 are all cropped in upright coordinates", async () => {
  // upright reference: red square top-left, blue square bottom-right
  const upright = await sharp({ create: { width: 2400, height: 800, channels: 3, background: "#808080" } })
    .composite([
      { input: await sharp({ create: { width: 400, height: 300, channels: 3, background: "#ff0000" } }).png().toBuffer(), left: 0, top: 0 },
      { input: await sharp({ create: { width: 400, height: 300, channels: 3, background: "#0000ff" } }).png().toBuffer(), left: 2000, top: 500 },
    ])
    .png()
    .toBuffer();
  const corner = async (buf, x, y) => {
    const { data, info } = await sharp(buf).raw().toBuffer({ resolveWithObject: true });
    const i = (y * info.width + x) * info.channels;
    return [data[i], data[i + 1], data[i + 2]];
  };
  const transforms = [(p) => p, (p) => p.rotate(90), (p) => p.rotate(180), (p) => p.rotate(270), (p) => p.flop(), (p) => p.flip(), (p) => p.rotate(90).flop(), (p) => p.rotate(270).flop()];
  for (let orientation = 1; orientation <= 8; orientation += 1) {
    // find the stored pixels that display upright under this orientation
    let stored = null;
    for (const t of transforms) {
      const bytes = await t(sharp(upright)).jpeg({ quality: 95 }).withMetadata({ orientation }).toBuffer();
      const shown = await sharp(bytes).rotate().png().toBuffer();
      const m = await sharp(shown).metadata();
      if (m.width !== 2400) continue;
      const tl = await corner(shown, 50, 50);
      const br = await corner(shown, 2350, 750);
      if (tl[0] > 200 && tl[2] < 60 && br[2] > 200 && br[0] < 60) {
        stored = bytes;
        break;
      }
    }
    assert.ok(stored, `a stored form for orientation ${orientation}`);
    await reset();
    const r = await hh.stage(AT, "desktop", stored);
    assert.equal(r.status, 201, `orientation ${orientation}: ${JSON.stringify(r.body)}`);
    const d = r.body.state.draft.desktop;
    assert.deepEqual([d.width, d.height], [2076, 800], `orientation ${orientation}: upright crop size`);
    const master = storage().__mock.objects.get(storage().keyFromUrl(d.url)).body;
    const tl = await corner(master, 20, 20);
    const br = await corner(master, 2076 - 20, 780);
    assert.ok(tl[0] > 200 && tl[2] < 60, `orientation ${orientation}: red at the top-left (${tl})`);
    assert.ok(br[2] > 200 && br[0] < 60, `orientation ${orientation}: blue at the bottom-right (${br})`);
  }
});

test("draft colour: Display-P3 values are converted to sRGB (not reinterpreted); CMYK, 16-bit and greyscale become 8-bit sRGB; alpha is flattened on white", async () => {
  const masterOf = async (r) => storage().__mock.objects.get(storage().keyFromUrl(r.body.state.draft.desktop.url)).body;
  const centre = async (buf) => {
    const { data, info } = await sharp(buf).raw().toBuffer({ resolveWithObject: true });
    const i = (Math.floor(info.height / 2) * info.width + Math.floor(info.width / 2)) * info.channels;
    return [data[i], data[i + 1], data[i + 2]];
  };
  // pixel values that ARE P3 numbers, tagged P3: the output must be their sRGB equivalent
  for (const p3 of [[200, 120, 80], [90, 160, 210], [230, 60, 40], [128, 128, 128]]) {
    await reset();
    const r = await hh.stage(AT, "desktop", await hh.p3Tagged(p3, 1920, 740), { type: "image/png" });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const got = await centre(await masterOf(r));
    const want = hh.p3ToSrgb(p3);
    assert.ok(got.every((v, i) => Math.abs(v - want[i]) <= 3), `P3 ${p3} → ${got}, expected ≈ ${want}`);
    if (p3[0] !== p3[1]) assert.ok(got.some((v, i) => Math.abs(v - p3[i]) > 5), `P3 ${p3} converted, not copied`);
  }
  for (const [label, buf, type] of [
    ["cmyk", await sharp(DESK).toColourspace("cmyk").jpeg({ quality: 92 }).toBuffer(), "image/jpeg"],
    ["16-bit", await sharp(DESK).toColourspace("rgb16").png().toBuffer(), "image/png"],
    ["greyscale", await sharp(DESK).greyscale().jpeg().toBuffer(), "image/jpeg"],
  ]) {
    await reset();
    const r = await hh.stage(AT, "desktop", buf, { type });
    assert.equal(r.status, 201, `${label}: ${JSON.stringify(r.body)}`);
    const m = await sharp(await masterOf(r)).metadata();
    assert.equal(m.space, "srgb", label);
    assert.equal(m.channels, 3, label);
    assert.equal(m.depth, "uchar", label);
    for (const rend of r.body.state.draft.desktop.renditions) {
      const k = storage().keyFromUrl(rend.webp);
      assert.equal((await sharp(storage().__mock.objects.get(k).body).metadata()).depth, "uchar", `${label} ${rend.width}`);
    }
  }
  await reset();
  const alpha = await hh.stage(AT, "desktop", await hh.photo(2000, 771, { format: "png", alpha: true }), { type: "image/png" });
  const { data, info } = await sharp(await masterOf(alpha)).raw().toBuffer({ resolveWithObject: true });
  const px = (x, y) => [...data.subarray((y * info.width + x) * info.channels, (y * info.width + x) * info.channels + 3)];
  assert.ok(px(100, 400).every((c) => c >= 245), `transparent area is white: ${px(100, 400)}`);
  assert.equal(info.channels, 3);
});

test("draft QR: a banner showing a QR code is refused before anything is stored; the detection floor is recorded", async () => {
  const QRCode = require("qrcode");
  const floor = [];
  for (const size of [600, 300, 160, 100]) {
    await reset();
    const qr = await QRCode.toBuffer("https://wa.me/919876543210", { type: "png", width: size, margin: 2 });
    const banner = await sharp(await hh.photo(1920, 740)).composite([{ input: qr, left: 1200, top: 70 }]).jpeg({ quality: 92 }).toBuffer();
    const r = await hh.stage(AT, "desktop", banner);
    floor.push(`${size}px: ${r.status === 422 ? "refused" : r.status}`);
    if (size === 600) await expectRefused(r, 422, "IMAGE_NOT_ALLOWED", "600 px QR");
  }
  console.log(`[site-hero] QR detection on a 1920 px banner — ${floor.join(", ")}`);
});

test("draft consistency: master, every rendition and the placeholder show the same picture (same crop, orientation, colour)", async () => {
  const src = await hh.photo(2600, 900, { hue: 90 });
  const r = await hh.stage(AT, "desktop", src, { fields: { focalX: "0.3" } });
  assert.equal(r.status, 201);
  const d = r.body.state.draft.desktop;
  // the lossless reference: the same raster the service encoded from
  const raster = await heroImage().prepareRaster(src, heroImage().cropRegion(2600, 900, "desktop", { x: 0.3, y: 0.5 }), "desktop");
  const reference = await sharp(raster.data, { raw: { width: raster.width, height: raster.height, channels: 3 } }).png().toBuffer();
  const outputs = [["jpeg master", storage().__mock.objects.get(storage().keyFromUrl(d.url)).body]];
  for (const rend of d.renditions) for (const fmt of ["avif", "webp"]) outputs.push([`${fmt} ${rend.width}`, storage().__mock.objects.get(storage().keyFromUrl(rend[fmt])).body, rend.width]);
  for (const [label, buf, width] of outputs) {
    const m = await sharp(buf).metadata();
    if (width) {
      assert.equal(m.width, width, `${label} is its width`);
      assert.ok(Math.abs(m.height - Math.round((width * d.height) / d.width)) <= 1, `${label} keeps the ratio`);
    }
    const diff = await hh.meanAbsDiff(buf, reference);
    assert.ok(diff <= 3, `${label}: mean |Δ| ${diff.toFixed(2)} vs the raster`);
    const bias = await hh.meanSignedDiff(buf, reference);
    assert.ok(bias.every((b) => Math.abs(b) <= 1), `${label}: no colour drift (${bias.map((b) => b.toFixed(2))})`);
  }
  const lqip = Buffer.from(d.lqip.split(",")[1], "base64");
  const lqipDiff = await hh.meanAbsDiff(lqip, reference, 24);
  const lqipBias = await hh.meanSignedDiff(lqip, reference, 24);
  console.log(`[site-hero] placeholder vs raster at 24 px: mean |Δ| ${lqipDiff.toFixed(2)}, bias ${lqipBias.map((b) => b.toFixed(2))}`);
  // a 24 px q40 blur-up is coarse by design (measured ~14); a wrong crop or
  // orientation measures 40+, a colour drift shows in the bias
  assert.ok(lqipDiff <= 20, `placeholder is the same picture (mean |Δ| ${lqipDiff.toFixed(2)})`);
  assert.ok(lqipBias.every((b) => Math.abs(b) <= 3), `placeholder has no colour drift (${lqipBias.map((b) => b.toFixed(2))})`);
});

// The fixture is photo-like (gradient sky, shapes, bold lettering, fine
// grain σ3). Measured and kept on record: with coarse per-pixel noise (σ6)
// the 3840 px renditions score SSIM 0.983 in both formats because the
// encoders remove noise SSIM counts as signal — raising quality does not
// help (AVIF q66: 0.9828; WebP needs q90 at 3× the bytes). The real-art
// gates run in the browser harness (tests/pw-final/hero-quality.mjs).
test("quality gates (synthetic banner): AVIF and WebP renditions and the JPEG master against the lossless raster", async () => {
  const buf = await hh.photo(3840, 1480, { hue: 35, grain: 3 });
  const r = await hh.stage(AT, "desktop", buf);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const d = r.body.state.draft.desktop;
  const region = heroImage().cropRegion(3840, 1480, "desktop");
  const raster = await heroImage().prepareRaster(buf, region, "desktop");
  const rasterPng = await sharp(raster.data, { raw: { width: raster.width, height: raster.height, channels: 3 } }).png().toBuffer();
  const results = [];
  const master = storage().__mock.objects.get(storage().keyFromUrl(d.url)).body;
  const mq = await hh.quality(master, await hh.rawOf(rasterPng));
  results.push(`jpeg@${raster.width} ssim ${mq.ssim.toFixed(4)}`);
  const misses = [];
  if (mq.ssim < 0.995) misses.push(`master SSIM ${mq.ssim}`);
  for (const rend of d.renditions) {
    const ref = await hh.rawOf(rasterPng, rend.width, Math.round((rend.width * raster.height) / raster.width));
    for (const fmt of ["avif", "webp"]) {
      const q = await hh.quality(storage().__mock.objects.get(storage().keyFromUrl(rend[fmt])).body, ref);
      results.push(`${fmt}@${rend.width} ssim ${q.ssim.toFixed(4)} p1 ${q.p1.toFixed(3)} chroma ${q.chroma.toFixed(1)}`);
      if (q.ssim < 0.985) misses.push(`${fmt}@${rend.width} SSIM ${q.ssim.toFixed(4)}`);
      if (q.p1 < 0.93) misses.push(`${fmt}@${rend.width} p1 ${q.p1.toFixed(3)}`);
    }
  }
  console.log(`[site-hero] synthetic quality — ${results.join("; ")}`);
  assert.deepEqual(misses, [], "every output meets its gate");
});

test("publish semantics: a desktop-only replacement keeps mobile live (not retired); unselected drafts are untouched", async () => {
  await hh.stage(AT, "desktop", DESK);
  await hh.stage(AT, "mobile", MOB);
  const first = await hh.publish(AT);
  assert.equal(first.status, 200);
  const mobileUrl = first.body.state.mobile.url;
  const oldDesktopKey = storage().keyFromUrl(first.body.state.desktop.url);
  await hh.stage(AT, "desktop", await hh.photo(2100, 810, { hue: 300 }));
  await hh.stage(AT, "mobile", await hh.photo(700, 951, { hue: 120 }));
  const st = await hh.adminState(AT);
  const p = await hh.publish(AT, { slots: { desktop: st.draft.desktop.opId } });
  assert.equal(p.status, 200, JSON.stringify(p.body));
  assert.equal(p.body.version, 2);
  assert.equal(p.body.state.mobile.url, mobileUrl, "mobile stays live");
  assert.equal(p.body.state.desktop.width, 2100);
  assert.ok(p.body.state.draft.mobile, "the unselected mobile draft is untouched");
  const doc = await heroDoc();
  assert.deepEqual(doc.retired.map((r) => r.masterKeys[0]), [oldDesktopKey], "only the replaced desktop art is retired");
});

test("publish preconditions: stale version, a changed or expired draft → 409 with a reason; alt and slot validation → 400", async () => {
  const publishAuditsBefore = (await audits("site.hero.publish")).length;
  await hh.stage(AT, "desktop", DESK);
  await hh.stage(AT, "mobile", MOB);
  const st = await hh.adminState(AT);
  const stale = await hh.publish(AT, { expectedVersion: 5 });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.code, "HERO_VERSION_CONFLICT");
  const changedDraft = await hh.publish(AT, { slots: { desktop: "6f2c1f8e-1b1d-4a57-9b2a-111111111111", mobile: st.draft.mobile.opId } });
  assert.equal(changedDraft.body.code, "HERO_DRAFT_CHANGED");
  for (const [alt, label] of [["", "empty"], ["   ", "blank"], ["x".repeat(151), "too long"], [42, "not text"]]) {
    const r = await hh.publish(AT, { alt });
    assert.equal(r.status, 400, label);
    assert.equal(r.body.code, "INVALID_ALT", label);
  }
  assert.equal((await hh.publish(AT, { slots: {} })).body.code, "HERO_NO_SLOTS");
  assert.equal((await hh.publish(AT, { slots: { tablet: st.draft.mobile.opId } })).body.code, "INVALID_SLOTS");
  assert.equal((await hh.publish(AT, { expectedVersion: "1; drop" })).body.code, "INVALID_VERSION");
  await SiteSetting().collection.updateOne({ _id: "home_hero" }, { $set: { "draft.mobile.expiresAt": new Date(Date.now() - 1000) } });
  const expired = await hh.publish(AT);
  assert.equal(expired.status, 409);
  assert.equal(expired.body.code, "HERO_DRAFT_EXPIRED");
  const doc = await heroDoc();
  assert.equal(doc.version, 0, "nothing changed");
  assert.equal((await audits("site.hero.publish")).length, publishAuditsBefore, "nothing audited");
});

test("description edit: only for a custom banner; compare-and-set; audited; the public read follows", async () => {
  const altAuditsBefore = (await audits("site.hero.alt")).length;
  const st0 = await hh.adminState(AT);
  const notCustom = await h.api("PATCH", "/site/admin/hero/alt", { token: AT, body: { opToken: st0.opToken, expectedVersion: 0, alt: "x" } });
  assert.equal(notCustom.body.code, "HERO_NOT_CUSTOM");
  await hh.stage(AT, "desktop", DESK);
  await hh.stage(AT, "mobile", MOB);
  await hh.publish(AT);
  const st = await hh.adminState(AT);
  const r = await h.api("PATCH", "/site/admin/hero/alt", { token: AT, body: { opToken: st.opToken, expectedVersion: st.version, alt: "Rann Utsav 2026 — book your tent" } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.version, 2);
  assert.equal((await h.api("GET", "/site/hero")).body.alt, "Rann Utsav 2026 — book your tent");
  const again = await h.api("PATCH", "/site/admin/hero/alt", { token: AT, body: { opToken: (await hh.adminState(AT)).opToken, expectedVersion: 1, alt: "y" } });
  assert.equal(again.body.code, "HERO_VERSION_CONFLICT");
  assert.equal((await audits("site.hero.alt")).length, altAuditsBefore + 1);
});

test("restore bundled default: the live pair is retired and the public read is empty again; drafts are kept; a second restore changes nothing", async () => {
  const resetAuditsBefore = (await audits("site.hero.reset")).length;
  await hh.stage(AT, "desktop", DESK);
  await hh.stage(AT, "mobile", MOB);
  await hh.publish(AT);
  await hh.stage(AT, "desktop", await hh.photo(1920, 740, { hue: 330 }));
  const st = await hh.adminState(AT);
  const r = await h.api("POST", "/site/admin/hero/restore-default", { token: AT, body: { opToken: st.opToken, expectedVersion: st.version } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.changed, true);
  assert.equal(r.body.state.custom, false);
  assert.ok(r.body.state.draft.desktop, "the draft survives a restore");
  assert.deepEqual((await h.api("GET", "/site/hero")).body, { version: 2, alt: null, desktop: null, mobile: null });
  const doc = await heroDoc();
  assert.equal(doc.retired.length, 2);
  assert.equal(objects().length > 0, true, "nothing deleted at restore time (the sweep decides later)");
  const st2 = await hh.adminState(AT);
  const again = await h.api("POST", "/site/admin/hero/restore-default", { token: AT, body: { opToken: st2.opToken, expectedVersion: st2.version } });
  assert.equal(again.body.changed, false);
  assert.equal((await audits("site.hero.reset")).length, resetAuditsBefore + 1);
  // after a restore the next publish needs both slots again
  const need = await hh.publish(AT, { slots: { desktop: st2.draft.desktop.opId } });
  assert.equal(need.body.code, "HERO_BOTH_SLOTS_REQUIRED");
});

test("discard draft: needs the draft id it expects; a stale id is 409 and the newer draft survives; audited; objects left for the sweep", async () => {
  const discardAuditsBefore = (await audits("site.hero.discard")).length;
  const first = await hh.stage(AT, "desktop", DESK);
  const x = first.body.state.draft.desktop.opId;
  const second = await hh.stage(AT, "desktop", await hh.photo(1920, 740, { hue: 60 }), { expectedDraftOpId: x });
  const y = second.body.state.draft.desktop.opId;
  const stale = await h.api("DELETE", "/site/admin/hero/desktop/draft", { token: AT, body: { opToken: (await hh.adminState(AT)).opToken, expectedDraftOpId: x } });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.code, "HERO_DRAFT_CHANGED");
  assert.equal((await hh.adminState(AT)).draft.desktop.opId, y);
  const before = objects().length;
  const ok = await h.api("DELETE", "/site/admin/hero/desktop/draft", { token: AT, body: { opToken: (await hh.adminState(AT)).opToken, expectedDraftOpId: y } });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.state.draft.desktop, null);
  assert.equal(objects().length, before, "objects are left for the sweep");
  assert.equal((await audits("site.hero.discard")).length, discardAuditsBefore + 1);
  const missing = await h.api("DELETE", "/site/admin/hero/desktop/draft", { token: AT, body: { opToken: (await hh.adminState(AT)).opToken } });
  assert.equal(missing.status, 400);
});

test("isolation: hero objects can't be referenced by users or listings, deleted through /uploads/delete, a profile swap, deleteObjects or the prune", async () => {
  const d = await hh.stage(AT, "desktop", DESK);
  const heroUrl = d.body.state.draft.desktop.url;
  const heroKey = storage().keyFromUrl(heroUrl);
  const policy = require("../../utils/publicTextPolicy");
  assert.equal(policy.isOurImageUrl(heroUrl), false);
  assert.equal(policy.isOurImageUrl(d.body.state.draft.desktop.renditions[0].webp), false, "renditions too (CDN host)");
  // a user can't make the banner their profile picture
  const U = await h.makeUser();
  const put = await h.api("PUT", `/accounts?email=${encodeURIComponent(U.email)}`, { token: h.userToken(U), body: { firstName: "U", lastName: "Test", dob: "1990-01-01", phoneNumber: "9000000999", profilePicture: heroUrl } });
  assert.equal(put.status, 422, JSON.stringify(put.body));
  // nor an admin a listing photo
  const listing = await h.api("POST", "/prop-listing", { token: AT, body: { title: "Hero thief", photos: [heroUrl], host: String(U._id) } });
  assert.equal(listing.status, 422, JSON.stringify(listing.body));
  // /uploads/delete refuses it, even for an admin
  const del = await h.api("DELETE", "/uploads/delete", { token: AT, body: { url: heroUrl } });
  assert.equal(del.status, 409);
  assert.equal(del.body.code, "OBJECT_IN_USE");
  // the lowest boundary refuses it without the explicit flag
  const res = await storage().deleteObjects([heroKey]);
  assert.deepEqual(res.deleted, []);
  assert.equal(res.failed[0].code, "PROTECTED");
  assert.equal((await storage().deleteImages([heroKey])).deleted.length, 0);
  assert.ok(storage().__mock.objects.has(heroKey), "still there");
  // a legacy profile picture pointing at a hero object: the swap cleanup can't delete it
  await require("../../models/User").updateOne({ _id: U._id }, { $set: { profilePicture: heroUrl } });
  const swap = await hh.multipart(`/uploads/profile?userId=${U._id}`, { token: h.userToken(U), fileField: "file", file: { buf: await hh.photo(400, 400), name: "me.jpg" } });
  assert.equal(swap.status, 200, JSON.stringify(swap.body));
  await h.sleep(200);
  assert.ok(storage().__mock.objects.has(heroKey), "the banner survived the profile swap");
  // the maintenance prune never touches the protected namespace (an .avif variant included)
  const orphan = "listings/64b0000000000000000000aa/x.jpg/v1/w640.webp";
  storage().__mock.objects.set(orphan, { body: Buffer.alloc(10), contentType: "image/webp", cacheControl: "", lastModified: new Date() });
  const { prune } = require("../../scripts/image-variants-backfill");
  const heroBefore = objects();
  const summary = await prune(new Map(), { apply: true }, () => {});
  assert.deepEqual(objects().sort(), heroBefore.sort(), "every hero object kept (an .avif rendition included)");
  assert.ok(!storage().__mock.objects.has(orphan), "a real listing orphan is still pruned");
  assert.ok(summary.orphans >= 1);
  assert.ok(storage().__mock.deleted.every((k) => !storage().isProtectedKey(k)), "nothing protected was ever deleted");
});

test("notifications: a CDN purge or a site call that times out is reported as timeout, not ok", async () => {
  const http = require("http");
  const stub = http.createServer(() => {
    /* never answers */
  });
  await new Promise((r) => stub.listen(0, "127.0.0.1", r));
  // @vercel/functions exports getters: swap the cached module's exports instead
  const entry = require.cache[require.resolve("@vercel/functions")];
  const original = entry.exports;
  const fns = { ...original };
  entry.exports = fns;
  const saved = { url: process.env.SITE_REVALIDATE_URL, secret: process.env.REVALIDATE_SECRET };
  changed().__setMock(null);
  try {
    fns.invalidateByTag = () => new Promise(() => {}); // a purge that never answers
    process.env.SITE_REVALIDATE_URL = `http://127.0.0.1:${stub.address().port}/api/revalidate`;
    process.env.REVALIDATE_SECRET = "s";
    const t0 = Date.now();
    const s = await changed().notifyTags(["site-hero"], "test");
    assert.ok(Date.now() - t0 < 5000);
    assert.equal(s.cdn.status, "timeout", JSON.stringify(s));
    assert.equal(s.site.status, "timeout", JSON.stringify(s));
    fns.invalidateByTag = async () => {};
    delete process.env.SITE_REVALIDATE_URL;
    const ok = await changed().notifyTags(["site-hero"], "test");
    assert.equal(ok.cdn.status, "ok");
    assert.equal(ok.site.status, "skipped");
  } finally {
    entry.exports = original;
    process.env.SITE_REVALIDATE_URL = saved.url;
    process.env.REVALIDATE_SECRET = saved.secret;
    changed().__setMock(notifyMock);
    stub.close();
  }
});

test("cost: Mongo operations per request stay small and bounded", async () => {
  const mongoose = require("mongoose");
  const seen = [];
  mongoose.set("debug", (collection, method) => seen.push(`${collection}.${method}`));
  const count = async (fn) => {
    seen.length = 0;
    await fn();
    await h.sleep(300); // background receipt prune / sweep trigger
    return seen.filter((x) => x.startsWith("sitesettings") || x.startsWith("adminauditlogs")).length;
  };
  try {
    const pub = await count(() => h.api("GET", "/site/hero"));
    assert.ok(pub <= 1, `public read: ${pub}`);
    const stage = await count(() => hh.stage(AT, "desktop", DESK));
    const stage2 = await count(() => hh.stage(AT, "mobile", MOB));
    const publishOps = await count(() => hh.publish(AT));
    const state = await count(() => hh.adminState(AT));
    console.log(`[site-hero] Mongo ops — public read ${pub}, draft ${stage}/${stage2} (incl. its state read), publish ${publishOps} (incl. its state read), admin state ${state}`);
    assert.ok(stage <= 14, `draft: ${stage}`);
    assert.ok(publishOps <= 14, `publish: ${publishOps}`);
    assert.ok(state <= 5, `admin state: ${state}`);
  } finally {
    mongoose.set("debug", false);
  }
});

test("contract: the server reproduces every crop and rendition vector shared with the site and admin; randomised crops stay in bounds", () => {
  const img = heroImage();
  const crop = require("./fixtures/hero-crop-vectors.json");
  for (const v of crop.vectors) {
    const r = img.cropRegion(v.width, v.height, v.slot, v.focal);
    assert.deepEqual({ left: r.left, top: r.top, width: r.width, height: r.height, cropped: r.cropped, deviation: Math.round(r.deviation * 1e6) / 1e6 }, v.expected, JSON.stringify(v));
  }
  const rend = require("./fixtures/hero-renditions-vectors.json");
  for (const v of rend.vectors) {
    const widths = img.heroRenditionWidths(v.masterWidth, v.slot);
    assert.deepEqual(widths, v.widths, JSON.stringify(v));
    assert.deepEqual(widths.map(img.renditionKeyWidth), v.keyWidths);
    assert.equal(new Set(v.keyWidths).size, v.keyWidths.length, "unique keys");
  }
  let seed = 42;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  for (let i = 0; i < 5000; i += 1) {
    const slot = rnd() < 0.5 ? "desktop" : "mobile";
    const w = 1 + Math.floor(rnd() * 9000);
    const hgt = 1 + Math.floor(rnd() * 9000);
    const focal = { x: rnd() * 1.4 - 0.2, y: rnd() * 1.4 - 0.2 }; // includes out-of-range values
    const r = img.cropRegion(w, hgt, slot, focal);
    assert.ok(Number.isInteger(r.left) && Number.isInteger(r.top) && Number.isInteger(r.width) && Number.isInteger(r.height));
    assert.ok(r.left >= 0 && r.top >= 0 && r.width >= 1 && r.height >= 1 && r.left + r.width <= w && r.top + r.height <= hgt, JSON.stringify({ w, hgt, focal, r }));
    if (r.cropped && r.width > 50 && r.height > 50) assert.ok(img.ratioDeviation(r.width, r.height, slot) < 0.02, "a crop has the box ratio");
    const widths = img.heroRenditionWidths(Math.min(r.width, img.SLOTS[slot].cap), slot);
    assert.ok(widths.length >= 1 && widths[widths.length - 1] <= img.SLOTS[slot].cap && widths.every((x, j) => j === 0 || x > widths[j - 1]));
  }
});

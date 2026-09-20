// Image pipeline — pre-generated display variants.
//
// Every accepted listing photo / profile picture is stored as its sanitised
// master plus a fixed set of immutable WebP display sizes derived from the
// master key; deletion takes the variants with the master; the owner-run
// backfill renders the same set for existing photos. Runs against the real
// app on the replica-set harness with the in-memory Spaces fake.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const h = require("./setup");

const User = () => require("../../models/User");
const ListingProperty = () => require("../../models/ListingProperty");
const AdminAuditLog = () => require("../../models/AdminAuditLog");
const storage = () => require("../../services/storage");
const sanitizer = () => require("../../services/imageSanitizer");
const backfill = () => require("../../scripts/image-variants-backfill");

const BUCKET = () => `https://${process.env.DO_SPACES_BUCKET}.${process.env.REGION}.digitaloceanspaces.com/`;
const WIDTHS = () => storage().VARIANT_WIDTHS;

let H, HT, O, OT, ADMIN, AT;
let PHOTO; // a textured 3000×2000 JPEG (a real camera photo, re-encoded)
let SMALL; // a 100×80 JPEG
let ALPHA; // a 1200×600 PNG with transparency

// A photo with real detail: gaussian noise over a gradient so every variant
// has something to encode (a flat colour would make every size a few bytes).
async function textured(width, height, format = "jpeg", extra = {}) {
  const sharp = require("sharp");
  let img = sharp({ create: { width, height, channels: 3, background: { r: 120, g: 140, b: 90 }, noise: { type: "gaussian", mean: 128, sigma: 40 } } });
  if (format === "png") {
    // transparent left half, opaque right half
    const mask = await sharp({ create: { width, height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
      .composite([{ input: await sharp({ create: { width: Math.floor(width / 2), height, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 1 } } }).png().toBuffer(), left: Math.floor(width / 2), top: 0 }])
      .png()
      .toBuffer();
    img = sharp(await img.png().toBuffer()).ensureAlpha().composite([{ input: mask, blend: "dest-in" }]);
    return img.png(extra).toBuffer();
  }
  return img.jpeg({ quality: 88, ...extra }).toBuffer();
}

async function upload(token, files, { path = "/uploads/", field = "images" } = {}) {
  const form = new FormData();
  for (const [name, buf, type] of files) form.append(field, new Blob([buf], { type }), name);
  const res = await fetch(`${h.baseUrl()}${path}`, { method: "POST", headers: token ? { authorization: `Bearer ${token}` } : {}, body: form });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = { raw: text };
  }
  return { status: res.status, body };
}

function objectsOf(masterKey) {
  return [...storage().__mock.objects.keys()].filter((k) => k === masterKey || k.startsWith(`${masterKey}/`));
}

test.before(async () => {
  await h.start();
  H = await h.makeUser({ role: "host", firstName: "Host", lastName: "Photos" });
  HT = h.userToken(H);
  O = await h.makeUser({ firstName: "Other", lastName: "User" });
  OT = h.userToken(O);
  ADMIN = await h.makeAdmin();
  AT = h.adminToken(ADMIN);
  PHOTO = await textured(3000, 2000);
  SMALL = await textured(100, 80);
  ALPHA = await textured(1200, 600, "png");
});

// ---------------------------------------------------------------------------
test("variants: every configured width from the master, never upscaled, aspect kept, WebP without metadata, transparency kept", async () => {
  const { makeVariants, hasMetadata } = sanitizer();
  const sharp = require("sharp");
  const { variants, errors } = await makeVariants(PHOTO);
  assert.deepEqual(errors, []);
  assert.deepEqual(variants.map((v) => v.width), WIDTHS());
  for (const v of variants) {
    const meta = await sharp(v.buffer).metadata();
    assert.equal(meta.format, "webp", `w${v.width} is WebP`);
    assert.equal(meta.width, v.actualWidth);
    assert.equal(v.actualWidth, Math.min(v.width, 3000), `w${v.width} → ${v.actualWidth} (never wider than the master)`);
    assert.ok(Math.abs(meta.height - Math.round(meta.width * (2000 / 3000))) <= 1, `w${v.width} keeps the 3:2 aspect (${meta.width}×${meta.height})`);
    assert.equal(await hasMetadata(v.buffer), false, `w${v.width} carries no metadata`);
  }
  const w3840 = variants.find((v) => v.width === 3840);
  assert.equal(w3840.actualWidth, 3000, "the widest key exists at the master's own width");
  assert.equal(w3840.reused, false, "3840 is the first width past the master: rendered once at 3000");
  // bytes grow with width (a real encode at every size)
  const sizes = variants.map((v) => v.buffer.length);
  for (let i = 1; i < sizes.length - 1; i++) assert.ok(sizes[i] > sizes[i - 1], `w${variants[i].width} (${sizes[i]} B) larger than w${variants[i - 1].width} (${sizes[i - 1]} B)`);

  // a master narrower than every width: all keys exist, one encode
  const small = await makeVariants(SMALL);
  assert.equal(small.variants.length, WIDTHS().length);
  assert.ok(small.variants.every((v) => v.actualWidth === 100));
  assert.equal(small.variants.filter((v) => v.reused).length, WIDTHS().length - 1, "the other widths reuse the first render");
  assert.ok(small.variants.every((v) => v.buffer === small.variants[0].buffer));

  // PNG with alpha → WebP keeps the alpha channel
  const png = await makeVariants(ALPHA, { widths: [640] });
  const pm = await sharp(png.variants[0].buffer).metadata();
  assert.equal(pm.hasAlpha, true);
  const { data } = await sharp(png.variants[0].buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  assert.equal(data[3], 0, "left half is transparent");
  assert.equal(data[(640 - 1) * 4 + 3], 255, "right half is opaque");

  // a legacy master that still carries an EXIF orientation is rotated like the sanitiser does
  const rotated = await sharp(PHOTO).withMetadata({ orientation: 6 }).toBuffer();
  const rv = await makeVariants(rotated, { widths: [640] });
  const rm = await sharp(rv.variants[0].buffer).metadata();
  assert.deepEqual([rm.width, rm.height], [640, 960], "EXIF orientation 6 baked into the variant");
  assert.equal(await hasMetadata(rv.variants[0].buffer), false);

  // a subset of widths (the backfill's missing set) renders exactly those
  const subset = await makeVariants(PHOTO, { widths: [1280, 160] });
  assert.deepEqual(subset.variants.map((v) => v.width), [160, 1280]);
});

test("sanitiser: a decompression bomb is refused before it is decoded (413 IMAGE_TOO_LARGE)", async () => {
  const sharp = require("sharp");
  // 48 megapixels of one colour: ~60 KB on disk, 190 MB decoded
  const bomb = await sharp({ create: { width: 8000, height: 6000, channels: 3, background: "#3366aa" }, limitInputPixels: false }).png({ compressionLevel: 9 }).toBuffer();
  assert.ok(bomb.length < 2 * 1024 * 1024, `fixture is small on disk (${bomb.length} B)`);
  const t0 = Date.now();
  await assert.rejects(() => sanitizer().sanitizeImage(bomb, "image/png"), (e) => e.code === "IMAGE_TOO_LARGE" && e.status === 413);
  assert.ok(Date.now() - t0 < 2000, "refused from the header, not after a decode");
  const r = await upload(HT, [["bomb.png", bomb, "image/png"]]);
  assert.equal(r.status, 413, JSON.stringify(r.body));
  assert.equal(r.body.code, "IMAGE_TOO_LARGE");
  // a photo at the realistic ceiling (24 MP) is still accepted
  const big = await sharp({ create: { width: 6000, height: 4000, channels: 3, background: "#336699" } }).jpeg().toBuffer();
  const clean = await sanitizer().sanitizeImage(big, "image/jpeg");
  assert.deepEqual([clean.width, clean.height], [6000, 4000]);
});

// ---------------------------------------------------------------------------
test("upload: master + every variant stored immutable, derived keys, response unchanged ({ urls } of masters)", async () => {
  storage().resetMock();
  const up = await upload(HT, [["Villa Front.JPG", PHOTO, "image/jpeg"], ["pool.png", ALPHA, "image/png"]]);
  assert.equal(up.status, 200, JSON.stringify(up.body));
  assert.equal(up.body.urls.length, 2);
  const keys = up.body.urls.map((u) => storage().keyFromUrl(u));
  assert.match(keys[0], new RegExp(`^listings/${H._id}/[0-9a-f-]{36}-Villa-Front.jpg$`));
  assert.match(keys[1], new RegExp(`^listings/${H._id}/[0-9a-f-]{36}-pool.png$`));
  assert.ok(keys.every((k) => !storage().isVariantKey(k)), "the URLs the client stores are the masters");
  const uploaded = storage().__mock.uploaded;
  assert.equal(uploaded.length, 2 * (1 + WIDTHS().length), "one master + one object per width, per file");
  for (const key of keys) {
    const mine = uploaded.filter((o) => o.key === key || o.key.startsWith(`${key}/`));
    assert.equal(mine[0].key, key, "the master is stored before its variants");
    assert.deepEqual(
      mine.slice(1).map((o) => o.key).sort(),
      storage().variantKeys(key).sort(),
      "variant keys are exactly the derived set",
    );
    for (const o of mine) assert.equal(o.cacheControl, storage().IMMUTABLE_CACHE_CONTROL, `${o.key} is immutable`);
    for (const o of mine.slice(1)) assert.equal(o.contentType, "image/webp");
  }
  assert.equal(uploaded.find((o) => o.key === keys[0]).contentType, "image/jpeg");
  assert.equal(uploaded.find((o) => o.key === keys[1]).contentType, "image/png");
  // the stored variants decode, are the expected sizes, and the PNG's alpha survived
  const sharp = require("sharp");
  const w640 = storage().__mock.objects.get(storage().variantKey(keys[1], 640));
  const m = await sharp(w640.body).metadata();
  assert.deepEqual([m.format, m.width, m.hasAlpha], ["webp", 640, true]);
  const w3840 = await sharp(storage().__mock.objects.get(storage().variantKey(keys[0], 3840)).body).metadata();
  assert.equal(w3840.width, 3000, "no upscaling: the 3840 key holds the master's own width");
  // variants and masters resolve to the same owner
  assert.equal(storage().ownerFromKey(storage().variantKey(keys[0], 640)), String(H._id));
});

test("upload: profile picture gets variants; replacing it removes the previous object and its variants (own, unreferenced elsewhere)", async () => {
  storage().resetMock();
  const first = await upload(HT, [["me.jpg", SMALL, "image/jpeg"]], { path: `/uploads/profile?userId=${H._id}`, field: "file" });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  const k1 = storage().keyFromUrl(first.body.url);
  assert.match(k1, new RegExp(`^profiles/${H._id}/`));
  assert.equal(objectsOf(k1).length, 1 + WIDTHS().length);
  assert.equal((await User().findById(H._id).lean()).profilePicture, first.body.url);

  const second = await upload(HT, [["me2.jpg", SMALL, "image/jpeg"]], { path: `/uploads/profile?userId=${H._id}`, field: "file" });
  assert.equal(second.status, 200);
  const k2 = storage().keyFromUrl(second.body.url);
  await h.sleep(50); // the old object is removed after the response
  assert.equal(objectsOf(k1).length, 0, "the replaced picture and its variants are gone");
  assert.equal(objectsOf(k2).length, 1 + WIDTHS().length);
  assert.ok(storage().__mock.deleted.includes(k1));
  assert.equal((await User().findById(H._id).lean()).profilePicture, second.body.url);

  // a legacy picture shared with another account is left alone
  const legacy = `${BUCKET()}1769315746961-shared.jpg`;
  await User().updateOne({ _id: H._id }, { $set: { profilePicture: legacy } });
  await User().updateOne({ _id: O._id }, { $set: { profilePicture: legacy } });
  storage().resetMock();
  const third = await upload(HT, [["me3.jpg", SMALL, "image/jpeg"]], { path: `/uploads/profile?userId=${H._id}`, field: "file" });
  assert.equal(third.status, 200);
  await h.sleep(50);
  assert.deepEqual(storage().__mock.deleted, [], "an object another profile still uses is not deleted");
  await User().updateOne({ _id: O._id }, { $unset: { profilePicture: 1 } });
});

test("delete: a photo's master and every variant go together, by master or variant URL, idempotently; listing deletion does the same", async () => {
  storage().resetMock();
  const up = await upload(HT, [["a.jpg", SMALL, "image/jpeg"], ["b.jpg", SMALL, "image/jpeg"]]);
  const [ka, kb] = up.body.urls.map((u) => storage().keyFromUrl(u));
  // a stray object from an older set under the same master is swept too
  await storage().putObject(`${ka}/v0/w640.webp`, Buffer.from("old"), "image/webp");
  assert.equal(objectsOf(ka).length, 1 + WIDTHS().length + 1);
  const del = (token, url) => h.api("DELETE", "/uploads/delete", { token, body: { url } });
  assert.equal((await del(OT, up.body.urls[0])).status, 403);
  assert.equal(objectsOf(ka).length, 1 + WIDTHS().length + 1, "nothing deleted for a foreign caller");
  assert.equal((await del(HT, up.body.urls[0])).status, 200);
  assert.equal(objectsOf(ka).length, 0, "master, every variant and the stray are gone");
  assert.ok(storage().__mock.purged.includes(ka) && storage().__mock.purged.includes(storage().variantKey(ka, 640)), "the deleted objects are purged from the CDN edges");
  assert.match(storage().IMMUTABLE_CACHE_CONTROL, /max-age=31536000/);
  assert.match(storage().IMMUTABLE_CACHE_CONTROL, /s-maxage=86400/, "the edge re-checks daily so a deleted photo cannot outlive s-maxage there");
  assert.equal((await del(HT, up.body.urls[0])).status, 200, "deleting again is fine (idempotent)");
  // the variant URL of a photo names the photo
  const variantUrl = storage().cdnUrl(storage().variantKey(kb, 960));
  assert.equal((await del(OT, variantUrl)).status, 403, "ownership is checked on the master");
  assert.equal((await del(HT, variantUrl)).status, 200);
  assert.equal(objectsOf(kb).length, 0);

  // admin listing deletion removes the listing's photos with their variants
  storage().resetMock();
  const up2 = await upload(HT, [["c.jpg", SMALL, "image/jpeg"]]);
  const kc = storage().keyFromUrl(up2.body.urls[0]);
  const L = await h.makeListing(H, { status: "processing", photos: [up2.body.urls[0]] });
  const r = await h.api("DELETE", `/properties/admin/${L._id}`, { token: AT });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.data.photosRemoved, 1);
  assert.equal(objectsOf(kc).length, 0);
  const audit = await AdminAuditLog().findOne({ targetId: L._id, action: "listing.delete" }).lean();
  assert.deepEqual(audit.details.photos.removed, [kc], "the audit row records photos (masters), not every object");
  assert.equal(audit.details.photos.cleanupStatus, "complete");

  // a variant that cannot be deleted keeps the photo in the retry set
  storage().resetMock();
  const up3 = await upload(HT, [["d.jpg", SMALL, "image/jpeg"], ["e.jpg", SMALL, "image/jpeg"]]);
  const [kd, ke] = up3.body.urls.map((u) => storage().keyFromUrl(u));
  storage().setMockFailure("partial");
  const res = await storage().deleteImages([kd, ke]);
  storage().setMockFailure(null);
  assert.deepEqual(res.deleted, [kd]);
  assert.equal(res.failed.length, 1);
  assert.equal(res.failed[0].key, ke, "failures are reported per photo, by master key");
  assert.equal(res.failed[0].objects.length, 1 + WIDTHS().length);
});

test("upload failures: a failed master fails the request and leaves no objects; a failed variant keeps the photo (master served meanwhile) and is logged", async () => {
  storage().resetMock();
  const errors = [];
  const orig = console.error;
  console.error = (...a) => errors.push(a.join(" "));
  try {
    storage().setMockFailure("put:-two.jpg");
    const r = await upload(HT, [["one.jpg", SMALL, "image/jpeg"], ["two.jpg", SMALL, "image/jpeg"]]);
    assert.equal(r.status, 500, JSON.stringify(r.body));
    assert.equal(storage().__mock.objects.size, 0, "the objects stored for the first file were removed again");
    storage().setMockFailure(null);

    storage().resetMock();
    storage().setMockFailure("put:/w960.webp");
    const ok = await upload(HT, [["three.jpg", SMALL, "image/jpeg"]]);
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    const k = storage().keyFromUrl(ok.body.urls[0]);
    assert.equal(objectsOf(k).length, 1 + WIDTHS().length - 1, "master + the other variants");
    assert.equal(storage().__mock.objects.has(storage().variantKey(k, 960)), false);
    assert.ok(errors.some((e) => e.includes("variant(s) not stored") && e.includes("w960")), `logged: ${errors.join(" | ")}`);
    storage().setMockFailure(null);

    // a corrupt file among good ones refuses the whole request before anything is stored
    storage().resetMock();
    const bad = await upload(HT, [["four.jpg", SMALL, "image/jpeg"], ["pdf.jpg", Buffer.from("%PDF-1.4 nope"), "image/jpeg"]]);
    assert.equal(bad.status, 400);
    assert.equal(bad.body.code, "INVALID_IMAGE");
    assert.equal(storage().__mock.objects.size, 0, "nothing stored");
  } finally {
    console.error = orig;
    storage().setMockFailure(null);
  }
});

test("upload: work is bounded — files one at a time, variants one at a time per file; a 20-file request completes", async () => {
  const { mapLimit, FILE_CONCURRENCY } = require("../../controllers/uploadController").__internals;
  let inFlight = 0;
  let peak = 0;
  await mapLimit(Array.from({ length: 9 }, (_, i) => i), FILE_CONCURRENCY, async () => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await h.sleep(5);
    inFlight -= 1;
  });
  assert.equal(peak, FILE_CONCURRENCY);
  storage().resetMock();
  const files = Array.from({ length: 20 }, (_, i) => [`p${i}.jpg`, SMALL, "image/jpeg"]);
  const t0 = Date.now();
  const r = await upload(HT, files);
  assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 200));
  assert.equal(r.body.urls.length, 20);
  assert.equal(storage().__mock.uploaded.length, 20 * (1 + WIDTHS().length));
  console.log(`[image-variants] 20 small files → ${storage().__mock.uploaded.length} objects in ${Date.now() - t0} ms`);
});

// ---------------------------------------------------------------------------
test("backfill: dry run writes nothing; apply renders the missing set from the bucket master; rerun is a no-op; limit, resume, retry, missing master, prune", async () => {
  storage().resetMock();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "variants-"));
  const stateFile = path.join(tmp, "state.json");
  const log = [];
  const logger = (line) => log.push(String(line));
  const { uri } = await h.start();

  // three legacy masters in the bucket (no variants yet), referenced by a listing and a profile,
  // one of them with EXIF (orientation + GPS) as legacy uploads may have
  const sharp = require("sharp");
  const legacy = await sharp(PHOTO).withMetadata({ orientation: 6, exif: { IFD0: { Make: "Canary" }, GPS: { GPSLatitudeRef: "N", GPSLatitude: "15/1 32/1 40/1" } } }).toBuffer();
  const m1 = "1769315746961-villa (front).jpg";
  const m2 = `listings/${H._id}/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa-pool.png`;
  const m3 = `profiles/${H._id}/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb-me.jpg`;
  await storage().putObject(m1, legacy, "image/jpeg");
  await storage().putObject(m2, ALPHA, "image/png");
  await storage().putObject(m3, SMALL, "image/jpeg");
  const dangling = `listings/${H._id}/cccccccc-cccc-4ccc-8ccc-cccccccccccc-gone.jpg`;
  const L = await h.makeListing(H, { status: "active", photos: [storage().publicUrl(m1), storage().cdnUrl(m2), "https://images.unsplash.com/photo-1.jpg", storage().publicUrl(dangling)] });
  await User().updateOne({ _id: H._id }, { $set: { profilePicture: storage().publicUrl(m3) } });
  const before = storage().__mock.uploaded.length;

  const dry = await backfill().run({ uri, apply: false, state: stateFile, concurrency: 2, limit: 0 }, logger);
  assert.equal(dry.masters, 4);
  assert.equal(dry.foreign, 1, "the unsplash reference is skipped");
  assert.equal(dry.wouldGenerate, 4);
  assert.equal(storage().__mock.uploaded.length, before, "dry run stores nothing");
  assert.ok(log.some((l) => /dry run/.test(l)));

  // --limit=1 then resume
  const one = await backfill().run({ uri, apply: true, state: stateFile, concurrency: 1, limit: 1 }, logger);
  assert.equal(one.generated, 1);
  assert.equal(one.variantsWritten, WIDTHS().length);
  const state1 = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  assert.equal(Object.keys(state1.done).length, 1);

  const rest = await backfill().run({ uri, apply: true, state: stateFile, concurrency: 2, limit: 0 }, logger);
  assert.equal(rest.skippedDone, 1, "resumed: the finished master is not re-listed");
  assert.equal(rest.generated, 2);
  assert.equal(rest.masterMissing, 1, "the dangling reference is reported, not invented");
  assert.equal(one.mastersWithMetadata + rest.mastersWithMetadata, 1, "the legacy master with EXIF is flagged for the strip script");
  for (const m of [m1, m2, m3]) {
    const keys = storage().variantKeys(m);
    for (const k of keys) {
      const o = storage().__mock.objects.get(k);
      assert.ok(o, `${k} exists`);
      assert.equal(o.contentType, "image/webp");
      assert.equal(o.cacheControl, storage().IMMUTABLE_CACHE_CONTROL);
    }
  }
  // the legacy master's EXIF orientation is honoured and no metadata survives
  const v = await sharp(storage().__mock.objects.get(storage().variantKey(m1, 640)).body).metadata();
  assert.deepEqual([v.width, v.height], [640, 960]);
  assert.equal(await sanitizer().hasMetadata(storage().__mock.objects.get(storage().variantKey(m1, 640)).body), false);
  const state2 = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  assert.equal(Object.keys(state2.done).length, 3);
  assert.deepEqual(Object.keys(state2.failed), [dangling]);

  // rerun: nothing to do (state) — and with --recheck the bucket is consulted and still nothing is written
  const again = await backfill().run({ uri, apply: true, state: stateFile, concurrency: 2, limit: 0 }, logger);
  assert.equal(again.generated, 0);
  assert.equal(again.skippedDone, 3);
  const n = storage().__mock.uploaded.length;
  const recheck = await backfill().run({ uri, apply: true, state: stateFile, concurrency: 2, limit: 0, recheck: true }, logger);
  assert.equal(recheck.complete, 3, "every variant present → complete, no render");
  assert.equal(storage().__mock.uploaded.length, n, "nothing re-uploaded");

  // a variant upload that fails is recorded and retried later with --retry (only the missing width is rendered)
  const m4 = `listings/${H._id}/dddddddd-dddd-4ddd-8ddd-dddddddddddd-deck.jpg`;
  await storage().putObject(m4, SMALL, "image/jpeg");
  await ListingProperty().updateOne({ _id: L._id }, { $push: { photos: storage().publicUrl(m4) } });
  storage().setMockFailure("put:/w1280.webp");
  const failing = await backfill().run({ uri, apply: true, state: stateFile, concurrency: 2, limit: 0, quiet: true }, logger);
  storage().setMockFailure(null);
  assert.equal(failing.failed, 1);
  const state3 = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  assert.ok(state3.failed[m4] && /w1280/.test(state3.failed[m4].error), JSON.stringify(state3.failed[m4]));
  assert.equal(state3.failed[m4].written.length, WIDTHS().length - 1);
  const uploadsBeforeRetry = storage().__mock.uploaded.length;
  const retried = await backfill().run({ uri, apply: true, state: stateFile, concurrency: 2, limit: 0, retry: true }, logger);
  assert.equal(retried.generated, 1);
  assert.equal(retried.variantsWritten, 1, "only the missing width was rendered and stored");
  assert.equal(storage().__mock.uploaded.length, uploadsBeforeRetry + 1);
  assert.equal(JSON.parse(fs.readFileSync(stateFile, "utf8")).failed[m4], undefined);

  // an existing but empty object counts as missing (a truncated upload is healed)
  storage().__mock.objects.set(storage().variantKey(m4, 320), { body: Buffer.alloc(0), contentType: "image/webp", cacheControl: "", lastModified: new Date() });
  const healed = await backfill().run({ uri, apply: true, state: stateFile, concurrency: 1, limit: 0, recheck: true, only: "deck.jpg" }, logger);
  assert.equal(healed.variantsWritten, 1);
  assert.ok(storage().__mock.objects.get(storage().variantKey(m4, 320)).body.length > 0);

  // prune: variants of an unreferenced master and an older set are orphans; masters are never touched
  const orphanMaster = `listings/${O._id}/eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee-old.jpg`;
  await storage().putObject(orphanMaster, SMALL, "image/jpeg");
  await storage().putObject(storage().variantKey(orphanMaster, 640), Buffer.from("x"), "image/webp");
  await storage().putObject(`${m2}/v0/w640.webp`, Buffer.from("x"), "image/webp");
  const pruneDry = await backfill().run({ uri, apply: false, state: stateFile, concurrency: 1, limit: 0, prune: true }, logger);
  assert.equal(pruneDry.prune.orphans, 2);
  assert.equal(pruneDry.prune.unreferencedMasters, 1);
  assert.equal(pruneDry.prune.deleted, 0);
  assert.ok(storage().__mock.objects.has(storage().variantKey(orphanMaster, 640)), "dry run deletes nothing");
  const pruneApply = await backfill().run({ uri, apply: true, state: stateFile, concurrency: 1, limit: 0, prune: true }, logger);
  assert.equal(pruneApply.prune.deleted, 2);
  assert.equal(storage().__mock.objects.has(storage().variantKey(orphanMaster, 640)), false);
  assert.equal(storage().__mock.objects.has(`${m2}/v0/w640.webp`), false);
  assert.ok(storage().__mock.objects.has(orphanMaster), "the unreferenced master itself is reported, not deleted");
  for (const m of [m1, m2, m3, m4]) for (const k of storage().variantKeys(m)) assert.ok(storage().__mock.objects.has(k), `${k} kept`);
  assert.ok(!log.join("\n").includes(process.env.DO_SPACES_SECRET), "no secret in the output");

  await ListingProperty().deleteOne({ _id: L._id });
  await User().updateOne({ _id: H._id }, { $unset: { profilePicture: 1 } });
  storage().resetMock();
});

// The site derives the same URLs (user.website src/lib/spaces-image.js). The
// vectors file is the contract: generated here from the server's naming, and
// asserted by the site's own check script — a change on one side that is not
// mirrored fails there.
test("variant URL vectors: the fixture matches the server's naming (contract with the site loader)", () => {
  const s = storage();
  const masters = [
    "listings/64f1c2a3b4c5d6e7f8a9b0c1/0b1e0c1a-1111-4222-8333-444455556666-Villa-Front.jpg",
    "profiles/64f1c2a3b4c5d6e7f8a9b0c1/0b1e0c1a-1111-4222-8333-444455556666-me.png",
    "1769315746961-villa (front).jpg",
    "1742666768717-pexels-frans-van-heerden-201846-1438834.jpg",
    "1769315746961-café photo+1.webp",
    "1769315746961-100%.jpg",
  ];
  const requested = [1, 160, 161, 700, 960, 1100, 1700, 2200, 2561, 3840, 5000];
  const vectors = [];
  for (const master of masters) {
    for (const host of ["origin", "cdn"]) {
      const src = host === "origin" ? s.publicUrl(master) : s.cdnUrl(master);
      vectors.push({ src, master, byWidth: Object.fromEntries(requested.map((w) => [w, s.cdnUrl(s.variantKey(master, s.variantWidthFor(w)))])) });
    }
  }
  // a variant URL used as a source maps to the same photo
  vectors.push({ src: s.cdnUrl(s.variantKey(masters[0], 960)), master: masters[0], byWidth: Object.fromEntries(requested.map((w) => [w, s.cdnUrl(s.variantKey(masters[0], s.variantWidthFor(w)))])) });
  const notOurs = ["https://images.unsplash.com/photo-1.jpg", "https://evil.example/listings/x.jpg", "/placeholder.svg", "https://majestic-escape-host-properties.blr1.digitaloceanspaces.com.evil.com/x.jpg", "http://majestic-escape-host-properties.blr1.digitaloceanspaces.com/x.jpg", "blob:https://majesticescape.in/1234", "data:image/png;base64,AAAA"];
  const fixture = { version: 1, set: s.VARIANT_SET, widths: s.VARIANT_WIDTHS, bucket: process.env.DO_SPACES_BUCKET, region: process.env.REGION, vectors, notOurs };
  const file = path.join(__dirname, "fixtures", "image-variant-vectors.json");
  if (process.env.WRITE_VECTORS === "1") fs.writeFileSync(file, JSON.stringify(fixture, null, 1) + "\n");
  const onDisk = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.deepEqual(onDisk, fixture, "tests/batch-s/fixtures/image-variant-vectors.json is out of date: regenerate with WRITE_VECTORS=1 and copy it to the site (scripts/check-image-loader.mjs)");
});

// Cost: the variants add no database work. An upload issues the same Mongo
// operations as before (actor resolution only); a profile-picture replacement
// adds the two reference lookups that guard the old object's deletion; the
// document stores the master URL only (no per-variant fields). The server has
// no Redis; viewing a photo never reaches this API at all (browser suite).
test("cost: uploads add no Mongo operations beyond the actor read; documents keep one URL per photo; no Redis anywhere", async () => {
  const mongoose = require("mongoose");
  const ops = [];
  const count = async (fn) => {
    ops.length = 0;
    mongoose.set("debug", (collection, method) => ops.push(`${collection}.${method}`));
    try {
      return await fn();
    } finally {
      mongoose.set("debug", false);
    }
  };
  storage().resetMock();
  const up = await count(() => upload(HT, [["a.jpg", SMALL, "image/jpeg"], ["b.jpg", SMALL, "image/jpeg"]]));
  assert.equal(up.status, 200);
  const uploadOps = ops.slice();
  assert.ok(uploadOps.length <= 2, `listing upload: ${uploadOps.join(", ")}`); // actor resolution (users.findOne [+ tokenVersion check])
  assert.ok(!uploadOps.some((o) => /insert|update/.test(o)), "an upload writes nothing to the database");
  const stored = await count(() => upload(HT, [["p.jpg", SMALL, "image/jpeg"]], { path: `/uploads/profile?userId=${H._id}`, field: "file" }));
  assert.equal(stored.status, 200);
  const profileOps = ops.slice();
  assert.ok(profileOps.length <= 6, `profile upload (first): ${profileOps.join(", ")}`);
  const doc = await User().findById(H._id).lean();
  assert.equal(doc.profilePicture, stored.body.url);
  assert.equal(Object.keys(doc).filter((k) => /variant|image|photo/i.test(k) && k !== "profilePicture").length, 0, "no variant metadata on the document");
  const docBytes = Buffer.byteLength(JSON.stringify(doc));
  assert.ok(docBytes < 4096, `user document stays small (${docBytes} B)`);
  // no Redis client anywhere in the API
  const fs = require("fs");
  const path = require("path");
  const root = path.join(__dirname, "..", "..");
  const files = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === "node_modules" || e.name === ".git" || e.name === "tests") continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(js|mjs|cjs|json)$/.test(e.name)) files.push(p);
    }
  })(root);
  // a require/import of a Redis client (a comment saying "no Redis" is not one)
  const redisRefs = files.filter((f) => /require\(["'](io)?redis["']\)|from ["'](io)?redis["']/.test(fs.readFileSync(f, "utf8")) && !/package-lock/.test(f));
  assert.deepEqual(redisRefs.map((f) => path.relative(root, f)), [], "no Redis client in server.me");
  const pkg = require("../../package.json");
  assert.ok(!Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).some((d) => /redis/i.test(d)), "no Redis dependency");
  await User().updateOne({ _id: H._id }, { $unset: { profilePicture: 1 } });
  storage().resetMock();
});

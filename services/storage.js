// DigitalOcean Spaces object helpers (Batch A2).
//
// Every object our clients reference is a public-read URL in one bucket, in
// either the origin form  https://<bucket>.<region>.digitaloceanspaces.com/<key>
// or the CDN form         https://<bucket>.<region>.cdn.digitaloceanspaces.com/<key>.
// keyFromUrl() canonicalises both to the bucket key so references are
// compared by object, never by URL string. Anything that is not exactly our
// bucket (other buckets, http, "digitaloceanspaces.com.evil.com", foreign
// hosts), or a key that could confuse path handling (".." segments, "//",
// leading "/", control characters, double-encoded separators) → null.
//
// New uploads get owner-bound keys: listings/<ownerId>/<uuid>-<name> and
// profiles/<ownerId>/<uuid>-<name>, so ownership of an object can be
// verified from the key itself. Legacy keys are flat "<timestamp>-<name>".
//
// Image variants (image pipeline): every public image is a sanitised master
// at its own key plus a fixed set of WebP display sizes stored *under* the
// master key, `<master key>/<set>/w<width>.webp`. The URLs are derived, never
// stored — the database keeps the master URL only — and the site derives
// the same URLs (user.website src/lib/spaces-image.js; the two are held in
// step by tests/batch-s/fixtures/image-variant-vectors.json). The set name is
// part of the key so a change of widths or quality ships as a new set (v2, …)
// beside the old one instead of overwriting objects that browsers and the
// CDN may cache for a year (Cache-Control: immutable).
//
// SPACES_MOCK=1 (tests only) swaps the S3 client for an in-memory fake that
// records uploads and deletions, serves HEAD/GET/LIST from what was put, and
// can be told to fail wholly, partially or for one key.
const crypto = require("crypto");

function bucket() {
  return process.env.DO_SPACES_BUCKET || "";
}
function region() {
  return process.env.REGION || "";
}
function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function hosts() {
  const b = bucket().toLowerCase();
  const r = region().toLowerCase();
  return [`${b}.${r}.digitaloceanspaces.com`, `${b}.${r}.cdn.digitaloceanspaces.com`];
}
// Regex usable in Mongo queries to find references to objects in our bucket.
function spacesUrlRegex() {
  return new RegExp("^https://" + escapeRe(bucket()) + "\\." + escapeRe(region()) + "(\\.cdn)?\\.digitaloceanspaces\\.com/", "i");
}

// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\x00-\x1f\x7f]/;
function keyFromUrl(url) {
  if (typeof url !== "string" || !url) return null;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:") return null;
  if (!hosts().includes(parsed.hostname.toLowerCase())) return null;
  let key;
  try {
    key = decodeURIComponent(parsed.pathname.slice(1));
  } catch {
    return null;
  }
  if (!key) return null;
  if (CONTROL_RE.test(key)) return null;
  if (key.startsWith("/") || key.includes("//")) return null;
  if (key.split("/").some((seg) => seg === "..")) return null;
  return key;
}

// Owner id embedded in an owner-bound key, or null for legacy keys.
const OWNER_RE = /^(listings|profiles)\/([0-9a-fA-F]{24})\//;
function ownerFromKey(key) {
  const m = typeof key === "string" ? key.match(OWNER_RE) : null;
  return m ? m[2].toLowerCase() : null;
}

function sanitizeName(name) {
  const base = String(name || "file")
    .split(/[\\/]/)
    .pop()
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9._-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[.-]+/, "");
  return (base || "file").slice(0, 80);
}
function makeUploadKey(kind, ownerId, originalName) {
  return `${kind}/${String(ownerId)}/${crypto.randomUUID()}-${sanitizeName(originalName)}`;
}

function encodeKey(key) {
  return key.split("/").map(encodeURIComponent).join("/");
}
function publicUrl(key) {
  return `https://${bucket()}.${region()}.digitaloceanspaces.com/${encodeKey(key)}`;
}
function cdnUrl(key) {
  return `https://${bucket()}.${region()}.cdn.digitaloceanspaces.com/${encodeKey(key)}`;
}

// --- image variants ----------------------------------------------------------
const VARIANT_SET = "v1";
// Display widths (px). Chosen from the rendered widths of the site's media
// surfaces at 390–1920 CSS px and DPR 1–3 (see docs/image-pipeline.md); the
// largest exists so a retina desktop lightbox never has to upscale.
const VARIANT_WIDTHS = [160, 320, 640, 960, 1280, 1600, 1920, 2560, 3840];
const VARIANT_FORMAT = "webp";
const VARIANT_CONTENT_TYPE = "image/webp";
// Objects are addressed by unique keys (uuid / timestamp masters, versioned
// variant sets), so browsers may keep them for a year (max-age, immutable).
// The CDN edge re-checks the origin daily (s-maxage — the Spaces CDN honours
// it, measured): a deleted photo leaves every edge within 24 h even without
// a purge, and purgeCdn() removes it at once when DO_API_TOKEN is configured.
const IMMUTABLE_CACHE_CONTROL = "public, max-age=31536000, s-maxage=86400, immutable";
const VARIANT_KEY_RE = /^(.+)\/(v[0-9]+)\/w([0-9]{2,4})\.webp$/;

function isVariantKey(key) {
  return typeof key === "string" && VARIANT_KEY_RE.test(key);
}
// The master key an object belongs to (a variant key → its master; anything
// else is its own master).
function masterKeyOf(key) {
  const m = typeof key === "string" ? key.match(VARIANT_KEY_RE) : null;
  return m ? m[1] : key;
}
function variantKey(masterKey, width, set = VARIANT_SET) {
  return `${masterKey}/${set}/w${width}.${VARIANT_FORMAT}`;
}
function variantKeys(masterKey, set = VARIANT_SET) {
  return VARIANT_WIDTHS.map((w) => variantKey(masterKey, w, set));
}
// Every object that belongs to a master lives under this prefix.
function variantPrefix(masterKey) {
  return `${masterKey}/`;
}
// The variant a display width maps to: the smallest that is at least as
// wide, the largest when nothing is. Mirrors the site loader.
function variantWidthFor(width) {
  const w = Number(width) || 0;
  return VARIANT_WIDTHS.find((v) => v >= w) || VARIANT_WIDTHS[VARIANT_WIDTHS.length - 1];
}

// --- upload / deletion -----------------------------------------------------
const mock = {
  deleted: [], // every object key deleted (masters and variants)
  purged: [], // keys handed to the CDN purge
  uploaded: [],
  objects: new Map(),
  failMode: null,
  calls: 0,
  listCalls: 0,
  // the photos deleted: master keys only (tests reason in photos)
  get photosDeleted() {
    return this.deleted.filter((k) => !isVariantKey(k));
  },
};
function setMockFailure(mode) {
  mock.failMode = mode || null;
}
function resetMock() {
  mock.deleted = [];
  mock.purged = [];
  mock.uploaded = [];
  mock.objects = new Map();
  mock.failMode = null;
  mock.calls = 0;
  mock.listCalls = 0;
}
class MockFailure extends Error {
  constructor(message, code = "MockFailure") {
    super(message);
    this.code = code;
    this.statusCode = 503;
  }
}
// failMode: "all" | "partial" | "put:<key substring>" | "head:<key substring>" | "list"
function mockFails(op, key) {
  const mode = mock.failMode;
  if (!mode) return false;
  if (mode === "all") return true;
  const [what, needle] = String(mode).split(":", 2);
  return what === op && (needle === undefined || String(key).includes(needle));
}

// Uploads one public-read object; resolves to its origin URL.
async function putObject(key, body, contentType, { cacheControl = IMMUTABLE_CACHE_CONTROL } = {}) {
  if (process.env.SPACES_MOCK === "1") {
    if (mockFails("put", key)) throw new MockFailure(`mock: put failed for ${key}`);
    mock.uploaded.push({ key, contentType, cacheControl, bytes: body ? body.length : 0 });
    mock.objects.set(key, { body: Buffer.isBuffer(body) ? Buffer.from(body) : Buffer.from(String(body || "")), contentType, cacheControl, lastModified: new Date() });
    return publicUrl(key);
  }
  const s3 = require("../config/digitalOcean.config");
  const result = await s3.upload({ Bucket: bucket(), Key: key, Body: body, ACL: "public-read", ContentType: contentType, CacheControl: cacheControl }).promise();
  return result.Location;
}

// HEAD of one object: { size, contentType, cacheControl, etag, lastModified } or null when missing.
async function headObject(key) {
  if (process.env.SPACES_MOCK === "1") {
    if (mockFails("head", key)) throw new MockFailure(`mock: head failed for ${key}`);
    const o = mock.objects.get(key);
    return o ? { size: o.body.length, contentType: o.contentType, cacheControl: o.cacheControl, etag: `"${crypto.createHash("md5").update(o.body).digest("hex")}"`, lastModified: o.lastModified } : null;
  }
  const s3 = require("../config/digitalOcean.config");
  try {
    const h = await s3.headObject({ Bucket: bucket(), Key: key }).promise();
    return { size: Number(h.ContentLength) || 0, contentType: h.ContentType || "", cacheControl: h.CacheControl || "", etag: h.ETag || "", lastModified: h.LastModified || null };
  } catch (e) {
    if (e.statusCode === 404 || e.code === "NotFound" || e.code === "NoSuchKey") return null;
    throw e;
  }
}

// The bytes of one object (masters are read this way by the backfill so a
// stale CDN copy can never be the source of a variant), null when missing.
async function getObject(key) {
  if (process.env.SPACES_MOCK === "1") {
    if (mockFails("get", key)) throw new MockFailure(`mock: get failed for ${key}`);
    const o = mock.objects.get(key);
    return o ? { body: Buffer.from(o.body), contentType: o.contentType } : null;
  }
  const s3 = require("../config/digitalOcean.config");
  try {
    const r = await s3.getObject({ Bucket: bucket(), Key: key }).promise();
    return { body: Buffer.isBuffer(r.Body) ? r.Body : Buffer.from(r.Body), contentType: r.ContentType || "" };
  } catch (e) {
    if (e.statusCode === 404 || e.code === "NotFound" || e.code === "NoSuchKey") return null;
    throw e;
  }
}

// Every key under a prefix (paginated), as [{ key, size, lastModified }].
async function listKeys(prefix, { limit = Infinity } = {}) {
  if (process.env.SPACES_MOCK === "1") {
    mock.listCalls += 1;
    if (mockFails("list", prefix)) throw new MockFailure(`mock: list failed for ${prefix}`);
    return [...mock.objects.entries()]
      .filter(([k]) => k.startsWith(prefix))
      .map(([key, o]) => ({ key, size: o.body.length, lastModified: o.lastModified }))
      .slice(0, limit);
  }
  const s3 = require("../config/digitalOcean.config");
  const out = [];
  let token;
  do {
    const page = await s3.listObjectsV2({ Bucket: bucket(), Prefix: prefix, ContinuationToken: token, MaxKeys: 1000 }).promise();
    for (const o of page.Contents || []) out.push({ key: o.Key, size: Number(o.Size) || 0, lastModified: o.LastModified || null });
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token && out.length < limit);
  return out.length > limit ? out.slice(0, limit) : out;
}

async function deleteObjects(keys) {
  const unique = [...new Set((keys || []).filter((k) => typeof k === "string" && k))];
  const out = { deleted: [], failed: [] };
  if (!unique.length) return out;
  if (process.env.SPACES_MOCK === "1") {
    mock.calls += 1;
    if (mock.failMode === "all") {
      out.failed = unique.map((key) => ({ key, code: "MockFailure", message: "mock: spaces unavailable" }));
      return out;
    }
    // "partial": every second photo fails (a master and its variants fail together)
    const groups = [...new Set(unique.map(masterKeyOf))];
    unique.forEach((key) => {
      if (mock.failMode === "partial" && groups.indexOf(masterKeyOf(key)) % 2 === 1) out.failed.push({ key, code: "MockFailure", message: "mock: partial failure" });
      else {
        mock.deleted.push(key);
        mock.objects.delete(key);
        out.deleted.push(key);
      }
    });
    return out;
  }
  const s3 = require("../config/digitalOcean.config");
  for (let i = 0; i < unique.length; i += 1000) {
    const batch = unique.slice(i, i + 1000);
    try {
      const result = await s3
        .deleteObjects({ Bucket: bucket(), Delete: { Objects: batch.map((Key) => ({ Key })), Quiet: false } })
        .promise();
      const errored = new Set();
      for (const e of result.Errors || []) {
        errored.add(e.Key);
        out.failed.push({ key: e.Key, code: e.Code, message: e.Message });
      }
      for (const key of batch) if (!errored.has(key)) out.deleted.push(key);
    } catch (err) {
      for (const key of batch) out.failed.push({ key, code: err.code || "RequestFailed", message: err.message });
    }
  }
  return out;
}

// --- CDN purge ------------------------------------------------------------------
// Best effort, after a delete: the DigitalOcean CDN API drops the deleted
// objects from every edge at once instead of at the end of s-maxage. Needs a
// DigitalOcean API token with CDN scope in DO_API_TOKEN (not the Spaces
// keys); without it the call is skipped and the edge expiry applies.
let cdnEndpointId = null;
async function purgeCdn(keys) {
  const unique = [...new Set((keys || []).filter((k) => typeof k === "string" && k))];
  if (!unique.length) return { purged: 0, skipped: "nothing" };
  if (process.env.SPACES_MOCK === "1") {
    mock.purged.push(...unique);
    return { purged: unique.length };
  }
  const token = process.env.DO_API_TOKEN;
  if (!token) return { purged: 0, skipped: "DO_API_TOKEN not configured" };
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  try {
    if (!cdnEndpointId) {
      const res = await fetch("https://api.digitalocean.com/v2/cdn/endpoints?per_page=200", { headers });
      if (!res.ok) throw new Error(`endpoints ${res.status}`);
      const origin = `${bucket()}.${region()}.digitaloceanspaces.com`;
      const ep = ((await res.json()).endpoints || []).find((e) => String(e.origin).toLowerCase() === origin);
      if (!ep) throw new Error(`no CDN endpoint for ${origin}`);
      cdnEndpointId = ep.id;
    }
    for (let i = 0; i < unique.length; i += 50) {
      const res = await fetch(`https://api.digitalocean.com/v2/cdn/endpoints/${cdnEndpointId}/cache`, { method: "DELETE", headers, body: JSON.stringify({ files: unique.slice(i, i + 50) }) });
      if (!res.ok && res.status !== 204) throw new Error(`purge ${res.status}`);
    }
    return { purged: unique.length };
  } catch (err) {
    console.error("storage: CDN purge failed (objects expire from the edge within s-maxage)", err && err.message);
    return { purged: 0, error: String(err && err.message) };
  }
}

// Deletes images: each master key together with every object under its
// variant prefix (the derived variant keys plus whatever a prefix listing
// finds — older sets, strays). Idempotent: a key that no longer exists is a
// successful delete for S3, and a failed listing only narrows the sweep to
// the derived keys. Variant keys passed directly are deleted as themselves.
// The deleted objects are purged from the CDN edges (best effort).
async function deleteImages(keys) {
  const masters = [...new Set((keys || []).filter((k) => typeof k === "string" && k))];
  const all = new Set();
  for (const key of masters) {
    all.add(key);
    if (isVariantKey(key)) continue;
    for (const v of variantKeys(key)) all.add(v);
    try {
      for (const o of await listKeys(variantPrefix(key))) all.add(o.key);
    } catch (err) {
      console.error("storage: variant listing failed, deleting the derived keys only", key, err && err.message);
    }
  }
  const result = await deleteObjects([...all]);
  if (result.deleted.length) await purgeCdn(result.deleted);
  // Results are per photo. A master counts as deleted only when every object
  // under it went: a leftover variant is still a public object of a deleted
  // photo, so the master stays in the caller's retry set
  // (scripts/repair-deleted-listings.js retries whole masters; repeating a
  // delete is free for S3). `failed` carries one entry per photo with the
  // first error and the objects that remain.
  const failedByMaster = new Map();
  for (const f of result.failed) {
    const master = masterKeyOf(f.key);
    const entry = failedByMaster.get(master) || { key: master, code: f.code, message: f.message, objects: [] };
    entry.objects.push(f.key);
    failedByMaster.set(master, entry);
  }
  return {
    deleted: masters.filter((k) => !failedByMaster.has(k)),
    failed: [...failedByMaster.values()],
    objectsDeleted: result.deleted.length,
    objectsFailed: result.failed.length,
  };
}

module.exports = {
  keyFromUrl,
  ownerFromKey,
  makeUploadKey,
  sanitizeName,
  publicUrl,
  cdnUrl,
  encodeKey,
  spacesUrlRegex,
  putObject,
  headObject,
  getObject,
  listKeys,
  deleteObjects,
  deleteImages,
  purgeCdn,
  VARIANT_SET,
  VARIANT_WIDTHS,
  VARIANT_FORMAT,
  VARIANT_CONTENT_TYPE,
  IMMUTABLE_CACHE_CONTROL,
  isVariantKey,
  masterKeyOf,
  variantKey,
  variantKeys,
  variantPrefix,
  variantWidthFor,
  __mock: mock,
  setMockFailure,
  resetMock,
};

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
// SPACES_MOCK=1 (tests only) swaps the S3 client for an in-memory fake that
// records deletions and can be told to fail wholly or partially.
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

function publicUrl(key) {
  return `https://${bucket()}.${region()}.digitaloceanspaces.com/${key.split("/").map(encodeURIComponent).join("/")}`;
}

// --- upload / deletion -----------------------------------------------------
const mock = { deleted: [], uploaded: [], failMode: null, calls: 0 };
function setMockFailure(mode) {
  mock.failMode = mode || null;
}
function resetMock() {
  mock.deleted = [];
  mock.uploaded = [];
  mock.failMode = null;
  mock.calls = 0;
}

// Uploads one public-read object; resolves to its origin URL.
async function putObject(key, body, contentType) {
  if (process.env.SPACES_MOCK === "1") {
    mock.uploaded.push({ key, contentType, bytes: body ? body.length : 0 });
    return publicUrl(key);
  }
  const s3 = require("../config/digitalOcean.config");
  const result = await s3.upload({ Bucket: bucket(), Key: key, Body: body, ACL: "public-read", ContentType: contentType }).promise();
  return result.Location;
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
    unique.forEach((key, i) => {
      if (mock.failMode === "partial" && i % 2 === 1) out.failed.push({ key, code: "MockFailure", message: "mock: partial failure" });
      else {
        mock.deleted.push(key);
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

module.exports = {
  keyFromUrl,
  ownerFromKey,
  makeUploadKey,
  sanitizeName,
  publicUrl,
  spacesUrlRegex,
  putObject,
  deleteObjects,
  __mock: mock,
  setMockFailure,
  resetMock,
};

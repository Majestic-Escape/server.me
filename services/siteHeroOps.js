// Safe retries for the homepage-hero admin actions (docs/site-hero.md).
//
// Every mutation carries an op token the server issued: `v1.<payload>.<mac>`
// with payload { n: uuid (the operation id), a: admin id, t: issued at },
// HMAC-SHA256 under a key derived from JWT_SECRET (no new secret). Tokens
// are valid for 30 minutes on the server clock.
//
// The outcome of every mutation is written as a receipt inside the very
// update that makes the change (and in the same transaction as its audit
// row), keyed by the operation id and a fingerprint of the request. So:
//  - a retry after a lost response finds its receipt and gets the recorded
//    result — never applied twice, never audited twice — even when other
//    admins have changed the banner since (their version bumps would make a
//    naive retry look like a conflict);
//  - the same id with different content (another file, crop, description)
//    is refused (OP_ID_REUSED);
//  - an id with no receipt whose token is older than 30 minutes is refused
//    (OP_EXPIRED): an old retry can never silently become a new operation.
// Receipts are kept at least 7 days (far past token validity) and bounded
// to 500; a receipt that is still retryable (younger than 30 minutes) is
// never evicted — the 501st such operation is refused instead.
const crypto = require("crypto");

const TOKEN_TTL_MS = 30 * 60 * 1000;
const TOKEN_SKEW_MS = 60 * 1000; // tokens "from the future" beyond this are refused
const RECEIPT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const RECEIPT_CAP = 500;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

class HeroError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

let cached = { secret: null, key: null };
function macKey() {
  const secret = process.env.JWT_SECRET || "";
  if (!secret) throw new HeroError(500, "SERVER_MISCONFIGURED", "JWT_SECRET is not set");
  if (cached.secret !== secret) cached = { secret, key: Buffer.from(crypto.hkdfSync("sha256", secret, "majestic-site-hero", "site-hero-op-v1", 32)) };
  return cached.key;
}
const b64u = (buf) => Buffer.from(buf).toString("base64url");
const mac = (payload) => crypto.createHmac("sha256", macKey()).update(payload).digest();

function issueOpToken(actorId, now = Date.now()) {
  const payload = b64u(JSON.stringify({ n: crypto.randomUUID(), a: String(actorId), t: now }));
  return `v1.${payload}.${b64u(mac(payload))}`;
}

/**
 * @returns {{ opId: string, issuedAt: number, expired: boolean }}
 * @throws {HeroError} 400 missing/malformed, 403 forged or another admin's
 */
function readOpToken(token, actorId, now = Date.now()) {
  if (typeof token !== "string" || !token || token.length > 512) throw new HeroError(400, "OP_TOKEN_REQUIRED", "This action needs a fresh page — reload and try again");
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== "v1" || !parts[1] || !parts[2]) throw new HeroError(400, "OP_TOKEN_INVALID", "Invalid operation token");
  const expected = mac(parts[1]);
  let given;
  try {
    given = Buffer.from(parts[2], "base64url");
  } catch {
    given = Buffer.alloc(0);
  }
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) throw new HeroError(403, "OP_TOKEN_INVALID", "Invalid operation token");
  let body;
  try {
    body = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    throw new HeroError(400, "OP_TOKEN_INVALID", "Invalid operation token");
  }
  if (!body || typeof body.n !== "string" || !UUID_RE.test(body.n) || typeof body.a !== "string" || !Number.isFinite(body.t)) throw new HeroError(400, "OP_TOKEN_INVALID", "Invalid operation token");
  if (body.a !== String(actorId)) throw new HeroError(403, "OP_TOKEN_FOREIGN", "This operation token belongs to another admin");
  return { opId: body.n, issuedAt: body.t, expired: now - body.t > TOKEN_TTL_MS || body.t - now > TOKEN_SKEW_MS };
}

// Stable JSON (sorted keys) → sha256: the fingerprint of a request.
function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}`;
  return JSON.stringify(v === undefined ? null : v);
}
function fingerprint(request) {
  return crypto.createHash("sha256").update(canonical(request)).digest("hex");
}

function findReceipt(doc, opId) {
  return ((doc && doc.receipts) || []).find((r) => r && r.opId === opId) || null;
}

/**
 * Decides what to do with an operation before anything is changed.
 * @returns {{ replay: object } | { proceed: true }}
 * @throws {HeroError} OP_ID_REUSED, OP_EXPIRED, HERO_TOO_MANY_OPS
 */
function checkOperation(doc, op, { actorId, fingerprint: fp }, now = Date.now()) {
  const r = findReceipt(doc, op.opId);
  if (r) {
    if (String(r.actorId) !== String(actorId) || r.fingerprint !== fp) throw new HeroError(422, "OP_ID_REUSED", "This operation was already used for a different change — reload and try again");
    return { replay: r };
  }
  if (op.expired) throw new HeroError(410, "OP_EXPIRED", "This page has been open too long — reload and try again");
  const retryable = ((doc && doc.receipts) || []).filter((x) => x && x.at && now - new Date(x.at).getTime() < TOKEN_TTL_MS).length;
  if (retryable >= RECEIPT_CAP) throw new HeroError(429, "HERO_TOO_MANY_OPS", "Too many banner changes in a short time — wait a few minutes");
  return { proceed: true };
}

function receipt({ opId, actorId, action, target, fingerprint: fp, status, result }, now = new Date()) {
  return { opId, actorId, action, target, fingerprint: fp, status, result: result || {}, at: now };
}
// Appended atomically with the change; the cap keeps the newest 500.
function pushReceipt(r) {
  return { $each: [r], $slice: -RECEIPT_CAP };
}
// Best effort after a write: receipts past the retention window go.
function pruneFilter(now = Date.now()) {
  return { at: { $lt: new Date(now - RECEIPT_TTL_MS) } };
}

module.exports = {
  HeroError,
  TOKEN_TTL_MS,
  RECEIPT_TTL_MS,
  RECEIPT_CAP,
  UUID_RE,
  issueOpToken,
  readOpToken,
  fingerprint,
  canonical,
  findReceipt,
  checkOperation,
  receipt,
  pushReceipt,
  pruneFilter,
};

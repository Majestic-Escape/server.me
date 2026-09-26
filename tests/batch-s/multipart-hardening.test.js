// Phase 0b — multer 2.4.0 with explicit limits (utils/multipart.js).
//
// multer's defaults for field count, field-name nesting and array indexes
// are Infinity, so the upgrade alone would not close the field-name DoS
// advisories; the upload routes now set every limit and answer parser/limit
// failures with 4xx instead of the global 500. Crafted bodies are written by
// hand so nothing here depends on a well-behaved client.
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const h = require("./setup");

const storage = () => require("../../services/storage");

const BOUNDARY = "----heroTestBoundary7MA4YWxkTrZu0gW";
const MB5 = 5 * 1024 * 1024;
let U, UT;

const textPart = (name, value) => Buffer.from(`--${BOUNDARY}\r\nContent-Disposition: form-data${name === null ? "" : `; name="${name}"`}\r\n\r\n${value}\r\n`);
const filePart = (name, filename, type, buf) =>
  Buffer.concat([Buffer.from(`--${BOUNDARY}\r\nContent-Disposition: form-data; name="${name}"; filename="${filename}"\r\nContent-Type: ${type}\r\n\r\n`), buf, Buffer.from("\r\n")]);
const end = () => Buffer.from(`--${BOUNDARY}--\r\n`);

async function send(path, parts, { token = UT, close = true } = {}) {
  const body = Buffer.concat([...parts, ...(close ? [end()] : [])]);
  const res = await fetch(`${h.baseUrl()}${path}`, {
    method: "POST",
    headers: { "content-type": `multipart/form-data; boundary=${BOUNDARY}`, ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body,
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  return { status: res.status, body: json };
}
const alive = async () => assert.equal((await h.api("GET", "/properties/front/dynamic")).status, 200, "the server still answers");

test.before(async () => {
  await h.start();
  U = await h.makeUser({ role: "host" });
  UT = h.userToken(U);
});
test.after(async () => h.stop());
test.beforeEach(() => storage().resetMock());

test("auth runs before the body is parsed: an anonymous 5 MB upload is refused with 401", async () => {
  const r = await send("/uploads/", [filePart("images", "a.jpg", "image/jpeg", Buffer.alloc(MB5, 1))], { token: null });
  assert.equal(r.status, 401);
  assert.equal(storage().__mock.uploaded.length, 0);
});

test("crafted field names: oversized array index, deep nesting, a part without a name → 400, never a crash", async () => {
  const idx = await send("/uploads/", [textPart("x[99999999]", "1")]);
  assert.equal(idx.status, 400, JSON.stringify(idx.body));
  assert.equal(idx.body.reason, "LIMIT_FIELD_ARRAY_INDEX");

  const nest = await send("/uploads/", [textPart("a[b][c][d][e]", "1")]);
  assert.equal(nest.status, 400, JSON.stringify(nest.body));
  assert.equal(nest.body.reason, "LIMIT_FIELD_NESTING");

  const unnamed = await send("/uploads/", [textPart(null, "1")]);
  assert.equal(unnamed.status, 400, JSON.stringify(unnamed.body));

  const empty = await send("/uploads/", [textPart("", "1")]);
  assert.ok(empty.status >= 400 && empty.status < 500, `empty name → ${empty.status}`);

  const longName = await send("/uploads/", [textPart("n".repeat(200), "1")]);
  assert.equal(longName.status, 400);
  assert.equal(longName.body.reason, "LIMIT_FIELD_KEY");
  await alive();
});

test("counts: too many fields or files → 400; the profile route takes exactly one file", async () => {
  const fields = await send("/uploads/", Array.from({ length: 11 }, (_, i) => textPart(`f${i}`, "v")));
  assert.equal(fields.status, 400, JSON.stringify(fields.body));
  assert.match(fields.body.reason, /LIMIT_(FIELD|PART)_COUNT/);

  const small = Buffer.alloc(32, 7);
  const files = await send("/uploads/", Array.from({ length: 21 }, (_, i) => filePart("images", `p${i}.jpg`, "image/jpeg", small)));
  assert.equal(files.status, 400, JSON.stringify(files.body));
  assert.equal(files.body.code, "UPLOAD_REJECTED");

  const two = await send(`/uploads/profile?userId=${U._id}`, [filePart("file", "a.jpg", "image/jpeg", small), filePart("file", "b.jpg", "image/jpeg", small)]);
  assert.equal(two.status, 400, JSON.stringify(two.body));
  assert.equal(storage().__mock.uploaded.length, 0, "nothing stored");
  await alive();
});

test("size: exactly 5 MB passes the parser (and is judged by the sanitiser); 5 MB + 1 byte → 413 FILE_TOO_LARGE", async () => {
  const exact = await send("/uploads/", [filePart("images", "a.jpg", "image/jpeg", Buffer.alloc(MB5, 1))]);
  assert.equal(exact.status, 400, JSON.stringify(exact.body));
  assert.equal(exact.body.code, "INVALID_IMAGE", "reached the sanitiser — the parser accepted exactly 5 MB");

  const over = await send("/uploads/", [filePart("images", "a.jpg", "image/jpeg", Buffer.alloc(MB5 + 1, 1))]);
  assert.equal(over.status, 413, JSON.stringify(over.body));
  assert.equal(over.body.code, "FILE_TOO_LARGE");
  assert.equal(storage().__mock.uploaded.length, 0);
});

test("type: a refused mimetype → 415 UNSUPPORTED_FILE_TYPE (was a 500)", async () => {
  const r = await send("/uploads/", [filePart("images", "notes.txt", "text/plain", Buffer.from("hello"))]);
  assert.equal(r.status, 415, JSON.stringify(r.body));
  assert.equal(r.body.code, "UNSUPPORTED_FILE_TYPE");
});

test("a truncated body (no closing boundary) → 400 MALFORMED_UPLOAD", async () => {
  const r = await send("/uploads/", [filePart("images", "a.jpg", "image/jpeg", Buffer.alloc(1024, 3))], { close: false });
  assert.equal(r.status, 400, JSON.stringify(r.body));
  assert.equal(r.body.code, "MALFORMED_UPLOAD");
  await alive();
});

test("an upload aborted mid-stream does not take the server down", async () => {
  const url = new URL(`${h.baseUrl()}/uploads/`);
  await new Promise((resolve) => {
    const req = http.request(
      { hostname: url.hostname, port: url.port, path: url.pathname, method: "POST", headers: { "content-type": `multipart/form-data; boundary=${BOUNDARY}`, "content-length": String(MB5), authorization: `Bearer ${UT}` } },
      () => resolve(),
    );
    req.on("error", () => resolve());
    req.write(Buffer.concat([Buffer.from(`--${BOUNDARY}\r\nContent-Disposition: form-data; name="images"; filename="a.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`), Buffer.alloc(64 * 1024, 5)]));
    setTimeout(() => {
      req.destroy();
      resolve();
    }, 150);
  });
  await h.sleep(200);
  await alive();
  assert.equal(storage().__mock.uploaded.length, 0);
});

// The contact-information detector mirrored from majestic-chat
// (utils/contactModeration.js, generated) must agree with the golden corpus
// byte for byte with the chat server's copy: every vector's verdict and
// masked output, the cross-message sequences, the cross-field cases, the
// exact-address cases and the name policy. The corpus hash is pinned here and
// in majestic-chat; the release harness (tests/pw-final/corpus-parity.mjs)
// additionally asserts the two files are identical.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const m = require("../../utils/contactModeration");

const CONTACT_VECTORS_SHA256 = "17bcca5570ccba248be77dc95e32c3a3b5c6dfb8746d15743638626181f25df8";

const raw = fs.readFileSync(path.join(__dirname, "fixtures", "contact-vectors.json"));
const corpus = JSON.parse(raw.toString("utf8"));

test("the corpus is the pinned one (edit it in majestic-chat, regenerate the mirror, re-pin both)", () => {
  assert.equal(crypto.createHash("sha256").update(raw).digest("hex"), CONTACT_VECTORS_SHA256);
  assert.ok(corpus.vectors.length >= 120);
});

test("single-text vectors: verdict, required kinds and masked output", () => {
  for (const v of corpus.vectors) {
    const r = m.detectContact(v.text);
    assert.equal(r.status, v.expected, `${v.id}: ${r.status} ≠ ${v.expected} (${r.kinds.join(",")})`);
    for (const k of v.kinds) assert.ok(r.kinds.includes(k), `${v.id}: missing kind ${k}`);
    assert.equal(m.maskContactInfo(v.text), v.masked, `${v.id}: mask`);
    assert.equal(m.getModerationStatus(m.checkText(v.text).confidence), v.expected, `${v.id}: legacy API`);
  }
});

test("cross-message sequences: blocked on the completing fragment, masked as a sequence", () => {
  for (const s of corpus.sequences) {
    const ctx = [];
    const blocked = [];
    const statuses = [];
    s.messages.forEach((msg, i) => {
      const r = m.checkCandidate(ctx, msg);
      statuses.push(r.status);
      if (r.status === "blocked") blocked.push(i);
      else ctx.push(msg);
    });
    assert.deepEqual(blocked, s.blockedAt, s.id);
    assert.deepEqual(statuses, s.statuses, s.id);
    assert.deepEqual(m.maskContactInfoParts(s.messages), s.masked, `${s.id}: masks`);
  }
});

test("cross-field resources", () => {
  for (const f of corpus.fields) {
    const keys = Object.keys(f.fields);
    const parts = keys.map((k) => f.fields[k]);
    assert.equal(m.detectContactInParts(parts).status, f.expected, f.id);
    const masked = m.maskContactInfoParts(parts);
    assert.deepEqual(Object.fromEntries(keys.map((k, i) => [k, masked[i]])), f.masked, f.id);
  }
});

test("exact-address tokens and disclosure cases", () => {
  for (const block of corpus.addresses) {
    const tokens = m.buildAddressTokens(block.address);
    assert.deepEqual(tokens, block.tokens);
    for (const c of block.cases) {
      assert.equal(m.detectContact(c.text, { address: tokens }).status, c.expected, c.id);
      assert.equal(m.maskContactInfo(c.text, { address: tokens }), c.masked, c.id);
    }
  }
});

test("name policy", () => {
  for (const n of corpus.names) assert.equal(m.isAcceptableName(n.name), n.ok, JSON.stringify(n.name));
});

test("adversarial 4000-character inputs are processed in milliseconds", () => {
  const inputs = ["a".repeat(2000) + " ".repeat(2000), "x".repeat(1000) + " ".repeat(1000) + "(" + " ".repeat(1000) + "at" + " ".repeat(990), "a.".repeat(2000), "9".repeat(4000), ("a" + " ".repeat(30)).repeat(129), "a@".repeat(2000), "9 ".repeat(2000), "nine ".repeat(800), "(at) ".repeat(800), "dot ".repeat(1000), "1.2.3.4.".repeat(500), "a-".repeat(2000), "9876543210 ".repeat(363), "x.in ".repeat(800)];
  for (const input of inputs) {
    const t0 = process.hrtime.bigint();
    m.detectContact(input);
    m.maskContactInfo(input);
    assert.ok(Number(process.hrtime.bigint() - t0) / 1e6 < 40, "budget");
  }
});

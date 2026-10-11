// KYC attempts after a failure (2026-10 "Too many verification attempts"
// production report). The real Digitap client used to swallow every provider
// error, so a rejected/blurred photo, a credentials or plan problem and an
// outage all reached the host as "the document number could not be read" —
// and the host's natural immediate retry hit the 30 s cooldown (429). Now:
// provider errors propagate with their status, every post-claim failure tells
// the client when it may retry (retryAfterSeconds) and how many attempts are
// left today, and an attempt lost to OUR account/plan problem is refunded.
const test = require("node:test");
const assert = require("node:assert/strict");
const h = require("./setup");

const KycHostData = () => require("../../models/KycHostForm");
const KycLogs = () => require("../../models/KycLogs");
const provider = () => require("../../services/kycProvider");
const guard = () => require("../../services/kycGuard");

let JPEG;
const b64 = (buf) => buf.toString("base64");

async function host(firstName) {
  const u = await h.makeUser({ role: "host", firstName, lastName: "Tester" });
  const token = h.userToken(u);
  const form = await h.api("POST", "/kyc/form", {
    token,
    body: {
      hostId: String(u._id),
      personalInfo: { fatherName: "Father", dob: "1990-01-01", address: { line1: "1 St", city: "Panaji", state: "Goa", pincode: "403001", country: "India" } },
      documentInfo: { documentType: "pan" },
    },
  });
  assert.equal(form.status, 200, JSON.stringify(form.body));
  return { u, token, verify: (doc = "voterId", img = JPEG) => h.api("POST", "/pan-kyc/verify", { token, body: { userId: String(u._id), doc, imageUrl: b64(img) } }) };
}
async function guardState(u, kind = "ocr") {
  return (await KycHostData().findOne({ hostId: u._id }).lean()).verification[kind];
}
async function leaseReleased(u, kind = "ocr") {
  // the controller releases the lease in its `finally`, after the response
  for (let i = 0; i < 40; i++) {
    if (!(await guardState(u, kind)).inFlightUntil) return;
    await h.sleep(25);
  }
  assert.fail("lease not released");
}

test.before(async () => {
  JPEG = await require("sharp")({ create: { width: 8, height: 8, channels: 3, background: "#996633" } }).jpeg().toBuffer();
  await h.start();
  process.env.KYC_ATTEMPT_COOLDOWN_SECONDS = "30";
  process.env.KYC_MAX_ATTEMPTS_PER_DAY = "5";
});
test.after(async () => h.stop());
test.beforeEach(() => {
  process.env.KYC_PROVIDER_MOCK_MODE = "success";
  provider().resetCalls();
});

// ---------------------------------------------------------------------------
test("real Digitap client: errors propagate with their HTTP status (never swallowed), every call has a deadline, paths unchanged", async () => {
  const axios = require("axios");
  const svc = require("../../services/panKycService");
  const original = axios.post;
  const seen = [];
  const reject = (status, data) => async (url, body, opts) => {
    seen.push({ url, opts });
    const err = new Error(`Request failed with status code ${status}`);
    err.response = { status, data };
    throw err;
  };
  try {
    for (const [doc, path] of [["pan", "/pan"], ["voterId", "/voter"], ["passport", "/passport"]]) {
      axios.post = reject(400, { error: "Image is blurred" });
      await assert.rejects(svc.performOCR(b64(JPEG), "OCR-1", doc), (err) => err.response.status === 400 && err.response.data.error === "Image is blurred");
      assert.ok(seen.at(-1).url.endsWith(path), seen.at(-1).url);
      assert.equal(seen.at(-1).opts.timeout, 45000);
    }
    for (const [doc, path] of [["pan", "/pan_basic"], ["voterId", "/voter"], ["passport", "/passport"]]) {
      axios.post = reject(401, { error: "Invalid client credentials" });
      // the PAN status check used to return undefined here (→ "failed" verdict overwriting the document state)
      await assert.rejects(svc.performStatusCheck({ client_ref_num: "S-1" }, doc), (err) => err.response.status === 401);
      assert.ok(seen.at(-1).url.endsWith(path), seen.at(-1).url);
      assert.equal(seen.at(-1).opts.timeout, 45000);
    }
    process.env.KYC_PROVIDER_TIMEOUT_MS = "1234";
    axios.post = async (url, body, opts) => {
      seen.push({ url, opts });
      return { data: { status: "success", result: [] } };
    };
    assert.deepEqual(await svc.performOCR(b64(JPEG), "OCR-2", "pan"), { status: "success", result: [] });
    assert.equal(seen.at(-1).opts.timeout, 1234);
    // input it cannot send is an error, not a silent undefined
    await assert.rejects(svc.performOCR("not base64 !!", "OCR-3", "pan"), /Invalid base64/);
  } finally {
    axios.post = original;
    delete process.env.KYC_PROVIDER_TIMEOUT_MS;
  }
});

// ---------------------------------------------------------------------------
test("attemptInfo: seconds left in the cooldown and attempts left in the window", () => {
  const now = new Date("2026-10-11T10:00:00Z");
  const g = guard();
  assert.deepEqual(g.attemptInfo({ verification: { ocr: { lastAt: new Date(now.getTime() - 12000), count: 2 } } }, "ocr", now), { retryAfterSeconds: 18, attemptsLeft: 3 });
  assert.deepEqual(g.attemptInfo({ verification: { ocr: { lastAt: new Date(now.getTime() - 31000), count: 5 } } }, "ocr", now), { retryAfterSeconds: 0, attemptsLeft: 0 });
  assert.deepEqual(g.attemptInfo({}, "ocr", now), { retryAfterSeconds: 0, attemptsLeft: 5 });
  assert.deepEqual(g.attemptInfo(null, "gst", now), { retryAfterSeconds: 0, attemptsLeft: 5 });
});

// ---------------------------------------------------------------------------
test("document rejected by the provider: its reason reaches the host and the log, with when to retry; the immediate retry is the 429 the client now prevents", async () => {
  const { u, verify } = await host("Rejected");
  process.env.KYC_PROVIDER_MOCK_MODE = "rejected";
  const r = await verify();
  assert.equal(r.status, 400, JSON.stringify(r.body));
  assert.equal(r.body.code, "PROVIDER_REJECTED");
  assert.equal(r.body.message, "Image is blurred");
  assert.ok(r.body.retryAfterSeconds >= 29 && r.body.retryAfterSeconds <= 30, String(r.body.retryAfterSeconds));
  assert.equal(r.body.attemptsLeft, 4, "a real provider attempt counts");
  const log = await KycLogs().findOne({ userId: u._id, type: "OCR" }).sort({ createdAt: -1 }).lean();
  assert.equal(log.status, "failed", "no longer recorded as a success");
  assert.equal(log.error, "HTTP 400: Image is blurred");
  await leaseReleased(u);

  process.env.KYC_PROVIDER_MOCK_MODE = "success";
  const again = await verify();
  assert.equal(again.status, 429);
  assert.equal(again.body.reason, "cooldown");
  assert.ok(again.body.retryAfterSeconds <= r.body.retryAfterSeconds);
  assert.match(again.body.message, /^Please wait \d+ seconds before trying again\.$/);
  assert.doesNotMatch(again.body.message, /too many/i, "one attempt is not \"too many\"");
  assert.equal(provider().calls.ocr, 1, "the cooldown still protects provider credits");
});

// ---------------------------------------------------------------------------
test("our provider account/plan refused (401): generic 'temporarily unavailable', the attempt is refunded, the cooldown stays, nothing leaks", async () => {
  const { u, verify } = await host("Account");
  process.env.KYC_PROVIDER_MOCK_MODE = "account";
  const r = await verify("pan");
  assert.equal(r.status, 502, JSON.stringify(r.body));
  assert.equal(r.body.code, "PROVIDER_UNAVAILABLE");
  assert.match(r.body.message, /temporarily unavailable/);
  assert.doesNotMatch(JSON.stringify(r.body), /credential/i, "the provider's message about OUR account never reaches the host");
  assert.equal(r.body.attemptsLeft, 5, "refunded");
  assert.ok(r.body.retryAfterSeconds >= 29);
  await leaseReleased(u);
  const g = await guardState(u);
  assert.equal(g.count, 0);
  assert.ok(g.lastAt, "cooldown kept so a broken provider is not hammered");
  const log = await KycLogs().findOne({ userId: u._id, type: "OCR" }).sort({ createdAt: -1 }).lean();
  assert.equal(log.error, "HTTP 401: Invalid client credentials", "ops can see what the provider said");
  assert.equal((await verify("pan")).status, 429);

  // the refund never goes below zero
  await KycHostData().updateOne({ hostId: u._id }, { $set: { "verification.ocr.count": 0 } });
  await guard().refund(u._id, "ocr");
  assert.equal((await guardState(u)).count, 0);
});

// ---------------------------------------------------------------------------
test("every post-claim failure carries retryAfterSeconds + attemptsLeft (unreadable, not verified, outage); a provider outage keeps the count", async () => {
  process.env.KYC_ATTEMPT_COOLDOWN_SECONDS = "0";
  try {
    const { u, verify } = await host("Mixed");
    process.env.KYC_PROVIDER_MOCK_MODE = "negative";
    const neg = await verify();
    assert.equal(neg.status, 422);
    assert.equal(neg.body.code, "DOCUMENT_NOT_VERIFIED");
    assert.equal(neg.body.retryAfterSeconds, 0);
    assert.equal(neg.body.attemptsLeft, 4);
    await leaseReleased(u);

    process.env.KYC_PROVIDER_MOCK_MODE = "failure";
    const down = await verify();
    assert.equal(down.status, 502);
    assert.equal(down.body.code, "PROVIDER_UNAVAILABLE");
    assert.equal(down.body.attemptsLeft, 3, "an outage may have cost credits: it counts");
    await leaseReleased(u);

    // OCR answered without a number → unreadable
    const ocr = provider().ocr;
    provider().ocr = async () => ({ status: "success", result: [{ details: {} }] });
    try {
      const unreadable = await verify();
      assert.equal(unreadable.status, 422);
      assert.equal(unreadable.body.reason, "DOCUMENT_UNREADABLE");
      assert.equal(unreadable.body.attemptsLeft, 2);
    } finally {
      provider().ocr = ocr;
    }
    await leaseReleased(u);

    process.env.KYC_PROVIDER_MOCK_MODE = "success";
    const ok = await verify("pan"); // the PAN mock carries the provider's own name match
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.verdict, "verified");
  } finally {
    process.env.KYC_ATTEMPT_COOLDOWN_SECONDS = "30";
  }
});

// ---------------------------------------------------------------------------
test("GST: provider failures carry retry info; our account problem is refunded and stays generic", async () => {
  const { u, token } = await host("Gst");
  const post = () => h.api("POST", "/kyc/verify/gst", { token, body: { userId: String(u._id), panNumber: provider().MOCK_PAN, gstNumber: provider().MOCK_GSTIN } });
  process.env.KYC_PROVIDER_MOCK_MODE = "account";
  const acc = await post();
  assert.equal(acc.status, 502, JSON.stringify(acc.body));
  assert.match(acc.body.message, /temporarily unavailable/);
  assert.equal(acc.body.attemptsLeft, 5);
  assert.ok(acc.body.retryAfterSeconds >= 29);
  await leaseReleased(u, "gst");
  assert.equal((await guardState(u, "gst")).count, 0);

  process.env.KYC_ATTEMPT_COOLDOWN_SECONDS = "0";
  try {
    process.env.KYC_PROVIDER_MOCK_MODE = "mismatch"; // listed but Cancelled
    const inactive = await post();
    assert.equal(inactive.status, 409);
    assert.equal(inactive.body.attemptsLeft, 4);
    assert.equal(inactive.body.retryAfterSeconds, 0);
  } finally {
    process.env.KYC_ATTEMPT_COOLDOWN_SECONDS = "30";
  }
});

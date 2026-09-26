// Homepage hero — safe retries and concurrency (docs/site-hero.md):
// server-issued op tokens, durable receipts, the image-job lease with real
// cancellation, unknown commit outcomes, audit failures and the races the
// design review listed. Real app, replica-set harness, in-memory Spaces.
const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const h = require("./setup");
const hh = require("./hero-helpers");

// In-memory storage only (SPACES_MOCK): these suites use production's key
// layout (site/hero/…); the environment rules have their own tests.
process.env.SITE_HERO_PRODUCTION = "1";

const storage = () => require("../../services/storage");
const SiteSetting = () => require("../../models/SiteSetting");
const AdminAuditLog = () => require("../../models/AdminAuditLog");
const ops = () => require("../../services/siteHeroOps");
const changed = () => require("../../services/listingChanged");

let ADMIN, AT, ADMIN2, AT2, DESK, MOB, MOB2;
const heroDoc = () => SiteSetting().collection.findOne({ _id: "home_hero" });
const objects = () => [...storage().__mock.objects.keys()].filter((k) => k.startsWith("site/hero/"));
const opStatus = (opId, token = AT) => h.api("GET", `/site/admin/hero/ops/${opId}`, { token });
const opIdOf = (token) => JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString()).n;
async function waitFor(pred, ms = 10000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await pred()) return true;
    await h.sleep(25);
  }
  return false;
}
async function reset() {
  await SiteSetting().collection.deleteMany({});
  storage().resetMock();
  changed().__setMock({ calls: [] });
  delete process.env.SITE_HERO_LEASE_MS;
  delete process.env.SITE_HERO_BUDGET_MS;
  delete process.env.SITE_HERO_PUT_TIMEOUT_MS;
}
async function banner() {
  await hh.stage(AT, "desktop", DESK);
  await hh.stage(AT, "mobile", MOB);
  const p = await hh.publish(AT);
  assert.equal(p.status, 200, JSON.stringify(p.body));
  return p;
}

test.before(async () => {
  await h.start();
  ADMIN = await h.makeAdmin();
  AT = h.adminToken(ADMIN);
  ADMIN2 = await h.makeAdmin();
  AT2 = h.adminToken(ADMIN2);
  DESK = await hh.photo(1920, 740, { hue: 15 });
  MOB = await hh.photo(530, 720, { hue: 200 });
  MOB2 = await hh.photo(540, 734, { hue: 120 });
});
test.after(async () => h.stop());
test.beforeEach(reset);

// --- op tokens ---------------------------------------------------------------------
test("op tokens: missing, malformed, forged, another admin's, and expired-without-receipt tokens are refused", async () => {
  await hh.stage(AT, "desktop", DESK);
  await hh.stage(AT, "mobile", MOB);
  const st = await hh.adminState(AT);
  const body = (opToken) => ({ opToken, expectedVersion: st.version, slots: { desktop: st.draft.desktop.opId, mobile: st.draft.mobile.opId }, alt: "A banner" });
  const post = (b) => h.api("POST", "/site/admin/hero/publish", { token: AT, body: b });
  assert.equal((await post({ ...body(undefined) })).body.code, "OP_TOKEN_REQUIRED");
  assert.equal((await post(body("abc"))).body.code, "OP_TOKEN_INVALID");
  const [v, p, sig] = st.opToken.split(".");
  const forged = `${v}.${p}.${sig.slice(0, -2)}${sig.endsWith("AA") ? "BB" : "AA"}`;
  const f = await post(body(forged));
  assert.equal(f.status, 403);
  assert.equal(f.body.code, "OP_TOKEN_INVALID");
  const tampered = `${v}.${Buffer.from(JSON.stringify({ n: "6f2c1f8e-1b1d-4a57-9b2a-111111111111", a: String(ADMIN._id), t: Date.now() })).toString("base64url")}.${sig}`;
  assert.equal((await post(body(tampered))).status, 403, "payload swapped under a valid signature");
  const foreign = await post(body((await hh.adminState(AT2)).opToken));
  assert.equal(foreign.status, 403);
  assert.equal(foreign.body.code, "OP_TOKEN_FOREIGN");
  const old = ops().issueOpToken(ADMIN._id, Date.now() - 31 * 60 * 1000);
  const expired = await post(body(old));
  assert.equal(expired.status, 410);
  assert.equal(expired.body.code, "OP_EXPIRED");
  const future = ops().issueOpToken(ADMIN._id, Date.now() + 5 * 60 * 1000);
  assert.equal((await post(body(future))).body.code, "OP_EXPIRED", "a token from the future is refused");
  assert.equal((await heroDoc()).version, 0, "nothing was published");
  // unit: an expired token whose receipt exists is a replay, not a refusal
  const r = ops().receipt({ opId: "6f2c1f8e-1b1d-4a57-9b2a-222222222222", actorId: ADMIN._id, action: "publish", fingerprint: "f", status: "completed", result: { version: 1 } });
  const check = ops().checkOperation({ receipts: [r] }, { opId: r.opId, expired: true }, { actorId: ADMIN._id, fingerprint: "f" });
  assert.ok(check.replay);
});

// --- receipts ------------------------------------------------------------------------
test("A commits, its response is lost, B commits, A retries: A is recognised as done and B's change is untouched", async () => {
  await hh.stage(AT, "desktop", DESK);
  await hh.stage(AT, "mobile", MOB);
  const st = await hh.adminState(AT);
  const bodyA = { opToken: st.opToken, expectedVersion: st.version, slots: { desktop: st.draft.desktop.opId, mobile: st.draft.mobile.opId }, alt: "Admin A's words" };
  const a = await h.api("POST", "/site/admin/hero/publish", { token: AT, body: bodyA }); // "lost"
  assert.equal(a.status, 200);
  const stB = await hh.adminState(AT2);
  const b = await h.api("PATCH", "/site/admin/hero/alt", { token: AT2, body: { opToken: stB.opToken, expectedVersion: stB.version, alt: "Admin B's words" } });
  assert.equal(b.status, 200);
  const retry = await h.api("POST", "/site/admin/hero/publish", { token: AT, body: bodyA });
  assert.equal(retry.status, 200, JSON.stringify(retry.body));
  assert.equal(retry.body.replayed, true);
  assert.equal(retry.body.result.version, 1, "A's own outcome");
  assert.equal(retry.body.state.version, 2);
  assert.equal(retry.body.state.alt, "Admin B's words", "B's change survives");
  assert.equal((await AdminAuditLog().countDocuments({ action: "site.hero.publish" })) >= 1, true);
  const s = await opStatus(opIdOf(bodyA.opToken));
  assert.equal(s.body.status, "completed");
  assert.equal(s.body.result.version, 1);
  const publishes = await AdminAuditLog().find({ action: "site.hero.publish", "details.version": 1 }).lean();
  assert.equal(publishes.filter((r) => String(r.actorId) === String(ADMIN._id)).length >= 1, true);
  const doc = await heroDoc();
  assert.equal(doc.receipts.filter((r) => r.opId === opIdOf(bodyA.opToken)).length, 1, "one receipt, never two");
});

test("the same operation id with different content is refused (publish and draft)", async () => {
  await hh.stage(AT, "desktop", DESK);
  await hh.stage(AT, "mobile", MOB);
  const st = await hh.adminState(AT);
  const body = { opToken: st.opToken, expectedVersion: st.version, slots: { desktop: st.draft.desktop.opId, mobile: st.draft.mobile.opId }, alt: "One" };
  assert.equal((await h.api("POST", "/site/admin/hero/publish", { token: AT, body })).status, 200);
  const other = await h.api("POST", "/site/admin/hero/publish", { token: AT, body: { ...body, alt: "Two" } });
  assert.equal(other.status, 422);
  assert.equal(other.body.code, "OP_ID_REUSED");
  const st2 = await hh.adminState(AT);
  const first = await hh.stage(AT, "desktop", DESK, { opToken: st2.opToken, expectedDraftOpId: "" });
  assert.equal(first.status, 201);
  const sameIdOtherFile = await hh.stage(AT, "desktop", await hh.photo(1920, 740, { hue: 99 }), { opToken: st2.opToken, expectedDraftOpId: "" });
  assert.equal(sameIdOtherFile.status, 422);
  assert.equal(sameIdOtherFile.body.code, "OP_ID_REUSED");
  const otherFocal = await hh.stage(AT, "desktop", DESK, { opToken: st2.opToken, expectedDraftOpId: "", fields: { focalX: "0.2" } });
  assert.equal(otherFocal.body.code, "OP_ID_REUSED", "a different crop is different content");
});

test("an old draft retry after the draft was replaced or published cannot resurrect or overwrite anything", async () => {
  const st = await hh.adminState(AT);
  const x = await hh.stage(AT, "desktop", DESK, { opToken: st.opToken, expectedDraftOpId: "" });
  const xId = x.body.state.draft.desktop.opId;
  const y = await hh.stage(AT, "desktop", await hh.photo(1920, 740, { hue: 77 }), { expectedDraftOpId: xId });
  const yId = y.body.state.draft.desktop.opId;
  const uploads = storage().__mock.uploaded.length;
  const retry = await hh.stage(AT, "desktop", DESK, { opToken: st.opToken, expectedDraftOpId: "" });
  assert.equal(retry.status, 200, JSON.stringify(retry.body));
  assert.equal(retry.body.replayed, true);
  assert.equal(retry.body.result.draftOpId, xId);
  assert.equal(retry.body.state.draft.desktop.opId, yId, "the newer draft stands");
  assert.equal(storage().__mock.uploaded.length, uploads, "nothing re-processed or re-uploaded");
  await hh.stage(AT, "mobile", MOB);
  await hh.publish(AT);
  const again = await hh.stage(AT, "desktop", DESK, { opToken: st.opToken, expectedDraftOpId: "" });
  assert.equal(again.body.replayed, true);
  assert.equal(again.body.state.draft.desktop, null, "the published draft does not come back");
  assert.equal(again.body.state.desktop.url, y.body.state.draft.desktop.url);
});

test("receipts: bounded to 500; a still-retryable receipt is never evicted (429 instead); old ones make room", async () => {
  await hh.stage(AT, "desktop", DESK);
  const make = (i, at) => ({ opId: `6f2c1f8e-1b1d-4a57-9b2a-${String(i).padStart(12, "0")}`, actorId: ADMIN._id, action: "discard", target: "desktop", fingerprint: "x", status: "completed", result: {}, at });
  await SiteSetting().collection.updateOne({ _id: "home_hero" }, { $set: { receipts: Array.from({ length: 500 }, (_, i) => make(i, new Date())) } });
  const busy = await hh.stage(AT, "mobile", MOB);
  assert.equal(busy.status, 429);
  assert.equal(busy.body.code, "HERO_TOO_MANY_OPS");
  await SiteSetting().collection.updateOne({ _id: "home_hero" }, { $set: { receipts: Array.from({ length: 500 }, (_, i) => make(i, new Date(Date.now() - 60 * 60 * 1000))) } });
  const ok = await hh.stage(AT, "mobile", MOB);
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  assert.equal((await heroDoc()).receipts.length, 500, "capped at 500, newest kept");
  assert.ok((await heroDoc()).receipts.some((r) => r.opId === ok.body.opId));
});

// --- lease ----------------------------------------------------------------------------
test("lease: from an empty database acquire → release → acquire again; a second job meanwhile is HERO_BUSY; status shows processing → completed", async () => {
  assert.equal(await heroDoc(), null, "no document yet");
  assert.equal((await hh.stage(AT, "desktop", DESK)).status, 201);
  assert.equal((await heroDoc()).lease, null);
  assert.equal((await hh.stage(AT, "mobile", MOB)).status, 201, "acquired again after the release");
  storage().__mock.putDelayMs = 250;
  const st = await hh.adminState(AT);
  const slow = hh.stage(AT, "desktop", DESK, { opToken: st.opToken, expectedDraftOpId: st.draft.desktop.opId });
  assert.ok(await waitFor(async () => !!((await heroDoc()) || {}).lease), "the first job holds the lease");
  const status = await opStatus(opIdOf(st.opToken));
  assert.equal(status.body.status, "processing");
  const busy = await hh.stage(AT2, "mobile", MOB2);
  assert.equal(busy.status, 409);
  assert.equal(busy.body.code, "HERO_BUSY");
  assert.ok(busy.body.retryAfter >= 1);
  const dup = await hh.stage(AT, "desktop", DESK, { opToken: st.opToken, expectedDraftOpId: st.draft.desktop.opId });
  assert.equal(dup.status, 202, "the same operation submitted twice while running");
  assert.equal((await slow).status, 201);
  assert.equal((await opStatus(opIdOf(st.opToken))).body.status, "completed");
  assert.equal((await opStatus(opIdOf(st.opToken), AT2)).body.status, "unknown", "another admin's operation is not visible");
});

test("lease: worker A outlives its lease, worker B takes over, A finishes late — A can neither install nor release B's lease", async () => {
  process.env.SITE_HERO_LEASE_MS = "1500";
  storage().__mock.putDelayMs = 700;
  const a = hh.stage(AT, "desktop", DESK);
  assert.ok(await waitFor(async () => !!((await heroDoc()) || {}).lease));
  const leaseA = (await heroDoc()).lease.token;
  await h.sleep(1600); // A's lease expired
  storage().__mock.putDelayMs = 0;
  const b = await hh.stage(AT2, "mobile", MOB);
  assert.equal(b.status, 201, JSON.stringify(b.body));
  const ra = await a;
  assert.equal(ra.status, 503, JSON.stringify(ra.body));
  assert.equal(ra.body.code, "HERO_TIMEOUT");
  const doc = await heroDoc();
  assert.equal(doc.draft.desktop, null, "A's draft was not installed");
  assert.ok(doc.draft.mobile, "B's draft stands");
  assert.notEqual(doc.lease && doc.lease.token, leaseA);
  assert.equal(doc.lease, null, "B released its own lease; A touched nothing");
  const aKeys = objects().filter((k) => k.startsWith("site/hero/desktop/"));
  assert.deepEqual(aKeys, [], "A's objects were deleted (never referenced)");
});

test("budget: an expired budget really stops the uploads (aborted, nothing after) → 503, failure recorded, lease released", async () => {
  process.env.SITE_HERO_BUDGET_MS = "1500";
  storage().__mock.putDelayMs = 5000;
  const st = await hh.adminState(AT);
  const t0 = Date.now();
  const r = await hh.stage(AT, "desktop", DESK, { opToken: st.opToken, expectedDraftOpId: "" });
  assert.equal(r.status, 503, JSON.stringify(r.body));
  assert.equal(r.body.code, "HERO_TIMEOUT");
  assert.ok(Date.now() - t0 < 5000, "answered at the budget, not after the slow upload");
  assert.ok(storage().__mock.aborted.length >= 1, "the in-flight upload was aborted");
  assert.equal(storage().__mock.uploaded.length, 0, "no upload completed after the abort");
  const doc = await heroDoc();
  assert.equal(doc.lease, null);
  assert.equal(doc.receipts.find((x) => x.opId === opIdOf(st.opToken)).status, "failed");
  assert.equal((await opStatus(opIdOf(st.opToken))).body.status, "failed");
  // a retry with the same token replays the failure instead of running again
  const again = await hh.stage(AT, "desktop", DESK, { opToken: st.opToken, expectedDraftOpId: "" });
  assert.equal(again.status, 503);
  assert.equal(again.body.replayed, true);
});

test("storage: a PUT that times out is retried once then 502; a failing PUT → 502 and every attempted object is removed", async () => {
  process.env.SITE_HERO_PUT_TIMEOUT_MS = "300";
  storage().__mock.putDelayMs = 1000;
  const r = await hh.stage(AT, "desktop", DESK);
  assert.equal(r.status, 502, JSON.stringify(r.body));
  assert.equal(r.body.code, "STORAGE_ERROR");
  assert.equal(storage().__mock.aborted.filter((k) => k.endsWith(".jpg")).length, 2, "master tried twice, each aborted at its deadline");
  await reset();
  storage().setMockFailure("put:w960");
  const f = await hh.stage(AT, "desktop", DESK);
  assert.equal(f.status, 502);
  assert.deepEqual(objects(), [], "nothing of the failed job remains");
  assert.equal((await heroDoc()).lease, null);
});

// --- unknown outcomes and audit failures ------------------------------------------------
function patchTransactions(mode) {
  const real = mongoose.startSession.bind(mongoose);
  mongoose.startSession = async (...args) => {
    const s = await real(...args);
    const realWT = s.withTransaction.bind(s);
    s.withTransaction = async (fn, opts) => {
      if (mode === "commit-then-lose") await realWT(fn, opts);
      const err = new Error("connection reset while committing");
      err.hasErrorLabel = (l) => l === "UnknownTransactionCommitResult";
      throw err;
    };
    return s;
  };
  return () => {
    mongoose.startSession = real;
  };
}

test("unknown commit (it happened): 503 HERO_OUTCOME_UNKNOWN, nothing deleted; the retry with the same token is recognised as done", async () => {
  await hh.stage(AT, "desktop", DESK);
  await hh.stage(AT, "mobile", MOB);
  const st = await hh.adminState(AT);
  const body = { opToken: st.opToken, expectedVersion: st.version, slots: { desktop: st.draft.desktop.opId, mobile: st.draft.mobile.opId }, alt: "Committed but unconfirmed" };
  const before = objects().length;
  const restore = patchTransactions("commit-then-lose");
  let r;
  try {
    r = await h.api("POST", "/site/admin/hero/publish", { token: AT, body });
  } finally {
    restore();
  }
  assert.equal(r.status, 503);
  assert.equal(r.body.code, "HERO_OUTCOME_UNKNOWN");
  assert.equal(objects().length, before, "nothing deleted on an unknown outcome");
  assert.equal((await heroDoc()).version, 1, "it did commit");
  assert.equal((await opStatus(opIdOf(body.opToken))).body.status, "completed");
  const retry = await h.api("POST", "/site/admin/hero/publish", { token: AT, body });
  assert.equal(retry.status, 200);
  assert.equal(retry.body.replayed, true);
  assert.equal((await heroDoc()).version, 1, "not published twice");
});

test("unknown commit (it did not happen): the draft's objects are kept, the lease is freed, status unknown, the same token may run again", async () => {
  const st = await hh.adminState(AT);
  const restore = patchTransactions("lose-without-commit");
  let r;
  try {
    r = await hh.stage(AT, "desktop", DESK, { opToken: st.opToken, expectedDraftOpId: "" });
  } finally {
    restore();
  }
  assert.equal(r.status, 503);
  assert.equal(r.body.code, "HERO_OUTCOME_UNKNOWN");
  const kept = objects().length;
  assert.ok(kept > 0, "objects kept — the sweep decides later");
  assert.equal((await heroDoc()).lease, null, "lease freed");
  assert.equal((await opStatus(opIdOf(st.opToken))).body.status, "unknown");
  const again = await hh.stage(AT, "desktop", DESK, { opToken: st.opToken, expectedDraftOpId: "" });
  assert.equal(again.status, 201, "not applied before → safe to run");
});

test("audit failure: nothing is committed — no publish, no receipt; a draft's objects are removed and the failure recorded", async () => {
  await hh.stage(AT, "desktop", DESK);
  await hh.stage(AT, "mobile", MOB);
  const st = await hh.adminState(AT);
  const Log = AdminAuditLog();
  const original = Log.create;
  Log.create = async () => {
    throw new Error("audit store down");
  };
  let pub;
  let draft;
  const beforeObjects = objects().length;
  try {
    pub = await h.api("POST", "/site/admin/hero/publish", { token: AT, body: { opToken: st.opToken, expectedVersion: st.version, slots: { desktop: st.draft.desktop.opId, mobile: st.draft.mobile.opId }, alt: "x" } });
    draft = await hh.stage(AT, "desktop", await hh.photo(1920, 740, { hue: 55 }));
  } finally {
    Log.create = original;
  }
  assert.equal(pub.status, 503);
  assert.equal(pub.body.code, "AUDIT_UNAVAILABLE");
  const doc = await heroDoc();
  assert.equal(doc.version, 0);
  assert.ok(doc.draft.desktop && doc.draft.mobile, "drafts untouched");
  assert.ok(!doc.receipts.some((r) => r.opId === opIdOf(st.opToken)), "no receipt for the failed publish");
  assert.equal(draft.status, 503);
  assert.equal(draft.body.code, "AUDIT_UNAVAILABLE");
  assert.equal(objects().length, beforeObjects, "the failed draft's objects were removed");
});

// --- races -----------------------------------------------------------------------------
test("races: two first publishes, publish vs restore, publish vs alt — exactly one wins each time", async () => {
  await hh.stage(AT, "desktop", DESK);
  await hh.stage(AT, "mobile", MOB);
  const [s1, s2] = [await hh.adminState(AT), await hh.adminState(AT2)];
  const body = (st) => ({ opToken: st.opToken, expectedVersion: st.version, slots: { desktop: st.draft.desktop.opId, mobile: st.draft.mobile.opId }, alt: "Race" });
  const [a, b] = await Promise.all([h.api("POST", "/site/admin/hero/publish", { token: AT, body: body(s1) }), h.api("POST", "/site/admin/hero/publish", { token: AT2, body: body(s2) })]);
  assert.deepEqual([a.status, b.status].sort(), [200, 409], `${a.status}/${b.status}`);
  assert.equal((await heroDoc()).version, 1);
  // publish vs restore at the same version
  await hh.stage(AT, "desktop", await hh.photo(1920, 740, { hue: 44 }));
  const [p, q] = [await hh.adminState(AT), await hh.adminState(AT2)];
  const [pub, res] = await Promise.all([
    h.api("POST", "/site/admin/hero/publish", { token: AT, body: { opToken: p.opToken, expectedVersion: p.version, slots: { desktop: p.draft.desktop.opId }, alt: "Race 2" } }),
    h.api("POST", "/site/admin/hero/restore-default", { token: AT2, body: { opToken: q.opToken, expectedVersion: q.version } }),
  ]);
  assert.deepEqual([pub.status, res.status].sort(), [200, 409], `${pub.status}/${res.status}`);
  assert.equal((await heroDoc()).version, 2);
  // publish vs alt edit
  if ((await heroDoc()).desktop === null) {
    await hh.stage(AT, "desktop", DESK);
    await hh.stage(AT, "mobile", MOB);
    await hh.publish(AT);
  }
  await hh.stage(AT, "mobile", MOB2);
  const [x, y] = [await hh.adminState(AT), await hh.adminState(AT2)];
  const [pb, al] = await Promise.all([
    h.api("POST", "/site/admin/hero/publish", { token: AT, body: { opToken: x.opToken, expectedVersion: x.version, slots: { mobile: x.draft.mobile.opId }, alt: "Race 3" } }),
    h.api("PATCH", "/site/admin/hero/alt", { token: AT2, body: { opToken: y.opToken, expectedVersion: y.version, alt: "Race 3b" } }),
  ]);
  assert.deepEqual([pb.status, al.status].sort(), [200, 409], `${pb.status}/${al.status}`);
});

test("expired draft vs publish: the publish is refused (HERO_DRAFT_EXPIRED) and the sweep removes the draft; run together, one consistent outcome", async () => {
  const { sweep } = require("../../services/siteHeroSweep");
  await hh.stage(AT, "desktop", DESK);
  await hh.stage(AT, "mobile", MOB);
  await SiteSetting().collection.updateOne({ _id: "home_hero" }, { $set: { "draft.mobile.expiresAt": new Date(Date.now() - 1000) } });
  const r = await hh.publish(AT);
  assert.equal(r.body.code, "HERO_DRAFT_EXPIRED");
  const s = await sweep({ force: true });
  assert.equal(s.expiredDrafts, 1);
  assert.equal((await heroDoc()).draft.mobile, null);
  assert.equal(await AdminAuditLog().countDocuments({ action: "site.hero.draft_expire", actorKind: "system" }), 1);
  // together, at the boundary
  await hh.stage(AT, "mobile", MOB);
  const st = await hh.adminState(AT);
  await SiteSetting().collection.updateOne({ _id: "home_hero" }, { $set: { "draft.mobile.expiresAt": new Date(Date.now() + 120) } });
  await h.sleep(100);
  const [pub, sw] = await Promise.all([
    h.api("POST", "/site/admin/hero/publish", { token: AT, body: { opToken: st.opToken, expectedVersion: st.version, slots: { desktop: st.draft.desktop.opId, mobile: st.draft.mobile.opId }, alt: "Boundary" } }),
    h.sleep(25).then(() => sweep({ force: true })),
  ]);
  const doc = await heroDoc();
  if (pub.status === 200) {
    assert.equal(doc.draft.mobile, null);
    assert.ok(doc.mobile, "published");
    assert.equal(sw.expiredDrafts, 0);
  } else {
    assert.ok(["HERO_DRAFT_EXPIRED", "HERO_DRAFT_CHANGED"].includes(pub.body.code), JSON.stringify(pub.body));
    assert.equal(doc.mobile, null, "not published");
  }
  for (const s2 of ["desktop", "mobile"]) {
    if (doc[s2]) assert.ok(storage().__mock.objects.has(storage().keyFromUrl(doc[s2].url)), "live objects are never deleted");
  }
});

test("restore default during a draft preparation: the draft still installs, nothing goes live", async () => {
  await banner();
  storage().__mock.putDelayMs = 200;
  const slow = hh.stage(AT, "desktop", await hh.photo(1920, 740, { hue: 250 }));
  assert.ok(await waitFor(async () => !!((await heroDoc()) || {}).lease));
  const st = await hh.adminState(AT2);
  const r = await h.api("POST", "/site/admin/hero/restore-default", { token: AT2, body: { opToken: st.opToken, expectedVersion: st.version } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const done = await slow;
  assert.equal(done.status, 201, JSON.stringify(done.body));
  assert.ok(done.body.state.draft.desktop, "the draft installed");
  assert.deepEqual((await h.api("GET", "/site/hero")).body.desktop, null, "the public banner stays the bundled default");
});

test("operation status: invalid ids are 400; unknown ids are unknown", async () => {
  assert.equal((await opStatus("nope")).status, 400);
  assert.equal((await opStatus("6f2c1f8e-1b1d-4a57-9b2a-999999999999")).body.status, "unknown");
});

// Homepage hero — closure-audit gaps (docs/site-hero.md): the branches the
// coverage report showed untested and the races the audit named. Each test
// checks the database, the storage and the audit log, not only the answer.
// Real app on the replica-set harness with the in-memory Spaces fake.
const test = require("node:test");
const assert = require("node:assert/strict");
const h = require("./setup");
const hh = require("./hero-helpers");

process.env.SITE_HERO_PRODUCTION = "1";

const storage = () => require("../../services/storage");
const SiteSetting = () => require("../../models/SiteSetting");
const AdminAuditLog = () => require("../../models/AdminAuditLog");
const heroImage = () => require("../../services/siteHeroImage");
const sweeper = () => require("../../services/siteHeroSweep");
const changed = () => require("../../services/listingChanged");
const User = () => require("../../models/User");
const Admin = () => require("../../models/Admin");

let ADMIN, AT, ADMIN2, AT2, RA, RAT, DESK, MOB;
const HOUR = 60 * 60 * 1000;
const heroDoc = () => SiteSetting().collection.findOne({ _id: "home_hero" });
const objects = (prefix = "site/hero/") => [...storage().__mock.objects.keys()].filter((k) => k.startsWith(prefix));
const audits = (action) => AdminAuditLog().countDocuments({ action });
const opIdOf = (token) => JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString()).n;
const opStatus = (opId, token = AT) => h.api("GET", `/site/admin/hero/ops/${opId}`, { token });
async function waitFor(pred, ms = 10000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await pred()) return true;
    await h.sleep(20);
  }
  return false;
}
async function reset() {
  await SiteSetting().collection.deleteMany({});
  await AdminAuditLog().deleteMany({ action: /^site\.hero\./ });
  storage().resetMock();
  changed().__setMock({ calls: [] });
  for (const k of ["SITE_HERO_LEASE_MS", "SITE_HERO_BUDGET_MS", "SITE_HERO_PUT_TIMEOUT_MS", "SITE_HERO_PREFIX", "VERCEL", "VERCEL_ENV"]) delete process.env[k];
  process.env.SITE_HERO_PRODUCTION = "1";
}
async function banner() {
  await hh.stage(AT, "desktop", DESK);
  await hh.stage(AT, "mobile", MOB);
  const p = await hh.publish(AT);
  assert.equal(p.status, 200, JSON.stringify(p.body));
}

// Holds the next `n` reads of the banner document until all `n` have
// arrived, so `n` requests all pass their pre-checks on the same state —
// the interleaving that a real "Try again" during a slow commit produces.
function readBarrier(n) {
  const c = SiteSetting().collection;
  const real = c.findOne;
  let waiting = [];
  c.findOne = async function (...args) {
    if (waiting !== null && args[1] && args[1].readPreference === "primary") {
      await new Promise((resolve) => {
        waiting.push(resolve);
        if (waiting.length === n) {
          for (const r of waiting) r();
          waiting = null;
        }
      });
    }
    return real.apply(this, args);
  };
  return () => {
    c.findOne = real;
    if (waiting) for (const r of waiting) r();
  };
}

test.before(async () => {
  await h.start();
  ADMIN = await h.makeAdmin();
  AT = h.adminToken(ADMIN);
  ADMIN2 = await h.makeAdmin();
  AT2 = h.adminToken(ADMIN2);
  RA = await h.makeUser({ role: "admin" });
  RAT = h.userToken(RA);
  DESK = await hh.photo(1920, 740, { hue: 15 });
  MOB = await hh.photo(530, 720, { hue: 200 });
});
test.after(async () => h.stop());
test.beforeEach(reset);

// --- one operation sent twice at once ------------------------------------------------
test("the same publish sent twice at once: applied once, both answers say it is done (one replayed) — never 'changed by someone else'", async () => {
  await hh.stage(AT, "desktop", DESK);
  await hh.stage(AT, "mobile", MOB);
  const st = await hh.adminState(AT);
  const body = { opToken: st.opToken, expectedVersion: st.version, slots: { desktop: st.draft.desktop.opId, mobile: st.draft.mobile.opId }, alt: "A festival banner" };
  const release = readBarrier(2);
  let a;
  let b;
  try {
    [a, b] = await Promise.all([h.api("POST", "/site/admin/hero/publish", { token: AT, body }), h.api("POST", "/site/admin/hero/publish", { token: AT, body })]);
  } finally {
    release();
  }
  assert.deepEqual([a.status, b.status], [200, 200], `${JSON.stringify(a.body)} / ${JSON.stringify(b.body)}`);
  assert.equal([a, b].filter((r) => r.body.replayed === true).length, 1, "exactly one is the recorded result");
  const doc = await heroDoc();
  assert.equal(doc.version, 1, "published once");
  assert.equal(doc.receipts.filter((r) => r.opId === opIdOf(st.opToken)).length, 1, "one receipt");
  assert.equal(await audits("site.hero.publish"), 1, "one audit row");
});

test("the same description edit, restore and discard sent twice at once: each applied once, audited once, both answers succeed", async () => {
  await banner();
  const twice = async (method, path, token, body) => {
    const release = readBarrier(2);
    try {
      return await Promise.all([h.api(method, path, { token, body }), h.api(method, path, { token, body })]);
    } finally {
      release();
    }
  };
  // description
  let st = await hh.adminState(AT);
  let rs = await twice("PATCH", "/site/admin/hero/alt", AT, { opToken: st.opToken, expectedVersion: st.version, alt: "An offer banner" });
  assert.deepEqual(rs.map((r) => r.status), [200, 200], JSON.stringify(rs.map((r) => r.body)));
  assert.equal((await heroDoc()).version, st.version + 1);
  assert.equal(await audits("site.hero.alt"), 1);
  // discard
  await hh.stage(AT, "desktop", await hh.photo(1920, 740, { hue: 90 }));
  st = await hh.adminState(AT);
  rs = await twice("DELETE", "/site/admin/hero/desktop/draft", AT, { opToken: st.opToken, expectedDraftOpId: st.draft.desktop.opId });
  assert.deepEqual(rs.map((r) => r.status), [200, 200], JSON.stringify(rs.map((r) => r.body)));
  assert.equal(await audits("site.hero.discard"), 1);
  assert.equal((await heroDoc()).retired.filter((r) => r.masterKeys[0] === storage().keyFromUrl(st.draft.desktop.url)).length, 1, "retired once");
  // restore
  st = await hh.adminState(AT);
  rs = await twice("POST", "/site/admin/hero/restore-default", AT, { opToken: st.opToken, expectedVersion: st.version });
  assert.deepEqual(rs.map((r) => r.status), [200, 200], JSON.stringify(rs.map((r) => r.body)));
  const doc = await heroDoc();
  assert.equal(doc.version, st.version + 1, "restored once");
  assert.equal(await audits("site.hero.reset"), 1);
  assert.equal(doc.retired.filter((r) => r.masterKeys[0] === storage().keyFromUrl(st.desktop.url)).length, 1, "the live art retired once");
});

test("two admins discarding the same draft at once: one succeeds, the other is told it changed; one audit row", async () => {
  await hh.stage(AT, "desktop", DESK);
  const [s1, s2] = [await hh.adminState(AT), await hh.adminState(AT2)];
  const release = readBarrier(2);
  let rs;
  try {
    rs = await Promise.all([
      h.api("DELETE", "/site/admin/hero/desktop/draft", { token: AT, body: { opToken: s1.opToken, expectedDraftOpId: s1.draft.desktop.opId } }),
      h.api("DELETE", "/site/admin/hero/desktop/draft", { token: AT2, body: { opToken: s2.opToken, expectedDraftOpId: s2.draft.desktop.opId } }),
    ]);
  } finally {
    release();
  }
  assert.deepEqual(rs.map((r) => r.status).sort(), [200, 409], JSON.stringify(rs.map((r) => r.body)));
  assert.equal(rs.find((r) => r.status === 409).body.code, "HERO_DRAFT_CHANGED");
  assert.equal(await audits("site.hero.discard"), 1);
});

// --- draft job failure paths ----------------------------------------------------------
test("draft: a stale expected draft is refused before the lease or any work (nothing stored, no lease, no receipt)", async () => {
  await hh.stage(AT, "desktop", DESK);
  const st = await hh.adminState(AT);
  const uploadsBefore = storage().__mock.uploaded.length;
  const r = await hh.stage(AT, "desktop", DESK, { opToken: st.opToken, expectedDraftOpId: "6f2c1f8e-1b1d-4a57-9b2a-111111111111" });
  assert.equal(r.status, 409);
  assert.equal(r.body.code, "HERO_DRAFT_CHANGED");
  assert.equal(r.body.draftOpId, st.draft.desktop.opId, "tells the caller which draft is current");
  const doc = await heroDoc();
  assert.equal(doc.lease, null);
  assert.equal(storage().__mock.uploaded.length, uploadsBefore, "nothing stored");
  assert.ok(!doc.receipts.some((x) => x.opId === opIdOf(st.opToken)), "not an operation that ran");
});

test("draft: the draft it replaces is discarded by another admin while the image is prepared → 409, failure recorded, own objects deleted, lease freed; the discard stands", async () => {
  await hh.stage(AT, "desktop", DESK);
  const st = await hh.adminState(AT);
  const d1 = st.draft.desktop;
  storage().__mock.putDelayMs = 300;
  const job = hh.stage(AT, "desktop", await hh.photo(1920, 740, { hue: 60 }), { opToken: st.opToken, expectedDraftOpId: d1.opId });
  assert.ok(await waitFor(async () => ((await heroDoc()).pending || []).length > 0), "the job is storing");
  const s2 = await hh.adminState(AT2);
  const discard = await h.api("DELETE", "/site/admin/hero/desktop/draft", { token: AT2, body: { opToken: s2.opToken, expectedDraftOpId: d1.opId } });
  assert.equal(discard.status, 200, JSON.stringify(discard.body));
  const r = await job;
  storage().__mock.putDelayMs = 0;
  assert.equal(r.status, 409, JSON.stringify(r.body));
  assert.equal(r.body.code, "HERO_DRAFT_CHANGED");
  const doc = await heroDoc();
  assert.equal(doc.draft.desktop, null, "the discard stands; the job installed nothing");
  assert.equal(doc.lease, null, "lease freed");
  assert.equal(doc.receipts.find((x) => x.opId === opIdOf(st.opToken)).status, "failed");
  const jobMaster = doc.pending.map((p) => p.masterKey).find((k) => k !== storage().keyFromUrl(d1.url));
  assert.ok(jobMaster, "the job's upload record stays until the sweep confirms");
  assert.deepEqual(objects().filter((k) => k.startsWith(jobMaster)), [], "the job's objects were deleted");
  assert.ok(objects().some((k) => k.startsWith(storage().keyFromUrl(d1.url))), "the discarded draft waits for the sweep (24 h)");
  assert.equal(await audits("site.hero.stage"), 1, "only the first draft was audited");
  // the sweep later lets go of the job's record (its objects are gone)
  const sw = await sweeper().sweep({ now: new Date(Date.now() + 25 * HOUR), force: true });
  assert.equal((await heroDoc()).pending.filter((p) => p.masterKey === jobMaster).length, 0, JSON.stringify(sw));
});

test("draft: the job's own lease runs out before it installs (nobody took it) → 503 HERO_TIMEOUT, failure recorded, objects deleted, lease freed", async () => {
  process.env.SITE_HERO_LEASE_MS = "2000";
  storage().__mock.putDelayMs = 500;
  const st = await hh.adminState(AT);
  const r = await hh.stage(AT, "desktop", DESK, { opToken: st.opToken, expectedDraftOpId: "" });
  storage().__mock.putDelayMs = 0;
  assert.equal(r.status, 503, JSON.stringify(r.body));
  assert.equal(r.body.code, "HERO_TIMEOUT");
  const doc = await heroDoc();
  assert.equal(doc.draft.desktop, null);
  assert.equal(doc.lease, null);
  assert.equal(doc.receipts.find((x) => x.opId === opIdOf(st.opToken)).status, "failed");
  assert.deepEqual(objects(), [], "nothing left stored");
  assert.equal((await opStatus(opIdOf(st.opToken))).body.status, "failed");
});

test("draft: an unexpected error after uploads started → 500, every attempted object deleted, failure recorded, lease freed", async () => {
  const img = heroImage();
  const real = img.renderOutputs;
  img.renderOutputs = (raster, slot, onOutput, opts) =>
    real(
      raster,
      slot,
      async (o) => {
        await onOutput(o);
        if (o.kind !== "master") throw new Error("encoder crashed");
      },
      opts,
    );
  const st = await hh.adminState(AT);
  let r;
  try {
    r = await hh.stage(AT, "desktop", DESK, { opToken: st.opToken, expectedDraftOpId: "" });
  } finally {
    img.renderOutputs = real;
  }
  assert.equal(r.status, 500, JSON.stringify(r.body));
  assert.equal(r.body.code, "SERVER_ERROR");
  assert.ok(storage().__mock.uploaded.length >= 1, "something had been stored");
  assert.deepEqual(objects(), [], "…and every attempted object is gone");
  const doc = await heroDoc();
  assert.equal(doc.lease, null);
  assert.equal(doc.draft.desktop, null);
  assert.equal(doc.receipts.find((x) => x.opId === opIdOf(st.opToken)).status, "failed");
});

test("discard: when the audit row can't be written nothing changes (503) and the same token can run again", async () => {
  await hh.stage(AT, "desktop", DESK);
  const st = await hh.adminState(AT);
  const Log = AdminAuditLog();
  const original = Log.create;
  Log.create = async () => {
    throw new Error("audit store down");
  };
  let r;
  try {
    r = await h.api("DELETE", "/site/admin/hero/desktop/draft", { token: AT, body: { opToken: st.opToken, expectedDraftOpId: st.draft.desktop.opId } });
  } finally {
    Log.create = original;
  }
  assert.equal(r.status, 503);
  assert.equal(r.body.code, "AUDIT_UNAVAILABLE");
  let doc = await heroDoc();
  assert.equal(doc.draft.desktop.opId, st.draft.desktop.opId, "draft kept");
  assert.equal(doc.retired.length, 0, "nothing retired");
  assert.ok(!doc.receipts.some((x) => x.opId === opIdOf(st.opToken)), "no receipt");
  const again = await h.api("DELETE", "/site/admin/hero/desktop/draft", { token: AT, body: { opToken: st.opToken, expectedDraftOpId: st.draft.desktop.opId } });
  assert.equal(again.status, 200);
  doc = await heroDoc();
  assert.equal(doc.draft.desktop, null);
});

test("sweep: when a draft's expiry can't be audited the draft stays (nothing retired, nothing deleted)", async () => {
  await hh.stage(AT, "desktop", DESK);
  await SiteSetting().collection.updateOne({ _id: "home_hero" }, { $set: { "draft.desktop.expiresAt": new Date(Date.now() - HOUR) } });
  const before = objects().length;
  const Log = AdminAuditLog();
  const original = Log.create;
  Log.create = async () => {
    throw new Error("audit store down");
  };
  const lines = [];
  let r;
  try {
    r = await sweeper().sweep({ force: true, log: (l) => lines.push(l) });
  } finally {
    Log.create = original;
  }
  assert.equal(r.expiredDrafts, 0);
  assert.ok(lines.some((l) => /draft expiry failed/.test(l)), lines.join("\n"));
  const doc = await heroDoc();
  assert.ok(doc.draft.desktop, "draft kept");
  assert.equal(doc.retired.length, 0);
  assert.equal(objects().length, before, "nothing deleted");
});

// --- initialisation, sessions, environments -------------------------------------------------
test("first use by many requests at once: one settings document, every request answered", async () => {
  const rs = await Promise.all(Array.from({ length: 12 }, (_, i) => h.api("GET", "/site/admin/hero", { token: i % 2 ? AT : AT2 })));
  assert.deepEqual([...new Set(rs.map((r) => r.status))], [200]);
  assert.equal(await SiteSetting().collection.countDocuments({}), 1);
  assert.equal((await heroDoc()).version, 0);
});

test("sessions whose rights change: an admin-role user demoted, and an admin banned, are refused on their next request with the same token", async () => {
  assert.equal((await h.api("GET", "/site/admin/hero", { token: RAT })).status, 200);
  await User().updateOne({ _id: RA._id }, { $set: { role: "host" } });
  assert.equal((await h.api("GET", "/site/admin/hero", { token: RAT })).status, 403, "demoted to host");
  await User().updateOne({ _id: RA._id }, { $set: { role: "user" } });
  const st = await hh.adminState(AT);
  assert.equal((await h.api("POST", "/site/admin/hero/restore-default", { token: RAT, body: { opToken: st.opToken, expectedVersion: 0 } })).status, 403, "demoted to guest");
  await User().updateOne({ _id: RA._id }, { $set: { role: "admin" } });
  const X = await h.makeAdmin();
  const XT = h.adminToken(X);
  assert.equal((await h.api("GET", "/site/admin/hero", { token: XT })).status, 200);
  await Admin().updateOne({ _id: X._id }, { $set: { "status.banned": true, "status.active": false } });
  assert.equal((await h.api("GET", "/site/admin/hero", { token: XT })).status, 401, "banned mid-session");
  const up = await hh.multipart("/site/admin/hero/desktop/draft", { token: XT, fields: { opToken: st.opToken }, file: { buf: DESK } });
  assert.equal(up.status, 401);
  assert.equal(storage().__mock.uploaded.length, 0, "nothing stored for the banned admin");
});

test("environments: only the exact production signals count; another QA run's records are never acted on", async () => {
  const hero = require("../../services/siteHero");
  delete process.env.SITE_HERO_PRODUCTION;
  for (const v of ["true", "yes", "0", " 1", "1 "]) {
    process.env.SITE_HERO_PRODUCTION = v;
    assert.equal(hero.isProduction(), false, `SITE_HERO_PRODUCTION=${JSON.stringify(v)}`);
  }
  delete process.env.SITE_HERO_PRODUCTION;
  for (const v of ["development", "preview", "Production", ""]) {
    process.env.VERCEL_ENV = v;
    assert.equal(hero.keyPrefix(), "_qa/site/hero/dev/", `VERCEL_ENV=${JSON.stringify(v)}`);
  }
  delete process.env.VERCEL_ENV;
  process.env.SITE_HERO_PREFIX = "site/hero/";
  assert.equal(hero.keyPrefix(), "_qa/site/hero/dev/", "a non-production server can't name production's prefix");
  process.env.SITE_HERO_PREFIX = "_qa/site/hero/run-1/";
  // run-1's database names run-2's objects (a copied QA database)
  const other = `_qa/site/hero/run-2/desktop/${require("crypto").randomUUID()}.jpg`;
  for (const k of [other, `${other}/v1/w640.avif`]) storage().__mock.objects.set(k, { body: Buffer.alloc(8), contentType: "image/jpeg", cacheControl: "", lastModified: new Date(Date.now() - 48 * HOUR) });
  await hero.ensureDoc();
  await SiteSetting().collection.updateOne({ _id: "home_hero" }, { $push: { retired: { masterKeys: [other], retiredAt: new Date(Date.now() - 48 * HOUR) }, pending: { masterKey: other, at: new Date(Date.now() - 48 * HOUR) } } });
  const r = await sweeper().sweep({ force: true });
  assert.equal(objects("_qa/site/hero/run-2/").length, 2, `run-2's objects untouched: ${JSON.stringify(r)}`);
  assert.equal(storage().__mock.deleted.length, 0, "nothing deleted at all");
});

// --- batch 2 (reviewer findings INT-1…9, SEC-A/B/E, D1, P4) -------------------------------
const mongoose = require("mongoose");
const ops = () => require("../../services/siteHeroOps");
const underKey = (master) => [...storage().__mock.objects.keys()].filter((k) => k === master || k.startsWith(`${master}/`));
// A real driver commit error without the UnknownTransactionCommitResult label:
// w:2 on the one-node test replica set → UnsatisfiableWriteConcern on commit,
// after the commit applied on the primary.
function unlabelledCommitErrors() {
  const real = mongoose.startSession.bind(mongoose);
  const seen = [];
  mongoose.startSession = async () => {
    const s = await real({ defaultTransactionOptions: { writeConcern: { w: 2 } } });
    const wt = s.withTransaction.bind(s);
    s.withTransaction = async (fn, o) => {
      try {
        return await wt(fn, o);
      } catch (e) {
        seen.push({ code: e.code, unknownLabel: !!(e.hasErrorLabel && e.hasErrorLabel("UnknownTransactionCommitResult")) });
        throw e;
      }
    };
    return s;
  };
  return { seen, restore: () => (mongoose.startSession = real) };
}

test("INT-1: a commit error the driver leaves unlabelled (write concern) is 'unknown' — the saved draft keeps its objects; the same-token retry replays it", async () => {
  const st = await hh.adminState(AT);
  const inj = unlabelledCommitErrors();
  let r;
  try {
    r = await hh.stage(AT, "desktop", DESK, { opToken: st.opToken, expectedDraftOpId: "" });
  } finally {
    inj.restore();
  }
  assert.equal(inj.seen.length, 1);
  assert.equal(inj.seen[0].unknownLabel, false, "the driver did not label it");
  assert.equal(r.status, 503, JSON.stringify(r.body));
  assert.equal(r.body.code, "HERO_OUTCOME_UNKNOWN", "never 'Nothing was saved'");
  const doc = await heroDoc();
  assert.ok(doc.draft.desktop, "the commit applied");
  const key = storage().keyFromUrl(doc.draft.desktop.url);
  assert.ok(underKey(key).length >= 2, "its objects are all still there");
  assert.equal(doc.lease, null);
  const again = await hh.stage(AT, "desktop", DESK, { opToken: st.opToken, expectedDraftOpId: "" });
  assert.equal(again.status, 200, JSON.stringify(again.body));
  assert.equal(again.body.replayed, true);
});

test("INT-1: the same on publish — 503 unknown (not 'nothing saved'); status completed; the retry replays", async () => {
  await hh.stage(AT, "desktop", DESK);
  await hh.stage(AT, "mobile", MOB);
  const st = await hh.adminState(AT);
  const body = { opToken: st.opToken, expectedVersion: st.version, slots: { desktop: st.draft.desktop.opId, mobile: st.draft.mobile.opId }, alt: "A season banner" };
  const inj = unlabelledCommitErrors();
  let r;
  try {
    r = await h.api("POST", "/site/admin/hero/publish", { token: AT, body });
  } finally {
    inj.restore();
  }
  assert.equal(r.body.code, "HERO_OUTCOME_UNKNOWN", JSON.stringify(r.body));
  assert.equal((await heroDoc()).version, 1);
  assert.equal((await opStatus(opIdOf(st.opToken))).body.status, "completed");
  const again = await h.api("POST", "/site/admin/hero/publish", { token: AT, body });
  assert.equal(again.status, 200);
  assert.equal(again.body.replayed, true);
  assert.equal(await audits("site.hero.publish"), 1);
});

test("INT-6: when a database session can't start at install, the lease is released at once and the failure recorded", async () => {
  const st = await hh.adminState(AT);
  const real = mongoose.startSession.bind(mongoose);
  mongoose.startSession = async () => {
    throw new Error("no session");
  };
  let r;
  try {
    r = await hh.stage(AT, "desktop", DESK, { opToken: st.opToken, expectedDraftOpId: "" });
  } finally {
    mongoose.startSession = real;
  }
  assert.equal(r.status, 503, JSON.stringify(r.body));
  const doc = await heroDoc();
  assert.equal(doc.lease, null, "not stuck for 150 s");
  assert.equal(doc.receipts.find((x) => x.opId === opIdOf(st.opToken)).status, "failed");
  assert.deepEqual(objects(), [], "nothing left stored");
});

test("INT-4: an install that finds this operation already has an outcome replays it (one receipt) and cleans up after itself", async () => {
  const st = await hh.adminState(AT);
  const opId = opIdOf(st.opToken);
  const fp = ops().fingerprint({ action: "stage", slot: "desktop", file: require("crypto").createHash("sha256").update(DESK).digest("hex"), focal: { x: 0.5, y: 0.5 }, acceptRatio: false, clientReencoded: false, expectedDraftOpId: null });
  const c = SiteSetting().collection;
  const realFOAU = c.findOneAndUpdate;
  let armed = true;
  // right after this attempt takes the lease, an earlier attempt of the same
  // request records its failure (the interleaving the reviewer found)
  c.findOneAndUpdate = async function (...args) {
    const res = await realFOAU.apply(this, args);
    if (armed && args[1] && args[1].$set && args[1].$set.lease) {
      armed = false;
      await c.updateOne({ _id: "home_hero" }, { $push: { receipts: { opId, actorId: ADMIN._id, action: "stage", target: "desktop", fingerprint: fp, status: "failed", result: { httpStatus: 503, code: "HERO_TIMEOUT", message: "Preparing the image took too long" }, at: new Date() } } });
    }
    return res;
  };
  let r;
  try {
    r = await hh.stage(AT, "desktop", DESK, { opToken: st.opToken, expectedDraftOpId: "" });
  } finally {
    c.findOneAndUpdate = realFOAU;
  }
  assert.equal(r.status, 503, JSON.stringify(r.body));
  assert.equal(r.body.code, "HERO_TIMEOUT");
  assert.equal(r.body.replayed, true, "the recorded outcome, not 'changed by someone else'");
  const doc = await heroDoc();
  assert.equal(doc.receipts.filter((x) => x.opId === opId).length, 1, "one receipt");
  assert.equal(doc.draft.desktop, null);
  assert.equal(doc.lease, null);
  assert.deepEqual(objects(), [], "this attempt's objects were deleted");
});

test("INT-5: receipts at the cap — two operations that both passed the check can't evict a retryable receipt (one gets 429)", async () => {
  await banner();
  await hh.stage(AT, "desktop", await hh.photo(1920, 740, { hue: 77 }));
  const cap = ops().RECEIPT_CAP;
  const doc0 = await heroDoc();
  const fill = cap - 1 - doc0.receipts.length;
  const filler = Array.from({ length: fill }, (_, i) => ({ opId: require("crypto").randomUUID(), actorId: ADMIN._id, action: "alt", target: "alt", fingerprint: "x", status: "completed", result: {}, at: new Date(Date.now() - 60_000 + i) }));
  await SiteSetting().collection.updateOne({ _id: "home_hero" }, { $push: { receipts: { $each: filler, $position: 0 } } });
  assert.equal((await heroDoc()).receipts.length, cap - 1);
  const oldest = (await heroDoc()).receipts[0].opId;
  const [s1, s2] = [await hh.adminState(AT), await hh.adminState(AT2)];
  const release = readBarrier(2);
  let rs;
  try {
    rs = await Promise.all([
      h.api("PATCH", "/site/admin/hero/alt", { token: AT, body: { opToken: s1.opToken, expectedVersion: s1.version, alt: "One" } }),
      h.api("DELETE", "/site/admin/hero/desktop/draft", { token: AT2, body: { opToken: s2.opToken, expectedDraftOpId: s2.draft.desktop.opId } }),
    ]);
  } finally {
    release();
  }
  assert.deepEqual(rs.map((r) => r.status).sort(), [200, 429], JSON.stringify(rs.map((r) => r.body.code)));
  const doc = await heroDoc();
  assert.equal(doc.receipts.length, cap);
  assert.equal(doc.receipts[0].opId, oldest, "the oldest (still retryable) receipt was not evicted");
});

test("INT-7: when the upload records are full, a new job is refused (503) before storing anything — no record is ever dropped", async () => {
  await require("../../services/siteHero").ensureDoc();
  const full = Array.from({ length: 200 }, () => ({ masterKey: `site/hero/desktop/${require("crypto").randomUUID()}.jpg`, at: new Date() }));
  await SiteSetting().collection.updateOne({ _id: "home_hero" }, { $set: { pending: full } });
  const r = await hh.stage(AT, "desktop", DESK);
  assert.equal(r.status, 503, JSON.stringify(r.body));
  assert.equal(r.body.code, "HERO_CLEANUP_BACKLOG");
  const doc = await heroDoc();
  assert.equal(doc.pending.length, 200);
  assert.equal(doc.pending[0].masterKey, full[0].masterKey, "nothing evicted");
  assert.equal(storage().__mock.uploaded.length, 0);
  assert.equal(doc.lease, null);
});

test("INT-8: while a job runs, its id with another file is OP_ID_REUSED; the very same request is 202 processing", async () => {
  storage().__mock.putDelayMs = 250;
  const st = await hh.adminState(AT);
  const first = hh.stage(AT, "desktop", DESK, { opToken: st.opToken, expectedDraftOpId: "" });
  assert.ok(await waitFor(async () => !!((await heroDoc()) || {}).lease));
  const other = await hh.stage(AT, "desktop", await hh.photo(1920, 740, { hue: 33 }), { opToken: st.opToken, expectedDraftOpId: "" });
  assert.equal(other.status, 422, JSON.stringify(other.body));
  assert.equal(other.body.code, "OP_ID_REUSED");
  const same = await hh.stage(AT, "desktop", DESK, { opToken: st.opToken, expectedDraftOpId: "" });
  assert.equal(same.status, 202);
  const reencoded = await hh.stage(AT, "desktop", DESK, { opToken: st.opToken, expectedDraftOpId: "", fields: { clientReencoded: "1" } });
  assert.equal(reencoded.status, 422, "clientReencoded is part of the request");
  storage().__mock.putDelayMs = 0;
  assert.equal((await first).status, 201);
});

test("INT-9: a listing page marked truncated without a continuation token is an error, never a short listing", async () => {
  const cfgPath = require.resolve("../../config/digitalOcean.config");
  const saved = require.cache[cfgPath];
  require.cache[cfgPath] = { id: cfgPath, filename: cfgPath, loaded: true, exports: { listObjectsV2: () => ({ promise: async () => ({ Contents: [{ Key: "a/1", Size: 1 }], IsTruncated: true }) }) } };
  process.env.SPACES_MOCK = "0";
  try {
    await assert.rejects(() => storage().listKeys("a/"), (e) => e.code === "LIST_INCOMPLETE");
  } finally {
    process.env.SPACES_MOCK = "1";
    if (saved) require.cache[cfgPath] = saved;
    else delete require.cache[cfgPath];
  }
});

test("SEC-A: a non-production server never changes or sweeps production's banner document; production takes over a document of another namespace; an old document is bound", async () => {
  await banner(); // created as production (SITE_HERO_PRODUCTION=1): namespace site/hero/
  assert.equal((await heroDoc()).namespace, "site/hero/");
  await SiteSetting().collection.updateOne({ _id: "home_hero" }, { $push: { retired: { masterKeys: ["site/hero/desktop/old.jpg"], retiredAt: new Date(Date.now() - 48 * HOUR) } } });
  const before = await heroDoc();
  delete process.env.SITE_HERO_PRODUCTION; // now a laptop / preview pointed at that database
  const st = await hh.adminState(AT);
  assert.equal(st.environment.writable, false);
  const refused = [
    await hh.stage(AT, "desktop", DESK),
    await h.api("PATCH", "/site/admin/hero/alt", { token: AT, body: { opToken: st.opToken, expectedVersion: st.version, alt: "x" } }),
    await h.api("POST", "/site/admin/hero/restore-default", { token: AT, body: { opToken: (await hh.adminState(AT)).opToken, expectedVersion: st.version } }),
  ];
  for (const r of refused) {
    assert.equal(r.status, 409, JSON.stringify(r.body));
    assert.equal(r.body.code, "HERO_WRONG_ENVIRONMENT");
  }
  assert.equal((await sweeper().sweep({ force: true })).skipped, "other-environment");
  assert.equal((await sweeper().sweep({})).skipped, "other-environment");
  const after = await heroDoc();
  assert.deepEqual(
    { v: after.version, r: after.retired.length, p: after.pending.length, s: String(after.lastSweepAt), d: !!after.draft.desktop },
    { v: before.version, r: before.retired.length, p: before.pending.length, s: String(before.lastSweepAt), d: !!before.draft.desktop },
    "production's document untouched (not even the sweep claim)",
  );
  assert.equal(storage().__mock.uploaded.filter((u) => !u.key.startsWith("site/hero/")).length, 0, "nothing stored for it");
  // production takes over a document created under a QA namespace
  await SiteSetting().collection.updateOne({ _id: "home_hero" }, { $set: { namespace: "_qa/site/hero/dev/" } });
  process.env.SITE_HERO_PRODUCTION = "1";
  const s2 = await hh.adminState(AT);
  const ok = await h.api("PATCH", "/site/admin/hero/alt", { token: AT, body: { opToken: s2.opToken, expectedVersion: s2.version, alt: "Adopted" } });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal((await heroDoc()).namespace, "site/hero/");
  // a document from before the rule is bound to its first writer
  await SiteSetting().collection.updateOne({ _id: "home_hero" }, { $unset: { namespace: 1 } });
  const s3 = await hh.adminState(AT);
  assert.equal((await h.api("PATCH", "/site/admin/hero/alt", { token: AT, body: { opToken: s3.opToken, expectedVersion: s3.version, alt: "Bound" } })).status, 200);
  assert.equal((await heroDoc()).namespace, "site/hero/");
});

test("SEC-B: keys with '.' segments (e.g. ./site/… via %2F) are not our keys", () => {
  const s = storage();
  const base = s.publicUrl("x").replace(/x$/, "");
  // a "." segment hidden behind %2F survives URL parsing and must be refused
  for (const p of [".%2Fsite/hero/desktop/a.jpg", "%2E%2Fsite/hero/desktop/a.jpg", "listings/.%2Fa.jpg", "a/.%2F.%2Fsite/x.jpg"]) assert.equal(s.keyFromUrl(`${base}${p}`), null, p);
  // a plain "/./" or "/%2E/" is normalised by the URL parser itself (the browser fetches the same object)
  assert.equal(s.keyFromUrl(`${base}listings/./a.jpg`), "listings/a.jpg");
  assert.equal(s.keyFromUrl(`${base}listings/%2E/a.jpg`), "listings/a.jpg");
  assert.equal(s.keyFromUrl(`${base}listings/a.jpg`), "listings/a.jpg");
});

test("SEC-E: with SPACES_WRITE_PREFIX (the real-bucket harness) every put and delete outside it is refused; the harness itself refuses production flags", async () => {
  process.env.SPACES_WRITE_PREFIX = "_qa/";
  try {
    await assert.rejects(() => storage().putObject("listings/x.jpg", Buffer.from("x"), "image/jpeg"), (e) => e.code === "WRITE_PREFIX");
    storage().__mock.objects.set("listings/keep.jpg", { body: Buffer.from("x"), contentType: "image/jpeg", cacheControl: "", lastModified: new Date() });
    const r = await storage().deleteObjects(["listings/keep.jpg", "site/hero/desktop/k.jpg"], { allowProtected: true });
    assert.deepEqual(r.deleted, []);
    assert.deepEqual(r.failed.map((f) => f.code), ["WRITE_PREFIX", "WRITE_PREFIX"]);
    assert.ok(storage().__mock.objects.has("listings/keep.jpg"));
    await storage().putObject("_qa/site/hero/x/ok.jpg", Buffer.from("x"), "image/jpeg");
  } finally {
    delete process.env.SPACES_WRITE_PREFIX;
  }
  const { spawnSync } = require("child_process");
  const script = "require('./tests/batch-s/setup').start().then(()=>process.exit(0),(e)=>{console.log(e.message);process.exit(3)})";
  const run = (env) => spawnSync(process.execPath, ["-e", script], { cwd: require("path").resolve(__dirname, "../.."), env: { PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT, E2E_REAL_SPACES: "1", ...env }, encoding: "utf8", timeout: 60000 });
  const noPrefix = run({});
  assert.equal(noPrefix.status, 3, noPrefix.stdout + noPrefix.stderr);
  assert.match(noPrefix.stdout, /needs SITE_HERO_PREFIX/);
  const prod = run({ SITE_HERO_PREFIX: "_qa/site/hero/x/", SITE_HERO_PRODUCTION: "1" });
  assert.equal(prod.status, 3);
  assert.match(prod.stdout, /must not run as production/);
  assert.equal(run({ SITE_HERO_PREFIX: "_qa/site/hero/x/", VERCEL: "1" }).status, 3);
});

test("P4: desktop renditions run from 960 to 2560 px (the master keeps its width); a 2805 px banner offers nothing wider or narrower", async () => {
  const wide = await hh.photo(2805, 1081, { hue: 140 });
  const r = await hh.stage(AT, "desktop", wide);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const d = r.body.state.draft.desktop;
  assert.equal(d.width, 2805, "master at full width");
  assert.deepEqual(d.renditions.map((x) => x.width), [960, 1280, 1600, 1920, 2560], "from 960 (desktop art is shown from 768 px) to 2560");
  const key = storage().keyFromUrl(d.url);
  assert.ok(!objects().some((k) => k.startsWith(`${key}/`) && /w3840/.test(k)), "no w3840 rendition stored");
});

test("D1: status polls and the admin read never ship the bookkeeping arrays (bounded replies with a full document)", async () => {
  await banner();
  const crypto = require("crypto");
  const receipts = Array.from({ length: 480 }, (_, i) => ({ opId: crypto.randomUUID(), actorId: ADMIN._id, action: "alt", target: "alt", fingerprint: "f".repeat(64), status: "completed", result: { version: i }, at: new Date(Date.now() - 2 * HOUR) }));
  const pending = Array.from({ length: 190 }, () => ({ masterKey: `site/hero/desktop/${crypto.randomUUID()}.jpg`, at: new Date() }));
  const retired = Array.from({ length: 60 }, () => ({ masterKeys: [`site/hero/desktop/${crypto.randomUUID()}.jpg`], retiredAt: new Date() }));
  await SiteSetting().collection.updateOne({ _id: "home_hero" }, { $push: { receipts: { $each: receipts } }, $set: { pending, retired } });
  const BSON = mongoose.mongo.BSON;
  const full = BSON.calculateObjectSize(await heroDoc());
  const c = SiteSetting().collection;
  const real = c.findOne;
  const sizes = [];
  c.findOne = async function (...args) {
    const res = await real.apply(this, args);
    sizes.push(res ? BSON.calculateObjectSize(res) : 0);
    return res;
  };
  try {
    sizes.length = 0;
    await opStatus(receipts[7].opId);
    const poll = Math.max(...sizes);
    sizes.length = 0;
    await hh.adminState(AT);
    const state = Math.max(...sizes);
    console.log(`[site-hero] reply bytes — full document ${full}, status poll ${poll}, admin read ${state}`);
    assert.ok(full > 100_000, `the document is realistically full (${full})`);
    assert.ok(poll < 3_000, `status poll ${poll} bytes`);
    assert.ok(state < 8_000, `admin read ${state} bytes`);
  } finally {
    c.findOne = real;
  }
});

test('QR: a "code" that decodes to nothing (jsQR on dithered noise) does not refuse a banner; listings keep their rule', async () => {
  const { detectQr } = require('../../services/imageSanitizer');
  const sharp = require('sharp');
  const buf = require('fs').readFileSync(require('path').join(__dirname, 'fixtures/qr-empty-decode.png'));
  assert.equal(await detectQr(sharp(buf)), true, 'the listing rule (unchanged) sees an empty version-1 decode');
  assert.equal(await detectQr(sharp(buf), { requirePayload: true }), false, 'the banner rule needs a payload');
});

test("sweep CLI: unknown arguments stop it; it prints the environment it runs as; a dry run writes nothing; a non-production run against production's document does nothing", async () => {
  await banner(); // a production document (namespace site/hero/)
  await SiteSetting().collection.updateOne({ _id: "home_hero" }, { $set: { lastSweepAt: null } });
  const before = await heroDoc();
  const { spawnSync } = require("child_process");
  const cli = (args, env) =>
    spawnSync(process.execPath, ["scripts/site-hero-sweep.js", `--uri=${process.env.DB_URI}`, ...args], {
      cwd: require("path").resolve(__dirname, "../.."),
      env: { PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT, SPACES_MOCK: "1", JWT_SECRET: "x", DO_SPACES_BUCKET: "test-bucket", REGION: "blr1", ...env },
      encoding: "utf8",
      timeout: 90000,
    });
  const bad = cli(["--aply"], {});
  assert.equal(bad.status, 1, bad.stdout + bad.stderr);
  assert.match(bad.stderr, /unknown argument/);
  const laptop = cli(["--apply"], {});
  assert.equal(laptop.status, 0, laptop.stderr);
  assert.match(laptop.stdout, /environment: not production \(prefix _qa\/site\/hero\/dev\/\); APPLY/);
  assert.match(laptop.stdout, /other-environment/);
  const prodDry = cli([], { SITE_HERO_PRODUCTION: "1" });
  assert.equal(prodDry.status, 0, prodDry.stderr);
  assert.match(prodDry.stdout, /environment: production \(prefix site\/hero\/\); dry run/);
  assert.match(prodDry.stdout, /"dryRun": true/);
  const after = await heroDoc();
  assert.deepEqual(
    { s: after.lastSweepAt, r: after.retired.length, p: after.pending.length, v: after.version },
    { s: before.lastSweepAt, r: before.retired.length, p: before.pending.length, v: before.version },
    "nothing written by any of the three",
  );
});

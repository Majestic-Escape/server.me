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

// Homepage hero — the sweep (services/siteHeroSweep.js): eventual cleanup
// that never deletes anything referenced, keeps retired art for 24 h,
// removes crash orphans and expired drafts, keeps its records until a
// deletion is confirmed, runs once per window, and the daily cron route.
const test = require("node:test");
const assert = require("node:assert/strict");
const h = require("./setup");
const hh = require("./hero-helpers");

const storage = () => require("../../services/storage");
const SiteSetting = () => require("../../models/SiteSetting");
const AdminAuditLog = () => require("../../models/AdminAuditLog");
const sweeper = () => require("../../services/siteHeroSweep");
const changed = () => require("../../services/listingChanged");

const HOUR = 60 * 60 * 1000;
let ADMIN, AT, DESK, MOB;
const heroDoc = () => SiteSetting().collection.findOne({ _id: "home_hero" });
const objects = (prefix = "site/hero/") => [...storage().__mock.objects.keys()].filter((k) => k.startsWith(prefix));
const later = (hours) => new Date(Date.now() + hours * HOUR);
async function reset() {
  await SiteSetting().collection.deleteMany({});
  storage().resetMock();
  changed().__setMock({ calls: [] });
  delete process.env.SITE_HERO_PREFIX;
  delete process.env.VERCEL;
}
async function publishPair(hue = 10) {
  await hh.stage(AT, "desktop", await hh.photo(1920, 740, { hue }));
  await hh.stage(AT, "mobile", await hh.photo(530, 720, { hue: hue + 100 }));
  const p = await hh.publish(AT);
  assert.equal(p.status, 200, JSON.stringify(p.body));
  return p.body.state;
}
const liveKeys = (state) => ["desktop", "mobile"].map((s) => storage().keyFromUrl(state[s].url));
const underMaster = (master) => objects().filter((k) => k === master || k.startsWith(`${master}/`));

test.before(async () => {
  await h.start();
  ADMIN = await h.makeAdmin();
  AT = h.adminToken(ADMIN);
  DESK = await hh.photo(1920, 740);
  MOB = await hh.photo(530, 720);
});
test.after(async () => h.stop());
test.beforeEach(reset);

test("cron route: only Vercel Cron's secret runs it", async () => {
  assert.equal((await h.api("GET", "/site/cron/hero-sweep")).status, 401);
  assert.equal((await h.api("GET", "/site/cron/hero-sweep", { headers: { authorization: "Bearer nope" } })).status, 401);
  const ok = await h.api("GET", "/site/cron/hero-sweep", { headers: { authorization: `Bearer ${process.env.CRON_SECRET}` } });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.success, true);
  const again = await h.api("GET", "/site/cron/hero-sweep", { headers: { authorization: `Bearer ${process.env.CRON_SECRET}` } });
  assert.equal(again.body.skipped, "recent", "once per window");
});

test("one runner per window: concurrent sweeps → one runs, the rest skip", async () => {
  await publishPair();
  await SiteSetting().collection.updateOne({ _id: "home_hero" }, { $set: { lastSweepAt: null } });
  const results = await Promise.all([sweeper().sweep(), sweeper().sweep(), sweeper().sweep()]);
  assert.equal(results.filter((r) => r.skipped === "recent").length, 2, JSON.stringify(results));
});

test("retired art: kept for 24 h (cached pages), then deleted by a later sweep; the record goes only once its objects are gone; live art is never touched", async () => {
  const first = await publishPair(10);
  const oldKeys = liveKeys(first);
  const second = await publishPair(200);
  const live = liveKeys(second);
  const doc = await heroDoc();
  assert.equal(doc.retired.length, 2);
  const now = await sweeper().sweep({ force: true });
  assert.equal(now.deleted, 0, "retired less than 24 h ago: kept");
  for (const k of oldKeys) assert.ok(underMaster(k).length > 0);
  const day = await sweeper().sweep({ now: later(25), force: true });
  assert.ok(day.deleted > 0, JSON.stringify(day));
  for (const k of oldKeys) assert.deepEqual(underMaster(k), [], `retired ${k} deleted`);
  for (const k of live) assert.ok(underMaster(k).length >= 3, "live art untouched");
  assert.equal(day.retiredPulled, 2);
  assert.equal((await heroDoc()).retired.length, 0);
  assert.ok(storage().__mock.purged.length > 0, "deleted objects are purged from the CDN");
  // far in the future the live pair is still referenced
  const decade = await sweeper().sweep({ now: later(24 * 3650), force: true });
  assert.equal(decade.deleted, 0);
  for (const k of live) assert.ok(underMaster(k).length >= 3);
});

test("orphans (a crash between upload and commit, a replaced or discarded draft): unreferenced and older than 24 h → deleted; younger → kept", async () => {
  const orphan = "site/hero/desktop/6f2c1f8e-1b1d-4a57-9b2a-000000000abc.jpg";
  for (const k of [orphan, `${orphan}/v1/w640.avif`, `${orphan}/v1/w640.webp`]) storage().__mock.objects.set(k, { body: Buffer.alloc(8), contentType: "image/jpeg", cacheControl: "", lastModified: new Date() });
  const st = await hh.adminState(AT);
  const x = await hh.stage(AT, "desktop", DESK, { opToken: st.opToken, expectedDraftOpId: "" });
  const xKey = storage().keyFromUrl(x.body.state.draft.desktop.url);
  await hh.stage(AT, "desktop", await hh.photo(1920, 740, { hue: 70 }), { expectedDraftOpId: x.body.state.draft.desktop.opId }); // x replaced
  const kept = await sweeper().sweep({ force: true });
  assert.equal(kept.deleted, 0, "younger than 24 h");
  const later25 = await sweeper().sweep({ now: later(25), force: true });
  assert.deepEqual(underMaster(orphan), [], "crash orphan removed");
  assert.deepEqual(underMaster(xKey), [], "replaced draft removed");
  const current = storage().keyFromUrl((await heroDoc()).draft.desktop.url);
  assert.ok(underMaster(current).length >= 3, "the current draft is referenced");
  assert.ok(later25.deleted >= 3);
});

test("expired drafts: removed from the document (system audit), then their objects once they are old", async () => {
  await hh.stage(AT, "desktop", DESK);
  const key = storage().keyFromUrl((await heroDoc()).draft.desktop.url);
  const r = await sweeper().sweep({ now: later(24 * 8), force: true });
  assert.equal(r.expiredDrafts, 1);
  assert.equal((await heroDoc()).draft.desktop, null);
  const row = await AdminAuditLog().findOne({ action: "site.hero.draft_expire" }).lean();
  assert.equal(row.actorKind, "system");
  assert.equal(row.targetKey, "home_hero");
  assert.equal(row.actorId, undefined);
  assert.deepEqual(underMaster(key), [], "its objects went in the same run (older than 24 h by then)");
});

test("failures: a failed delete keeps the retired record for the next run; a failed listing deletes nothing", async () => {
  await publishPair(10);
  await publishPair(200);
  storage().setMockFailure("all");
  const failed = await sweeper().sweep({ now: later(25), force: true });
  assert.ok(failed.failed > 0 || failed.error, JSON.stringify(failed));
  assert.equal((await heroDoc()).retired.length, 2, "records kept");
  storage().setMockFailure("list");
  const noList = await sweeper().sweep({ now: later(25), force: true });
  assert.equal(noList.error, "list");
  assert.equal((await heroDoc()).retired.length, 2);
  storage().setMockFailure(null);
  const ok = await sweeper().sweep({ now: later(25), force: true });
  assert.equal(ok.retiredPulled, 2, JSON.stringify(ok));
});

test("dry run: reports what would go and changes nothing", async () => {
  await publishPair(10);
  await publishPair(200);
  await hh.stage(AT, "desktop", DESK);
  const before = objects().length;
  const retiredBefore = (await heroDoc()).retired.length;
  const d = await sweeper().sweep({ now: later(24 * 8), dryRun: true });
  assert.equal(d.dryRun, true);
  assert.ok(d.candidates > 0);
  assert.equal(objects().length, before);
  assert.equal((await heroDoc()).retired.length, retiredBefore);
  assert.ok((await heroDoc()).draft.desktop, "the draft was not expired by a dry run");
});

test("QA prefix: honoured off production, scoped listing; ignored (default prefix) on Vercel/production", async () => {
  process.env.SITE_HERO_PREFIX = "_qa/site/hero/run-1/";
  const { keyPrefix } = require("../../services/siteHero");
  assert.equal(keyPrefix(), "_qa/site/hero/run-1/");
  const d = await hh.stage(AT, "desktop", DESK);
  assert.match(storage().keyFromUrl(d.body.state.draft.desktop.url), /^_qa\/site\/hero\/run-1\/desktop\//);
  assert.ok(storage().isProtectedKey("_qa/site/hero/run-1/desktop/x.jpg"), "QA objects are protected too");
  process.env.VERCEL = "1";
  assert.equal(keyPrefix(), "site/hero/", "never a QA prefix in production");
  delete process.env.VERCEL;
  process.env.SITE_HERO_PREFIX = "../../evil/";
  assert.equal(keyPrefix(), "site/hero/", "an invalid value falls back to the default");
});

// Homepage hero — the sweep (services/siteHeroSweep.js) and where objects
// live (siteHero.keyPrefix). The sweep deletes only what this database
// recorded as its own and no longer needs — retired art and drafts, and the
// uploads of jobs that never installed — never an object it has no record
// of, never anything referenced, never outside this environment's prefix;
// it keeps retired art for 24 h, keeps its records until a deletion is
// confirmed, runs once per window, and has a daily cron route.
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
const PROD = "site/hero/";
let ADMIN, AT, DESK, MOB;
const heroDoc = () => SiteSetting().collection.findOne({ _id: "home_hero" });
const objects = (prefix = PROD) => [...storage().__mock.objects.keys()].filter((k) => k.startsWith(prefix));
const later = (hours) => new Date(Date.now() + hours * HOUR);
const put = (key, ageHours = 48) => storage().__mock.objects.set(key, { body: Buffer.alloc(8), contentType: "image/jpeg", cacheControl: "", lastModified: new Date(Date.now() - ageHours * HOUR) });
const uuid = () => require("crypto").randomUUID();
async function reset() {
  await SiteSetting().collection.deleteMany({});
  storage().resetMock();
  changed().__setMock({ calls: [] });
  delete process.env.SITE_HERO_PREFIX;
  delete process.env.VERCEL;
  delete process.env.VERCEL_ENV;
  process.env.SITE_HERO_PRODUCTION = "1"; // in-memory storage: the production key layout
}
async function publishPair(hue = 10) {
  await hh.stage(AT, "desktop", await hh.photo(1920, 740, { hue }));
  await hh.stage(AT, "mobile", await hh.photo(530, 720, { hue: hue + 100 }));
  const p = await hh.publish(AT);
  assert.equal(p.status, 200, JSON.stringify(p.body));
  return p.body.state;
}
const liveKeys = (state) => ["desktop", "mobile"].map((s) => storage().keyFromUrl(state[s].url));
const underMaster = (master, prefix = PROD) => objects(prefix).filter((k) => k === master || k.startsWith(`${master}/`));

test.before(async () => {
  await h.start();
  ADMIN = await h.makeAdmin();
  AT = h.adminToken(ADMIN);
  DESK = await hh.photo(1920, 740);
  MOB = await hh.photo(530, 720);
});
test.after(async () => {
  delete process.env.SITE_HERO_PRODUCTION;
  await h.stop();
});
test.beforeEach(reset);

test("cron route: only Vercel Cron's secret runs it", async () => {
  assert.equal((await h.api("GET", "/site/cron/hero-sweep")).status, 401);
  assert.equal((await h.api("GET", "/site/cron/hero-sweep", { headers: { authorization: "Bearer nope" } })).status, 401);
  // a multi-byte header the length of the secret: still a plain 401 (no length oracle)
  assert.equal((await h.api("GET", "/site/cron/hero-sweep", { headers: { authorization: `Bearer ${"é".repeat(process.env.CRON_SECRET.length)}` } })).status, 401);
  const ok = await h.api("GET", "/site/cron/hero-sweep", { headers: { authorization: `Bearer ${process.env.CRON_SECRET}` } });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.success, true);
  const again = await h.api("GET", "/site/cron/hero-sweep", { headers: { authorization: `Bearer ${process.env.CRON_SECRET}` } });
  assert.equal(again.body.skipped, "recent", "once per window");
});

test("one runner per window: concurrent sweeps → one runs, the rest skip", async () => {
  await publishPair();
  // the publish starts a sweep in the background: let it claim its window
  // first, or it could take the one this test hands out
  for (let i = 0; i < 200 && !((await heroDoc()) || {}).lastSweepAt; i += 1) await h.sleep(25);
  await h.sleep(300);
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

test("an object no record names is never deleted, however old (another environment's, something put there by hand)", async () => {
  await publishPair(10);
  const stray = `${PROD}desktop/${uuid()}.jpg`;
  for (const k of [stray, `${stray}/v1/w640.avif`, `${stray}/v1/w640.webp`]) put(k, 24 * 365);
  const r = await sweeper().sweep({ now: later(24 * 30), force: true });
  assert.equal(underMaster(stray).length, 3, "left alone");
  assert.equal(r.unrecorded, 3, JSON.stringify(r));
});

test("a replaced draft and a discarded draft are retired at that moment, then deleted a day later; the current draft is untouched", async () => {
  const a = await hh.stage(AT, "desktop", DESK);
  const aKey = storage().keyFromUrl(a.body.state.draft.desktop.url);
  const b = await hh.stage(AT, "desktop", await hh.photo(1920, 740, { hue: 70 }), { expectedDraftOpId: a.body.state.draft.desktop.opId });
  assert.equal(b.status, 201, JSON.stringify(b.body));
  const bKey = storage().keyFromUrl(b.body.state.draft.desktop.url);
  const m = await hh.stage(AT, "mobile", MOB);
  const mKey = storage().keyFromUrl(m.body.state.draft.mobile.url);
  const st = await hh.adminState(AT);
  const del = await h.api("DELETE", "/site/admin/hero/mobile/draft", { token: AT, body: { opToken: st.opToken, expectedDraftOpId: m.body.state.draft.mobile.opId } });
  assert.equal(del.status, 200, JSON.stringify(del.body));
  const doc = await heroDoc();
  assert.deepEqual(doc.retired.map((r) => r.masterKeys[0]).sort(), [aKey, mKey].sort(), "replaced + discarded recorded");
  assert.deepEqual(doc.pending, [], "installed jobs leave no pending record");
  assert.equal((await sweeper().sweep({ force: true })).deleted, 0, "within 24 h: kept");
  const r = await sweeper().sweep({ now: later(25), force: true });
  assert.deepEqual(underMaster(aKey), [], "replaced draft removed");
  assert.deepEqual(underMaster(mKey), [], "discarded draft removed");
  assert.ok(underMaster(bKey).length >= 3, "the current draft is referenced");
  assert.equal(r.retiredPulled, 2, JSON.stringify(r));
});

test("a job that never installed (crash, lost lease, failure): its pending record lets the sweep remove its uploads a day later", async () => {
  // a job that died between upload and install: the record, the uploads
  const key = `${PROD}desktop/${uuid()}.jpg`;
  for (const k of [key, `${key}/v1/w640.avif`, `${key}/v1/w1920.webp`]) put(k, 1);
  await hh.stage(AT, "mobile", MOB); // creates the document
  await SiteSetting().collection.updateOne({ _id: "home_hero" }, { $push: { pending: { masterKey: key, at: new Date() } } });
  const early = await sweeper().sweep({ now: later(2), force: true });
  assert.equal(early.deleted, 0, "not before 24 h (a job could still be running)");
  const r = await sweeper().sweep({ now: later(25), force: true });
  assert.deepEqual(underMaster(key), [], JSON.stringify(r));
  assert.equal(r.pendingPulled, 1);
  assert.deepEqual((await heroDoc()).pending, []);
  // a real failure after uploads: cleaned up at once, its record swept later
  storage().setMockFailure("put:/v1/w1920.webp");
  const bad = await hh.stage(AT, "desktop", DESK);
  storage().setMockFailure(null);
  assert.equal(bad.status, 502, JSON.stringify(bad.body));
  const left = (await heroDoc()).pending;
  assert.equal(left.length, 1, "the failed job's record stays for the sweep");
  const r2 = await sweeper().sweep({ now: later(26), force: true });
  assert.equal(r2.pendingPulled, 1, JSON.stringify(r2));
  assert.deepEqual(underMaster(left[0].masterKey), []);
});

test("expired drafts: removed from the document (system audit) and retired in the same update; their objects go a day later", async () => {
  await hh.stage(AT, "desktop", DESK);
  const key = storage().keyFromUrl((await heroDoc()).draft.desktop.url);
  const r = await sweeper().sweep({ now: later(24 * 8), force: true });
  assert.equal(r.expiredDrafts, 1);
  const doc = await heroDoc();
  assert.equal(doc.draft.desktop, null);
  assert.ok(doc.retired.some((x) => x.masterKeys[0] === key), "retired at expiry");
  const row = await AdminAuditLog().findOne({ action: "site.hero.draft_expire" }).lean();
  assert.equal(row.actorKind, "system");
  assert.equal(row.targetKey, "home_hero");
  assert.equal(row.actorId, undefined);
  assert.ok(underMaster(key).length > 0, "kept for 24 h after expiry");
  await sweeper().sweep({ now: later(24 * 9 + 1), force: true });
  assert.deepEqual(underMaster(key), []);
});

test("failures: a failed delete keeps the records for the next run; a failed listing deletes nothing", async () => {
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

test("a live or draft URL that does not parse to a key stops the run: nothing is deleted", async () => {
  await publishPair(10);
  await publishPair(200);
  await SiteSetting().collection.updateOne({ _id: "home_hero" }, { $set: { "desktop.url": "https://blr1.digitaloceanspaces.com/test-bucket/site/hero/desktop/x.jpg" } });
  const before = objects().length;
  const r = await sweeper().sweep({ now: later(25), force: true });
  assert.equal(r.error, "unparseable-reference");
  assert.equal(objects().length, before);
  assert.equal((await heroDoc()).retired.length, 2);
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

test("environments: only production uses site/hero/; anything else has its own namespace, and its sweep never touches another's objects", async () => {
  const hero = require("../../services/siteHero");
  delete process.env.SITE_HERO_PRODUCTION;
  assert.equal(hero.keyPrefix(), "_qa/site/hero/dev/", "a developer machine: its own namespace");
  process.env.VERCEL = "1";
  assert.equal(hero.keyPrefix(), "_qa/site/hero/dev/", "a Vercel preview/dev deployment is not production");
  process.env.VERCEL_ENV = "preview";
  assert.equal(hero.keyPrefix(), "_qa/site/hero/dev/");
  process.env.VERCEL_ENV = "production";
  process.env.SITE_HERO_PREFIX = "_qa/site/hero/run-1/";
  assert.equal(hero.keyPrefix(), "site/hero/", "production ignores QA prefixes");
  delete process.env.VERCEL_ENV;
  delete process.env.VERCEL;
  assert.equal(hero.keyPrefix(), "_qa/site/hero/run-1/", "a QA run");
  process.env.SITE_HERO_PREFIX = "../../evil/";
  assert.equal(hero.keyPrefix(), "_qa/site/hero/dev/", "an invalid prefix never falls back to production's");
  process.env.SITE_HERO_PRODUCTION = "1";
  assert.equal(hero.keyPrefix(), "site/hero/", "explicit production (maintenance scripts)");

  // a QA environment whose database even names production's objects (a
  // restored production backup): its sweep neither lists nor deletes them
  delete process.env.SITE_HERO_PRODUCTION;
  process.env.SITE_HERO_PREFIX = "_qa/site/hero/run-1/";
  const prodKey = `${PROD}desktop/${uuid()}.jpg`;
  for (const k of [prodKey, `${prodKey}/v1/w640.avif`]) put(k, 24 * 30);
  const d = await hh.stage(AT, "desktop", DESK);
  assert.match(storage().keyFromUrl(d.body.state.draft.desktop.url), /^_qa\/site\/hero\/run-1\/desktop\//);
  assert.ok(storage().isProtectedKey("_qa/site/hero/run-1/desktop/x.jpg"), "QA objects are protected too");
  const st = await hh.adminState(AT);
  assert.deepEqual(st.environment, { production: false, prefix: "_qa/site/hero/run-1/" }, "the admin page is told");
  await SiteSetting().collection.updateOne({ _id: "home_hero" }, { $push: { retired: { masterKeys: [prodKey], retiredAt: new Date() }, pending: { masterKey: prodKey, at: new Date() } } });
  const r = await sweeper().sweep({ now: later(25), force: true });
  assert.equal(underMaster(prodKey).length, 2, `production's objects untouched: ${JSON.stringify(r)}`);
  const doc = await heroDoc();
  assert.equal(doc.retired.length + doc.pending.length, 0, "the foreign records are let go of, not acted on");
});

test("the draft's URL is built from its key, whatever format the storage reply has", async () => {
  storage().__mock.locationStyle = "path"; // as a multipart upload's reply may be
  const d = await hh.stage(AT, "desktop", DESK);
  assert.equal(d.status, 201, JSON.stringify(d.body));
  const url = d.body.state.draft.desktop.url;
  const key = storage().keyFromUrl(url);
  assert.ok(key && key.startsWith(`${PROD}desktop/`), url);
  assert.equal(url, storage().publicUrl(key));
  assert.ok(d.body.state.draft.desktop.renditions.length > 0, "renditions derived from it");
});

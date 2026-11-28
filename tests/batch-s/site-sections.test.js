// Website sections switches (admin Settings: Experiences / Services): the
// public read the customer site uses when it generates pages, the admin-only
// read and update, the audit row and the website refresh.
// Node's test runner + in-memory replica set.
const test = require("node:test");
const assert = require("node:assert/strict");
const h = require("./setup");

const SiteSetting = () => require("../../models/SiteSetting");
const AdminAuditLog = () => require("../../models/AdminAuditLog");
const changed = () => require("../../services/listingChanged");

const DOC = "site_sections";
const DEFAULTS = { experiences: true, services: false };
const doc = () => SiteSetting().collection.findOne({ _id: DOC });
const audits = () => AdminAuditLog().find({ action: "site.sections.update" }).lean();
const publicRead = async () => (await h.api("GET", "/site/sections")).body;

let ADMIN, AT, GT, HT, BT, RAT, GHOST;
let notifyMock;

async function reset() {
  await SiteSetting().collection.deleteMany({ _id: DOC });
  await AdminAuditLog().deleteMany({ action: "site.sections.update" });
  notifyMock = { calls: [] };
  changed().__setMock(notifyMock);
}
const patch = (body, token = AT) => h.api("PATCH", "/site/admin/sections", { token, body });
async function rawPatch(body, type = "application/json") {
  const res = await fetch(`${h.baseUrl()}/site/admin/sections`, {
    method: "PATCH",
    headers: { "content-type": type, authorization: `Bearer ${AT}` },
    body,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

test.before(async () => {
  await h.start();
  ADMIN = await h.makeAdmin();
  AT = h.adminToken(ADMIN);
  GT = h.userToken(await h.makeUser());
  HT = h.userToken(await h.makeUser({ role: "host" }));
  BT = h.adminToken(await h.makeAdmin({ status: { active: false, banned: true } }));
  RAT = h.userToken(await h.makeUser({ role: "admin" }));
  GHOST = require("jsonwebtoken").sign({ userId: "64b000000000000000000003", firstName: "Ghost" }, process.env.JWT_SECRET, { expiresIn: "1h" });
});
test.after(async () => h.stop());
test.beforeEach(reset);

test("public read: defaults before any save, edge-cached under site-sections, ?fresh needs the secret", async () => {
  const r = await h.api("GET", "/site/sections");
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, DEFAULTS);
  const res = await fetch(`${h.baseUrl()}/site/sections`);
  assert.match(res.headers.get("cdn-cache-control") || "", /s-maxage=300/);
  assert.equal(res.headers.get("vercel-cache-tag"), "site-sections");
  const noSecret = await h.api("GET", "/site/sections?fresh=1");
  assert.equal(noSecret.status, 400);
  assert.equal(noSecret.body.code, "FRESH_NOT_ALLOWED");
  const fresh = await fetch(`${h.baseUrl()}/site/sections?fresh=1`, { headers: { "x-catalogue-fresh": process.env.CATALOGUE_FRESH_SECRET } });
  assert.equal(fresh.status, 200);
  assert.equal(fresh.headers.get("cache-control"), "no-store");
  assert.deepEqual(await fresh.json(), DEFAULTS);
  assert.equal(await doc(), null, "a read never creates the document");
});

test("public read: a stored value that is not true/false reads as the default", async () => {
  await SiteSetting().collection.insertOne({ _id: DOC, experiences: "no", services: 1, version: 3 });
  assert.deepEqual(await publicRead(), DEFAULTS);
  await SiteSetting().collection.updateOne({ _id: DOC }, { $set: { experiences: false, services: true } });
  assert.deepEqual(await publicRead(), { experiences: false, services: true });
});

test("authorization: admin read and update refuse anonymous (401), guests and hosts (403), banned or deleted admins (401)", async () => {
  for (const [method, body] of [["GET", undefined], ["PATCH", { services: true }]]) {
    for (const [label, token, status] of [["anonymous", undefined, 401], ["guest", GT, 403], ["host", HT, 403], ["banned admin", BT, 401], ["deleted admin", GHOST, 401]]) {
      const r = await h.api(method, "/site/admin/sections", { token, body });
      assert.equal(r.status, status, `${method} as ${label}: ${JSON.stringify(r.body)}`);
    }
  }
  assert.equal(await doc(), null, "nothing written");
  assert.equal(notifyMock.calls.length, 0, "nothing refreshed");
  const ok = await fetch(`${h.baseUrl()}/site/admin/sections`, { headers: { authorization: `Bearer ${AT}` } });
  assert.equal(ok.status, 200);
  assert.match(ok.headers.get("cache-control") || "", /no-store/);
  assert.deepEqual(await ok.json(), { success: true, sections: DEFAULTS, updatedAt: null });
  assert.equal((await h.api("GET", "/site/admin/sections", { token: RAT })).status, 200, "a user whose role is admin is an admin");
});

test("update accepts only true/false for experiences and services: anything else is refused and changes nothing", async () => {
  const bodies = [[], {}, [{ services: true }], { services: "true" }, { services: 1 }, { services: null }, { experiences: "false" }, { foo: true }, { services: true, foo: true }, { services: { $ne: false } }];
  for (const body of bodies) {
    const r = await patch(body);
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.equal(r.body.code, "INVALID_FIELDS", JSON.stringify(body));
  }
  const raws = [
    ['{"__proto__":{"services":true}}', "application/json"],
    ['{"constructor":{"prototype":{"services":true}}}', "application/json"],
    ["services=true", "application/x-www-form-urlencoded"],
    ["services[a]=1", "application/x-www-form-urlencoded"],
    ["", "application/json"],
  ];
  for (const [body, type] of raws) {
    const r = await rawPatch(body, type);
    assert.equal(r.status, 400, `${type} ${body}: ${JSON.stringify(r.body)}`);
  }
  // Not JSON objects at all: the body parser refuses them before the route
  // (the app's global handler answers 500 for any malformed JSON, pre-existing).
  for (const body of ['"x"', "null", "{bad json"]) {
    const r = await rawPatch(body);
    assert.ok(r.status >= 400, `${body} → ${r.status}`);
  }
  assert.equal({}.services, undefined, "no prototype pollution");
  assert.equal(await doc(), null, "nothing written");
  assert.equal((await audits()).length, 0, "nothing audited");
  assert.equal(notifyMock.calls.length, 0, "nothing refreshed");
  assert.deepEqual(await publicRead(), DEFAULTS);
});

test("turning Services on: saved, audited with before/after and the admin, the public read follows, the website is refreshed", async () => {
  const r = await patch({ services: true });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.success, true);
  assert.equal(r.body.changed, true);
  assert.deepEqual(r.body.sections, { experiences: true, services: true });
  assert.ok(!Number.isNaN(Date.parse(r.body.updatedAt)), "updatedAt is a date");
  assert.deepEqual(r.body.notified, { site: "mocked", cdn: "mocked" });
  assert.deepEqual(notifyMock.calls.map((c) => c.tags), [["site-sections"]]);

  assert.deepEqual(await publicRead(), { experiences: true, services: true });
  const d = await doc();
  assert.equal(d.experiences, true);
  assert.equal(d.services, true);
  assert.equal(d.version, 1);
  assert.equal(String(d.updatedBy), String(ADMIN._id));

  const rows = await audits();
  assert.equal(rows.length, 1);
  assert.equal(String(rows[0].actorId), String(ADMIN._id));
  assert.equal(rows[0].actorKind, "admin");
  assert.equal(rows[0].targetType, "SiteSetting");
  assert.equal(rows[0].targetKey, DOC);
  assert.deepEqual(rows[0].details, { before: DEFAULTS, after: { experiences: true, services: true } });

  const g = await h.api("GET", "/site/admin/sections", { token: AT });
  assert.deepEqual(g.body.sections, { experiences: true, services: true });
  assert.equal(g.body.updatedAt, r.body.updatedAt);
});

test("both switches in one save; switching back restores the defaults; each change is one audit row", async () => {
  const both = await patch({ experiences: false, services: true });
  assert.equal(both.status, 200);
  assert.deepEqual(both.body.sections, { experiences: false, services: true });
  const back = await patch({ experiences: true, services: false });
  assert.deepEqual(back.body.sections, DEFAULTS);
  assert.deepEqual(await publicRead(), DEFAULTS);
  const rows = await audits();
  assert.equal(rows.length, 2);
  assert.equal((await doc()).version, 2);
});

test("saving the value it already has changes nothing but refreshes the website again (the retry path), with a refresh-only audit row", async () => {
  // never saved: the default is already off
  const noop = await patch({ services: false });
  assert.equal(noop.status, 200);
  assert.equal(noop.body.changed, false);
  assert.deepEqual(noop.body.sections, DEFAULTS);
  assert.equal(noop.body.updatedAt, null);
  let rows = await audits();
  assert.equal(rows.length, 1, "the refresh is traceable");
  assert.deepEqual(rows[0].details, { before: DEFAULTS, after: DEFAULTS, refreshOnly: true });
  assert.equal(String(rows[0].actorId), String(ADMIN._id));
  assert.equal(notifyMock.calls.length, 1, "refreshed anyway");

  await patch({ services: true });
  const again = await patch({ services: true });
  assert.equal(again.status, 200);
  assert.equal(again.body.changed, false);
  assert.deepEqual(again.body.sections, { experiences: true, services: true });
  assert.equal((await doc()).version, 1, "no version bump");
  rows = await audits();
  assert.equal(rows.length, 3);
  assert.equal(rows.filter((r) => r.details.refreshOnly).length, 2, "one change, two refresh-only rows");
  assert.equal(notifyMock.calls.length, 3);
});

test("two admins saving different switches at the same moment: both land, each audited once, in order", async () => {
  const AT2 = h.adminToken(await h.makeAdmin());
  for (let round = 0; round < 3; round += 1) {
    await reset();
    const [a, b] = await Promise.all([patch({ experiences: false }), patch({ services: true }, AT2)]);
    assert.equal(a.status, 200, JSON.stringify(a.body));
    assert.equal(b.status, 200, JSON.stringify(b.body));
    assert.deepEqual(await publicRead(), { experiences: false, services: true });
    const rows = await audits();
    assert.equal(rows.length, 2);
    const first = rows.find((r) => JSON.stringify(r.details.before) === JSON.stringify(DEFAULTS));
    const second = rows.find((r) => r !== first);
    assert.ok(first && second, "one change saw the defaults, the other saw the first change");
    assert.deepEqual(second.details.before, first.details.after);
    assert.deepEqual(second.details.after, { experiences: false, services: true });
    assert.equal((await doc()).version, 2);
  }
});

test("if the audit row can't be written nothing is saved (503) and a retry works", async (t) => {
  const Model = AdminAuditLog();
  t.mock.method(Model, "create", async () => {
    throw new Error("audit store down");
  });
  const r = await patch({ services: true });
  t.mock.restoreAll();
  assert.equal(r.status, 503);
  assert.equal(r.body.code, "SECTIONS_SAVE_FAILED");
  assert.deepEqual(await publicRead(), DEFAULTS, "nothing saved");
  assert.equal(notifyMock.calls.length, 0, "no refresh for a failed save");
  const ok = await patch({ services: true });
  assert.equal(ok.status, 200);
  assert.deepEqual(await publicRead(), { experiences: true, services: true });
});

test("a website refresh that fails never undoes the save", async () => {
  changed().__setMock({
    calls: {
      push() {
        throw new Error("site refresh down");
      },
    },
  });
  const r = await patch({ services: true });
  assert.equal(r.status, 200);
  assert.equal(r.body.changed, true);
  assert.deepEqual(r.body.notified, { site: "error", cdn: "error" });
  assert.deepEqual(await publicRead(), { experiences: true, services: true });
});

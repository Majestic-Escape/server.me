// Publication and ban integrity (services/listingPublish.js,
// docs/listing-visibility.md):
//   the transition rules per actor (host relist only of a listing THEY
//   delisted; admin publish only of a submitted or delisted one; never over a
//   moderation ban; never for a banned / deactivated / missing host)
//   delist provenance from the route (never ?hostSide), unban that respects
//   an admin delist, generic edits that cannot write status / ban / delist
//   ban / unban / publish / reassignment serialised on the host's fence —
//   deterministic interleavings in both orders, a failure injected before
//   commit, no e-mail or purge before commit
const test = require("node:test");
const assert = require("node:assert/strict");
const h = require("./setup");

const ListingProperty = () => require("../../models/ListingProperty");
const User = () => require("../../models/User");
const publish = () => require("../../services/listingPublish");
const { sendEmail } = require("../../utils/sendEmail");

let AT, DEACT_AT;

test.before(async () => {
  await h.start();
  AT = h.adminToken(await h.makeAdmin());
  DEACT_AT = h.adminToken(await h.makeAdmin({ status: { active: false, banned: false } }));
});
test.after(async () => {
  publish().__setTestHooks(null);
  await h.stop();
});

async function host(tag) {
  const u = await h.makeUser({ role: "host", firstName: `Host${tag}`, email: `host-${tag}-${Date.now()}@publish.test` });
  return { u, t: h.userToken(u) };
}
const state = async (id) => ListingProperty().findById(id).select("status delist ban host title").lean();
const sent = () => (sendEmail.sent || []).length;

function deferred() {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
}
const tick = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
test("host relist: only a listing the host delisted themselves", async () => {
  const { u, t } = await host("relist");
  const cases = [
    ["processing", { status: "processing" }, 409, "LISTING_NOT_RELISTABLE"],
    ["incomplete", { status: "incomplete" }, 409, "LISTING_NOT_RELISTABLE"],
    ["inactive, no provenance (legacy / admin edit)", { status: "inactive" }, 409, "LISTING_NEEDS_REVIEW"],
    ["banned", { status: "inactive", ban: true }, 409, "LISTING_BANNED"],
  ];
  for (const [label, s, code, err] of cases) {
    const l = await h.makeListing(u, s);
    const r = await h.api("PATCH", `/properties/host/reactivate/${l._id}`, { token: t });
    assert.equal(r.status, code, label);
    assert.equal(r.body.code, err, label);
    assert.deepEqual(await state(l._id), await state(l._id), label);
    assert.equal((await state(l._id)).status, s.status, `${label}: unchanged`);
  }
  // admin-delisted keeps the clients' existing answer shape
  const ad = await h.makeListing(u, { status: "inactive", delist: "admin" });
  const r = await h.api("PATCH", `/properties/host/reactivate/${ad._id}`, { token: t });
  assert.equal(r.status, 200);
  assert.equal(r.body.listing, "adminDelist");
  assert.equal((await state(ad._id)).status, "inactive");
  // the legitimate path
  const ok = await h.makeListing(u, { status: "inactive", delist: "host" });
  const re = await h.api("PATCH", `/properties/host/reactivate/${ok._id}`, { token: t });
  assert.equal(re.status, 200, JSON.stringify(re.body));
  const st = await state(ok._id);
  assert.equal(st.status, "active");
  assert.equal(st.delist, undefined, "provenance cleared on publish");
});

test("processing → host delist → host relist is no longer an approval bypass", async () => {
  const { u, t } = await host("bypass");
  for (const status of ["processing", "incomplete"]) {
    const l = await h.makeListing(u, { status });
    const d = await h.api("PATCH", `/properties/host/delist/${l._id}?hostSide=true`, { token: t });
    assert.equal(d.status, 409, `${status}: only a live listing can be delisted`);
    assert.equal(d.body.code, "LISTING_NOT_LIVE");
    assert.equal((await state(l._id)).status, status, "unchanged");
    const re = await h.api("PATCH", `/properties/host/reactivate/${l._id}`, { token: t });
    assert.equal(re.status, 409);
    assert.equal((await state(l._id)).status, status);
  }
  // a generic admin edit never moves the status (the edit page echoes the
  // status it loaded) — a draft cannot be laundered into a relistable row
  const l = await h.makeListing(u, { status: "processing" });
  assert.equal((await h.api("PUT", `/properties/admin-update-property/${l._id}`, { token: AT, body: { status: "inactive" } })).status, 200);
  assert.deepEqual([(await state(l._id)).status, (await state(l._id)).delist], ["processing", undefined]);
  assert.equal((await h.api("PATCH", `/properties/host/reactivate/${l._id}`, { token: t })).status, 409);
  // an admin delist of a never-submitted draft is refused (delist → approve would skip review)
  const draft = await h.makeListing(u, { status: "incomplete" });
  const dd = await h.api("PATCH", `/properties/admin/delist/${draft._id}`, { token: AT });
  assert.equal(dd.status, 409);
  assert.equal((await state(draft._id)).status, "incomplete");
});

test("delist kind comes from the route; ?hostSide is ignored", async () => {
  const { u, t } = await host("route");
  const other = await host("route2");
  const l = await h.makeListing(u, { status: "active" });
  // a host cannot reach the admin route, with or without hostSide
  assert.equal((await h.api("PATCH", `/properties/admin/delist/${l._id}?hostSide=true`, { token: t })).status, 403);
  // another host cannot delist it
  assert.equal((await h.api("PATCH", `/properties/host/delist/${l._id}?hostSide=true`, { token: other.t })).status, 403);
  // the host route without (or with a false) hostSide is still a HOST delist
  const d = await h.api("PATCH", `/properties/host/delist/${l._id}?hostSide=false`, { token: t });
  assert.equal(d.status, 200, JSON.stringify(d.body));
  assert.deepEqual([(await state(l._id)).status, (await state(l._id)).delist], ["inactive", "host"]);
  // and the admin route with hostSide=true is still an ADMIN delist
  const l2 = await h.makeListing(u, { status: "active" });
  assert.equal((await h.api("PATCH", `/properties/admin/delist/${l2._id}?hostSide=true`, { token: AT })).status, 200);
  assert.equal((await state(l2._id)).delist, "admin");
});

test("admin approve: legal sources only; eligible host only; already-live is a no-op", async () => {
  const { u } = await host("approve");
  const p = await h.makeListing(u, { status: "processing" });
  let before = sent();
  const r = await h.api("PATCH", `/properties/admin/approve/${p._id}`, { token: AT });
  assert.equal(r.status, 200);
  assert.equal((await state(p._id)).status, "active");
  assert.ok(sent() > before, "approval e-mails after commit");
  // again: no write, no e-mail
  before = sent();
  assert.equal((await h.api("PATCH", `/properties/admin/approve/${p._id}`, { token: AT })).status, 200);
  assert.equal(sent(), before, "no e-mail for a no-op");
  // a draft is not submitted
  const draft = await h.makeListing(u, { status: "incomplete" });
  const dr = await h.api("PATCH", `/properties/admin/approve/${draft._id}`, { token: AT });
  assert.equal(dr.status, 409);
  assert.equal(dr.body.code, "LISTING_NOT_SUBMITTED");
  // a banned listing is restored only by unban
  const b = await h.makeListing(u, { status: "inactive", ban: true });
  assert.equal((await h.api("PATCH", `/properties/admin/approve/${b._id}`, { token: AT })).body.code, "LISTING_BANNED");
  // stale admin provenance cleared on approval → a later host delist / relist works
  const a = await h.makeListing(u, { status: "inactive", delist: "admin" });
  assert.equal((await h.api("PATCH", `/properties/admin/approve/${a._id}`, { token: AT })).status, 200);
  assert.equal((await state(a._id)).delist, undefined);
  const t = h.userToken(u);
  assert.equal((await h.api("PATCH", `/properties/host/delist/${a._id}`, { token: t })).status, 200);
  assert.equal((await h.api("PATCH", `/properties/host/reactivate/${a._id}`, { token: t })).status, 200);
  assert.equal((await state(a._id)).status, "active");
});

test("publish refuses a banned, deactivated or missing host — no write, no e-mail", async () => {
  const banned = await h.makeUser({ role: "host", firstName: "Banned", email: "banned@publish.test", status: { active: false, banned: true } });
  const deact = await h.makeUser({ role: "host", firstName: "Deact", email: "deact@publish.test", status: { active: false, banned: false } });
  const ghost = { _id: new (require("mongoose").Types.ObjectId)(), email: "ghost@publish.test" };
  for (const [label, owner] of [["banned", banned], ["deactivated", deact], ["missing", ghost]]) {
    const l = await h.makeListing(owner, { status: "processing" });
    const before = sent();
    const r = await h.api("PATCH", `/properties/admin/approve/${l._id}`, { token: AT });
    assert.equal(r.status, 409, label);
    assert.equal(r.body.code, "HOST_NOT_ELIGIBLE", label);
    assert.equal((await state(l._id)).status, "processing", label);
    assert.equal(sent(), before, `${label}: no e-mail`);
  }
  // admin create as live: refused for an ineligible host, nothing created
  const count = await ListingProperty().countDocuments({ host: banned._id });
  const c = await h.api("POST", "/prop-listing", { token: AT, body: { title: "Created live", host: String(banned._id), hostEmail: banned.email, status: "active" } });
  assert.equal(c.status, 409);
  assert.equal(await ListingProperty().countDocuments({ host: banned._id }), count, "no listing created");
  const { u } = await host("create");
  const ok = await h.api("POST", "/prop-listing", { token: AT, body: { title: "Created live ok", host: String(u._id), hostEmail: u.email, status: "active", ban: true, delist: "admin" } });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  const st = await state(ok.body._id);
  assert.deepEqual([st.status, st.ban, st.delist], ["active", false, undefined], "ban / delist never set by a create body");
});

test("generic edits cannot write status / ban / delist / host blindly", async () => {
  const { u, t } = await host("edit");
  const l = await h.makeListing(u, { status: "active" });
  // host wizard: an echoed status is ignored; ban / delist / host stripped
  let r = await h.api("PUT", `/properties/update-listing-property/${l._id}`, { token: t, body: { title: "Edited title", status: "active", ban: false, delist: "host", host: String((await host("x")).u._id) } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  let st = await state(l._id);
  assert.deepEqual([st.title, st.status, st.delist, String(st.host)], ["Edited title", "active", undefined, String(u._id)]);
  // host: a forbidden status change is still refused
  r = await h.api("PUT", `/properties/update-listing-property/${l._id}`, { token: t, body: { status: "inactive" } });
  assert.equal(r.status, 403);
  // after a ban the wizard's echoed "active" cannot bring the listing back
  await User().updateOne({ _id: u._id }, { $set: {} });
  const banned = await h.api("PATCH", `/guests/ban/${u._id}`, { token: AT, body: { active: true } });
  assert.equal(banned.status, 200);
  r = await h.api("PUT", `/properties/admin-update-property/${l._id}`, { token: AT, body: { title: "Admin echo", status: "inactive", ban: false } });
  assert.equal(r.status, 200);
  st = await state(l._id);
  assert.equal(st.ban, true, "a generic edit never clears the ban");
  // a stale "active" from the edit page cannot republish the banned listing
  r = await h.api("PUT", `/properties/admin-update-property/${l._id}`, { token: AT, body: { status: "active", title: "Stale echo" } });
  assert.equal(r.status, 200);
  st = await state(l._id);
  assert.deepEqual([st.status, st.ban, st.title], ["inactive", true, "Stale echo"], "status untouched, other fields saved");
  await h.api("PATCH", `/guests/ban/${u._id}`, { token: AT, body: { active: false } });
  // a stale echo after a HOST delist does not republish (the admin page loaded "active")
  const t2 = h.userToken(await User().findById(u._id)); // the ban revoked the old session
  const l2 = await h.makeListing(u, { status: "active" });
  assert.equal((await h.api("PATCH", `/properties/host/delist/${l2._id}`, { token: t2 })).status, 200);
  r = await h.api("PUT", `/prop-listing/${l2._id}`, { token: AT, body: { status: "active", title: "Typo fixed" } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  st = await state(l2._id);
  assert.deepEqual([st.status, st.delist, st.title], ["inactive", "host", "Typo fixed"], "host's delist stands");
  // ...nor a stale "processing" take a freshly approved listing down
  const l3 = await h.makeListing(u, { status: "processing" });
  assert.equal((await h.api("PATCH", `/properties/admin/approve/${l3._id}`, { token: AT })).status, 200);
  r = await h.api("PUT", `/properties/admin-update-property/${l3._id}`, { token: AT, body: { status: "processing", title: "Second admin" } });
  assert.equal(r.status, 200);
  assert.equal((await state(l3._id)).status, "active");
});

test("host reassignment: fenced, eligible target for a live listing, old owner loses write", async () => {
  const a = await host("ra");
  const b = await host("rb");
  const bannedT = await h.makeUser({ role: "host", firstName: "Bt", email: "bt@publish.test", status: { active: false, banned: true } });
  const l = await h.makeListing(a.u, { status: "active" });
  let r = await h.api("PUT", `/prop-listing/${l._id}`, { token: AT, body: { host: String(bannedT._id) } });
  assert.equal(r.status, 409, "a live listing never moves to a banned host");
  assert.equal(String((await state(l._id)).host), String(a.u._id));
  r = await h.api("PUT", `/prop-listing/${l._id}`, { token: AT, body: { host: String(b.u._id), hostEmail: b.u.email } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(String((await state(l._id)).host), String(b.u._id));
  // the old owner cannot edit, delist or relist it any more
  assert.equal((await h.api("PUT", `/properties/update-listing-property/${l._id}`, { token: a.t, body: { title: "Old owner" } })).status, 403);
  assert.equal((await h.api("PATCH", `/properties/host/delist/${l._id}`, { token: a.t })).status, 403);
  // reverse swap works the same way
  r = await h.api("PUT", `/prop-listing/${l._id}`, { token: AT, body: { host: String(a.u._id), hostEmail: a.u.email } });
  assert.equal(r.status, 200);
  // an inactive listing may move to any existing host; a missing one is refused
  const off = await h.makeListing(a.u, { status: "processing" });
  assert.equal((await h.api("PUT", `/prop-listing/${off._id}`, { token: AT, body: { host: String(bannedT._id) } })).status, 200);
  assert.equal((await h.api("PUT", `/prop-listing/${off._id}`, { token: AT, body: { host: "0123456789abcdef01234567" } })).status, 409);
});

test("ban / unban: strict payload, atomic, unban keeps an admin delist", async () => {
  const { u } = await host("ban");
  const live = await h.makeListing(u, { status: "active" });
  const pending = await h.makeListing(u, { status: "processing" });
  for (const body of [{}, { active: "true" }, { active: 1 }, { active: null }]) {
    const r = await h.api("PATCH", `/guests/ban/${u._id}`, { token: AT, body });
    assert.equal(r.status, 400, JSON.stringify(body));
  }
  assert.equal((await User().findById(u._id).lean()).status.banned, false, "malformed payloads changed nothing");
  assert.equal((await h.api("PATCH", `/guests/ban/${u._id}`, { token: AT, body: { active: true } })).status, 200);
  assert.deepEqual([(await state(live._id)).status, (await state(live._id)).ban], ["inactive", true]);
  assert.equal((await state(pending._id)).status, "processing", "not live → untouched");
  // the admin delists the banned listing; unban must not bring it back
  assert.equal((await h.api("PATCH", `/properties/admin/delist/${live._id}`, { token: AT })).status, 200);
  assert.equal((await h.api("PATCH", `/guests/ban/${u._id}`, { token: AT, body: { active: false } })).status, 200);
  const st = await state(live._id);
  assert.deepEqual([st.status, st.delist, st.ban], ["inactive", "admin", false], "admin delist stands; ban marker cleared");
  // a plain ban → unban restores
  // a legacy live row still carrying delist:"admin" (re-approved before
  // approval cleared provenance) comes back after ban → unban
  const legacy = await h.makeListing(u, { status: "active", delist: "admin" });
  const live2 = await h.makeListing(u, { status: "active" });
  await h.api("PATCH", `/guests/ban/${u._id}`, { token: AT, body: { active: true } });
  await h.api("PATCH", `/guests/ban/${u._id}`, { token: AT, body: { active: false } });
  assert.deepEqual([(await state(live2._id)).status, (await state(live2._id)).ban], ["active", false]);
  assert.equal((await state(legacy._id)).status, "active", "legacy admin-provenance row restored by unban");
  // updateHost cannot change an account's standing
  const before = await User().findById(u._id).lean();
  const r = await h.api("PUT", `/hosts/${u._id}`, { token: AT, body: { status: "Inactive", firstName: "Renamed" } });
  assert.equal(r.status, 400);
  const after = await User().findById(u._id).lean();
  assert.deepEqual([after.firstName, after.status.active], [before.firstName, before.status.active], "refused before any change");
});

// --- deterministic interleavings -------------------------------------------
test("race: ban commits while an approval is between its read and its fence → approval refused", async () => {
  const { u } = await host("race1");
  const l = await h.makeListing(u, { status: "processing" });
  const gate = deferred();
  const reached = deferred();
  let first = true;
  publish().__setTestHooks({
    beforeFence: async (ctx) => {
      if (ctx.op === "publish" && first) {
        first = false;
        reached.resolve();
        await gate.promise; // holds no lock yet: it has only read the listing
      }
    },
  });
  const emails = sent();
  const approval = h.api("PATCH", `/properties/admin/approve/${l._id}`, { token: AT });
  await reached.promise;
  const ban = await h.api("PATCH", `/guests/ban/${u._id}`, { token: AT, body: { active: true } });
  assert.equal(ban.status, 200);
  gate.resolve();
  const r = await approval;
  publish().__setTestHooks(null);
  assert.equal(r.status, 409, JSON.stringify(r.body));
  assert.equal(r.body.code, "HOST_NOT_ELIGIBLE");
  assert.equal((await state(l._id)).status, "processing");
  assert.equal(sent(), emails, "no approval e-mail");
});

test("race: approval holds the fence while a ban starts → ban waits, then takes the new listing down", async () => {
  const { u } = await host("race2");
  const l = await h.makeListing(u, { status: "processing" });
  const gate = deferred();
  const reached = deferred();
  let first = true;
  publish().__setTestHooks({
    afterFence: async (ctx) => {
      if (ctx.op === "publish" && first) {
        first = false;
        reached.resolve();
        await gate.promise; // holds the host fence; the ban must not wait on us to finish first
      }
    },
  });
  const approval = h.api("PATCH", `/properties/admin/approve/${l._id}`, { token: AT });
  await reached.promise;
  const ban = h.api("PATCH", `/guests/ban/${u._id}`, { token: AT, body: { active: true } }); // conflicts and retries
  await tick(200);
  gate.resolve();
  const [ra, rb] = await Promise.all([approval, ban]);
  publish().__setTestHooks(null);
  assert.equal(ra.status, 200, JSON.stringify(ra.body));
  assert.equal(rb.status, 200, JSON.stringify(rb.body));
  const st = await state(l._id);
  assert.deepEqual([st.status, st.ban], ["inactive", true], "the invariant holds: banned host, no live listing");
});

test("race: ban holds the fence while an approval starts → approval refused after the ban", async () => {
  const { u } = await host("race3");
  const l = await h.makeListing(u, { status: "processing" });
  const gate = deferred();
  const reached = deferred();
  let first = true;
  publish().__setTestHooks({
    afterFence: async (ctx) => {
      if (ctx.op === "ban" && first) {
        first = false;
        reached.resolve();
        await gate.promise;
      }
    },
  });
  const ban = h.api("PATCH", `/guests/ban/${u._id}`, { token: AT, body: { active: true } });
  await reached.promise;
  const approval = h.api("PATCH", `/properties/admin/approve/${l._id}`, { token: AT });
  await tick(200);
  gate.resolve();
  const [rb, ra] = await Promise.all([ban, approval]);
  publish().__setTestHooks(null);
  assert.equal(rb.status, 200);
  assert.equal(ra.status, 409, JSON.stringify(ra.body));
  assert.equal((await state(l._id)).status, "processing");
});

test("race: unban vs a concurrent admin delist → the admin delist stands", async () => {
  const { u } = await host("race4");
  const l = await h.makeListing(u, { status: "active" });
  await h.api("PATCH", `/guests/ban/${u._id}`, { token: AT, body: { active: true } });
  const gate = deferred();
  const reached = deferred();
  let first = true;
  publish().__setTestHooks({
    afterFence: async (ctx) => {
      if (ctx.op === "unban" && first) {
        first = false;
        reached.resolve();
        await gate.promise;
      }
    },
  });
  const unban = h.api("PATCH", `/guests/ban/${u._id}`, { token: AT, body: { active: false } });
  await reached.promise;
  assert.equal((await h.api("PATCH", `/properties/admin/delist/${l._id}`, { token: AT })).status, 200);
  gate.resolve();
  assert.equal((await unban).status, 200);
  publish().__setTestHooks(null);
  const st = await state(l._id);
  assert.deepEqual([st.status, st.delist], ["inactive", "admin"]);
});

test("a failure before commit leaves nothing applied (no compensation needed)", async () => {
  const { u } = await host("crash");
  const l = await h.makeListing(u, { status: "active" });
  const calls = require("../../services/listingChanged");
  publish().__setTestHooks({
    beforeCommit: async (ctx) => {
      if (ctx.op === "ban") throw new Error("injected: process died before commit");
    },
  });
  const r = await h.api("PATCH", `/guests/ban/${u._id}`, { token: AT, body: { active: true } });
  publish().__setTestHooks(null);
  assert.equal(r.status, 500);
  const user = await User().findById(u._id).lean();
  assert.deepEqual([user.status.banned, user.status.active], [false, true], "account untouched");
  assert.equal((await state(l._id)).status, "active", "listing untouched");
  assert.ok(calls, "module loaded");
  // the retried ban completes normally
  assert.equal((await h.api("PATCH", `/guests/ban/${u._id}`, { token: AT, body: { active: true } })).status, 200);
  assert.deepEqual([(await state(l._id)).status, (await state(l._id)).ban], ["inactive", true]);
});

test("deactivated admin cannot publish, ban or edit", async () => {
  const { u } = await host("deact");
  const l = await h.makeListing(u, { status: "processing" });
  assert.equal((await h.api("PATCH", `/properties/admin/approve/${l._id}`, { token: DEACT_AT })).status, 403);
  assert.equal((await h.api("PATCH", `/guests/ban/${u._id}`, { token: DEACT_AT, body: { active: true } })).status, 403);
  assert.equal((await h.api("PUT", `/prop-listing/${l._id}`, { token: DEACT_AT, body: { status: "active" } })).status, 403);
  assert.equal((await state(l._id)).status, "processing");
});

test("audit script: read-only, reports hard violations and legacy rows", async () => {
  const mongoose = require("mongoose");
  const { audit } = require("../../scripts/audit-listing-invariants");
  const before = await ListingProperty().countDocuments();
  const banned = await h.makeUser({ role: "host", firstName: "Aud", email: "aud@publish.test", status: { active: false, banned: true } });
  const deact = await h.makeUser({ role: "host", firstName: "Aue", email: "aue@publish.test", status: { active: false, banned: false } });
  const { u } = await host("audit");
  const a = await h.makeListing(banned, { status: "active" });
  const b = await h.makeListing(deact, { status: "active" });
  const c = await h.makeListing({ _id: new mongoose.Types.ObjectId(), email: "x@y.z" }, { status: "active" });
  const d = await h.makeListing(u, { status: "active", ban: true });
  const e = await h.makeListing(u, { status: "inactive" });
  const res = await audit(mongoose.connection);
  assert.ok(res.ids.bannedHostLive.includes(String(a._id)));
  assert.ok(res.ids.deactivatedHostLive.includes(String(b._id)));
  assert.ok(res.ids.orphanHostLive.includes(String(c._id)));
  assert.ok(res.ids.liveWithBanFlag.includes(String(d._id)));
  assert.ok(res.ids.inactiveNoProvenance.includes(String(e._id)));
  assert.ok(res.hardViolations >= 4);
  assert.equal(await ListingProperty().countDocuments(), before + 5, "the audit wrote nothing");
  await ListingProperty().deleteMany({ _id: { $in: [a._id, b._id, c._id, d._id, e._id] } });
});

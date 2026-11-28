// Admin Listings table: search by host name (first, last, full), by either
// host e-mail (the account's and the listing's copy the table shows), and a
// Host column sort. Search input stays literal text (no regex injection) and
// the endpoint stays admin-only. Node's test runner + in-memory replica set.
const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const h = require("./setup");

const ListingProperty = () => require("../../models/ListingProperty");

let AT, HT, AISH, KARAM, ANA, ZED;
const titles = (body) => body.properties.map((p) => p.title).sort();
const list = (qs, token = AT) => h.api("GET", `/properties/admin/filtered-listings?${qs}`, { token });
const search = (term, extra = "status=all") => list(`${extra}&page=1&limit=100&search=${encodeURIComponent(term)}`);

test.before(async () => {
  await h.start();
  AT = h.adminToken(await h.makeAdmin());
  AISH = await h.makeUser({ role: "host", firstName: "Aishwarya", lastName: "Sinha", email: "sinha@hs.test" });
  KARAM = await h.makeUser({ role: "host", firstName: "Karamveer", lastName: "Rathor", email: "karam@hs.test" });
  ANA = await h.makeUser({ role: "host", firstName: "Ana (QA)", lastName: "Mehta", email: "ana@hs.test" });
  ZED = await h.makeUser({ role: "host", firstName: "Zed", lastName: undefined, email: "zed@hs.test" });
  HT = h.userToken(AISH);
  await h.makeListing(AISH, { title: "Sea View Villa" });
  await h.makeListing(AISH, { title: "Hill Cottage", status: "processing" });
  await h.makeListing(AISH, { title: "Draft Hut", status: "incomplete" });
  // Legacy row: the listing's e-mail copy predates an account e-mail change.
  await h.makeListing(KARAM, { title: "Bhairon Niwas", hostEmail: "old-karam@hs.test" });
  await h.makeListing(ANA, { title: "Pool House" });
  await h.makeListing(ZED, { title: "Desert Camp" });
  // The host account no longer exists ($lookup finds nothing).
  await ListingProperty().create({
    title: "Orphan Stay", host: new mongoose.Types.ObjectId(), hostEmail: "gone@hs.test", basePrice: 9000, guests: 2,
    status: "active", bookingType: { manual: false }, cancellationType: { flexible: true }, checkinTime: "15", checkoutTime: "11",
  });
});
test.after(async () => h.stop());

test("finds listings by host first name, last name and full name, any case, partial", async () => {
  for (const term of ["Aishwarya", "sinha", "SINHA", "aishw", "Aishwarya Sinha", "warya sin"]) {
    const r = await search(term);
    assert.equal(r.status, 200, term);
    assert.deepEqual(titles(r.body), ["Hill Cottage", "Sea View Villa"], `"${term}" → Aishwarya's listings (draft excluded under All)`);
    assert.equal(r.body.total, 2, term);
  }
  assert.deepEqual(titles((await search("Karamveer Rathor")).body), ["Bhairon Niwas"]);
  assert.deepEqual(titles((await search("Zed")).body), ["Desert Camp"], "host without a last name");
  assert.equal((await search("Sinha Aishwarya")).body.total, 0, "reversed name is not a match");
});

test("finds listings by the account e-mail and by the listing's own e-mail copy", async () => {
  assert.deepEqual(titles((await search("karam@hs.test")).body), ["Bhairon Niwas"], "account e-mail");
  assert.deepEqual(titles((await search("old-karam")).body), ["Bhairon Niwas"], "the e-mail the table's Email column shows");
  assert.deepEqual(titles((await search("gone@hs.test")).body), ["Orphan Stay"], "listing whose host account is gone");
});

test("title search and the status filter still work and combine with host search", async () => {
  assert.deepEqual(titles((await search("villa")).body), ["Sea View Villa"]);
  assert.deepEqual(titles((await search("Aishwarya", "status=processing")).body), ["Hill Cottage"]);
  assert.deepEqual(titles((await search("Aishwarya", "status=active")).body), ["Sea View Villa"]);
  assert.deepEqual(titles((await search("Aishwarya", "status=incomplete")).body), ["Draft Hut"]);
  assert.equal((await search("Karamveer", "status=processing")).body.total, 0);
  const stats = (await search("Aishwarya")).body;
  assert.equal(stats.totalList, 6, "stat cards stay unfiltered (all non-draft listings)");
});

test("search text is literal: regex characters never widen or break the query", async () => {
  assert.deepEqual(titles((await search("(QA)")).body), ["Pool House"], "parentheses match literally");
  assert.deepEqual(titles((await search("Ana (QA) Mehta")).body), ["Pool House"]);
  for (const term of [".*", "^", "$", "[", "\\", "a+(", "|"]) {
    const r = await search(term);
    assert.equal(r.status, 200, term);
    assert.equal(r.body.total, 0, `"${term}" is not a pattern`);
  }
  const blank = await search("   ");
  assert.equal(blank.body.total, 6, "whitespace-only search = no search (drafts excluded under All)");
  const long = await search("a".repeat(5000));
  assert.equal(long.status, 200, "over-long input is bounded, not an error");
  const repeated = await list("status=all&page=1&limit=100&search=Zed&search=Pool");
  assert.equal(repeated.status, 200, "a repeated ?search= is not a 500");
  const objSearch = await list("status=all&page=1&limit=100&search[$ne]=x");
  assert.equal(objSearch.status, 200);
  assert.equal(objSearch.body.total, 0, "an object search is literal text, not an operator");
});

test("status must be plain text: an operator object is ignored, not run", async () => {
  const r = await list("status[$in][]=processing&page=1&limit=100");
  assert.equal(r.status, 200);
  assert.notDeepEqual(titles(r.body), ["Hill Cottage"], "the $in operator did not filter");
  assert.equal(r.body.total, 7, "treated like no status (every row, drafts too)");
});

test("Host column sort: by host first name both ways, missing host last/first, stable", async () => {
  const asc = await list("status=all&page=1&limit=100&sort=hostName:asc");
  assert.equal(asc.status, 200);
  assert.equal(asc.body.sort, "hostName:asc");
  assert.deepEqual(asc.body.properties.map((p) => p.host?.firstName ?? null), [null, "Aishwarya", "Aishwarya", "Ana (QA)", "Karamveer", "Zed"]);
  const desc = await list("status=all&page=1&limit=100&sort=hostName:desc");
  assert.deepEqual(desc.body.properties.map((p) => p.host?.firstName ?? null), ["Zed", "Karamveer", "Ana (QA)", "Aishwarya", "Aishwarya", null]);
  const p1 = await list("status=all&page=1&limit=3&sort=hostName:asc");
  const p2 = await list("status=all&page=2&limit=3&sort=hostName:asc");
  const seen = new Set([...p1.body.properties, ...p2.body.properties].map((p) => String(p._id)));
  assert.equal(seen.size, 6, "pages never overlap under the host sort");
});

test("the host fields the Host column needs are present; secrets are not", async () => {
  const r = await search("Aishwarya");
  assert.equal(r.body.properties.length, 2);
  for (const p of r.body.properties) {
    assert.equal(p.host.firstName, "Aishwarya");
    assert.equal(p.host.lastName, "Sinha");
  }
  assert.deepEqual(JSON.stringify(r.body).match(/"(otp|otpRetries|lockUntil|tokenVersion|password|embedding)"/g) || [], []);
});

test("still admin-only: a host token is refused, no token is refused", async () => {
  assert.equal((await list("status=all&search=Sinha", HT)).status, 403);
  assert.equal((await list("status=all&search=Sinha", null)).status, 401);
});

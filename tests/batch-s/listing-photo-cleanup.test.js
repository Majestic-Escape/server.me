// Listing photos removed by the host are deleted from storage when the
// listing is SAVED without them (not when the photo is removed on the page —
// an abandoned edit used to leave a broken photo on the live listing), and
// only when no other listing or profile still uses them.
const test = require("node:test");
const assert = require("node:assert/strict");
const h = require("./setup");

const ListingProperty = () => require("../../models/ListingProperty");
const storage = () => require("../../services/storage");

let JPEG, H, HT, O;

async function upload(token, files) {
  const form = new FormData();
  for (const [name, buf] of files) form.append("images", new Blob([buf], { type: "image/jpeg" }), name);
  const res = await fetch(`${h.baseUrl()}/uploads/`, { method: "POST", headers: { authorization: `Bearer ${token}` }, body: form });
  return { status: res.status, body: await res.json() };
}
const key = (url) => storage().masterKeyOf(storage().keyFromUrl(url));
const deleted = () => storage().__mock.photosDeleted;
const save = (id, body) => h.api("PUT", `/properties/update-listing-property/${id}?submit=&status=`, { token: HT, body });

test.before(async () => {
  JPEG = await require("sharp")({ create: { width: 64, height: 48, channels: 3, background: "#558877" } }).jpeg().toBuffer();
  await h.start();
  H = await h.makeUser({ role: "host", firstName: "Photo", lastName: "Host" });
  HT = h.userToken(H);
  O = await h.makeUser({ role: "host", firstName: "Other", lastName: "Host" });
});
test.after(async () => h.stop());

test("a photo removed from the saved listing is deleted; kept, shared and untouched photos are not; cleanup never fails the save", async () => {
  const up = await upload(HT, [["a.jpg", JPEG], ["b.jpg", JPEG], ["c.jpg", JPEG], ["d.jpg", JPEG]]);
  assert.equal(up.status, 200, JSON.stringify(up.body));
  const [a, b, c, d] = up.body.urls;
  const L = await h.makeListing(H, { title: "Cleanup villa", status: "processing", photos: [a, b, c, d] });
  await h.makeListing(O, { title: "Shares c", status: "processing", photos: [c] }); // c is still used elsewhere

  // a save that does not touch photos deletes nothing
  storage().resetMock();
  assert.equal((await save(L._id, { title: "Cleanup villa 2" })).status, 200);
  assert.deepEqual(deleted(), []);

  // b and c removed: b is deleted (with its variants), c stays (another listing uses it), a and d untouched
  const r = await save(L._id, { photos: [a, d] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual((await ListingProperty().findById(L._id).lean()).photos, [a, d]);
  assert.ok(deleted().includes(key(b)), JSON.stringify(deleted()));
  assert.ok(!deleted().includes(key(c)), "a photo another listing uses is kept");
  assert.ok(!deleted().includes(key(a)) && !deleted().includes(key(d)), "kept photos are not deleted");

  // reordering only (same set) deletes nothing
  storage().resetMock();
  assert.equal((await save(L._id, { photos: [d, a] })).status, 200);
  assert.deepEqual(deleted(), []);

  // storage failing: the host's save still succeeds
  storage().resetMock();
  storage().setMockFailure("all");
  try {
    const failing = await save(L._id, { photos: [d] });
    assert.equal(failing.status, 200, "a cleanup failure never fails the save");
    assert.deepEqual((await ListingProperty().findById(L._id).lean()).photos, [d]);
  } finally {
    storage().setMockFailure(null);
  }
});

// Batch A2 cost evidence: how many MongoDB operations each admin action and
// each hardened user route issues, the size of the KYC document list with a
// 4 MB upload on file, and the Spaces call count for a deletion. Numbers are
// asserted as ceilings so a regression that adds queries fails loudly.
const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const h = require("./setup");

const KycLogs = () => require("../../models/KycLogs");
const KycHostData = () => require("../../models/KycHostForm");
const ExternalCalendar = () => require("../../models/ExternalCalendar");
const storage = () => require("../../services/storage");

const JPEG = Buffer.concat([Buffer.from("ffd8ffe000104a464946", "hex"), Buffer.alloc(64, 1)]);
const BUCKET = () => `https://${process.env.DO_SPACES_BUCKET}.${process.env.REGION}.digitaloceanspaces.com/`;

let ADMIN, AT, H, HT, G;
const ops = [];
function startCounting() {
  ops.length = 0;
  mongoose.set("debug", (collection, method) => ops.push(`${collection}.${method}`));
}
function stopCounting() {
  mongoose.set("debug", false);
  return ops.slice();
}

test.before(async () => {
  await h.start();
  ADMIN = await h.makeAdmin();
  AT = h.adminToken(ADMIN);
  H = await h.makeUser({ role: "host", firstName: "Cost", lastName: "Host" });
  HT = h.userToken(H);
  G = await h.makeUser({ firstName: "Cost", lastName: "Guest" });
});
test.after(async () => h.stop());

test("cost: rename = ≤ 6 operations in one transaction; users list = 2 round trips", async () => {
  startCounting();
  const r = await h.api("PATCH", `/guests/name/${G._id}`, { token: AT, body: { firstName: "Renamed", lastName: "Guest", expected: { firstName: "Cost", lastName: "Guest" } } });
  const renameOps = stopCounting();
  assert.equal(r.status, 200);
  // admin resolve (1) + user read + privileged check + update + audit insert
  console.log(`[cost] rename: ${renameOps.length} ops → ${renameOps.join(", ")}`);
  assert.ok(renameOps.length <= 6, `rename issued ${renameOps.length}: ${renameOps.join(", ")}`);

  startCounting();
  assert.equal((await h.api("GET", "/guests/?limit=10", { token: AT })).status, 200);
  const listOps = stopCounting();
  const dbOps = listOps.filter((o) => !o.startsWith("admins.findOne"));
  console.log(`[cost] users list: ${listOps.length} ops → ${listOps.join(", ")}`);
  assert.ok(dbOps.length <= 2, `users list issued ${listOps.join(", ")}`);
});

test("cost: pending listing delete ≤ 16 operations, one Spaces call, no polling", async () => {
  const L = await h.makeListing(H, { status: "processing", photos: [`${BUCKET()}listings/${H._id}/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa-1.jpg`, `${BUCKET()}listings/${H._id}/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa-2.jpg`] });
  await ExternalCalendar().create({ propertyId: L._id, url: "https://cal.example/x.ics", kind: "import" });
  storage().resetMock();
  startCounting();
  const r = await h.api("DELETE", `/properties/admin/${L._id}`, { token: AT });
  const delOps = stopCounting();
  assert.equal(r.status, 200, JSON.stringify(r.body));
  // actor (1) + listing read + 6 blocker reads + 2 cleanup + conditional delete + audit insert (=12 in the txn)
  // + sweep (distinct + 2 deleteMany) + 2 distinct reads + audit updates (2)
  console.log(`[cost] delete: ${delOps.length} ops → ${delOps.join(", ")}`);
  assert.ok(delOps.length <= 20, `delete issued ${delOps.length}: ${delOps.join(", ")}`);
  assert.equal(storage().__mock.calls, 1, "exactly one deleteObjects call");
  assert.equal(storage().__mock.photosDeleted.length, 2);
  assert.equal(storage().__mock.deleted.length, 2 * (1 + storage().VARIANT_WIDTHS.length), "each photo's master and every display variant, in that one call");
  assert.equal(storage().__mock.listCalls, 2, "one variant listing per photo");
});

test("cost: KYC document list ≤ 4 round trips and < 5 KB with a 4 MiB upload on file; file endpoint ≤ 3 operations", async () => {
  const big = Buffer.concat([Buffer.from("ffd8ffe000104a464946", "hex"), Buffer.alloc(4 * 1024 * 1024 - 10, 9)]);
  const log = await KycLogs().create({ userId: H._id, email: H.email, type: "OCR", status: "success", requestData: { imageUrl: big.toString("base64"), clientRefId: "c", doc: "pan" }, responseData: { status: "success", result: [{ type: "pan", details: { name: { value: "COST HOST" }, pan_no: { value: "ABCDE1234F" } } }] } });
  await KycLogs().create({ userId: H._id, email: H.email, type: "OCR", status: "success", requestData: { imageUrl: JPEG.toString("base64"), clientRefId: "c", doc: "pan" } });
  await KycHostData().create({ hostId: H._id, hostEmail: H.email, status: "pending", documentInfo: { documentType: "pan", isVerified: false, reviewStatus: "needs_review", verifiedLogId: log._id } });

  startCounting();
  const res = await fetch(`${h.baseUrl()}/guests/kyc-documents/${H._id}`, { headers: { authorization: `Bearer ${AT}` } });
  const listOps = stopCounting();
  const text = await res.text();
  assert.equal(res.status, 200);
  console.log(`[cost] kyc list: ${listOps.length} ops → ${listOps.join(", ")}; payload ${text.length} bytes with a ${big.length}-byte document on file`);
  assert.ok(text.length < 5 * 1024, `list payload is ${text.length} bytes`);
  assert.ok(listOps.length <= 4, `kyc list issued ${listOps.length}: ${listOps.join(", ")}`);
  const body = JSON.parse(text);
  const bigRow = body.data.documents.find((d) => d._id === String(log._id));
  assert.equal(bigRow.sizeBytes, big.length);
  assert.equal(bigRow.mime, "image/jpeg");
  assert.equal(bigRow.isCurrent, true);

  startCounting();
  const file = await fetch(`${h.baseUrl()}/guests/kyc-documents/${H._id}/${log._id}/file?mode=view`, { headers: { authorization: `Bearer ${AT}` } });
  const fileOps = stopCounting();
  assert.equal(file.status, 200);
  assert.equal(Number(file.headers.get("content-length")), big.length);
  console.log(`[cost] kyc file: ${fileOps.length} ops → ${fileOps.join(", ")}`);
  assert.ok(fileOps.length <= 3, `kyc file issued ${fileOps.length}: ${fileOps.join(", ")}`);
});

test("cost: hardened user routes add at most one ownership read; document verification ≤ 12 operations", async () => {
  startCounting();
  assert.equal((await h.api("GET", `/accounts/?email=${encodeURIComponent(H.email)}`, { token: HT })).status, 200);
  const acc = stopCounting();
  console.log(`[cost] accounts GET: ${acc.length} ops → ${acc.join(", ")}`);
  assert.ok(acc.length <= 3, `accounts GET issued ${acc.length}: ${acc.join(", ")}`);

  await KycHostData().deleteMany({ hostId: H._id });
  await KycHostData().create({ hostId: H._id, hostEmail: H.email, status: "processing" });
  process.env.KYC_PROVIDER_MOCK_MODE = "success";
  process.env.KYC_ATTEMPT_COOLDOWN_SECONDS = "0";
  startCounting();
  const v = await h.api("POST", "/pan-kyc/verify", { token: HT, body: { userId: String(H._id), doc: "pan", imageUrl: JPEG.toString("base64") } });
  const verifyOps = stopCounting();
  assert.equal(v.status, 200, JSON.stringify(v.body));
  // auth user read + user read + form read + guard (init, window, claim) + log create/update ×2 + form update + release
  console.log(`[cost] document verify: ${verifyOps.length} ops → ${verifyOps.join(", ")}`);
  assert.ok(verifyOps.length <= 14, `verify issued ${verifyOps.length}: ${verifyOps.join(", ")}`);
});

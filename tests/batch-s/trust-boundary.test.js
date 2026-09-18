// Batch A2 Stage 0 — trust-boundary hardening of the user-scoped routes that
// were open (accounts, KYC, uploads, bank details, hosts analytics, guests,
// prop-listing writes), server-owned KYC verification and the provider
// cost guard. Runs against the real app on the replica-set harness with the
// Spaces and provider fakes.
const test = require("node:test");
const assert = require("node:assert/strict");
const h = require("./setup");

const KycHostData = () => require("../../models/KycHostForm");
const KycLogs = () => require("../../models/KycLogs");
const User = () => require("../../models/User");
const ListingProperty = () => require("../../models/ListingProperty");
const AdminAuditLog = () => require("../../models/AdminAuditLog");
const storage = () => require("../../services/storage");
const provider = () => require("../../services/kycProvider");

// Minimal files that sniff as jpeg / png / pdf.
const JPEG = Buffer.concat([Buffer.from("ffd8ffe000104a464946", "hex"), Buffer.alloc(64, 1)]);
const PNG = Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), Buffer.alloc(64, 2)]);
const PDF = Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(64, 3)]);
const b64 = (buf) => buf.toString("base64");
const BUCKET = () => `https://${process.env.DO_SPACES_BUCKET}.${process.env.REGION}.digitaloceanspaces.com/`;
const CDN = () => `https://${process.env.DO_SPACES_BUCKET}.${process.env.REGION}.cdn.digitaloceanspaces.com/`;

let G, GT, H, HT, O, OT, ADMIN, AT, RA, RAT, PA, PAT;
let LH; // host H's active listing

async function upload(token, files, { path = "/uploads/", field = "images" } = {}) {
  const form = new FormData();
  for (const [name, buf, type] of files) form.append(field, new Blob([buf], { type }), name);
  const res = await fetch(`${h.baseUrl()}${path}`, { method: "POST", headers: token ? { authorization: `Bearer ${token}` } : {}, body: form });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = { raw: text };
  }
  return { status: res.status, body };
}

test.before(async () => {
  await h.start();
  G = await h.makeUser({ firstName: "Guest", lastName: "One" });
  GT = h.userToken(G);
  H = await h.makeUser({ role: "host", firstName: "Host", lastName: "Person" });
  HT = h.userToken(H);
  O = await h.makeUser({ firstName: "Other", lastName: "User" });
  OT = h.userToken(O);
  ADMIN = await h.makeAdmin();
  AT = h.adminToken(ADMIN);
  RA = await h.makeUser({ role: "admin", firstName: "Role", lastName: "Admin" });
  RAT = h.userToken(RA);
  PA = await h.makeUser({ firstName: "Plain", lastName: "AdminEmail", email: ADMIN.email.replace("@", "+customer@") });
  // Same email as an Admin-collection identity: PA is privileged by email.
  await User().updateOne({ _id: PA._id }, { $set: { email: ADMIN.email } });
  PAT = h.userToken(PA);
  LH = await h.makeListing(H);
  process.env.KYC_ATTEMPT_COOLDOWN_SECONDS = "0";
  process.env.KYC_MAX_ATTEMPTS_PER_DAY = "50";
});
test.after(async () => h.stop());
test.beforeEach(() => {
  process.env.KYC_PROVIDER_MOCK_MODE = "success";
  provider().resetCalls();
  storage().resetMock();
});

// ---------------------------------------------------------------------------
test("accounts: only the owner (or an admin) reads/updates a profile; the body whitelist never writes names, role, status, kyc, email or tokenVersion", async () => {
  const q = `?email=${encodeURIComponent(G.email)}`;
  assert.equal((await h.api("GET", `/accounts/${q}`)).status, 401);
  assert.equal((await h.api("GET", `/accounts/${q}`, { token: OT })).status, 403);
  assert.equal((await h.api("GET", `/accounts/${q}`, { token: GT })).status, 200);
  assert.equal((await h.api("GET", `/accounts/${q}`, { token: AT })).status, 200);
  assert.equal((await h.api("GET", `/accounts/?email=${encodeURIComponent(G.email.toUpperCase())}`, { token: GT })).status, 200, "email compare is case-insensitive");

  const body = {
    firstName: "Hacked", lastName: "Name", dob: "1990-01-01", phoneNumber: "9111111111",
    email: "evil@test.local", role: "admin", status: { banned: false, active: true }, kyc: true, bank: true, tokenVersion: 99,
    about: "hello", address: { city: "Panaji", zzz: "no" }, languages: ["en", "hi"], governmentIdType: "pan",
  };
  assert.equal((await h.api("PUT", `/accounts/${q}`, { body })).status, 401);
  assert.equal((await h.api("PUT", `/accounts/${q}`, { token: OT, body })).status, 403);
  const ok = await h.api("PUT", `/accounts/${q}`, { token: GT, body });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  const after = await User().findById(G._id).lean();
  assert.equal(after.firstName, "Guest", "names are admin-managed");
  assert.equal(after.lastName, "One");
  assert.equal(after.email, G.email);
  assert.equal(after.role, "user");
  assert.ok(!after.kyc);
  assert.equal(after.tokenVersion, 0);
  assert.equal(after.phoneNumber, "9111111111");
  assert.equal(after.about, "hello");
  assert.equal(after.address.city, "Panaji");
  assert.equal(after.address.zzz, undefined);
  assert.deepEqual(after.languages, ["en", "hi"]);
  assert.equal(ok.body.firstName, "Guest", "response carries the stored (admin-managed) name");
  // a taken phone number is a clean 409, not a 500
  const dup = await h.api("PUT", `/accounts/?email=${encodeURIComponent(O.email)}`, { token: OT, body: { ...body, phoneNumber: "9111111111" } });
  assert.equal(dup.status, 409);
  assert.equal(dup.body.code, "PHONE_IN_USE");
});

// ---------------------------------------------------------------------------
test("bank details, hosts analytics, hostData listings, prop-listing writes and legacy hosts PUT are gated", async () => {
  const bank = { accountNumber: "1234567890", ifsc: "HDFC0000001", accountHolderName: "Host Person", bankName: "HDFC" };
  assert.equal((await h.api("GET", `/hostData/bank/${H._id}`)).status, 401);
  assert.equal((await h.api("GET", `/hostData/bank/${H._id}`, { token: OT })).status, 403);
  assert.equal((await h.api("PUT", `/hostData/bank/${H._id}`, { token: OT, body: bank })).status, 403);
  assert.notEqual((await h.api("GET", `/hostData/bank/${H._id}`, { token: HT })).status, 403);
  assert.notEqual((await h.api("GET", `/hostData/bank/${H._id}`, { token: AT })).status, 403);
  assert.equal((await h.api("GET", "/hostData/bank/not-an-id", { token: HT })).status, 404);
  assert.equal((await h.api("GET", "/hostData/")).status, 401);
  assert.equal((await h.api("GET", "/hostData/", { token: HT })).status, 403);
  assert.equal((await h.api("GET", "/hostData/review/admin", { token: HT })).status, 403);

  for (const path of ["/hosts/", "/hosts/stats", "/hosts/growth", "/hosts/top-performing", "/hosts/activity", "/hosts/distribution", "/hosts/report", "/hosts/export"]) {
    assert.equal((await h.api("GET", path)).status, 401, path);
    assert.equal((await h.api("GET", path, { token: HT })).status, 403, path);
  }
  assert.equal((await h.api("PUT", `/hosts/${H._id}`, { body: { firstName: "X" } })).status, 401);
  assert.equal((await h.api("PUT", `/hosts/${H._id}`, { token: HT, body: { firstName: "X" } })).status, 403);
  assert.equal((await h.api("PUT", `/hosts/${H._id}`, { token: OT, body: { email: "steal@test.local" } })).status, 403);
  assert.equal((await User().findById(H._id).lean()).email, H.email);

  assert.equal((await h.api("POST", "/prop-listing/", { body: { title: "x" } })).status, 401);
  assert.equal((await h.api("POST", "/prop-listing/", { token: HT, body: { title: "x" } })).status, 403);
  assert.equal((await h.api("PUT", `/prop-listing/${LH._id}`, { body: { title: "x" } })).status, 401);
  assert.equal((await h.api("PUT", `/prop-listing/${LH._id}`, { token: OT, body: { title: "x" } })).status, 403);
  assert.equal((await h.api("DELETE", `/prop-listing/${LH._id}`, { token: AT })).status, 404, "anonymous delete route removed");
  assert.equal((await h.api("POST", "/prop-listing/bulk-action", { token: AT, body: { propertyIds: [String(LH._id)], action: "delete" } })).status, 404, "bulk-action route removed");
  assert.ok(await ListingProperty().exists({ _id: LH._id }));
  // Batch P: the stage read is the host's own (the site sends the session token) or an admin's
  assert.equal((await h.api("GET", `/prop-listing/status?email=${encodeURIComponent(H.email)}`)).status, 401);
  assert.equal((await h.api("GET", `/prop-listing/status?email=${encodeURIComponent(H.email)}`, { token: OT })).status, 403);
  assert.equal((await h.api("GET", `/prop-listing/status?email=${encodeURIComponent(H.email)}`, { token: HT })).status, 200);
  assert.equal((await h.api("GET", `/prop-listing/status?email=${encodeURIComponent(H.email)}`, { token: AT })).status, 200);
});

// ---------------------------------------------------------------------------
test("guests: admin-only listing of every non-privileged account (hosts flagged, admins hidden, search escaped); ban is admin-only and slim; delete route removed", async () => {
  assert.equal((await h.api("GET", "/guests/")).status, 401);
  assert.equal((await h.api("GET", "/guests/", { token: GT })).status, 403);
  assert.equal((await h.api("GET", "/guests/", { token: RAT })).status, 200, "a User with role admin is an admin");
  const all = await h.api("GET", "/guests/?limit=100", { token: AT });
  assert.equal(all.status, 200);
  const ids = all.body.data.map((u) => String(u._id));
  assert.ok(ids.includes(String(G._id)), "a pure guest is listed");
  assert.ok(ids.includes(String(H._id)), "a host is listed");
  assert.ok(!ids.includes(String(RA._id)), "role:admin users are hidden");
  assert.ok(!ids.includes(String(PA._id)), "users whose email is an Admin identity are hidden");
  const host = all.body.data.find((u) => String(u._id) === String(H._id));
  assert.equal(host.isHost, true);
  assert.equal(host.totalProperties, 1);
  assert.equal(all.body.data.find((u) => String(u._id) === String(G._id)).isHost, false);
  assert.equal(host.tokenVersion, undefined, "internal fields are projected out");
  assert.equal((await h.api("GET", "/guests/?search=(", { token: AT })).status, 200, "regex metacharacters are escaped");
  const found = await h.api("GET", `/guests/?search=${encodeURIComponent("guest one")}`, { token: AT });
  assert.ok(found.body.data.some((u) => String(u._id) === String(G._id)), "full-name search");

  assert.equal((await h.api("GET", `/guests/kyc?id=${H._id}`, { token: HT })).status, 403);
  assert.equal((await h.api("GET", "/guests/kyc?id=nope", { token: AT })).status, 400);
  assert.equal((await h.api("GET", `/guests/kyc?id=${H._id}`, { token: AT })).status, 200);

  assert.equal((await h.api("PATCH", `/guests/ban/${O._id}`, { token: GT, body: { active: true } })).status, 403);
  const ban = await h.api("PATCH", `/guests/ban/${O._id}`, { token: AT, body: { active: true } });
  assert.equal(ban.status, 200);
  assert.equal(ban.body.data.status.banned, true);
  assert.equal(ban.body.updatedList, undefined);
  assert.equal(Array.isArray(ban.body.data), false, "no more user dump");
  assert.equal((await h.api("GET", "/guests/guest-by-id?userId=" + O._id, { token: OT })).status, 403, "banned token is refused (USER_BANNED)");
  const unban = await h.api("PATCH", `/guests/ban/${O._id}`, { token: AT, body: { active: false } });
  assert.equal(unban.status, 200);
  assert.equal(unban.body.data.status.banned, false);
  OT = h.userToken(await User().findById(O._id)); // tokenVersion moved on
  assert.equal((await h.api("DELETE", `/guests/delete/${O._id}`, { token: AT })).status, 404, "delete route removed");
  assert.ok(await User().exists({ _id: O._id }));
  assert.equal((await h.api("GET", `/guests/info/${G._id}`, { token: OT })).status, 200, "self-service read unchanged");
  assert.equal((await h.api("GET", "/guests/info/not-an-id", { token: OT })).status, 400);
});

// ---------------------------------------------------------------------------
async function createForm(token, hostId) {
  return h.api("POST", "/kyc/form", {
    token,
    body: {
      hostId: String(hostId),
      personalInfo: { fatherName: "Father", dob: "1990-01-01", address: { line1: "1 St", city: "Panaji", state: "Goa", pincode: "403001", country: "India" } },
      documentInfo: { documentType: "pan", isVerified: true },
      gstInfo: { gstNumber: "x", panNumber: "y", isVerified: true },
      acceptedTerms: { general: true },
      status: "completed",
      hostEmail: "spoof@test.local",
    },
  });
}

test("kyc form: authenticated + own; create is idempotent and whitelisted; update-form cannot touch verification blocks or complete without a verified document", async () => {
  assert.equal((await createForm(undefined, H._id)).status, 401);
  assert.equal((await createForm(OT, H._id)).status, 403, "another user cannot create a form for the host");
  const created = await createForm(HT, H._id);
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const form = created.body.data;
  assert.equal(form.hostEmail, H.email, "hostEmail comes from the actor, not the body");
  assert.equal(form.status, "processing");
  assert.equal(form.documentInfo.isVerified, false, "verification cannot be asserted on create");
  assert.equal(form.gstInfo.isVerified, false);
  assert.equal(form.acceptedTerms.general, true);
  const again = await createForm(HT, H._id);
  assert.equal(again.status, 200);
  assert.equal(String(again.body.data._id), String(form._id), "idempotent");

  // reads
  assert.equal((await h.api("GET", `/kyc/user/${H._id}`)).status, 401);
  assert.equal((await h.api("GET", `/kyc/user/${H._id}`, { token: OT })).status, 403);
  assert.equal((await h.api("GET", `/kyc/user/${H._id}`, { token: HT })).status, 200);
  assert.equal((await h.api("GET", `/kyc/form/${H._id}`, { token: AT })).status, 200);
  assert.equal((await h.api("GET", `/kyc/form-kyc/${form._id}`, { token: OT })).status, 403);
  assert.equal((await h.api("GET", `/kyc/form-kyc/${form._id}`, { token: HT })).status, 200);
  assert.equal((await h.api("GET", `/kyc/user/${G._id}`, { token: GT })).status, 404, "no form yet → 404 as before");

  // update-form: whitelist
  const upd = await h.api("PUT", `/kyc/update-form/${form._id}`, {
    token: HT,
    body: { personalInfo: { fatherName: "Dad", address: { city: "Margao" } }, documentInfo: { isVerified: true, documentType: "passport" }, gstInfo: { isVerified: true }, hostId: String(O._id), hostEmail: "x@y.z", status: "processing" },
  });
  assert.equal(upd.status, 200, JSON.stringify(upd.body));
  const stored = await KycHostData().findById(form._id).lean();
  assert.equal(stored.personalInfo.fatherName, "Dad");
  assert.equal(stored.personalInfo.address.city, "Margao");
  assert.equal(stored.personalInfo.address.pincode, "403001", "merge keeps untouched address fields");
  assert.equal(stored.documentInfo.isVerified, false, "documentInfo is server-owned");
  assert.equal(stored.documentInfo.documentType, "");
  assert.equal(stored.gstInfo.isVerified, false);
  assert.equal(String(stored.hostId), String(H._id));
  assert.equal(stored.hostEmail, H.email);
  assert.equal((await h.api("PUT", `/kyc/update-form/${form._id}`, { token: OT, body: { status: "processing" } })).status, 403);
  assert.equal((await h.api("PUT", `/kyc/update-form/${form._id}`, { token: HT, body: { status: "weird" } })).status, 400);

  // completion without a verified document → saved as pending + 409
  const complete = await h.api("PUT", `/kyc/update-form/${form._id}`, { token: HT, body: { acceptedTerms: { general: true }, status: "completed" } });
  assert.equal(complete.status, 409);
  assert.equal(complete.body.code, "KYC_INCOMPLETE");
  const pending = await KycHostData().findById(form._id).lean();
  assert.equal(pending.status, "pending");
  assert.ok(!(await User().findById(H._id).lean()).kyc, "host not marked kyc");

  // the client's PATCHes can only confirm, never promote
  assert.equal((await h.api("PATCH", "/kyc/verify-status", { body: { userId: String(H._id), isVerified: true, documentType: "pan" } })).status, 401);
  assert.equal((await h.api("PATCH", "/kyc/verify-status", { token: OT, body: { userId: String(H._id), isVerified: true, documentType: "pan" } })).status, 403);
  const confirm = await h.api("PATCH", "/kyc/verify-status", { token: HT, body: { userId: String(H._id), isVerified: true, documentType: "pan" } });
  assert.equal(confirm.status, 409);
  assert.equal(confirm.body.code, "VERIFICATION_NOT_FOUND");
  assert.equal((await KycHostData().findById(form._id).lean()).documentInfo.isVerified, false);
  const gstConfirm = await h.api("PATCH", "/kyc/verify-gst-status", { token: HT, body: { userId: String(H._id), isVerified: true, panNumber: "******1234", gstNumber: "******1Z5" } });
  assert.equal(gstConfirm.status, 409);
});

// ---------------------------------------------------------------------------
test("document verification: cheap validation before any log or provider call; verdicts (verified / needs_review / failed) decide documentInfo; replacement vs retry; admin manual verification completes a waiting KYC", async () => {
  const userId = String(H._id);
  const post = (body, token = HT) => h.api("POST", "/pan-kyc/verify", { token, body: { userId, doc: "pan", ...body } });
  assert.equal((await h.api("POST", "/pan-kyc/verify", { body: { userId, doc: "pan", imageUrl: b64(JPEG) } })).status, 401);
  assert.equal((await post({ imageUrl: b64(JPEG) }, OT)).status, 403);

  // garbage never reaches the provider, never writes a log, never consumes quota
  const before = await KycLogs().countDocuments({ userId: H._id });
  assert.equal((await post({ imageUrl: "" })).status, 400);
  assert.equal((await post({ imageUrl: "not base64 at all !!" })).status, 422);
  assert.equal((await post({ imageUrl: b64(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'></svg>")) })).status, 415);
  assert.equal((await post({ imageUrl: b64(Buffer.from("<html><script>alert(1)</script></html>")) })).status, 415);
  assert.equal((await post({ imageUrl: "A".repeat(Math.ceil((4 * 1024 * 1024) / 3) * 4 + 4) })).status, 413);
  assert.equal((await post({ imageUrl: b64(JPEG), doc: "aadhaar" })).status, 400);
  assert.equal(await KycLogs().countDocuments({ userId: H._id }), before, "no log rows for rejected input");
  assert.equal(provider().calls.ocr, 0);
  const guardBefore = (await KycHostData().findOne({ hostId: H._id }).lean()).verification;
  assert.equal(guardBefore, undefined, "no quota consumed by rejected input");

  // success → verified with the provider's name match
  const ok = await post({ imageUrl: b64(JPEG) });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.verdict, "verified");
  let form = await KycHostData().findOne({ hostId: H._id }).lean();
  assert.equal(form.documentInfo.isVerified, true);
  assert.equal(form.documentInfo.reviewStatus, "verified");
  assert.equal(form.documentInfo.documentType, "pan");
  assert.ok(form.documentInfo.verifiedLogId);
  assert.equal(form.documentInfo.fingerprint.length, 64);
  const ocrLog = await KycLogs().findById(form.documentInfo.verifiedLogId).lean();
  assert.equal(ocrLog.type, "OCR");
  assert.equal(ocrLog.requestData.doc, "pan");
  assert.equal(ocrLog.requestData.mime, "image/jpeg");
  assert.equal(provider().calls.ocr, 1);
  assert.equal(provider().calls.status, 1);
  const confirm = await h.api("PATCH", "/kyc/verify-status", { token: HT, body: { userId, isVerified: false, documentType: "voterId" } });
  assert.equal(confirm.status, 200, "client PATCH confirms");
  form = await KycHostData().findOne({ hostId: H._id }).lean();
  assert.equal(form.documentInfo.isVerified, true, "…and cannot demote or retype");
  assert.equal(form.documentInfo.documentType, "pan");

  // same bytes, provider times out → the existing verification stays
  process.env.KYC_PROVIDER_MOCK_MODE = "timeout";
  const retry = await post({ imageUrl: b64(JPEG) });
  assert.equal(retry.status, 502);
  form = await KycHostData().findOne({ hostId: H._id }).lean();
  assert.equal(form.documentInfo.isVerified, true, "a failed retry of the same document keeps the verification");
  assert.equal(form.verification.ocr.inFlightUntil, null, "in-flight lease released");
  assert.equal(form.verification.ocr.count, 2, "the attempt still counts (it may have cost credits)");

  // a different document (replacement) that fails → unverified; replaying the old PATCH cannot promote it
  process.env.KYC_PROVIDER_MOCK_MODE = "negative";
  const replaced = await post({ imageUrl: b64(PNG) });
  assert.equal(replaced.status, 422);
  assert.equal(replaced.body.code, "DOCUMENT_NOT_VERIFIED");
  form = await KycHostData().findOne({ hostId: H._id }).lean();
  assert.equal(form.documentInfo.isVerified, false, "a replaced document is unverified until it passes");
  assert.equal(form.documentInfo.reviewStatus, "failed");
  assert.equal((await h.api("PATCH", "/kyc/verify-status", { token: HT, body: { userId, isVerified: true, documentType: "pan" } })).status, 409);
  const completeTry = await h.api("PUT", `/kyc/update-form/${form._id}`, { token: HT, body: { acceptedTerms: { general: true }, status: "completed" } });
  assert.equal(completeTry.status, 409);

  // provider 200 without validity fields → needs_review (never verified automatically)
  process.env.KYC_PROVIDER_MOCK_MODE = "ambiguous";
  const amb = await post({ imageUrl: b64(PDF) });
  assert.equal(amb.status, 200);
  assert.equal(amb.body.verdict, "needs_review");
  form = await KycHostData().findOne({ hostId: H._id }).lean();
  assert.equal(form.documentInfo.isVerified, false);
  assert.equal(form.documentInfo.reviewStatus, "needs_review");
  const reviewLogId = String(form.documentInfo.verifiedLogId);
  // the host publishes → saved as pending with the review message
  const publish = await h.api("PUT", `/kyc/update-form/${form._id}`, { token: HT, body: { acceptedTerms: { general: true }, status: "completed" } });
  assert.equal(publish.status, 409);
  assert.match(publish.body.message, /manual review/);
  assert.equal((await KycHostData().findById(form._id).lean()).status, "pending");

  // name mismatch on an active document → needs_review as well
  process.env.KYC_PROVIDER_MOCK_MODE = "mismatch";
  const mm = await post({ imageUrl: b64(PNG) });
  assert.equal(mm.status, 200);
  assert.equal(mm.body.verdict, "needs_review");
  assert.equal(mm.body.reason, "NAME_MISMATCH");
  form = await KycHostData().findOne({ hostId: H._id }).lean();
  const currentLogId = String(form.documentInfo.verifiedLogId);
  assert.notEqual(currentLogId, reviewLogId);

  // admin manual verification: only the current attempt awaiting review
  const manual = (body, token = AT) => h.api("PATCH", `/guests/admin/kyc/${H._id}/document-verified`, { token, body });
  assert.equal((await manual({ logId: currentLogId }, HT)).status, 403);
  assert.equal((await manual({ logId: reviewLogId })).status, 409, "an older attempt cannot be promoted");
  assert.equal((await manual({ logId: String(ocrLog._id) })).status, 409, "the originally verified log is not the current attempt");
  assert.equal((await manual({ logId: "nope" })).status, 400);
  const promoted = await manual({ logId: currentLogId });
  assert.equal(promoted.status, 200, JSON.stringify(promoted.body));
  assert.equal(promoted.body.data.completed, true, "terms were accepted → KYC completed");
  form = await KycHostData().findById(form._id).lean();
  assert.equal(form.documentInfo.isVerified, true);
  assert.equal(form.documentInfo.reviewStatus, "verified");
  assert.equal(form.status, "completed");
  assert.equal((await User().findById(H._id).lean()).kyc, true);
  assert.equal((await ListingProperty().findById(LH._id).lean()).kycStatus, "completed");
  const audit = await AdminAuditLog().findOne({ action: "kyc.document.manual_verify" }).lean();
  assert.ok(audit);
  assert.equal(String(audit.targetId), currentLogId);
  assert.equal(String(audit.actorId), String(ADMIN._id));
  assert.equal((await manual({ logId: currentLogId })).status, 409, "already verified → nothing to review");
});

// ---------------------------------------------------------------------------
test("voter id / passport: no provider name match → local name match against the OCR name decides verified vs needs_review", async () => {
  const V = await h.makeUser({ role: "host", firstName: "Priya", lastName: "Sharma" });
  const VT = h.userToken(V);
  assert.equal((await createForm(VT, V._id)).status, 200);
  process.env.KYC_PROVIDER_MOCK_NAME = "PRIYA SHARMA";
  const ok = await h.api("POST", "/pan-kyc/verify", { token: VT, body: { userId: String(V._id), doc: "voterId", imageUrl: b64(JPEG) } });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.verdict, "verified");
  process.env.KYC_PROVIDER_MOCK_NAME = "SOMEONE ELSE";
  const other = await h.api("POST", "/pan-kyc/verify", { token: VT, body: { userId: String(V._id), doc: "passport", imageUrl: b64(PNG) } });
  assert.equal(other.status, 200);
  assert.equal(other.body.verdict, "needs_review");
  assert.equal(other.body.reason, "NAME_MISMATCH");
  const form = await KycHostData().findOne({ hostId: V._id }).lean();
  assert.equal(form.documentInfo.isVerified, false);
  assert.equal(form.documentInfo.documentType, "passport");
  delete process.env.KYC_PROVIDER_MOCK_NAME;
});

// ---------------------------------------------------------------------------
test("GST: format checks before any provider call; server writes masked gstInfo on a positive verdict; inactive/unlisted GST stays unverified", async () => {
  const userId = String(H._id);
  const post = (body, token = HT) => h.api("POST", "/kyc/verify/gst", { token, body: { userId, ...body } });
  assert.equal((await h.api("POST", "/kyc/verify/gst", { body: { userId, panNumber: provider().MOCK_PAN, gstNumber: provider().MOCK_GSTIN } })).status, 401);
  assert.equal((await post({ panNumber: provider().MOCK_PAN, gstNumber: provider().MOCK_GSTIN }, OT)).status, 403);
  assert.equal((await post({ panNumber: "bad", gstNumber: provider().MOCK_GSTIN })).status, 400);
  assert.equal((await post({ panNumber: provider().MOCK_PAN, gstNumber: "27ZZZZZ9999Z1Z5" })).status, 400, "GSTIN must embed the PAN");
  assert.equal(provider().calls.gstPan, 0, "no provider call for malformed input");

  process.env.KYC_PROVIDER_MOCK_MODE = "mismatch"; // GSTIN listed but Cancelled
  const inactive = await post({ panNumber: provider().MOCK_PAN, gstNumber: provider().MOCK_GSTIN });
  assert.equal(inactive.status, 409);
  let form = await KycHostData().findOne({ hostId: H._id }).lean();
  assert.equal(form.gstInfo.isVerified, false);

  process.env.KYC_PROVIDER_MOCK_MODE = "success";
  const ok = await post({ panNumber: provider().MOCK_PAN, gstNumber: provider().MOCK_GSTIN });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  form = await KycHostData().findOne({ hostId: H._id }).lean();
  assert.equal(form.gstInfo.isVerified, true);
  assert.equal(form.gstInfo.gstNumber, "******F1Z5");
  assert.equal(form.gstInfo.panNumber, "******234F");
  assert.ok(form.gstInfo.verifiedLogId);
  const confirm = await h.api("PATCH", "/kyc/verify-gst-status", { token: HT, body: { userId, panNumber: "******0000", gstNumber: "******0000", isVerified: true } });
  assert.equal(confirm.status, 200);
  form = await KycHostData().findOne({ hostId: H._id }).lean();
  assert.equal(form.gstInfo.gstNumber, "******F1Z5", "the client's numbers are ignored");
  assert.equal(form.verification.gst.count, 2);
});

// ---------------------------------------------------------------------------
test("provider cost guard: one attempt in flight, cooldown, daily ceiling, legacy forms initialised, timeouts keep the count", async () => {
  const R = await h.makeUser({ role: "host", firstName: "Rate", lastName: "Limited" });
  const RT = h.userToken(R);
  // legacy form: created straight in the DB without guard state
  await KycHostData().create({ hostId: R._id, hostEmail: R.email, status: "processing", personalInfo: { fatherName: "x" } });
  process.env.KYC_ATTEMPT_COOLDOWN_SECONDS = "1";
  process.env.KYC_MAX_ATTEMPTS_PER_DAY = "3";
  process.env.KYC_PROVIDER_MOCK_TIMEOUT_MS = "300";
  process.env.KYC_PROVIDER_MOCK_MODE = "timeout";
  const post = () => h.api("POST", "/pan-kyc/verify", { token: RT, body: { userId: String(R._id), doc: "pan", imageUrl: b64(JPEG) } });
  try {
    const burst = await Promise.all(Array.from({ length: 10 }, post));
    const statuses = burst.map((r) => r.status).sort();
    assert.equal(statuses.filter((s) => s === 429).length, 9, JSON.stringify(statuses));
    assert.equal(provider().calls.ocr, 1, "exactly one provider call for ten simultaneous attempts");
    const limited = burst.find((r) => r.status === 429);
    assert.equal(limited.body.code, "KYC_RATE_LIMITED");
    assert.equal(limited.body.reason, "in_flight");
    assert.ok(limited.body.retryAfterSeconds >= 1);
    const form = await KycHostData().findOne({ hostId: R._id }).lean();
    assert.equal(form.verification.ocr.count, 1);
    assert.equal(form.verification.ocr.inFlightUntil, null);

    // cooldown after the (timed out) attempt
    process.env.KYC_PROVIDER_MOCK_MODE = "success";
    const cool = await post();
    assert.equal(cool.status, 429);
    assert.equal(cool.body.reason, "cooldown");
    await h.sleep(1100);
    assert.equal((await post()).status, 200);
    await h.sleep(1100);
    assert.equal((await post()).status, 200);
    await h.sleep(1100);
    const daily = await post();
    assert.equal(daily.status, 429);
    assert.equal(daily.body.reason, "daily_limit");
    assert.equal(provider().calls.ocr, 3);
    // the window is 24 h: age it and the host is admitted again
    await KycHostData().updateOne({ hostId: R._id }, { $set: { "verification.ocr.windowStart": new Date(Date.now() - 25 * 3600 * 1000) } });
    assert.equal((await post()).status, 200);
  } finally {
    process.env.KYC_ATTEMPT_COOLDOWN_SECONDS = "0";
    process.env.KYC_MAX_ATTEMPTS_PER_DAY = "50";
    delete process.env.KYC_PROVIDER_MOCK_TIMEOUT_MS;
  }
  assert.equal((await h.api("POST", "/pan-kyc/verify", { token: GT, body: { userId: String(G._id), doc: "pan", imageUrl: b64(JPEG) } })).status, 409, "no form → no provider call");
});

// ---------------------------------------------------------------------------
test("uploads: authenticated, owner-bound keys, profile picture only on own account, deletion by ownership with foreign-reference protection and key canonicalisation", async () => {
  assert.equal((await upload(undefined, [["a.jpg", JPEG, "image/jpeg"]])).status, 401);
  const up = await upload(HT, [["My Photo (1).JPG", JPEG, "image/jpeg"], ["b.png", PNG, "image/png"]]);
  assert.equal(up.status, 200, JSON.stringify(up.body));
  assert.equal(up.body.urls.length, 2);
  const key0 = storage().keyFromUrl(up.body.urls[0]);
  assert.match(key0, new RegExp(`^listings/${H._id}/[0-9a-f-]{36}-My-Photo-1-.JPG$`));
  assert.equal(storage().ownerFromKey(key0), String(H._id));
  const key1 = storage().keyFromUrl(up.body.urls[1]);

  // profile picture: only own account
  assert.equal((await upload(OT, [["me.png", PNG, "image/png"]], { path: `/uploads/profile?userId=${H._id}`, field: "file" })).status, 403);
  const prof = await upload(HT, [["me.png", PNG, "image/png"]], { path: `/uploads/profile?userId=${H._id}`, field: "file" });
  assert.equal(prof.status, 200, JSON.stringify(prof.body));
  const profKey = storage().keyFromUrl(prof.body.url);
  assert.match(profKey, new RegExp(`^profiles/${H._id}/`));
  assert.equal((await User().findById(H._id).lean()).profilePicture, prof.body.url);

  const del = (token, url) => h.api("DELETE", "/uploads/delete", { token, body: { url } });
  // unreferenced in-progress upload: only its owner (upload→attach race: another user gets 403)
  assert.equal((await del(undefined, up.body.urls[0])).status, 401);
  assert.equal((await del(OT, up.body.urls[0])).status, 403);
  assert.deepEqual(storage().__mock.deleted, []);
  assert.equal((await del(HT, up.body.urls[0])).status, 200);
  assert.deepEqual(storage().__mock.deleted, [key0]);

  // attach the second upload to the host's listing → another user still cannot, the host can, admin can
  await ListingProperty().updateOne({ _id: LH._id }, { $set: { photos: [up.body.urls[1]] } });
  assert.equal((await del(OT, up.body.urls[1])).status, 403);
  assert.equal((await del(HT, up.body.urls[1].replace(".digitaloceanspaces.com/", ".cdn.digitaloceanspaces.com/"))).status, 200, "CDN form of the same object");
  assert.ok(storage().__mock.deleted.includes(key1));

  // own profile picture
  assert.equal((await del(OT, prof.body.url)).status, 403);
  assert.equal((await del(HT, prof.body.url)).status, 200);

  // legacy key referenced by two hosts' listings → 409 for either host, admin may
  const legacy = `${BUCKET()}1769315746961-room.jpg`;
  const L2 = await h.makeListing(O, { photos: [legacy.replace(".digitaloceanspaces.com/", ".cdn.digitaloceanspaces.com/")] });
  await ListingProperty().updateOne({ _id: LH._id }, { $set: { photos: [legacy] } });
  storage().resetMock();
  const conflict = await del(HT, legacy);
  assert.equal(conflict.status, 409, JSON.stringify(conflict.body));
  assert.equal(conflict.body.code, "OBJECT_IN_USE");
  assert.equal((await del(OT, legacy)).status, 409);
  assert.deepEqual(storage().__mock.deleted, []);
  assert.equal((await del(AT, legacy)).status, 200);
  await ListingProperty().deleteOne({ _id: L2._id });
  // legacy unreferenced key: admin-only
  storage().resetMock();
  assert.equal((await del(HT, `${BUCKET()}1769315746961-orphan.jpg`)).status, 403);
  assert.equal((await del(AT, `${BUCKET()}1769315746961-orphan.jpg`)).status, 200);

  // canonicalisation / path confusion — nothing foreign ever reaches storage
  storage().resetMock();
  const victimKey = `listings/${O._id}/11111111-1111-4111-8111-111111111111-v.jpg`;
  for (const url of [
    `${BUCKET()}listings/${O._id}/x.jpg`, // wrong owner segment
    `${BUCKET()}listings/${H._id}/../${O._id}/x.jpg`, // normalises to the victim's key
    `${BUCKET()}listings/${H._id}/%2e%2e/${O._id}/x.jpg`,
    `${BUCKET()}listings%252F${H._id}/x.jpg`, // double-encoded separator stays literal
    `${BUCKET()}listings/${H._id}//x.jpg`,
    `${BUCKET()}%2Flistings/${H._id}/x.jpg`,
    `https://${process.env.DO_SPACES_BUCKET}.${process.env.REGION}.digitaloceanspaces.com.evil.com/${victimKey}`,
    `https://images.pexels.com/${victimKey}`,
    "not a url",
  ]) {
    const r = await del(HT, url);
    assert.ok(r.status === 400 || r.status === 403, `${url} → ${r.status}`);
  }
  assert.deepEqual(storage().__mock.deleted, []);
  assert.equal((await del(HT, `${BUCKET()}listings/${H._id}%2Fmine.jpg`)).status, 200, "%2F is the same object as / and the owner segment still matches");
  assert.deepEqual(storage().__mock.deleted, [`listings/${H._id}/mine.jpg`]);
  assert.equal((await h.api("POST", "/uploads/generate-presigned-url", { token: HT, body: { fileName: "x", fileType: "image/png" } })).status, 403);
});

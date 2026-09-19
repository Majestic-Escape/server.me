// PII exposure probe (read-only against the in-process harness). For every
// guest/host/public-facing read it reports which fields of the OTHER party's
// user record come back. Run: node tests/batch-s/pii-probe.mjs
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const h = require("./setup");

const PII = ["email", "phoneNumber", "countryCode", "dob", "address", "otp", "otpRetries", "lockUntil", "tokenVersion", "gender", "bio", "status", "verification", "preferences", "bookings", "wishlist", "kyc", "bank", "hostOffer", "isVerified", "role", "lastName"];

function findUsers(node, path = "", out = []) {
  if (!node || typeof node !== "object") return out;
  if (Array.isArray(node)) { node.forEach((v, i) => findUsers(v, `${path}[${i}]`, out)); return out; }
  if (typeof node.firstName === "string" && (node._id || node.id)) {
    const present = PII.filter((k) => node[k] !== undefined && node[k] !== null && !(Array.isArray(node[k]) && node[k].length === 0));
    out.push({ path, id: String(node._id || node.id), present });
  }
  for (const [k, v] of Object.entries(node)) if (typeof v === "object") findUsers(v, path ? `${path}.${k}` : k, out);
  return out;
}

await h.start();
const G = await h.makeUser({ about: "guest about" });
const GT = h.userToken(G);
const H = await h.makeUser({ role: "host", about: "host about" });
const HT = h.userToken(H);
const L = await h.makeListing(H);
const X = await h.makeUser();
const XT = h.userToken(X);

// paid booking by G on L
const r = await h.api("POST", "/booking/", { token: GT, body: h.bookingBody(L, { checkIn: h.day(400), checkOut: h.day(402) }) });
if (r.status !== 201) throw new Error("booking " + JSON.stringify(r.body));
const b = r.body.data;
const o = (await h.api("POST", "/payment/create-order", { token: GT, body: { bookingId: b._id, amount: b.quote.totalPaise } })).body.data;
const p = h.razorpay().__registerPayment({ id: `pay_probe_${Date.now()}`, order_id: o.id, amount: o.amount, currency: "INR", status: "captured", method: "upi" });
const v = await h.api("POST", "/payment/verify-payment", { token: GT, body: { razorpay_order_id: o.id, razorpay_payment_id: p.id, razorpay_signature: h.signature(o.id, p.id) } });
if (v.status !== 200) throw new Error("verify " + JSON.stringify(v.body));
// a review by the guest
const Review = require("../../models/Review");
await Review.create({ user: G._id, property: L._id, bookingId: b._id, rating: 5, content: "Lovely", hostId: H._id });
const HostReview = require("../../models/HostReview");
try { await HostReview.create({ user: G._id, host: H._id, property: L._id, bookingId: b._id, rating: 4, content: "Nice guest" }); } catch (e) { console.log("hostreview seed skipped:", e.message.split("\n")[0]); }

const calls = [
  ["guest", "GET", `/booking/${b._id}`, GT],
  ["host", "GET", `/booking/${b._id}`, HT],
  ["guest", "GET", `/booking/data?userId=${G._id}`, GT],
  ["guest", "GET", `/booking/user/${G._id}`, GT],
  ["host", "GET", `/booking/host/${H._id}`, HT],
  ["host", "GET", `/booking/analytics-filter?hostId=${H._id}&status=all`, HT],
  ["host", "GET", `/booking/analytics-stats-filter?hostId=${H._id}`, HT],
  ["host", "GET", `/booking/revenue-filter?hostId=${H._id}`, HT],
  ["host", "GET", `/booking/filter-active-bookings`, HT],
  ["host", "GET", `/booking/filter`, HT],
  ["guest", "GET", `/payment/booking?id=${b._id}`, GT],
  ["public", "GET", `/review/${L._id}`, null],
  ["public", "GET", `/hostData/review/${H._id}`, null],
  ["guest", "GET", `/hostData/${H._id}`, GT],
  ["guest", "GET", `/hosts/single/${H._id}`, GT],
  ["guest", "GET", `/hosts/${H._id}`, GT],
  ["guest", "GET", `/guests/info/${H._id}`, GT],
  ["guest", "GET", `/guests/guest-by-id?userId=${H._id}`, GT],
  ["public", "GET", `/properties/${L._id}`, null],
  ["public", "GET", `/prop-listing/${L._id}`, null],
  ["host", "GET", `/properties/user-properties/${H._id}`, HT],
  ["guest", "GET", `/auth/verify`, GT],
  ["guest", "GET", `/accounts?email=${encodeURIComponent(G.email)}`, GT],
  ["stranger", "GET", `/booking/${b._id}`, XT],
  ["stranger", "GET", `/booking/analytics-filter?hostId=${H._id}&status=all`, XT],
];
const ids = { [String(G._id)]: "GUEST", [String(H._id)]: "HOST", [String(X._id)]: "STRANGER" };
for (const [who, m, path, tok] of calls) {
  const res = await h.api(m, path, { token: tok || undefined });
  const users = findUsers(res.body);
  const other = users.filter((u) => ids[u.id] && ((who === "guest" && ids[u.id] !== "GUEST") || (who === "host" && ids[u.id] !== "HOST") || who === "public" || who === "stranger"));
  const summary = other.map((u) => `${ids[u.id]}@${u.path}: ${u.present.join(",") || "(safe)"}`);
  console.log(`${res.status} ${who.padEnd(8)} ${m} ${path}\n      ${summary.length ? summary.join("\n      ") : "no other-party user objects"}`);
}
await h.stop();

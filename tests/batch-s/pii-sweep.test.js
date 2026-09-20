// Contact lock-down — global route sweep. Every GET route the Express app
// mounts is called as anonymous / guest / host / stranger / admin with the
// seeded ids substituted for its params, and the serialised body is searched
// for the OTHER party's canary VALUES (last name, e-mail, phone, dob) and for
// secret field names. It exists so a new endpoint (or a forgotten populate)
// cannot leak without turning this suite red — the endpoint list is derived
// from the router at runtime, not maintained by hand.
const test = require("node:test");
const assert = require("node:assert/strict");
const h = require("./setup");

const CANARY = {
  guest: { lastName: "Zyqvoxguest", email: "zyqvoxguest@canary.test", phoneNumber: "9812345601", dob: "1991-02-03" },
  host: { lastName: "Zyqvoxhost", email: "zyqvoxhost@canary.test", phoneNumber: "9812345602", dob: "1985-06-07" },
  stranger: { lastName: "Zyqvoxstranger", email: "zyqvoxstranger@canary.test", phoneNumber: "9812345603", dob: "1970-01-02" },
};
// never returned to any user: account secrets and the payment customer record
const SECRET_KEYS = /"(otp|otpRetries|lockUntil|tokenVersion|password|customerDetails)"\s*:/;
// owner-only listing values (canaries): visible to the listing's host and admins only
const OWNER_ONLY = { host: { hostEmail: "zyqvoxhost@canary.test", registrationNumber: "REG-ZYQVOX-H" }, stranger: { hostEmail: "zyqvoxstranger@canary.test", registrationNumber: "REG-ZYQVOX-S" } };
// GET /booking/generate-pdf is a Puppeteer template endpoint with no booking data; it answers 500 wherever Chrome is absent (pre-existing, not a data path)
const SKIP = [/\/booking\/generate-pdf$/];

let G, H, X, GT, HT, XT, AT, L, B, P;

async function paidBooking(listing, token, base) {
  const r = await h.api("POST", "/booking/", { token, body: h.bookingBody(listing, { checkIn: h.day(base), checkOut: h.day(base + 2) }) });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const b = r.body.data;
  const o = (await h.api("POST", "/payment/create-order", { token, body: { bookingId: b._id, amount: b.quote.totalPaise } })).body.data;
  const p = h.razorpay().__registerPayment({ id: `pay_sweep_${base}_${Date.now()}`, order_id: o.id, amount: o.amount, currency: "INR", status: "captured", method: "upi" });
  const v = await h.api("POST", "/payment/verify-payment", { token, body: { razorpay_order_id: o.id, razorpay_payment_id: p.id, razorpay_signature: h.signature(o.id, p.id) } });
  assert.equal(v.status, 200, JSON.stringify(v.body));
  await h.api("POST", "/booking/updateStatus", { token, body: { bookingId: b._id } });
  return b;
}

test.before(async () => {
  await h.start();
  G = await h.makeUser({ role: "user", firstName: "Priya", ...CANARY.guest, dob: new Date(CANARY.guest.dob) });
  H = await h.makeUser({ role: "host", firstName: "Rahul", ...CANARY.host, dob: new Date(CANARY.host.dob), about: "host about text" });
  X = await h.makeUser({ role: "host", firstName: "Stranger", ...CANARY.stranger, dob: new Date(CANARY.stranger.dob) });
  const ADMIN = await h.makeAdmin();
  GT = h.userToken(G); HT = h.userToken(H); XT = h.userToken(X); AT = h.adminToken(ADMIN);
  L = await h.makeListing(H, { hostEmail: OWNER_ONLY.host.hostEmail, address: { street: "House No 72, Holiday Street", city: "Calangute", district: "North Goa", state: "Goa", pincode: "403516", registrationNumber: OWNER_ONLY.host.registrationNumber, latitude: 15.5445, longitude: 73.7628 } });
  // a second live listing by another host: owner-only fields of THIS one must never reach H or G
  await h.makeListing(X, { hostEmail: OWNER_ONLY.stranger.hostEmail, address: { street: "Plot 9, Sunset Lane", city: "Anjuna", district: "North Goa", state: "Goa", pincode: "403509", registrationNumber: OWNER_ONLY.stranger.registrationNumber, latitude: 15.57, longitude: 73.74 } });
  B = await paidBooking(L, GT, 500);
  const Payment = require("../../models/Payment");
  P = await Payment.findOne({ bookingId: B._id }).lean();
  await h.api("POST", "/review/", { token: GT, body: { propertyId: L._id, bookingId: B._id, rating: 5, content: "Lovely stay, spotless rooms" } }).catch(() => {});
});
test.after(async () => h.stop());

/** Every GET route of the app: [path, mountPrefix]. */
function getRoutes() {
  const app = h.appInstance();
  const out = [];
  const walk = (stack, prefix) => {
    for (const layer of stack) {
      if (layer.route) {
        if (layer.route.methods.get) out.push(prefix + layer.route.path);
      } else if (layer.name === "router" && layer.handle && layer.handle.stack) {
        // mount path from the layer regexp: /^\/api\/v1\/booking\/?(?=\/|$)/i
        const m = layer.regexp && layer.regexp.source.match(/^\^\\\/(.+?)\\\/\?\(\?=\\\/\|\$\)/);
        const mount = m ? "/" + m[1].replace(/\\\//g, "/") : "";
        walk(layer.handle.stack, prefix + mount);
      }
    }
  };
  walk(app._router.stack, "");
  return [...new Set(out)].filter((p) => p.startsWith("/api/v1/"));
}

function substitute(path) {
  const ids = {
    id: null, hostId: String(H._id), userId: String(G._id), guestId: String(G._id), propertyId: String(L._id), listingId: String(L._id),
    bookingId: String(B._id), paymentId: P ? String(P._id) : String(B._id), reviewId: String(L._id), email: G.email, token: "x", orderId: "order_x",
  };
  // ":id" depends on the resource the route is about
  const idFor = (p) => {
    if (/\/booking\//.test(p)) return String(B._id);
    if (/\/payment\//.test(p)) return P ? String(P._id) : String(B._id);
    if (/\/hostData|\/hosts\/|\/host\//.test(p)) return String(H._id);
    if (/\/guests|\/accounts|\/users/.test(p)) return String(G._id);
    return String(L._id);
  };
  return path.replace(/:([a-zA-Z]+)\??/g, (_, name) => (name === "id" ? idFor(path) : ids[name] || String(L._id)));
}

test("every GET route: no counterpart canary value, no secret field, no 500 — anon / guest / host / stranger", async () => {
  const routes = getRoutes();
  assert.ok(routes.length > 40, `found ${routes.length} GET routes`);
  const actors = [
    { name: "anon", token: null, forbidden: ["guest", "host", "stranger"] },
    { name: "guest", token: GT, forbidden: ["host", "stranger"] },
    { name: "host", token: HT, forbidden: ["guest", "stranger"] },
    { name: "stranger", token: XT, forbidden: ["guest", "host"] },
  ];
  const problems = [];
  const seen = { calls: 0, ok: 0 };
  for (const route of routes) {
    if (SKIP.some((re) => re.test(route))) continue;
    const path = substitute(route).replace(/^\/api\/v1/, "");
    for (const actor of actors) {
      let r;
      try {
        r = await h.api("GET", path, actor.token ? { token: actor.token } : {});
      } catch (e) {
        problems.push(`${actor.name} GET ${path}: threw ${e.message}`);
        continue;
      }
      seen.calls++;
      if (r.status >= 500) { problems.push(`${actor.name} GET ${path}: ${r.status} ${JSON.stringify(r.body).slice(0, 100)}`); continue; }
      const s = JSON.stringify(r.body || {});
      for (const who of actor.forbidden) {
        for (const [k, v] of Object.entries(CANARY[who])) if (s.includes(v)) problems.push(`${actor.name} GET ${path}: ${who}.${k} (${r.status})`);
      }
      if (SECRET_KEYS.test(s)) problems.push(`${actor.name} GET ${path}: secret field name (${r.status})`);
      // owner-only listing values: the host may see their own listing's, nobody else's
      for (const [owner, vals] of Object.entries(OWNER_ONLY)) {
        if (actor.name === owner) continue;
        for (const [k, v] of Object.entries(vals)) if (s.includes(v)) problems.push(`${actor.name} GET ${path}: ${owner}'s owner-only ${k} (${r.status})`);
      }
      seen.ok++;
    }
  }
  assert.deepEqual(problems, [], `${seen.calls} calls over ${routes.length} routes`);
  assert.ok(seen.ok > 150, `${seen.ok} clean responses`);
});

test("admin still receives full records on the same routes (no over-blocking)", async () => {
  const b = await h.api("GET", `/booking/${B._id}`, { token: AT });
  const s = JSON.stringify(b.body);
  assert.ok(s.includes(CANARY.guest.email) && s.includes(CANARY.host.email) && s.includes(CANARY.guest.lastName), "admin booking read carries both parties in full");
});

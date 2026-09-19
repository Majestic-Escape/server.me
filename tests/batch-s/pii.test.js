// Contact lock-down (2026-09-20): what a guest, a host, a stranger, an
// anonymous caller and an admin receive about the OTHER party and about a
// listing's location, on every endpoint of the traceability matrix; the
// write-time policy on names / profile / listing / review text; the
// approximate public location; the fail-closed response filter; and the
// image sanitiser. Canary values prove absence by VALUE, not by key name.
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const h = require("./setup");

const User = () => require("../../models/User");
const Booking = () => require("../../models/Booking");
const Review = () => require("../../models/Review");
const HostReview = () => require("../../models/HostReview");
const ListingProperty = () => require("../../models/ListingProperty");
const { sanitizeBody } = require("../../middleware/piiResponseFilter");
const { approximateLocation, resetLocationKeyCache, SELF_USER_FIELDS, SECRET_USER_FIELDS, PUBLIC_USER_FIELDS } = require("../../utils/sanitizeResponse");

// Unmistakable counterpart values (a leak under any key name is caught by
// searching the serialised body for them).
const CANARY = {
  guest: { lastName: "Zyqvoxguest", email: "zyqvoxguest@canary.test", phoneNumber: "9812345601", dob: new Date("1991-02-03T00:00:00.000Z"), about: "guest about text" },
  host: { lastName: "Zyqvoxhost", email: "zyqvoxhost@canary.test", phoneNumber: "9812345602", dob: new Date("1985-06-07T00:00:00.000Z"), about: "host about text" },
};
const STREET = "House No 72, Holiday Street";
const TRUE_LAT = 15.5445;
const TRUE_LNG = 73.7628;

let G, GT, H, HT, X, XT, ADMIN, AT, L, B;

function leaks(body, who) {
  const s = JSON.stringify(body);
  const c = CANARY[who];
  const found = [];
  for (const [k, v] of Object.entries({ lastName: c.lastName, email: c.email, phone: c.phoneNumber, dob: c.dob.toISOString().slice(0, 10) })) {
    if (s.includes(v)) found.push(k);
  }
  return found;
}
function hasSecrets(body) {
  const s = JSON.stringify(body);
  return /"(otp|otpRetries|lockUntil|tokenVersion|password)"/.test(s);
}

async function paidBooking(listing, token, base) {
  const r = await h.api("POST", "/booking/", { token, body: h.bookingBody(listing, { checkIn: h.day(base), checkOut: h.day(base + 2) }) });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const b = r.body.data;
  const o = (await h.api("POST", "/payment/create-order", { token, body: { bookingId: b._id, amount: b.quote.totalPaise } })).body.data;
  const p = h.razorpay().__registerPayment({ id: `pay_pii_${base}_${Date.now()}`, order_id: o.id, amount: o.amount, currency: "INR", status: "captured", method: "upi" });
  const v = await h.api("POST", "/payment/verify-payment", { token, body: { razorpay_order_id: o.id, razorpay_payment_id: p.id, razorpay_signature: h.signature(o.id, p.id) } });
  assert.equal(v.status, 200, JSON.stringify(v.body));
  // the site's post-payment call sends the notifications (once)
  const n = await h.api("POST", "/booking/updateStatus", { token, body: { bookingId: b._id } });
  assert.equal(n.status, 200, JSON.stringify(n.body));
  return b;
}

test.before(async () => {
  await h.start();
  G = await h.makeUser({ firstName: "Priya", ...CANARY.guest });
  GT = h.userToken(G);
  H = await h.makeUser({ role: "host", firstName: "Rahul", ...CANARY.host });
  HT = h.userToken(H);
  X = await h.makeUser({ firstName: "Stranger" });
  XT = h.userToken(X);
  ADMIN = await h.makeAdmin();
  AT = h.adminToken(ADMIN);
  L = await h.makeListing(H, {
    description: "Sea-facing villa with a pool",
    address: { street: STREET, city: "Calangute", district: "North Goa", state: "Goa", pincode: "403516", registrationNumber: "REG-77", latitude: TRUE_LAT, longitude: TRUE_LNG },
    line1: "Plot 12/B",
  });
  B = await paidBooking(L, GT, 700); // instant listing → confirmed + paid
  await Review().create({ user: G._id, property: L._id, bookingId: B._id, rating: 5, content: "Lovely stay", hostId: H._id });
  await HostReview().create({ user: G._id, hostId: H._id, property: L._id, bookingId: B._id, rating: 4, content: "Nice guest" });
});
test.after(async () => h.stop());

// ---------------------------------------------------------------------------
// Actor matrix: counterpart PII never leaves, own data stays, admin sees all
// ---------------------------------------------------------------------------
test("every user/host/public read hides the counterpart's contact details, last name and secrets (by value)", async () => {
  const reads = [
    ["guest", "GET", `/booking/${B._id}`, GT, "host"],
    ["host", "GET", `/booking/${B._id}`, HT, "guest"],
    ["guest", "GET", `/booking/data`, GT, "host"],
    ["guest", "GET", `/booking/user/${G._id}`, GT, "host"],
    ["host", "GET", `/booking/host/${H._id}`, HT, "guest"],
    ["host", "GET", `/booking/analytics-filter?status=all`, HT, "guest"],
    ["host", "GET", `/booking/analytics-stats-filter`, HT, "guest"],
    ["host", "GET", `/booking/revenue-filter`, HT, "guest"],
    ["host", "GET", `/booking/filter`, HT, "guest"],
    ["host", "GET", `/booking/filter-active-bookings`, HT, "guest"],
    ["guest", "GET", `/payment/booking?id=${B._id}`, GT, "guest"], // own contact is not echoed through the payment either
    ["host", "GET", `/payment/booking?id=${B._id}`, HT, "guest"],
    ["anon", "GET", `/review/${L._id}`, null, "guest"],
    ["anon", "GET", `/hostData/review/${H._id}`, null, "guest"],
    ["guest", "GET", `/hostData/${H._id}`, GT, "host"],
    ["guest", "GET", `/hosts/single/${H._id}`, GT, "host"],
    ["guest", "GET", `/hosts/${H._id}`, GT, "host"],
    ["guest", "GET", `/guests/info/${H._id}`, GT, "host"],
    ["guest", "GET", `/guests/guest-by-id?userId=${H._id}`, GT, "host"],
    ["anon", "GET", `/properties/${L._id}`, null, "host"],
    ["anon", "GET", `/prop-listing/${L._id}`, null, "host"],
    ["anon", "GET", `/properties/front/dynamic`, null, "host"],
    ["stranger", "GET", `/hostData/${H._id}`, XT, "host"],
    ["stranger", "GET", `/properties/${L._id}`, XT, "host"],
  ];
  for (const [who, m, path, tok, counterpart] of reads) {
    const res = await h.api(m, path, { token: tok || undefined });
    assert.equal(res.status, 200, `${who} ${path}: ${res.status} ${JSON.stringify(res.body).slice(0, 200)}`);
    assert.deepEqual(leaks(res.body, counterpart), [], `${who} ${m} ${path} leaks the ${counterpart}`);
    assert.equal(hasSecrets(res.body), false, `${who} ${path} carries secrets`);
    assert.doesNotMatch(JSON.stringify(res.body), /customerDetails/, `${who} ${path} carries customerDetails`);
  }
});

test("own record: the caller keeps their own contact details, never their secrets; the first name of the counterpart is present", async () => {
  const mine = await h.api("GET", `/booking/${B._id}`, { token: GT });
  assert.equal(mine.body.data.userId.email, CANARY.guest.email);
  assert.equal(mine.body.data.userId.lastName, CANARY.guest.lastName);
  assert.equal(mine.body.data.hostId.firstName, "Rahul");
  assert.equal(mine.body.data.hostId.email, undefined);
  assert.equal(hasSecrets(mine.body), false);
  const profile = await h.api("GET", `/accounts?email=${encodeURIComponent(G.email)}`, { token: GT });
  assert.equal(profile.status, 200);
  assert.equal(profile.body.email, CANARY.guest.email);
  const verify = await h.api("GET", "/auth/verify", { token: GT });
  assert.equal(verify.status, 200);
  assert.equal(JSON.stringify(verify.body).includes(CANARY.guest.email), true);
  assert.equal(hasSecrets(verify.body), false);
  const self = await h.api("GET", `/hostData/${H._id}`, { token: HT });
  assert.equal(self.body.data.email, CANARY.host.email, "the host reads their own record");
  assert.equal(hasSecrets(self.body), false);
});

test("an admin still receives everything (admin.site unchanged)", async () => {
  const res = await h.api("GET", `/booking/${B._id}`, { token: AT });
  assert.equal(res.status, 200);
  assert.deepEqual(leaks(res.body, "host").sort(), ["dob", "email", "lastName", "phone"]);
  assert.deepEqual(leaks(res.body, "guest").sort(), ["dob", "email", "lastName", "phone"]);
  assert.match(JSON.stringify(res.body), /customerDetails/);
  const guests = await h.api("GET", "/guests/", { token: AT });
  assert.equal(guests.status, 200);
  assert.match(JSON.stringify(guests.body), new RegExp(CANARY.guest.email));
});

test("booking-interest: recorded for the caller, no email echoed; the list is admin-only", async () => {
  const anon = await h.api("POST", "/booking-interest/availability", { body: { userId: String(H._id), propertyId: String(L._id), dateFrom: h.day(10), dateTo: h.day(12), guests: 2 } });
  assert.equal(anon.status, 401);
  const forged = await h.api("POST", "/booking-interest/availability", { token: XT, body: { userId: String(H._id), propertyId: String(L._id), dateFrom: h.day(10), dateTo: h.day(12), guests: 2 } });
  assert.equal(forged.status, 201, JSON.stringify(forged.body));
  assert.equal(String(forged.body.data.userId), String(X._id), "the enquiry belongs to the caller, not the body's userId");
  assert.equal(forged.body.data.email, undefined);
  assert.deepEqual(leaks(forged.body, "host"), []);
  assert.equal((await h.api("GET", "/booking-interest/", { token: XT })).status, 403);
  assert.equal((await h.api("GET", "/booking-interest/", { token: AT })).status, 200);
});

// ---------------------------------------------------------------------------
// Location: approximate before booking, exact for the confirmed guest only
// ---------------------------------------------------------------------------
test("public listing reads carry an approximate point (150–350 m off, stable, keyed) and no street", async () => {
  const pub = await h.api("GET", `/properties/${L._id}`);
  const a = pub.body.data.address;
  assert.equal(a.street, undefined);
  assert.equal(a.registrationNumber, undefined);
  assert.equal(pub.body.data.line1, undefined);
  const dist = haversine(TRUE_LAT, TRUE_LNG, a.latitude, a.longitude);
  assert.ok(dist >= 140 && dist <= 360, `offset ${dist} m`);
  const again = await h.api("GET", `/properties/${L._id}`);
  assert.deepEqual([again.body.data.address.latitude, again.body.data.address.longitude], [a.latitude, a.longitude], "stable per listing");
  const card = await h.api("GET", `/properties/front/dynamic`);
  const mine = (card.body.properties || card.body.data || []).find((p) => String(p._id) === String(L._id));
  if (mine) assert.deepEqual([mine.address.latitude, mine.address.longitude], [a.latitude, a.longitude], "cards use the same approximate point");
  // the offset is a function of the server key: another key moves the point, and knowing the id + the public point does not recover the truth
  const withKey = approximateLocation(String(L._id), TRUE_LAT, TRUE_LNG);
  assert.deepEqual([withKey.latitude, withKey.longitude], [a.latitude, a.longitude]);
  process.env.LOCATION_MASK_SECRET = "rotated-key";
  resetLocationKeyCache();
  const rotated = approximateLocation(String(L._id), TRUE_LAT, TRUE_LNG);
  delete process.env.LOCATION_MASK_SECRET;
  resetLocationKeyCache();
  assert.notDeepEqual([rotated.latitude, rotated.longitude], [a.latitude, a.longitude]);
  const idOnly = crypto.createHash("sha256").update(String(L._id)).digest();
  assert.notEqual(idOnly.readUInt32BE(0) % 360, Math.round(((Math.atan2(a.longitude - TRUE_LNG, a.latitude - TRUE_LAT) * 180) / Math.PI + 360) % 360), "bearing is not the plain hash of the id");
});

test("exact street and coordinates: confirmed+paid guest yes; pending / cancelled / stranger no; host always", async () => {
  const confirmed = await h.api("GET", `/booking/${B._id}`, { token: GT });
  assert.equal(confirmed.body.data.status, "confirmed");
  assert.equal(confirmed.body.data.propertyId.address.street, STREET);
  assert.equal(confirmed.body.data.propertyId.address.latitude, TRUE_LAT);
  assert.equal(confirmed.body.data.propertyId.hostEmail, undefined);
  assert.equal(confirmed.body.data.propertyId.address.registrationNumber, undefined);

  // a manual (request-to-book) listing: paid but pending → approximate only
  const manual = await h.makeListing(H, { bookingType: { manual: true }, address: { street: STREET, city: "Calangute", state: "Goa", latitude: TRUE_LAT, longitude: TRUE_LNG } });
  const pending = await paidBooking(manual, GT, 720);
  const pendingRead = await h.api("GET", `/booking/${pending._id}`, { token: GT });
  assert.equal(pendingRead.body.data.status, "pending");
  assert.equal(pendingRead.body.data.propertyId.address.street, undefined);
  // the point is 150–350 m away; with an axis-aligned bearing one coordinate
  // can round back to the true value, so compare the distance, not a coordinate
  const pendingDist = haversine(TRUE_LAT, TRUE_LNG, pendingRead.body.data.propertyId.address.latitude, pendingRead.body.data.propertyId.address.longitude);
  assert.ok(pendingDist > 140 && pendingDist < 360, `pending booking: approximate point (${Math.round(pendingDist)} m)`);
  const list = await h.api("GET", "/booking/data", { token: GT });
  assert.equal(list.status, 200, JSON.stringify(list.body).slice(0, 300));
  const rows = list.body.data;
  assert.equal(rows.find((r) => r._id === String(B._id)).propertyId.address.street, STREET);
  assert.equal(rows.find((r) => r._id === String(pending._id)).propertyId.address.street, undefined);
  // the host sees the exact address of their own listing on every booking
  const hostRead = await h.api("GET", `/booking/${pending._id}`, { token: HT });
  assert.equal(hostRead.body.data.propertyId.address.street, STREET);
  // host rejects → cancelled: exact location gone again for the guest
  const rejected = await h.api("PATCH", "/booking/host/cancel", { token: HT, body: { bookingId: pending._id } });
  assert.equal(rejected.status, 200, JSON.stringify(rejected.body));
  assert.deepEqual(leaks(rejected.body, "guest"), [], "the host's cancel response hides the guest");
  const afterReject = await h.api("GET", `/booking/${pending._id}`, { token: GT });
  assert.equal(afterReject.body.data.propertyId.address.street, undefined);
  assert.deepEqual(leaks(afterReject.body, "host"), []);
});

test("voucher data in emails only for the confirmed lifecycle; counterpart first names", async () => {
  const sent = h.sentEmails();
  const confirmedGuestMail = sent.find((e) => e.recipientEmail === G.email && e.templateId === 35);
  assert.ok(confirmedGuestMail, "instant confirmation to the guest (35)");
  assert.equal(confirmedGuestMail.params.hostContact, CANARY.host.phoneNumber);
  assert.equal(confirmedGuestMail.params.street, STREET);
  assert.equal(confirmedGuestMail.params.hostName, "Rahul");
  assert.equal(confirmedGuestMail.params.userName, `Priya ${CANARY.guest.lastName}`);
  const confirmedHostMail = sent.find((e) => e.recipientEmail === H.email && e.templateId === 34);
  assert.equal(confirmedHostMail.params.userName, "Priya");
  assert.equal(confirmedHostMail.params.guestContact, CANARY.guest.phoneNumber);
  const pendingHostMail = sent.find((e) => e.recipientEmail === H.email && e.templateId === 8);
  assert.ok(pendingHostMail, "pending notification to the host (8)");
  assert.equal(pendingHostMail.params.guestContact, undefined);
  assert.equal(pendingHostMail.params.guestEmail, undefined);
  assert.equal(pendingHostMail.params.street, undefined);
  assert.equal(pendingHostMail.params.userName, "Priya");
  const rejectedGuestMail = sent.find((e) => e.recipientEmail === G.email && e.templateId === 11);
  assert.ok(rejectedGuestMail);
  assert.equal(rejectedGuestMail.params.hostContact, undefined);
  assert.equal(rejectedGuestMail.params.street, undefined);
  assert.equal(rejectedGuestMail.params.hostName, "Rahul");
});

// ---------------------------------------------------------------------------
// Write-time policy
// ---------------------------------------------------------------------------
test("traveller names at checkout follow the name policy (they reach the host's guest list)", async () => {
  const listing = await h.makeListing(H);
  const bad = await h.api("POST", "/booking/", { token: GT, body: h.bookingBody(listing, { checkIn: h.day(800), checkOut: h.day(802), guestData: { adults: [{ name: "Rahul 9876543210", age: 30 }], children: [] } }) });
  assert.equal(bad.status, 422, JSON.stringify(bad.body));
  assert.equal(bad.body.code, "CONTACT_INFO_NOT_ALLOWED");
  // split across two traveller rows: still one phone number
  const split = await h.api("POST", "/booking/", { token: GT, body: h.bookingBody(listing, { checkIn: h.day(800), checkOut: h.day(802), guestData: { adults: [{ name: "Rahul 98765", age: 30 }, { name: "Priya 43210", age: 28 }], children: [] } }) });
  assert.equal(split.status, 422, JSON.stringify(split.body));
  const ok = await h.api("POST", "/booking/", { token: GT, body: h.bookingBody(listing, { checkIn: h.day(800), checkOut: h.day(802), guestData: { adults: [{ name: "Mary Jane O'Brien", age: 30 }, { name: "Guest 2", age: 40 }], children: [{ name: "José (2 yrs)", age: 8 }] } }) });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
});

test("names: registration, become-host and the admin rename refuse contact-bearing names; ordinary names pass", async () => {
  const bad = ["Rahul9876543210", "9876543210", "rahul@gmail.com", "@rahul123", "rahulvilla.in", "WhatsApp Rahul"];
  for (const name of bad) {
    const r = await h.api("POST", "/register/request-otp", { body: { firstName: name, lastName: "Test", phoneNumber: "9700000111", email: `n${Date.now()}@test.local`, dob: "1990-01-01" } });
    assert.equal(r.status, 422, `${name}: ${r.status}`);
    assert.equal(r.body.code, "CONTACT_INFO_NOT_ALLOWED");
    const rename = await h.api("PATCH", `/guests/name/${X._id}`, { token: AT, body: { firstName: name, lastName: "Test", expected: { firstName: X.firstName, lastName: X.lastName } } });
    assert.equal(rename.status, 400, `admin rename ${name}`);
  }
  for (const name of ["José", "Mary Jane", "O'Brien", "Anne-Marie"]) {
    const rename = await h.api("PATCH", `/guests/name/${X._id}`, { token: AT, body: { firstName: name, lastName: "Test", expected: { firstName: (await User().findById(X._id)).firstName, lastName: "Test" } } });
    assert.equal(rename.status, 200, `${name}: ${JSON.stringify(rename.body)}`);
  }
  await User().updateOne({ _id: X._id }, { $set: { firstName: "Stranger", lastName: "Test" } });
});

test("profile: about + languages are judged as one resource, against the host's listing addresses; the 422 names the field", async () => {
  const put = (body) => h.api("PUT", `/accounts?email=${encodeURIComponent(H.email)}`, { token: HT, body: { firstName: H.firstName, lastName: H.lastName, dob: "1985-06-07", phoneNumber: CANARY.host.phoneNumber, ...body } });
  let r = await put({ about: "Call me on 98765", languages: ["English", "43210"] });
  assert.equal(r.status, 422, JSON.stringify(r.body));
  assert.equal(r.body.code, "CONTACT_INFO_NOT_ALLOWED");
  assert.ok(r.body.fields.includes("about") || r.body.fields.some((f) => f.startsWith("languages")), JSON.stringify(r.body.fields));
  r = await put({ about: "My villa is House 72, Holiday Street", languages: ["English"] });
  assert.equal(r.status, 422, "exact address of the host's own listing");
  assert.ok(r.body.kinds.includes("ADDRESS"));
  r = await put({ about: "Near Calangute beach, 2 km from Baga", languages: ["English", "Konkani"] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  // split across two saves: "98765" saved, then "43210" in languages must be refused
  r = await put({ about: "reference 98765", languages: ["English"] });
  assert.equal(r.status, 200);
  r = await put({ about: "reference 98765", languages: ["English", "43210"] });
  assert.equal(r.status, 422, "half a number already stored + the other half now");
  r = await put({ about: "Near Calangute beach", languages: ["English"] });
  assert.equal(r.status, 200);
});

test("listing writes (host, admin): title + description + rules judged together, own address refused; a legit listing passes", async () => {
  const other = await h.makeListing(H, { address: { street: "House 9, Palm Lane", city: "Anjuna", state: "Goa" } });
  const update = (token, body, path) => h.api("PUT", path || `/properties/update-listing-property/${other._id}`, { token, body });
  let r = await update(HT, { title: "Palm villa 98765", description: "Call 43210 for the best rate" });
  assert.equal(r.status, 422);
  assert.ok(r.body.fields.includes("title") && r.body.fields.includes("description"), JSON.stringify(r.body.fields));
  r = await update(HT, { title: "Palm villa", description: "Book directly with me and save 12%" });
  assert.equal(r.status, 422);
  r = await update(HT, { description: "We are at House 9, Palm Lane, come straight in" });
  assert.equal(r.status, 422);
  assert.ok(r.body.kinds.includes("ADDRESS"));
  r = await update(HT, { description: "A quiet lane in Anjuna, 5 minutes from the beach; 2 bedrooms, pool, wifi" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  // split across saves (document order: title, description, rules)
  r = await update(HT, { title: "Palm villa 98765" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  r = await update(HT, { customRules: ["Call 43210 for parties"] });
  assert.equal(r.status, 422, "the stored title + the new rule complete a number");
  r = await update(HT, { title: "Palm villa" });
  assert.equal(r.status, 200);
  // admins are not exempt
  r = await update(AT, { title: "Palm villa", description: "whatsapp the caretaker" }, `/properties/admin-update-property/${other._id}`);
  assert.equal(r.status, 422, "admin edits obey the public-text policy");
  r = await update(AT, { title: "Palm villa", description: "A lovely villa" }, `/properties/admin-update-property/${other._id}`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  r = await h.api("POST", "/properties/create-listing-property/", { token: HT, body: { hostEmail: H.email, title: "New place", description: "insta rahul_villa" } });
  assert.equal(r.status, 422);
});

test("reviews: contact details or the listing's address are refused; the public review text is masked on read for legacy rows", async () => {
  const listing = await h.makeListing(H, { address: { street: "House 21, Sunset Road", city: "Vagator", state: "Goa" } });
  const booking = await paidBooking(listing, GT, 760);
  let r = await h.api("POST", "/review/", { token: GT, body: { bookingId: booking._id, rating: 5, content: "Great host, whatsapp him on 9876543210" } });
  assert.equal(r.status, 422);
  r = await h.api("POST", "/review/", { token: GT, body: { bookingId: booking._id, rating: 5, content: "It is House 21, Sunset Road, easy to find" } });
  assert.equal(r.status, 422);
  r = await h.api("POST", "/review/", { token: GT, body: { bookingId: booking._id, rating: 5, content: "Great host, lovely pool" } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  // a legacy review that slipped through before the lock-down is masked on read (contact + own address)
  await Review().create({ user: G._id, property: listing._id, bookingId: booking._id, rating: 4, content: "Legacy: call 9876543210, house 21 sunset road", hostId: H._id });
  const pub = await h.api("GET", `/review/${listing._id}?limit=10`);
  const texts = pub.body.data.map((x) => x.content).join(" | ");
  assert.doesNotMatch(texts, /9876543210|sunset road/i);
  assert.match(texts, /•••/);
  assert.equal(pub.body.data.every((x) => x.user.lastName === undefined && x.user.email === undefined), true);
  const hostReview = await h.api("POST", "/review/guest", { token: HT, body: { bookingId: booking._id, rating: 5, content: "Reach me at rahul (at) gmail (dot) com" } });
  assert.equal(hostReview.status, 422);
});

test("legacy public text is masked on read: profile about/languages/firstName and listing text split across fields", async () => {
  const legacyHost = await h.makeUser({ role: "host", firstName: "Rahul9876543210", about: "Reach me on rahul", languages: ["English", "at gmail dot com"] });
  const legacyListing = await h.makeListing(legacyHost, { title: "Beach villa 98765", description: "Call 43210 anytime", customRules: ["Quiet after 10 pm"], address: { street: "House 5, Coral Lane", city: "Morjim", state: "Goa" } });
  const pub = await h.api("GET", `/properties/${legacyListing._id}`);
  assert.equal(pub.status, 200);
  const s = JSON.stringify(pub.body);
  assert.doesNotMatch(s, /98765|43210|gmail|9876543210/);
  assert.equal(pub.body.data.host.firstName, "Rahul");
  assert.match(pub.body.data.title, /•••/);
  assert.match(pub.body.data.description, /•••/);
  assert.equal(pub.body.data.customRules[0], "Quiet after 10 pm");
  const host = await h.api("GET", `/hostData/${legacyHost._id}`, { token: GT });
  assert.doesNotMatch(JSON.stringify(host.body), /gmail|rahul\b.*at gmail/);
  assert.equal(host.body.data.firstName, "Rahul");
  // the host's own address in a legacy about is masked against all their listings
  await User().updateOne({ _id: legacyHost._id }, { $set: { about: "My villa is House 5, Coral Lane, Morjim", languages: [] } });
  const host2 = await h.api("GET", `/hostData/${legacyHost._id}`, { token: GT });
  assert.doesNotMatch(host2.body.data.about, /coral lane/i);
  assert.match(host2.body.data.about, /Morjim/);
});

// ---------------------------------------------------------------------------
// Backstop filter
// ---------------------------------------------------------------------------
test("response filter: user shapes, listing shapes, payment details, KYC-like shapes, cycles, depth, and fail-closed", async () => {
  const other = { _id: "aaaaaaaaaaaaaaaaaaaaaaaa", firstName: "Rahul", lastName: "Zyq", email: "z@x.test", phoneNumber: "9", otp: { value: "1" }, tokenVersion: 3, profilePicture: "p" };
  const self = { ...other, _id: "bbbbbbbbbbbbbbbbbbbbbbbb" };
  const body = {
    success: true,
    data: {
      userId: self,
      hostId: other,
      propertyId: { _id: "l1", title: "T", host: "aaaaaaaaaaaaaaaaaaaaaaaa", hostEmail: "h@x.test", validRegistrationNo: true, bankDetails: true, address: { street: "S", registrationNumber: "R", city: "C" } },
      payment: { orderId: "o", customerDetails: { name: "N", email: "e", contact: "c" } },
      kyc: { personalInfo: { fatherName: "F", dob: "1990", address: { line1: "x" } }, documentInfo: { panNumber: "ABCDE1234F" } },
      list: [other, { nested: [other] }],
    },
  };
  const out = sanitizeBody(JSON.parse(JSON.stringify(body)), { isAdmin: false, selfId: "bbbbbbbbbbbbbbbbbbbbbbbb" });
  assert.deepEqual(Object.keys(out.data.hostId).sort(), ["_id", "firstName", "profilePicture"]);
  assert.equal(out.data.userId.email, "z@x.test");
  assert.equal(out.data.userId.otp, undefined);
  assert.equal(out.data.userId.tokenVersion, undefined);
  assert.equal(out.data.propertyId.hostEmail, undefined);
  assert.equal(out.data.propertyId.address.registrationNumber, undefined);
  assert.equal(out.data.propertyId.address.street, "S", "the walker does not decide location policy (the controllers do)");
  assert.equal(out.data.payment.customerDetails, undefined);
  assert.equal(out.data.kyc.personalInfo.fatherName, "F", "a KYC form is not user-shaped");
  assert.equal(out.data.list[0].email, undefined);
  assert.equal(out.data.list[1].nested[0].email, undefined);
  // admin: untouched
  const adminOut = sanitizeBody(JSON.parse(JSON.stringify(body)), { isAdmin: true, selfId: null });
  assert.equal(adminOut.data.hostId.email, "z@x.test");
  // owner keeps owner-only listing fields
  const ownerOut = sanitizeBody(JSON.parse(JSON.stringify(body)), { isAdmin: false, selfId: "aaaaaaaaaaaaaaaaaaaaaaaa" });
  assert.equal(ownerOut.data.propertyId.hostEmail, "h@x.test");
  // cycles and depth fail closed (throw) — the middleware turns that into a 500 without the body
  const cyc = { a: {} };
  cyc.a.self = cyc;
  assert.throws(() => sanitizeBody(cyc, { isAdmin: false, selfId: null }), /cyclic/);
  const sharedHost = { _id: "h", firstName: "R", lastName: "Z", email: "e@x" };
  const shared = sanitizeBody({ data: [{ hostId: sharedHost }, { hostId: sharedHost }] }, { isAdmin: false, selfId: null });
  assert.equal(shared.data[1].hostId.email, undefined, "a shared reference is walked, not refused");
  let deep = {};
  const root = deep;
  for (let i = 0; i < 20; i++) deep = deep.n = {};
  assert.throws(() => sanitizeBody(root, { isAdmin: false, selfId: null }), /deep/);
  // performance: < 1 ms per 100 KB
  const big = { data: Array.from({ length: 400 }, (_, i) => ({ _id: `l${i}`, title: "T".repeat(100), photos: Array.from({ length: 6 }, (_, j) => `https://x/${i}/${j}.jpg`), host: { _id: `h${i}`, firstName: "R", lastName: "Z", email: "e@x", profilePicture: "p" }, address: { city: "C" } })) };
  const bytes = Buffer.byteLength(JSON.stringify(big));
  const t0 = process.hrtime.bigint();
  sanitizeBody(big, { isAdmin: false, selfId: null });
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.ok(ms < (bytes / 100000) * 1 + 2, `${ms} ms for ${bytes} bytes`);
});

test("the filter fails closed on the wire: a body the walk cannot sanitise yields a 500 with no canary bytes", async () => {
  const filter = require("../../middleware/piiResponseFilter");
  const express = require("express");
  const app = express();
  app.use(filter.piiResponseFilter);
  app.get("/leak", (req, res) => res.json({ user: { _id: "x", firstName: "R", email: CANARY.host.email } }));
  app.get("/cyclic", (req, res) => {
    const body = { wrapper: { user: { _id: "x", firstName: "R", email: CANARY.host.email } } };
    body.wrapper.self = body.wrapper; // JSON.stringify would throw on this too — the walker refuses first
    res.json(body);
  });
  app.get("/deep", (req, res) => {
    let node = { email: CANARY.host.email };
    const root = node;
    for (let i = 0; i < 20; i++) node = node.n = { email: CANARY.host.email };
    res.json(root);
  });
  const server = await new Promise((r) => {
    const s = app.listen(0, () => r(s));
  });
  const port = server.address().port;
  const get = (p) => fetch(`http://127.0.0.1:${port}${p}`).then(async (x) => ({ status: x.status, text: await x.text() }));
  const r1 = await get("/leak");
  assert.equal(r1.status, 200);
  assert.doesNotMatch(r1.text, new RegExp(CANARY.host.email));
  for (const p of ["/cyclic", "/deep"]) {
    const r = await get(p);
    assert.equal(r.status, 500, p);
    assert.doesNotMatch(r.text, new RegExp(CANARY.host.email));
    assert.match(r.text, /RESPONSE_FILTER_ERROR/);
  }
  server.close();
});

test("every User schema path is classified as public, self-only or secret", () => {
  const paths = Object.keys(User().schema.paths).map((p) => p.split(".")[0]);
  const known = new Set([...SELF_USER_FIELDS, ...SECRET_USER_FIELDS, ...PUBLIC_USER_FIELDS, "id"]);
  const unclassified = [...new Set(paths)].filter((p) => !known.has(p));
  assert.deepEqual(unclassified, [], `classify these in utils/sanitizeResponse.js: ${unclassified.join(", ")}`);
});

// ---------------------------------------------------------------------------
// Images
// ---------------------------------------------------------------------------
test("uploads: metadata (incl. GPS) is stripped, orientation baked, formats kept, QR refused, non-images refused", async () => {
  const sharp = require("sharp");
  const { hasMetadata, sanitizeImage } = require("../../services/imageSanitizer");
  const withGps = await sharp({ create: { width: 64, height: 48, channels: 3, background: { r: 200, g: 100, b: 50 } } })
    .jpeg()
    .withMetadata({ orientation: 6, exif: { IFD0: { Make: "Canary Cam" }, GPS: { GPSLatitudeRef: "N", GPSLatitude: "15/1 32/1 40/1", GPSLongitudeRef: "E", GPSLongitude: "73/1 45/1 46/1" } } })
    .toBuffer();
  assert.equal(await hasMetadata(withGps), true, "fixture carries EXIF");
  const clean = await sanitizeImage(withGps, "image/jpeg");
  assert.equal(await hasMetadata(clean.buffer), false);
  assert.equal(clean.mimetype, "image/jpeg");
  assert.deepEqual([clean.width, clean.height], [48, 64], "EXIF orientation 6 is baked into the pixels");
  const png = await sharp({ create: { width: 20, height: 20, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toBuffer();
  const cleanPng = await sanitizeImage(png, "image/png");
  assert.equal(cleanPng.mimetype, "image/png");
  assert.equal((await sharp(cleanPng.buffer).metadata()).hasAlpha, true, "PNG transparency preserved");
  const webp = await sharp({ create: { width: 30, height: 10, channels: 3, background: "#123456" } }).webp().toBuffer();
  assert.equal((await sanitizeImage(webp, "image/webp")).mimetype, "image/webp");
  await assert.rejects(() => sanitizeImage(Buffer.from("%PDF-1.4 not an image"), "image/png"), (e) => e.code === "INVALID_IMAGE");
  // a QR code (rendered as a raster) is refused
  const qrPng = await qrFixture();
  await assert.rejects(() => sanitizeImage(qrPng, "image/png"), (e) => e.code === "IMAGE_NOT_ALLOWED");

  // on the wire: the stored object has no metadata and the public URL is served
  const form = new FormData();
  form.append("images", new Blob([withGps], { type: "image/jpeg" }), "villa.jpg");
  const res = await fetch(`${h.baseUrl()}/uploads/`, { method: "POST", headers: { authorization: `Bearer ${HT}` }, body: form });
  assert.equal(res.status, 200);
  const stored = require("../../services/storage").__mock.uploaded.at(-1);
  assert.ok(stored.key.endsWith("villa.jpg"));
  assert.equal(stored.contentType, "image/jpeg");
  const qrForm = new FormData();
  qrForm.append("file", new Blob([qrPng], { type: "image/png" }), "me.png");
  const qrRes = await fetch(`${h.baseUrl()}/uploads/profile?userId=${H._id}`, { method: "POST", headers: { authorization: `Bearer ${HT}` }, body: qrForm });
  assert.equal(qrRes.status, 422);
  assert.match(await qrRes.text(), /IMAGE_NOT_ALLOWED/);
});

async function qrFixture() {
  // A real QR code (a phone number in disguise), rendered as a PNG.
  const QRCode = require("qrcode");
  return QRCode.toBuffer("WhatsApp 9876543210", { type: "png", width: 320, margin: 4 });
}

function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

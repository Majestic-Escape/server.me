// Boots the real backend on an isolated in-memory MongoDB with seeded data,
// for end-to-end runs of the frontend against Batch S. Test-only.
//
//   node tests/batch-s/e2e-server.js     (backend :5005, helper :5056)
//
// Helper endpoints (port 5056, CORS *):
//   GET  /seed                       → ids/tokens of the seeded fixtures
//   POST /register-payment {orderId} → registers a captured mock payment for
//                                      that order and returns the signed
//                                      (payment id, signature) the checkout
//                                      handler expects from Razorpay
//   POST /set-price {listingId, basePrice}
//   POST /gate {enabled}            → booking-write maintenance gate on/off
//   POST /expire-holds {bookingId}  → ages that booking's hold past expiry
//   POST /book-as-other {checkIn, checkOut} → another guest takes the nights
const http = require("http");
const crypto = require("crypto");
const h = require("./setup");

const PHOTO = "https://majestic-escape-host-properties.blr1.cdn.digitaloceanspaces.com/1769315746961-gettyimages-1516933385-612x612.jpg";

async function main() {
  process.env.E2E_PORT = "5005";
  await h.start();
  // Canary values (contact lock-down): the counterpart's last name, email and
  // phone are searched for by VALUE in browser-side responses, DOM and storage.
  const HOST = await h.makeUser({ role: "host", firstName: "Hosty", lastName: "Zyqvoxhost", email: "host@test.local", phoneNumber: "9812345602", about: "Hosting since 2019, love the sea" });
  const GUEST = await h.makeUser({ firstName: "Test", lastName: "Zyqvoxguest", email: "guest@test.local", phoneNumber: "9812345601" });
  const listing = await h.makeListing(HOST, {
    title: "E2E Villa",
    description: "Seeded listing for the Batch S end-to-end run",
    photos: [PHOTO],
    address: { street: "House No 72, Holiday Street", city: "Panaji", state: "Goa", country: "India", district: "North Goa", pincode: "403001", latitude: 15.4909, longitude: 73.8278 },
    propertyType: "villa",
    placeType: "entire",
    amenities: [],
    selectedRules: [],
    customRules: [],
    location: { lat: 15.49, long: 73.82 },
  });
  const ADMIN = await h.makeAdmin({ firstName: "Ops", email: "ops@test.local" });
  const GUEST_B = await h.makeUser({ firstName: "Second", lastName: "Guest", email: "guestb@test.local", phoneNumber: "9999999998", isVerified: true, isActive: true, verification: { emailVerified: true, phoneVerified: true }, status: { active: true, banned: false } });
  const HOST_B = await h.makeUser({ role: "host", firstName: "Hostb", email: "hostb@test.local" });
  // A realistic catalogue: 32 more listings across cities/types/prices (some
  // manual, some at the ₹7,500 GST threshold, one without a price, one
  // delisted), plus a manual listing of the main host for request-to-book.
  const cities = [["Panaji", "North Goa", "Goa"], ["Lonavala", "Pune", "Maharashtra"], ["Manali", "Kullu", "Himachal Pradesh"], ["Alibaug", "Raigad", "Maharashtra"], ["Munnar", "Idukki", "Kerala"], ["Coorg", "Kodagu", "Karnataka"], ["Jaipur", "Jaipur", "Rajasthan"], ["Udaipur", "Udaipur", "Rajasthan"]];
  const types = ["villa", "farmhouse", "cottage", "apartment"];
  const prices = [1500, 4200, 7500, 7501, 9000, 12000, 25000, 3333.33];
  const catalogue = [];
  for (let i = 0; i < 32; i++) {
    const [city, district, state] = cities[i % cities.length];
    catalogue.push(await h.makeListing(i % 5 === 0 ? HOST_B : HOST, {
      title: `${types[i % types.length][0].toUpperCase()}${types[i % types.length].slice(1)} ${city} ${i + 1}`,
      description: `Seeded listing ${i + 1} for the final verification run`,
      photos: [PHOTO, PHOTO],
      address: { city, state, country: "India", district },
      propertyType: types[i % types.length],
      placeType: "entire",
      basePrice: i === 31 ? undefined : prices[i % prices.length],
      guests: 2 + (i % 5),
      bookingType: { manual: i % 4 === 3 },
      cancellationType: i % 3 === 0 ? { moderate: true } : { flexible: true },
      status: i === 30 ? "inactive" : "active",
      amenities: [], selectedRules: [], customRules: [],
      location: { lat: 15.49 + i * 0.01, long: 73.82 },
    }));
  }
  const manual = await h.makeListing(HOST, {
    title: "Request Villa", description: "Request-to-book listing", photos: [PHOTO], address: { city: "Panaji", state: "Goa", country: "India", district: "North Goa" },
    propertyType: "villa", placeType: "entire", basePrice: 6000, guests: 4, bookingType: { manual: true }, cancellationType: { moderate: true }, amenities: [], selectedRules: [], customRules: [], location: { lat: 15.5, long: 73.8 },
  });
  // Prior bookings so the guest/host/admin lists are not empty: one paid+confirmed
  // (instant), one paid+pending (manual, awaiting the host), one cancelled/refunded,
  // and a host block on the main listing.
  const Booking = require("../../models/Booking");
  const Payment = require("../../models/Payment");
  const inventory = require("../../services/inventory");
  const mongoose = require("mongoose");
  async function seedBooking(L, user, dayFrom, nights, { status, paymentStatus, action = "user" }) {
    const checkIn = new Date(`${h.day(dayFrom)}T00:00:00.000Z`);
    const checkOut = new Date(`${h.day(dayFrom + nights)}T00:00:00.000Z`);
    const quote = require("../../services/pricing").quoteStay({ basePrice: L.basePrice, nights });
    const _id = new mongoose.Types.ObjectId();
    if (!["cancelled", "rejected"].includes(status)) {
      await inventory.reserveNights({ propertyId: L._id, nights: inventory.nightsBetween(checkIn, checkOut), bookingId: _id, kind: action === "host" ? "block" : "booking" });
      await inventory.finalizeNights({ bookingId: _id, nights: inventory.nightsBetween(checkIn, checkOut) });
    }
    const b = await Booking.create({ _id, userId: user._id, hostId: L.host, propertyId: L._id, action, source: "local", checkIn, checkOut, nights, guests: 2, adults: 2, children: 0, infants: 0, guestData: { adults: [{ name: `${user.firstName} Traveller`, age: 30 }], children: [] }, price: quote.total, subTotal: quote.subTotal, currency: "INR", cancellationPolicy: "flexible", status, paymentStatus, quote: { basePrice: quote.basePrice, nights, subTotalPaise: quote.subTotalPaise, serviceFeePaise: quote.serviceFeePaise, gstPaise: quote.gstPaise, totalPaise: quote.totalPaise, currency: "INR" }, holdExpiresAt: null, notifications: { paidAt: new Date(), confirmedAt: status === "confirmed" ? new Date() : null } });
    if (paymentStatus === "paid" || paymentStatus === "refunded") {
      const order = await h.razorpay().orders.create({ amount: quote.totalPaise, currency: "INR", receipt: `bk_${_id}` });
      const pay = h.razorpay().__registerPayment({ id: `pay_seed_${_id}`, order_id: order.id, amount: order.amount, currency: "INR", status: "captured", method: "upi" });
      const p = await Payment.create({ orderId: order.id, paymentId: pay.id, amount: quote.totalPaise, currency: "INR", bookingId: _id, propertyId: L._id, status: paymentStatus === "refunded" ? "refunded" : "paid", paymentType: paymentStatus === "refunded" ? "refunded" : "pay-in", paidAt: new Date(), customerDetails: { name: user.firstName, email: user.email, contact: user.phoneNumber } });
      await Booking.updateOne({ _id }, { $set: { payment: p._id } });
    }
    return b;
  }
  const priorConfirmed = await seedBooking(listing, GUEST, 20, 2, { status: "confirmed", paymentStatus: "paid" });
  const priorManual = await seedBooking(manual, GUEST, 26, 3, { status: "pending", paymentStatus: "paid" });
  const priorCancelled = await seedBooking(listing, GUEST, -30, 2, { status: "cancelled", paymentStatus: "refunded" });
  const priorBlock = await seedBooking(listing, HOST, 40, 1, { status: "confirmed", paymentStatus: "paid", action: "host" });
  const priorGuestB = await seedBooking(catalogue[1], GUEST_B, 50, 2, { status: "confirmed", paymentStatus: "paid" });
  // --- Batch A2 admin-tools fixtures --------------------------------------
  // A pure guest (no listing), a role:"admin" user (must be hidden from the
  // Users page), pending listings to delete (one with a review → blocked, one
  // sharing a photo with an active listing → object kept), and KYC uploads
  // for the main host (jpeg / png data-URI / pdf / html-looking, the latest
  // one awaiting manual review) plus a host with 21 uploads.
  const PENDING_PHOTO = (n) => `https://${process.env.DO_SPACES_BUCKET}.${process.env.REGION}.digitaloceanspaces.com/listings/${HOST._id}/00000000-0000-4000-8000-${String(n).padStart(12, "0")}-photo.jpg`;
  const PURE_GUEST = await h.makeUser({ firstName: "Pure", lastName: "Guest", email: "pure@test.local", phoneNumber: "9999999990" });
  const ROLE_ADMIN = await h.makeUser({ firstName: "Role", lastName: "Admin", email: "roleadmin@test.local", phoneNumber: "9999999991", role: "admin" });
  const pendingA = await h.makeListing(HOST, { title: "QA Pending Villa A", status: "processing", photos: [PENDING_PHOTO(1), PENDING_PHOTO(2), "https://images.pexels.com/photos/1.jpg"], address: { city: "Panaji", state: "Goa", country: "India", district: "North Goa" }, propertyType: "villa", placeType: "entire", basePrice: 5000, guests: 4 });
  const pendingB = await h.makeListing(HOST_B, { title: "QA Pending Cottage B", status: "processing", photos: [PENDING_PHOTO(3)], address: { city: "Manali", state: "Himachal Pradesh", country: "India", district: "Kullu" }, propertyType: "cottage", placeType: "entire", basePrice: 3000, guests: 2 });
  const pendingC = await h.makeListing(HOST, { title: "QA Pending Farmhouse C", status: "processing", photos: [PENDING_PHOTO(4)], address: { city: "Lonavala", state: "Maharashtra", country: "India", district: "Pune" }, propertyType: "farmhouse", placeType: "entire", basePrice: 8000, guests: 6 });
  const pendingShared = await h.makeListing(HOST, { title: "QA Pending Shared Photo", status: "processing", photos: [PHOTO], address: { city: "Panaji", state: "Goa", country: "India", district: "North Goa" }, propertyType: "villa", placeType: "entire", basePrice: 5000, guests: 4 });
  const pendingReviewed = await h.makeListing(HOST, { title: "QA Pending With Review", status: "processing", photos: [PENDING_PHOTO(5)], address: { city: "Panaji", state: "Goa", country: "India", district: "North Goa" }, propertyType: "villa", placeType: "entire", basePrice: 5000, guests: 4 });
  await require("../../models/Review").create({ bookingId: new mongoose.Types.ObjectId(), hostId: HOST._id, property: pendingReviewed._id, user: GUEST._id, rating: 5, content: "seeded review" });
  const qaActive = await h.makeListing(HOST, { title: "QA Active Villa", status: "active", photos: [PHOTO], address: { city: "Panaji", state: "Goa", country: "India", district: "North Goa" }, propertyType: "villa", placeType: "entire", basePrice: 5000, guests: 4 });
  // The main host's KYC and bank flags are set so the admin Approve dialog offers Confirm.
  await require("../../models/User").updateOne({ _id: HOST._id }, { $set: { kyc: true, bank: true } });
  const KycLogs = require("../../models/KycLogs");
  const KycHostData = require("../../models/KycHostForm");
  const JPEG = Buffer.from("/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/yQALCAABAAEBAREA/8wABgAQEAX/2gAIAQEAAD8A0s8g/9k=", "base64");
  const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c636000010000050001a5f645400000000049454e44ae426082", "hex");
  const PDF = Buffer.from("%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 100]>>endobj\nxref\n0 4\n0000000000 65535 f \n0000000009 00000 n \n0000000052 00000 n \n0000000101 00000 n \ntrailer<</Size 4/Root 1 0 R>>\nstartxref\n168\n%%EOF\n");
  const HTMLISH = Buffer.from("<html><script>alert(1)</script></html>");
  async function seedOcr(user, buf, { doc, dataUri = false, minutesAgo = 0, status = "success", name = "HOSTY PERSON", number = "ABCDE1234F" }) {
    const image = dataUri ? `data:image/png;base64,${buf.toString("base64")}` : buf.toString("base64");
    const details = doc === "pan" ? { name: { value: name }, pan_no: { value: number } } : doc === "voterId" ? { name: { value: name }, voterid: { value: number } } : { name: { value: name }, passport_num: { value: number } };
    return KycLogs.create({ userId: user._id, email: user.email, type: "OCR", status, requestData: { imageUrl: image, clientRefId: "seed", doc }, responseData: { status: "success", result: [{ type: doc, details }] }, createdAt: new Date(Date.now() - minutesAgo * 60000) });
  }
  const docJpeg = await seedOcr(HOST, JPEG, { doc: "pan", minutesAgo: 60 });
  const docPng = await seedOcr(HOST, PNG, { doc: "voterId", dataUri: true, minutesAgo: 45, number: "XYZ9876543" });
  const docPdf = await seedOcr(HOST, PDF, { doc: "passport", minutesAgo: 30, number: "N1234567" });
  const docHtml = await seedOcr(HOST, HTMLISH, { doc: "pan", minutesAgo: 20, status: "failed" });
  const docReview = await seedOcr(HOST, JPEG, { doc: "pan", minutesAgo: 5, name: "SOMEBODY ELSE" });
  await KycHostData.create({ hostId: HOST._id, hostEmail: HOST.email, status: "pending", personalInfo: { fatherName: "Father", dob: "1990-01-01", address: { line1: "1 St", city: "Panaji", state: "Goa", pincode: "403001", country: "India" } }, acceptedTerms: { general: true }, documentInfo: { documentType: "pan", isVerified: false, reviewStatus: "needs_review", reviewReason: "NAME_MISMATCH", verifiedLogId: docReview._id, fingerprint: "seed" }, gstInfo: { isVerified: true, gstNumber: "******F1Z5", panNumber: "******234F" } });
  const MANY_HOST = await h.makeUser({ role: "host", firstName: "Many", lastName: "Uploads", email: "many@test.local", phoneNumber: "9999999992" });
  for (let i = 0; i < 21; i++) await seedOcr(MANY_HOST, JPEG, { doc: "pan", minutesAgo: 1000 + i });
  const seed = {
    adminTools: {
      pureGuestId: String(PURE_GUEST._id),
      roleAdminId: String(ROLE_ADMIN._id),
      pending: { a: String(pendingA._id), b: String(pendingB._id), c: String(pendingC._id), shared: String(pendingShared._id), reviewed: String(pendingReviewed._id) },
      qaActiveId: String(qaActive._id),
      docs: { jpeg: String(docJpeg._id), png: String(docPng._id), pdf: String(docPdf._id), html: String(docHtml._id), review: String(docReview._id) },
      manyHostId: String(MANY_HOST._id),
    },
    guestBToken: h.userToken(GUEST_B),
    guestBId: String(GUEST_B._id),
    guestBUser: { _id: String(GUEST_B._id), firstName: GUEST_B.firstName, lastName: GUEST_B.lastName, email: GUEST_B.email, role: "user" },
    hostBToken: h.userToken(HOST_B),
    hostBId: String(HOST_B._id),
    manualListingId: String(manual._id),
    catalogue: catalogue.map((l) => ({ id: String(l._id), title: l.title, basePrice: l.basePrice, status: l.status, manual: !!l.bookingType.manual, city: l.address.city })),
    priorBookings: { confirmed: String(priorConfirmed._id), manualPending: String(priorManual._id), cancelled: String(priorCancelled._id), block: String(priorBlock._id), guestB: String(priorGuestB._id) },
    adminToken: h.adminToken(ADMIN),
    adminId: String(ADMIN._id),
    adminUser: { _id: String(ADMIN._id), firstName: ADMIN.firstName, lastName: ADMIN.lastName, email: ADMIN.email },
    guestToken: h.userToken(GUEST),
    guestId: String(GUEST._id),
    guestUser: { _id: String(GUEST._id), firstName: GUEST.firstName, lastName: GUEST.lastName, email: GUEST.email, role: "user" },
    hostToken: h.userToken(HOST),
    hostId: String(HOST._id),
    hostUser: { _id: String(HOST._id), firstName: HOST.firstName, lastName: HOST.lastName, email: HOST.email, role: "host" },
    listingId: String(listing._id),
  };
  const ListingProperty = require("../../models/ListingProperty");
  let seq = 0;
  http
    .createServer(async (req, res) => {
      res.setHeader("access-control-allow-origin", "*");
      res.setHeader("access-control-allow-headers", "content-type");
      if (req.method === "OPTIONS") return res.end();
      let body = "";
      for await (const c of req) body += c;
      const json = body ? JSON.parse(body) : {};
      // tokens are re-minted per request so long-running browser sessions never hit the 1 h expiry
      if (req.url === "/seed") return res.end(JSON.stringify({ ...seed, guestToken: h.userToken(GUEST), hostToken: h.userToken(HOST), guestBToken: h.userToken(GUEST_B), hostBToken: h.userToken(HOST_B), adminToken: h.adminToken(ADMIN) }));
      // GET /mock-object?key=<bucket key> → the bytes an upload stored in the
      // in-memory Spaces fake (headers as the real bucket sends them), 404 when
      // absent — a browser suite routes *.digitaloceanspaces.com here so photos
      // uploaded through the wizard render like they do from the real CDN.
      if (req.url.startsWith("/mock-object?")) {
        const key = decodeURIComponent(new URL(req.url, "http://x").searchParams.get("key") || "");
        const o = require("../../services/storage").__mock.objects.get(key);
        if (!o) { res.statusCode = 404; return res.end("not found"); }
        res.setHeader("content-type", o.contentType || "application/octet-stream");
        if (o.cacheControl) res.setHeader("cache-control", o.cacheControl);
        return res.end(o.body);
      }
      if (req.url === "/register-payment") {
        const order = h.razorpay().__mock.orders.get(json.orderId);
        if (!order) { res.statusCode = 404; return res.end(JSON.stringify({ error: "unknown order" })); }
        const id = `pay_e2e${++seq}`;
        h.razorpay().__registerPayment({ id, order_id: order.id, amount: order.amount, currency: "INR", status: "captured", method: "upi" });
        const signature = crypto.createHmac("sha256", process.env.RAZORPAY_KEY_SECRET).update(`${order.id}|${id}`).digest("hex");
        return res.end(JSON.stringify({ razorpay_payment_id: id, razorpay_order_id: order.id, razorpay_signature: signature, amount: order.amount }));
      }
      // /seed-admin-lists?n=30 — extra guests / listings / bookings / payments /
      // reviews so the admin tables cross page boundaries (idempotent: rows are
      // tagged "QA List"; a second call adds nothing).
      if (req.url.startsWith("/seed-admin-lists")) {
        const n = Math.min(Math.max(parseInt(new URL(req.url, "http://x").searchParams.get("n") || "30", 10) || 30, 1), 200);
        const User = require("../../models/User");
        const Review = require("../../models/Review");
        const existing = await ListingProperty.countDocuments({ title: /^QA List Villa/ });
        if (!existing) {
          for (let i = 0; i < n; i++) {
            const tag = String(i).padStart(2, "0");
            const g = await h.makeUser({ firstName: `Lister${tag}`, lastName: "Guest", email: `lister${tag}@test.local`, phoneNumber: `98${String(10000000 + i)}`, createdAt: new Date(Date.UTC(2026, 0, 1 + (i % 28))) });
            const l = await h.makeListing(i % 4 === 0 ? HOST_B : HOST, { title: `QA List Villa ${tag}`, basePrice: 1500 + i * 50, guests: 2 + (i % 6), status: i % 5 === 0 ? "processing" : "active", address: { city: ["Panaji", "Manali", "Lonavala", "Alibaug"][i % 4], state: "Goa", country: "India", district: "North Goa" } });
            const b = await Booking.create({ userId: g._id, hostId: l.host, propertyId: l._id, action: "user", source: "local", checkIn: new Date(Date.UTC(2027, 2, 1 + (i % 27))), checkOut: new Date(Date.UTC(2027, 2, 3 + (i % 27))), nights: 2, guests: 2, adults: 2, children: 0, infants: 0, price: 6000 + i * 25, subTotal: 5500 + i * 25, status: i % 3 === 0 ? "pending" : "confirmed", paymentStatus: i % 3 === 0 ? "unpaid" : "paid", reviewed: i % 2 === 0 });
            await Payment.create({ orderId: `order_list_${tag}`, paymentId: `pay_list_${tag}`, amount: (6000 + i * 25) * 100, currency: "INR", bookingId: b._id, propertyId: l._id, status: i % 3 === 0 ? "created" : "paid", paymentType: i % 7 === 0 ? "refunded" : "pay-in", customerDetails: { name: `Lister${tag} Guest`, email: `lister${tag}@test.local`, contact: `98${String(10000000 + i)}` }, createdAt: new Date(Date.UTC(2026, 4, 1 + (i % 28))) });
            await Review.create({ user: g._id, property: l._id, bookingId: b._id, hostId: l.host, rating: 1 + (i % 5), content: `QA List review ${tag} — a pleasant stay`, hideStatus: i % 6 === 0 ? "pending" : "accept", createdAt: new Date(Date.UTC(2026, 5, 1 + (i % 28))) });
          }
        }
        // 12 recent bookings (check-ins over the last 6 days) so the Analytics
        // page's default range has more than one page of rows
        const recent = await Booking.countDocuments({ sourceId: "qa-recent" });
        if (!recent) {
          const listings = await ListingProperty.find({ title: /^QA List Villa/ }).select("_id host").limit(12).lean();
          for (let i = 0; i < 12 && i < listings.length; i++) {
            const day = new Date(); day.setUTCHours(0, 0, 0, 0); day.setUTCDate(day.getUTCDate() - (i % 6)); // two per day inside the page's default 7-day range
            const out = new Date(day); out.setUTCDate(out.getUTCDate() + 2);
            await Booking.create({ userId: GUEST._id, hostId: listings[i].host, propertyId: listings[i]._id, action: "user", source: "local", checkIn: day, checkOut: out, nights: 2, guests: 2, adults: 2, children: 0, infants: 0, price: 4000 + i * 10, subTotal: 3600 + i * 10, status: "confirmed", paymentStatus: "paid", sourceId: "qa-recent" });
          }
        }
        return res.end(JSON.stringify({ ok: true, added: existing ? 0 : n }));
      }
      // POST /make-listing { status, title, owner: "host"|"hostB", address?, fields? } → a fresh listing for the browser suites (drafts / pending / wizard)
      if (req.url === "/make-listing") {
        const owner = json.owner === "hostB" ? HOST_B : HOST;
        const l = await h.makeListing(owner, { title: json.title ?? "", status: json.status || "incomplete", photos: json.photos || [PHOTO], address: json.address || { city: "Panaji", state: "Goa", country: "India", district: "North Goa" }, ...(json.fields || {}) });
        return res.end(JSON.stringify({ id: String(l._id), status: l.status, title: l.title }));
      }
      // POST /set-profile-picture { url } → the seeded host's profile picture ("" clears it)
      if (req.url === "/set-profile-picture") {
        const User = require("../../models/User");
        await User.updateOne({ _id: HOST._id }, json.url ? { $set: { profilePicture: json.url } } : { $unset: { profilePicture: 1 } });
        return res.end(JSON.stringify({ ok: true }));
      }
      // POST /set-kyc { status: "completed" | "pending" } → the seeded host's KYC form
      // (the verified summary page vs the wizard); "completed" mirrors what the
      // verification endpoints write, "pending" restores the seed.
      if (req.url === "/set-kyc") {
        const KycHostData = require("../../models/KycHostForm");
        const completed = json.status === "completed";
        const form = await KycHostData.findOneAndUpdate(
          { hostId: HOST._id },
          completed
            ? { $set: { status: "completed", "documentInfo.isVerified": true, "documentInfo.reviewStatus": "verified", "documentInfo.reviewReason": "", "documentInfo.verifiedAt": new Date("2026-09-01T10:00:00Z") } }
            : { $set: { status: "pending", "documentInfo.isVerified": false, "documentInfo.reviewStatus": "needs_review", "documentInfo.reviewReason": "NAME_MISMATCH", "documentInfo.verifiedAt": null } },
          { new: true },
        ).lean();
        return res.end(JSON.stringify({ id: String(form._id), status: form.status }));
      }
      if (req.url === "/set-price") {
        await ListingProperty.updateOne({ _id: json.listingId }, { $set: { basePrice: json.basePrice } });
        return res.end(JSON.stringify({ ok: true }));
      }
      if (req.url === "/gate") {
        const OpsFlag = require("../../models/OpsFlag");
        const { FLAG_ID } = require("../../services/maintenance");
        await OpsFlag.updateOne({ _id: FLAG_ID }, { $set: { enabled: !!json.enabled, updatedAt: new Date() } }, { upsert: true });
        return res.end(JSON.stringify({ ok: true, enabled: !!json.enabled }));
      }
      if (req.url === "/expire-holds") {
        const BookingNight = require("../../models/BookingNight");
        const r = await BookingNight.updateMany({ bookingId: json.bookingId, expiresAt: { $ne: null } }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
        return res.end(JSON.stringify({ ok: true, modified: r.modifiedCount }));
      }
      if (req.url === "/book-as-other") {
        // another guest takes the nights server-side (simulates a concurrent customer)
        const Booking = require("../../models/Booking");
        const inventory = require("../../services/inventory");
        const OTHER = await h.makeUser({ firstName: "Other", email: `other${Date.now()}@test.local` });
        const nights = inventory.nightsBetween(json.checkIn, json.checkOut);
        const bookingId = new (require("mongoose").Types.ObjectId)();
        const r = await inventory.reserveNights({ propertyId: seed.listingId, nights, bookingId });
        if (r.ok) await Booking.create({ _id: bookingId, userId: OTHER._id, hostId: seed.hostId, propertyId: seed.listingId, action: "user", source: "local", checkIn: new Date(json.checkIn), checkOut: new Date(json.checkOut), nights: nights.length, guests: 1, adults: 1, price: 1, subTotal: 1, status: "pending", paymentStatus: "unpaid", holdExpiresAt: inventory.holdExpiry() });
        return res.end(JSON.stringify({ ok: r.ok, bookingId: String(bookingId) }));
      }
      if (req.url.startsWith("/otp?")) {
        // The login OTP is saved on the user before the (unavailable) mail
        // provider is called; the browser test reads it here.
        const User = require("../../models/User");
        const email = decodeURIComponent(req.url.split("email=")[1] || "");
        const u = await User.findOne({ email }).select("otp").lean();
        return res.end(JSON.stringify({ otp: u && u.otp && u.otp.value }));
      }
      if (req.url === "/spaces") {
        // Control/inspect the Spaces fake: { failMode: "all"|"partial"|null }
        const storage = require("../../services/storage");
        if (json.failMode !== undefined) storage.setMockFailure(json.failMode);
        if (json.reset) storage.resetMock();
        return res.end(JSON.stringify({ deleted: storage.__mock.deleted, calls: storage.__mock.calls, failMode: storage.__mock.failMode }));
      }
      if (req.url === "/audit") {
        const AdminAuditLog = require("../../models/AdminAuditLog");
        return res.end(JSON.stringify(await AdminAuditLog.find({}).sort({ createdAt: -1 }).limit(50).lean()));
      }
      if (req.url === "/rename-server-side") {
        // Another admin renames the user behind the page's back (stale-page test)
        const User = require("../../models/User");
        await User.updateOne({ _id: json.userId }, { $set: { firstName: json.firstName, lastName: json.lastName } });
        return res.end(JSON.stringify({ ok: true }));
      }
      if (req.url === "/calendars") {
        const ExternalCalendar = require("../../models/ExternalCalendar");
        return res.end(JSON.stringify(await ExternalCalendar.find({ propertyId: seed.listingId }).lean()));
      }
      if (req.url === "/state") {
        const Booking = require("../../models/Booking");
        const Payment = require("../../models/Payment");
        const BookingNight = require("../../models/BookingNight");
        return res.end(JSON.stringify({
          bookings: await Booking.find({ propertyId: seed.listingId }).lean(),
          payments: await Payment.find({ propertyId: seed.listingId }).lean(),
          nights: await BookingNight.find({ propertyId: seed.listingId }).lean(),
          gatewayCalls: h.razorpay().__mock.calls,
          emails: h.sentEmails(),
        }));
      }
      res.statusCode = 404;
      res.end("{}");
    })
    .listen(5056, () => console.log("[e2e] helper on 5056; backend on 5005; listing", seed.listingId));
}
main().catch((err) => {
  console.error(err);
  process.exit(1);
});

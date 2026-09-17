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
  const HOST = await h.makeUser({ role: "host", firstName: "Hosty", email: "host@test.local" });
  const GUEST = await h.makeUser({ firstName: "Test", lastName: "User", email: "guest@test.local", phoneNumber: "9999999999" });
  const listing = await h.makeListing(HOST, {
    title: "E2E Villa",
    description: "Seeded listing for the Batch S end-to-end run",
    photos: [PHOTO],
    address: { city: "Panaji", state: "Goa", country: "India", district: "North Goa" },
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
    const b = await Booking.create({ _id, userId: user._id, hostId: L.host, propertyId: L._id, action, source: "local", checkIn, checkOut, nights, guests: 2, adults: 2, children: 0, infants: 0, guestData: { adults: [{ name: `${user.firstName} ${user.lastName}`, age: 30 }], children: [] }, price: quote.total, subTotal: quote.subTotal, currency: "INR", cancellationPolicy: "flexible", status, paymentStatus, quote: { basePrice: quote.basePrice, nights, subTotalPaise: quote.subTotalPaise, serviceFeePaise: quote.serviceFeePaise, gstPaise: quote.gstPaise, totalPaise: quote.totalPaise, currency: "INR" }, holdExpiresAt: null, notifications: { paidAt: new Date(), confirmedAt: status === "confirmed" ? new Date() : null } });
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
  const seed = {
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
      if (req.url === "/seed") return res.end(JSON.stringify(seed));
      if (req.url === "/register-payment") {
        const order = h.razorpay().__mock.orders.get(json.orderId);
        if (!order) { res.statusCode = 404; return res.end(JSON.stringify({ error: "unknown order" })); }
        const id = `pay_e2e${++seq}`;
        h.razorpay().__registerPayment({ id, order_id: order.id, amount: order.amount, currency: "INR", status: "captured", method: "upi" });
        const signature = crypto.createHmac("sha256", process.env.RAZORPAY_KEY_SECRET).update(`${order.id}|${id}`).digest("hex");
        return res.end(JSON.stringify({ razorpay_payment_id: id, razorpay_order_id: order.id, razorpay_signature: signature, amount: order.amount }));
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

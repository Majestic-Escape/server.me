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
const http = require("http");
const crypto = require("crypto");
const h = require("./setup");

async function main() {
  process.env.E2E_PORT = "5005";
  await h.start();
  const HOST = await h.makeUser({ role: "host", firstName: "Hosty", email: "host@test.local" });
  const GUEST = await h.makeUser({ firstName: "Test", lastName: "User", email: "guest@test.local", phoneNumber: "9999999999" });
  const listing = await h.makeListing(HOST, {
    title: "E2E Villa",
    description: "Seeded listing for the Batch S end-to-end run",
    photos: ["https://majestic-escape-host-properties.blr1.cdn.digitaloceanspaces.com/1769315746961-gettyimages-1516933385-612x612.jpg"],
    address: { city: "Panaji", state: "Goa", country: "India", district: "North Goa" },
    propertyType: "villa",
    placeType: "entire",
    amenities: [],
    selectedRules: [],
    customRules: [],
    location: { lat: 15.49, long: 73.82 },
  });
  const seed = {
    guestToken: h.userToken(GUEST),
    guestId: String(GUEST._id),
    guestUser: { _id: String(GUEST._id), firstName: GUEST.firstName, lastName: GUEST.lastName, email: GUEST.email, role: "user" },
    hostToken: h.userToken(HOST),
    hostId: String(HOST._id),
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

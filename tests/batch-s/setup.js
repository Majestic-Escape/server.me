// In-process test harness: an isolated MongoDB (mongodb-memory-server), the
// real Express app from index.js, the mock Razorpay gateway and recorded
// emails. Nothing here touches any real database or gateway.
const { MongoMemoryServer } = require("mongodb-memory-server");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");

let mongod;
let started;

async function start() {
  if (started) return started;
  mongod = await MongoMemoryServer.create();
  const uri = mongod.getUri("batch_s_test");
  Object.assign(process.env, {
    DB_URI: uri,
    PORT: process.env.E2E_PORT || "0",
    JWT_SECRET: "test-jwt-secret",
    RAZORPAY_MOCK: "1",
    RAZORPAY_KEY_ID: "rzp_test_mock",
    RAZORPAY_KEY_SECRET: "mock_secret_key",
    RAZORPAY_WEBHOOK_KEY: "mock_webhook_secret",
    RAZORPAY_API: "http://localhost:1",
    ADMIN_EMAIL: "admin1@test.local,admin2@test.local",
    MODERATE_POLICY_DAYS: "5",
    FLEXIBLE_POLICY_DAYS: "24",
    CRON_SECRET: "test-cron-secret",
    NEXTAUTH_URL: "http://localhost:3000",
    EMAIL_DISABLED: "1",
    INVOICE_PDF_DISABLED: "1",
    BOOKING_HOLD_MINUTES: "30",
    NEXT_PUBLIC_ENV: "test",
    // Non-secret placeholders the app constructs clients from at import time.
    DO_SPACES_ENDPOINT: "https://blr1.digitaloceanspaces.com",
    DO_SPACES_KEY: "test",
    DO_SPACES_SECRET: "test",
    DO_SPACES_BUCKET: "test-bucket",
    REGION: "blr1",
    BREVO_API_KEY: "disabled",
    ALLOWED_ORIGINS: "http://localhost:3000",
    PUBLIC_HOSTNAME: "http://127.0.0.1",
    MAJESTIC_COMMISSION: "12",
    HOST_COMMISSION_OFFER: "0",
    ADMIN_ACCOUNT: "acc_test",
  });
  const { app, server } = require("../../index.js");
  await new Promise((resolve) => {
    if (server.listening) return resolve();
    server.on("listening", resolve);
  });
  // wait for mongoose + index builds
  for (let i = 0; i < 100 && mongoose.connection.readyState !== 1; i++) await sleep(50);
  await Promise.all([
    require("../../models/BookingNight").init(),
    require("../../models/Payment").init(),
    require("../../models/Booking").init(),
  ]);
  const port = server.address().port;
  started = { app, server, baseUrl: `http://127.0.0.1:${port}/api/v1`, uri };
  return started;
}

async function stop() {
  if (!started) return;
  await new Promise((r) => started.server.close(r));
  await mongoose.disconnect();
  await mongod.stop();
  started = null;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function api(method, path, { token, body, headers = {} } = {}) {
  const res = await fetch(`${started.baseUrl}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  const text = await res.text();
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  return { status: res.status, body: json };
}

// --- fixtures ------------------------------------------------------------
const User = require("../../models/User");
const Admin = require("../../models/Admin");
const ListingProperty = require("../../models/ListingProperty");

let seq = 0;
async function makeUser(overrides = {}) {
  seq += 1;
  const user = await User.create({
    firstName: `User${seq}`,
    lastName: "Test",
    email: `user${seq}@test.local`,
    phoneNumber: `9000000${String(seq).padStart(3, "0")}`,
    role: "user",
    ...overrides,
  });
  return user;
}
function userToken(user, extra = {}) {
  return jwt.sign(
    { userId: String(user._id), firstName: user.firstName, tokenVersion: user.tokenVersion || 0, admin: 0, ...extra },
    process.env.JWT_SECRET,
    { expiresIn: "1h" },
  );
}
async function makeAdmin(overrides = {}) {
  seq += 1;
  const admin = await Admin.create({
    firstName: `Admin${seq}`,
    lastName: "Test",
    email: `admin${seq}@test.local`,
    phoneNumber: `8000000${String(seq).padStart(3, "0")}`,
    ...overrides,
  });
  return admin;
}
function adminToken(admin) {
  // Exactly the claims adminController issues: no `admin` flag at all.
  return jwt.sign({ userId: String(admin._id), firstName: admin.firstName }, process.env.JWT_SECRET, { expiresIn: "1h" });
}
async function makeListing(host, overrides = {}) {
  seq += 1;
  return ListingProperty.create({
    title: `Listing ${seq}`,
    host: host._id,
    basePrice: 9000,
    guests: 4,
    status: "active",
    bookingType: { manual: false },
    cancellationType: { flexible: true },
    checkinTime: "15",
    checkoutTime: "11",
    ...overrides,
  });
}
// YYYY-MM-DD strings n days from today (UTC), like the checkout link sends
function day(offset) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
}
function bookingBody(listing, { checkIn, checkOut, adults = 2, children = 0, infants = 0, ...rest } = {}) {
  return {
    propertyId: String(listing._id),
    checkIn: `${checkIn}T00:00:00.000Z`,
    checkOut: `${checkOut}T00:00:00.000Z`,
    guests: adults + children,
    adults,
    children,
    infants,
    currency: "INR",
    guestData: { adults: [{ name: "Guest One", age: 30 }], children: [] },
    ...rest,
  };
}
function razorpay() {
  return require("../../services/razorpayClient").getRazorpay();
}
function signature(orderId, paymentId, secret = process.env.RAZORPAY_KEY_SECRET) {
  return require("crypto").createHmac("sha256", secret).update(`${orderId}|${paymentId}`).digest("hex");
}
function sentEmails() {
  const { sendEmail } = require("../../utils/sendEmail");
  return sendEmail.sent || [];
}
function resetEmails() {
  const { sendEmail } = require("../../utils/sendEmail");
  sendEmail.sent = [];
}

module.exports = {
  start, stop, api, sleep,
  makeUser, userToken, makeAdmin, adminToken, makeListing, day, bookingBody,
  razorpay, signature, sentEmails, resetEmails,
};

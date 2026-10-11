// Booking + cancellation journeys, end to end, with every e-mail captured at
// the HTTP layer (the real utils/sendEmail runs; only axios.post to Brevo is
// replaced). Asserts WHO is mailed, WHICH template, WHAT attachments and
// params, that nothing is sent twice, and that one failing send never
// swallows the others. Nothing here touches Brevo, Razorpay or a real DB.
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const h = require("./setup");

const Booking = () => require("../../models/Booking");
const Payment = () => require("../../models/Payment");
const BookingNight = () => require("../../models/BookingNight");
const ListingProperty = () => require("../../models/ListingProperty");

let G, GT, HOST, HT, ADMIN, AT, STRANGER, ST;
const ADMINS = ["admin1@test.local", "admin2@test.local"];
const BREVO = "https://api.brevo.com/v3/smtp/email";

// --- Brevo capture ---------------------------------------------------------
const wire = []; // every request the app made to Brevo
let failWhen = null; // (payload) => true → that send fails with a 503
function installBrevo() {
  const axios = require("axios");
  axios.post = async (url, payload, cfg) => {
    assert.equal(url, BREVO, "mail goes to the Brevo transactional endpoint only");
    const rec = { url, payload, headers: cfg && cfg.headers, timeout: cfg && cfg.timeout };
    if (failWhen && failWhen(payload)) {
      wire.push({ ...rec, failed: true });
      const e = new Error("Request failed with status code 503");
      e.response = { status: 503, data: { message: "Service unavailable" } };
      throw e;
    }
    wire.push(rec);
    return { data: { messageId: `<m${wire.length}@brevo>` } };
  };
}
const mails = () => wire.filter((w) => !w.failed).map((w) => ({ to: w.payload.to[0].email, tpl: w.payload.templateId, params: w.payload.params, att: (w.payload.attachment || []).length }));
const reset = () => {
  wire.length = 0;
  failWhen = null;
};
const tplTo = (to) => mails().filter((m) => m.to === to).map((m) => m.tpl).sort((a, b) => a - b);
const allTpl = () => mails().map((m) => m.tpl).sort((a, b) => a - b);

test.before(async () => {
  await h.start();
  process.env.EMAIL_DISABLED = "0"; // exercise the real sender
  process.env.BREVO_API_KEY = "test-brevo-key";
  installBrevo();
  G = await h.makeUser({ firstName: "Priya", lastName: "Guestlast" });
  GT = h.userToken(G);
  HOST = await h.makeUser({ role: "host", firstName: "Rahul", lastName: "Hostlast" });
  HT = h.userToken(HOST);
  STRANGER = await h.makeUser({ role: "host" });
  ST = h.userToken(STRANGER);
  ADMIN = await h.makeAdmin();
  AT = h.adminToken(ADMIN);
});
test.beforeEach(() => reset());
test.after(async () => h.stop());

let base = 40;
let paySeq = 0;
async function listing(over = {}) {
  return h.makeListing(HOST, {
    address: { street: "House 9 Secret Lane", city: "Anjuna", state: "Goa", district: "North Goa", pincode: "403509", latitude: 15.58, longitude: 73.74 },
    ...over,
  });
}
async function book(L, { token = GT, nights = 2, startsIn } = {}) {
  base += 10;
  const from = startsIn !== undefined ? startsIn : base;
  const r = await h.api("POST", "/booking/", { token, body: h.bookingBody(L, { checkIn: h.day(from), checkOut: h.day(from + nights) }) });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body.data;
}
async function pay(b, token = GT) {
  const o = await h.api("POST", "/payment/create-order", { token, body: { bookingId: b._id, amount: b.quote.totalPaise } });
  assert.equal(o.status, 200, JSON.stringify(o.body));
  const p = h.razorpay().__registerPayment({ id: `pay_flow${++paySeq}`, order_id: o.body.data.id, amount: o.body.data.amount, currency: "INR", status: "captured", method: "upi" });
  const v = await h.api("POST", "/payment/verify-payment", { token, body: { razorpay_order_id: o.body.data.id, razorpay_payment_id: p.id, razorpay_signature: h.signature(o.body.data.id, p.id) } });
  assert.equal(v.status, 200, JSON.stringify(v.body));
  return { order: o.body.data, payment: p };
}
// What the site does after the Razorpay popup closes.
async function paidInstant(L, opts) {
  const b = await book(L, opts);
  await pay(b);
  assert.equal((await h.api("POST", "/booking/updateStatus", { token: GT, body: { bookingId: b._id } })).status, 200);
  assert.equal((await h.api("PATCH", "/booking/instant/confirm", { token: GT, body: { bookingId: b._id } })).status, 200);
  return b;
}
async function paidManual(L, opts) {
  const b = await book(L, opts);
  await pay(b);
  assert.equal((await h.api("POST", "/booking/updateStatus", { token: GT, body: { bookingId: b._id } })).status, 200);
  return b;
}
const get = (id) => Booking().findById(id).lean();
const nights = (id) => BookingNight().countDocuments({ bookingId: id });
const reviewJobs = async (bookingIdStr) => {
  const mongoose = require("mongoose");
  const rows = await mongoose.connection.db.collection("agendaJobs").find({ name: "sendReviewEmail" }).toArray();
  return rows.filter((r) => JSON.stringify(r.data).includes(bookingIdStr));
};

// ---------------------------------------------------------------------------
// Happy paths: who gets what, as it reaches Brevo
// ---------------------------------------------------------------------------
test("instant booking: exact recipients, templates, attachments, request shape — and each exactly once", async () => {
  reset();
  const L = await listing({ bookingType: { manual: false } });
  const b = await paidInstant(L);
  // replays (double click, two tabs, app retry) must not mail again
  await h.api("POST", "/booking/updateStatus", { token: GT, body: { bookingId: b._id } });
  await h.api("PATCH", "/booking/instant/confirm", { token: GT, body: { bookingId: b._id } });
  assert.deepEqual(tplTo(HOST.email), [34]);
  assert.deepEqual(tplTo(G.email), [35]);
  for (const a of ADMINS) assert.deepEqual(tplTo(a), [36]);
  assert.equal(mails().length, 4, "host + guest + 2 admins, nothing else");
  assert.equal(mails().find((m) => m.to === G.email).att, 1, "guest gets the invoice");
  assert.equal(mails().find((m) => m.to === HOST.email).att, 1, "host gets the guest list");
  assert.equal(mails().filter((m) => ADMINS.includes(m.to) && m.att).length, 0);
  // request shape: sender, key header, single recipient, numeric template
  for (const w of wire) {
    assert.equal(w.headers["api-key"], "test-brevo-key");
    assert.ok(w.timeout > 0 && w.timeout <= 30000, "every mail request has a timeout");
    assert.equal(w.payload.to.length, 1, "never a shared To/Cc list");
    assert.equal(typeof w.payload.templateId, "number");
    assert.ok(w.payload.sender && w.payload.sender.email);
  }
  // params are usable by a template: nothing undefined / NaN / Invalid Date where a guest reads it
  for (const m of mails()) {
    for (const k of ["userName", "hostName", "propertyTitle", "from", "to", "amount", "bookingId", "city", "state"]) {
      const v = m.params[k];
      assert.ok(v !== undefined && v !== null && String(v) !== "" && !/Invalid Date|NaN|undefined/.test(String(v)), `${m.tpl}→${m.to}: ${k}=${v}`);
    }
  }
  assert.equal((await get(b._id)).status, "confirmed");
  assert.equal((await reviewJobs(String(b._id))).length, 1, "post-stay review reminder scheduled once");
});

test("request-to-book: pending mails → host approves → voucher mails; host reject → refund + rejection mails", async () => {
  reset();
  const L = await listing({ bookingType: { manual: true }, cancellationType: { moderate: true } });
  const b = await paidManual(L);
  assert.deepEqual(tplTo(HOST.email), [8]);
  assert.deepEqual(tplTo(G.email), [42]);
  for (const a of ADMINS) assert.deepEqual(tplTo(a), [9]);
  assert.equal(mails().filter((m) => m.att).length, 0, "no invoice before the host decides");
  assert.ok(mails().filter((m) => !ADMINS.includes(m.to)).every((m) => m.params.street === undefined && m.params.hostContact === undefined && m.params.guestContact === undefined), "no contact/street for guest/host while pending (admin copies carry the full record)");

  reset();
  assert.equal((await h.api("PATCH", "/booking/host/confirm", { token: HT, body: { bookingId: b._id } })).status, 200);
  await h.api("PATCH", "/booking/host/confirm", { token: HT, body: { bookingId: b._id } });
  assert.deepEqual(tplTo(G.email), [10]);
  assert.deepEqual(tplTo(HOST.email), [19]);
  for (const a of ADMINS) assert.deepEqual(tplTo(a), [18]);
  assert.equal(mails().length, 4);
  assert.equal(mails().find((m) => m.to === G.email).att, 1);
  assert.equal(mails().find((m) => m.to === HOST.email).att, 1);
  assert.equal(mails().find((m) => m.to === G.email).params.street, "House 9 Secret Lane", "confirmed voucher carries the street");

  // a second request-to-book, rejected by the host
  reset();
  const b2 = await paidManual(L);
  reset();
  const rej = await h.api("PATCH", "/booking/host/cancel", { token: HT, body: { bookingId: b2._id } });
  assert.equal(rej.status, 200, JSON.stringify(rej.body));
  assert.equal(rej.body.refunded, true);
  assert.deepEqual(tplTo(G.email), [11]);
  assert.deepEqual(tplTo(HOST.email), [17]);
  for (const a of ADMINS) assert.deepEqual(tplTo(a), [16]);
  const after = await get(b2._id);
  assert.equal(after.status, "rejected");
  assert.equal(after.paymentStatus, "refunded");
  assert.equal(await nights(b2._id), 0);
});

// ---------------------------------------------------------------------------
// Cancellation matrix: money, inventory, recipients
// ---------------------------------------------------------------------------
const CASES = [
  { label: "host terminates", path: "/booking/host/terminate", who: () => HT, tpls: [13, 14, 15], refund: true },
  { label: "admin cancels", path: "/booking/admin/cancel", who: () => AT, tpls: [32, 33, 31], refund: true },
  { label: "guest cancels inside the flexible window", path: "/booking/user/terminate", who: () => GT, tpls: [22, 20, 21], refund: true, startsIn: 20 },
  { label: "guest cancels too late (no refund)", path: "/booking/user/terminate", who: () => GT, tpls: [22, 20, 21], refund: false, startsIn: 0 },
];
for (const c of CASES) {
  test(`cancel — ${c.label}: status, refund, nights, recipients, no contact data`, async () => {
    const L = await listing({ bookingType: { manual: false }, cancellationType: { flexible: true } });
    const b = await paidInstant(L, { startsIn: c.startsIn });
    reset();
    const r = await h.api("PATCH", c.path, { token: c.who(), body: { bookingId: b._id, reason: "test" } });
    assert.equal(r.status, 200, `${c.label}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.refunded, c.refund);
    const after = await get(b._id);
    assert.equal(after.status, "cancelled");
    assert.equal(after.paymentStatus, c.refund ? "refunded" : "paid", "money state matches the policy");
    assert.equal(await nights(b._id), 0, "nights released");
    const [gt, ht, at] = c.tpls;
    assert.deepEqual(tplTo(G.email), [gt]);
    assert.deepEqual(tplTo(HOST.email), [ht]);
    for (const a of ADMINS) assert.deepEqual(tplTo(a), [at]);
    assert.equal(mails().length, 4);
    for (const m of mails().filter((x) => !ADMINS.includes(x.to))) {
      for (const k of ["hostEmail", "hostContact", "guestEmail", "guestContact", "street"]) assert.equal(m.params[k], undefined, `${m.tpl}: ${k} must not be in a cancellation mail`);
    }
    // closed bookings cannot be closed again, and a replay mails nobody
    reset();
    const again = await h.api("PATCH", c.path, { token: c.who(), body: { bookingId: b._id } });
    assert.equal(again.status, 409);
    assert.equal(mails().length, 0);
    // the dates are bookable again
    const rebook = await h.api("POST", "/booking/", { token: h.userToken(await h.makeUser()), body: h.bookingBody(L, { checkIn: h.day(c.startsIn !== undefined ? c.startsIn : base), checkOut: h.day((c.startsIn !== undefined ? c.startsIn : base) + 2) }) });
    assert.equal(rebook.status, 201, JSON.stringify(rebook.body));
  });
}

test("cancel authorisation: a stranger, the wrong role and anonymous callers mail nobody and change nothing", async () => {
  const L = await listing({ bookingType: { manual: false } });
  const b = await paidInstant(L);
  reset();
  for (const [path, token] of [
    ["/booking/host/terminate", ST],
    ["/booking/host/terminate", GT],
    ["/booking/host/cancel", GT],
    ["/booking/user/terminate", HT],
    ["/booking/user/terminate", ST],
    ["/booking/admin/cancel", HT],
    ["/booking/admin/cancel", GT],
    ["/booking/user/terminate", undefined],
  ]) {
    const r = await h.api("PATCH", path, { token, body: { bookingId: b._id } });
    assert.ok([401, 403].includes(r.status), `${path}: ${r.status}`);
  }
  assert.equal(mails().length, 0);
  assert.equal((await get(b._id)).status, "confirmed");
  // recipients come from the booking, never the request body
  const r = await h.api("PATCH", "/booking/host/terminate", { token: HT, body: { bookingId: b._id, userEmail: "attacker@evil.test", hostEmail: "attacker@evil.test", email: "attacker@evil.test" } });
  assert.equal(r.status, 200);
  assert.ok(mails().every((m) => !JSON.stringify(m).includes("attacker@evil.test")));
});

// ---------------------------------------------------------------------------
// Resilience: mail provider trouble must not silently lose notifications
// ---------------------------------------------------------------------------
test("a failing guest e-mail does not stop the host and admins from being told (cancellation)", async () => {
  const L = await listing({ bookingType: { manual: false } });
  const b = await paidInstant(L);
  reset();
  failWhen = (p) => p.to[0].email === G.email;
  const r = await h.api("PATCH", "/booking/host/terminate", { token: HT, body: { bookingId: b._id } });
  assert.equal(r.status, 200, "the cancellation itself succeeded");
  assert.deepEqual(tplTo(HOST.email), [14], "host still told");
  for (const a of ADMINS) assert.deepEqual(tplTo(a), [15], "admins still told");
});

test("a failing admin e-mail does not stop the other admin or the guest (rejection)", async () => {
  const L = await listing({ bookingType: { manual: true } });
  const b = await paidManual(L);
  reset();
  failWhen = (p) => p.to[0].email === ADMINS[0];
  const r = await h.api("PATCH", "/booking/host/cancel", { token: HT, body: { bookingId: b._id } });
  assert.equal(r.status, 200);
  assert.deepEqual(tplTo(G.email), [11]);
  assert.deepEqual(tplTo(HOST.email), [17]);
  assert.deepEqual(tplTo(ADMINS[1]), [16]);
});

test("post-payment mail trouble: a retry sends only what was not delivered (no duplicates)", async () => {
  const L = await listing({ bookingType: { manual: false } });
  const b = await book(L);
  await pay(b);
  reset();
  failWhen = (p) => p.to[0].email === G.email; // guest's invoice mail fails
  const first = await h.api("POST", "/booking/updateStatus", { token: GT, body: { bookingId: b._id } });
  assert.ok(first.status >= 500 || first.body.success === false, "the client is told it failed so it can retry");
  const delivered = mails().map((m) => `${m.to}:${m.tpl}`);
  failWhen = null;
  const second = await h.api("POST", "/booking/updateStatus", { token: GT, body: { bookingId: b._id } });
  assert.equal(second.status, 200, JSON.stringify(second.body));
  const all = mails().map((m) => `${m.to}:${m.tpl}`);
  assert.equal(new Set(all).size, all.length, `no recipient got the same mail twice: ${all.join(", ")}`);
  assert.ok(all.includes(`${G.email}:35`), "the guest's invoice mail finally arrived");
  for (const d of delivered) assert.ok(all.includes(d));
});

// ---------------------------------------------------------------------------
// Payment captured but the browser never came back
// ---------------------------------------------------------------------------
test("payment recorded by the Razorpay webhook only (guest closed the tab): the parties are still notified", async () => {
  const L = await listing({ bookingType: { manual: false } });
  const b = await book(L);
  const o = (await h.api("POST", "/payment/create-order", { token: GT, body: { bookingId: b._id, amount: b.quote.totalPaise } })).body.data;
  const p = h.razorpay().__registerPayment({ id: `pay_hook${++paySeq}`, order_id: o.id, amount: o.amount, currency: "INR", status: "captured", method: "upi" });
  const body = JSON.stringify({ event: "order.paid", payload: { payment: { entity: p }, order: { entity: { id: o.id } } } });
  const sig = crypto.createHmac("sha256", process.env.RAZORPAY_WEBHOOK_KEY).update(body).digest("hex");
  reset();
  const res = await fetch(`${(await h.start()).baseUrl}/paymentforpayout/payout/update`, { method: "POST", headers: { "content-type": "application/json", "x-razorpay-signature": sig }, body });
  assert.equal(res.status, 200);
  const bk = await get(b._id);
  assert.equal(bk.paymentStatus, "paid");
  assert.equal(bk.status, "confirmed");
  // wait out any background delivery, then expect the same four mails the browser path sends
  for (let i = 0; i < 20 && mails().length < 4; i++) await h.sleep(100);
  assert.deepEqual(allTpl(), [34, 35, 36, 36], "host, guest and both admins told although the browser never called updateStatus");
  // the browser (or app) arriving late must not mail them again
  await h.api("POST", "/booking/updateStatus", { token: GT, body: { bookingId: b._id } });
  await h.api("PATCH", "/booking/instant/confirm", { token: GT, body: { bookingId: b._id } });
  assert.equal(mails().length, 4, "exactly once");
});

// ---------------------------------------------------------------------------
// The post-stay review reminder must never go out for a cancelled stay
// ---------------------------------------------------------------------------
test("review reminders: cancelled stays get no 'how was your stay' e-mail", async () => {
  const L = await listing({ bookingType: { manual: false } });
  const b = await paidInstant(L);
  const jobs = await reviewJobs(String(b._id));
  assert.equal(jobs.length, 1);
  const agenda = require("../../utils/agenda");
  const run = async () => {
    const job = { attrs: { data: jobs[0].data } };
    await new Promise((resolve) => agenda._definitions.sendReviewEmail.fn(job, resolve));
  };
  // still confirmed → the reminder is due (control)
  reset();
  await run();
  assert.deepEqual(allTpl(), [12, 43], "control: a confirmed stay does get the reminder (guest 12, host 43)");
  // cancel, then the (already scheduled) job fires
  assert.equal((await h.api("PATCH", "/booking/host/terminate", { token: HT, body: { bookingId: b._id } })).status, 200);
  reset();
  await run();
  assert.deepEqual(allTpl(), [], "cancelled stay → no review mail to guest or host");
});

// ---------------------------------------------------------------------------
// Recovery sweep: paid bookings whose mails never fully went out
// ---------------------------------------------------------------------------
const sweep = (token = process.env.CRON_SECRET) => h.api("GET", "/booking/cron/notify-sweep", { token });
async function ageBooking(id, patch = {}) {
  await Booking().updateOne({ _id: id }, { $set: { updatedAt: new Date(Date.now() - 30 * 60_000), ...patch } });
}

test("notify-sweep: needs the cron secret; sends what is missing exactly once; leaves old, past, flagged and complete bookings alone", async () => {
  assert.equal((await h.api("GET", "/booking/cron/notify-sweep")).status, 401);
  assert.equal((await sweep("wrong")).status, 401);
  assert.equal((await sweep(AT)).status, 401, "an admin JWT is not the cron secret");
  const ok = await sweep(process.env.CALENDAR_SYNC_CRON_SECRET || "x");
  assert.ok([200, 401].includes(ok.status));

  const L = await listing({ bookingType: { manual: false } });
  // A: paid, browser never called back, aged past the grace period
  const a = await book(L);
  await pay(a);
  await ageBooking(a._id);
  // B: same but too old (predates the sweep window) — must never be mailed
  const b = await book(L);
  await pay(b);
  await ageBooking(b._id, { updatedAt: new Date(Date.now() - 5 * 24 * 3600_000) });
  // C: needs attention (admin decides) — no customer mails
  const c = await book(L);
  await pay(c);
  await ageBooking(c._id, { needsAttention: "inventory_conflict" });
  // D: fresh (inside the grace period): the browser may still be on its way
  const d = await book(L);
  await pay(d);
  // E: unpaid hold
  await book(L);
  reset();
  const r = await sweep();
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.summary.found, 1, JSON.stringify(r.body));
  assert.deepEqual(allTpl(), [34, 35, 36, 36]);
  assert.ok(mails().every((m) => JSON.stringify(m.params).includes(String(a._id))), "only booking A");
  assert.equal((await reviewJobs(String(a._id))).length, 1, "the review reminder was scheduled too");
  reset();
  assert.equal((await sweep()).body.summary.found, 0, "second run: nothing left");
  assert.equal(mails().length, 0);
  // the browser arriving late changes nothing
  await h.api("POST", "/booking/updateStatus", { token: GT, body: { bookingId: a._id } });
  assert.equal(mails().length, 0);
  // D becomes eligible once it ages (grace configurable)
  await ageBooking(d._id);
  assert.equal((await sweep()).body.summary.found, 1);
});

test("notify-sweep: mail trouble is retried on the next run without repeats; a cancelled or past stay is never mailed", async () => {
  const L = await listing({ bookingType: { manual: false } });
  const a = await book(L);
  await pay(a);
  await ageBooking(a._id);
  reset();
  failWhen = (p) => p.to[0].email === HOST.email;
  const first = await sweep();
  assert.equal(first.body.summary.failed, 1, JSON.stringify(first.body));
  const got = allTpl();
  assert.deepEqual(got, [35, 36, 36], "everyone but the host (whose mail failed) was told");
  failWhen = null;
  const second = await sweep();
  assert.equal(second.body.summary.completed, 1, JSON.stringify(second.body));
  assert.deepEqual(allTpl(), [34, 35, 36, 36], "the host's mail arrived; nobody got a second copy");

  // a stay that is already over is never mailed "booking confirmed"
  const past = await book(L);
  await pay(past);
  await ageBooking(past._id, { checkOut: new Date(Date.now() - 24 * 3600_000), checkIn: new Date(Date.now() - 72 * 3600_000) });
  reset();
  assert.equal((await sweep()).body.summary.found, 0, "past stay ignored");
  assert.equal(mails().length, 0);

  // cancelled before the sweep ran → nothing
  const c = await book(L);
  await pay(c);
  await ageBooking(c._id);
  assert.equal((await h.api("PATCH", "/booking/admin/cancel", { token: AT, body: { bookingId: c._id } })).status, 200);
  reset();
  assert.equal((await sweep()).body.summary.found, 0);
  assert.equal(mails().length, 0);
});

// ---------------------------------------------------------------------------
// Content details
// ---------------------------------------------------------------------------
test("stay dates in mails are unambiguous (12 Oct 2026) and match the booked UTC days", async () => {
  const L = await listing({ bookingType: { manual: false } });
  const b = await paidInstant(L, { startsIn: 61 });
  const fmt = (offset) => {
    const d = new Date(h.day(offset) + "T00:00:00.000Z");
    return `${d.getUTCDate()} ${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.getUTCMonth()]} ${d.getUTCFullYear()}`;
  };
  for (const m of mails()) {
    assert.equal(m.params.from, fmt(61), `${m.tpl}: from`);
    assert.equal(m.params.to, fmt(63), `${m.tpl}: to`);
  }
  void b;
});

// A guest walking away from an UNPAID hold is not a booking the host or ops
// ever heard of: telling them it was "cancelled by the guest" is noise.
test("cancelling a booking that was never paid mails nobody about a booking they never saw", async () => {
  const L = await listing({ bookingType: { manual: false } });
  const b = await book(L);
  reset();
  const r = await h.api("PATCH", "/booking/user/terminate", { token: GT, body: { bookingId: b._id } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.refunded, false);
  assert.equal((await get(b._id)).status, "cancelled");
  assert.equal(await nights(b._id), 0);
  assert.equal(mails().filter((m) => m.to === HOST.email || ADMINS.includes(m.to)).length, 0, `host/admins were mailed about an unpaid hold: ${JSON.stringify(allTpl())}`);
});

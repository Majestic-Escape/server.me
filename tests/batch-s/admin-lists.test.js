// Admin dashboard list contract (utils/listQuery.js): every admin table
// endpoint pages, sorts and filters server-side and reports the filtered
// total. Seeds enough rows to cross page boundaries. Node's test runner, the
// in-memory replica set, the real Express app (setup.js).
const test = require("node:test");
const assert = require("node:assert/strict");
const h = require("./setup");
const { parseListQuery, listMeta } = require("../../utils/listQuery");

const User = () => require("../../models/User");
const Booking = () => require("../../models/Booking");
const Payment = () => require("../../models/Payment");
const Review = () => require("../../models/Review");
const ListingProperty = () => require("../../models/ListingProperty");

let AT, HOST, HT, GUESTS = [], LISTINGS = [];
const N = 27;

const ids = (rows) => rows.map((r) => String(r._id || r.id));
const secretKeys = (body) => (JSON.stringify(body).match(/"(otp|otpRetries|lockUntil|tokenVersion|password|embedding)"/g) || []);

test.before(async () => {
  await h.start();
  AT = h.adminToken(await h.makeAdmin());
  HOST = await h.makeUser({ role: "host", firstName: "Hosty", lastName: "Owner", email: "hosty@lists.test" });
  HT = h.userToken(HOST);
  for (let i = 0; i < N; i++) {
    const g = await h.makeUser({ firstName: `Guest${String(i).padStart(2, "0")}`, lastName: "Lister", email: `guest${i}@lists.test`, createdAt: new Date(Date.UTC(2026, 0, 1 + i)) });
    GUESTS.push(g);
    const l = await h.makeListing(HOST, { title: `Villa ${String(i).padStart(2, "0")}`, basePrice: 1000 + i * 100, guests: 2 + (i % 5), status: i % 3 === 0 ? "processing" : "active" });
    LISTINGS.push(l);
  }
  // 27 bookings (one per guest, staggered check-ins), 27 payments, 27 reviews
  for (let i = 0; i < N; i++) {
    const b = await Booking().create({
      userId: GUESTS[i]._id,
      hostId: HOST._id,
      propertyId: LISTINGS[i]._id,
      checkIn: new Date(Date.UTC(2027, 0, 1 + i)),
      checkOut: new Date(Date.UTC(2027, 0, 3 + i)),
      guests: 2,
      adults: 2,
      nights: 2,
      price: 5000 + i * 10,
      subTotal: 4500 + i * 10,
      status: i % 4 === 0 ? "pending" : "confirmed",
      paymentStatus: i % 4 === 0 ? "unpaid" : "paid",
      source: "local",
      action: "user",
      reviewed: i % 2 === 0,
    });
    await Payment().create({ orderId: `order_l${i}`, paymentId: `pay_l${String(i).padStart(2, "0")}`, amount: (7000 + i * 10) * 100, currency: "INR", bookingId: b._id, propertyId: LISTINGS[i]._id, status: i % 5 === 0 ? "created" : "paid", paymentType: i % 2 ? "pay-in" : "refunded", customerDetails: { name: `Guest${i} Lister`, email: `guest${i}@lists.test`, contact: "9812345600" }, createdAt: new Date(Date.UTC(2026, 5, 1 + i)) });
    await Review().create({ user: GUESTS[i]._id, property: LISTINGS[i]._id, bookingId: b._id, hostId: HOST._id, rating: 1 + (i % 5), content: `Review number ${i} of the stay`, hideStatus: i % 6 === 0 ? "pending" : "accept", createdAt: new Date(Date.UTC(2026, 6, 1 + i)) });
  }
});
test.after(async () => h.stop());

test("parseListQuery: page/limit/sort parsing, legacy skip, clamping, allow-list", () => {
  const sortable = { title: "title", price: "basePrice", hostEmail: "host.email" };
  let q = parseListQuery({ page: "3", limit: "20", sort: "price:desc" }, { sortable, defaultSort: "-title" });
  assert.deepEqual([q.page, q.limit, q.skip, q.sortKey], [3, 20, 40, "price:desc"]);
  assert.deepEqual(q.sort, { basePrice: -1, _id: -1 });
  q = parseListQuery({ skip: "25", limit: "10" }, { sortable, defaultSort: "-title" });
  assert.deepEqual([q.page, q.skip], [3, 25], "legacy skip maps to a page");
  q = parseListQuery({ sort: "nope:asc", limit: "5000", page: "0" }, { sortable, defaultSort: "-title" });
  assert.deepEqual([q.page, q.limit, q.sortKey], [1, 100, "title:desc"], "unknown sort → default; limit clamped; page ≥ 1");
  q = parseListQuery({ sort: "-hostEmail" }, { sortable, defaultSort: "title" });
  assert.deepEqual(q.sort, { "host.email": -1, _id: -1 });
  q = parseListQuery({}, { sortable, defaultSort: "title", defaultLimit: 0 });
  assert.equal(q.limit, 0, "an unbounded default stays unbounded without a page request");
  q = parseListQuery({ page: "2" }, { sortable, defaultSort: "title", defaultLimit: 0 });
  assert.deepEqual([q.limit, q.skip], [10, 10], "asking for a page turns paging on at 10");
  assert.deepEqual(listMeta({ page: 2, limit: 10, total: 27, sortKey: "title:asc" }), { page: 2, limit: 10, total: 27, totalPages: 3, hasMore: true, sort: "title:asc" });
  assert.deepEqual(listMeta({ page: 1, limit: 0, total: 27, sortKey: "title:asc" }).totalPages, 1);
});

test("properties admin list: pages, filtered total, sort by title/price/status, search, no secrets", async () => {
  const p1 = await h.api("GET", "/properties/admin/filtered-listings?status=all&page=1&limit=10&sort=title:asc", { token: AT });
  assert.equal(p1.status, 200);
  assert.equal(p1.body.properties.length, 10);
  assert.equal(p1.body.total, N);
  assert.equal(p1.body.totalPages, 3);
  assert.equal(p1.body.totalList, N, "legacy field kept");
  assert.equal(p1.body.properties[0].title, "Villa 00");
  const p3 = await h.api("GET", "/properties/admin/filtered-listings?status=all&page=3&limit=10&sort=title:asc", { token: AT });
  assert.equal(p3.body.properties.length, 7);
  assert.equal(p3.body.hasMore, false);
  const desc = await h.api("GET", "/properties/admin/filtered-listings?status=all&page=1&limit=5&sort=basePrice:desc", { token: AT });
  assert.deepEqual(desc.body.properties.map((x) => x.basePrice), [3600, 3500, 3400, 3300, 3200]);
  const processing = await h.api("GET", "/properties/admin/filtered-listings?status=processing&page=1&limit=100", { token: AT });
  assert.equal(processing.body.total, 9);
  assert.ok(processing.body.properties.every((x) => x.status === "processing"));
  const search = await h.api("GET", "/properties/admin/filtered-listings?status=all&search=Villa 1&page=1&limit=100", { token: AT });
  assert.equal(search.body.total, 10, "Villa 10..19");
  const bad = await h.api("GET", "/properties/admin/filtered-listings?status=all&sort=__proto__:asc&page=1&limit=3", { token: AT });
  assert.equal(bad.status, 200);
  assert.equal(bad.body.sort, "updatedAt:desc", "unknown sort key falls back to the default");
  assert.deepEqual(secretKeys(p1.body), [], "no secret / embedding fields to the admin table");
  // pages never overlap or skip under a stable sort
  const a = await h.api("GET", "/properties/admin/filtered-listings?status=all&page=1&limit=20&sort=guests:asc", { token: AT });
  const b = await h.api("GET", "/properties/admin/filtered-listings?status=all&page=2&limit=20&sort=guests:asc", { token: AT });
  const seen = new Set([...ids(a.body.properties), ...ids(b.body.properties)]);
  assert.equal(seen.size, N, "two pages cover every row exactly once");
});

test("users admin list: page + legacy skip, sort by name/createdAt/isHost, search, filtered total", async () => {
  const p1 = await h.api("GET", "/guests/?page=1&limit=10&sort=createdAt:asc", { token: AT });
  assert.equal(p1.status, 200);
  assert.equal(p1.body.data.length, 10);
  assert.ok(p1.body.total >= N + 1);
  assert.equal(p1.body.page, 1);
  const legacy = await h.api("GET", "/guests/?skip=10&limit=10&sort=createdAt:asc", { token: AT });
  assert.equal(legacy.body.page, 2, "legacy skip reported as a page");
  assert.equal(legacy.body.data[0]._id, (await h.api("GET", "/guests/?page=2&limit=10&sort=createdAt:asc", { token: AT })).body.data[0]._id);
  const byName = await h.api("GET", "/guests/?search=Lister&page=1&limit=5&sort=firstName:desc", { token: AT });
  assert.equal(byName.body.total, N);
  assert.equal(byName.body.data[0].firstName, "Guest26");
  const hosts = await h.api("GET", "/guests/?page=1&limit=3&sort=isHost:desc", { token: AT });
  assert.equal(hosts.body.data[0].isHost, true, "hosts first when sorting by isHost desc");
  assert.deepEqual(secretKeys(p1.body), []);
});

test("bookings admin list: filtered total (was the global paid count), status/date/search filters, sort by checkIn/price/guest", async () => {
  const all = await h.api("GET", "/booking/admin/analytics-filter?search=&status=all&from=1/1/2027&to=12/31/2027&page=1&limit=10&sort=checkIn:asc", { token: AT });
  assert.equal(all.status, 200, JSON.stringify(all.body).slice(0, 200));
  assert.equal(all.body.total, N);
  assert.equal(all.body.data.length, 10);
  assert.equal(all.body.data[0].userId.firstName, "Guest00");
  assert.equal(all.body.data[0].propertyId.title, "Villa 00");
  const pending = await h.api("GET", "/booking/admin/analytics-filter?status=pending&from=1/1/2027&to=12/31/2027&page=1&limit=100", { token: AT });
  assert.equal(pending.body.total, 7, "the total is the filtered count");
  assert.ok(pending.body.data.every((b) => b.status === "pending"));
  const search = await h.api("GET", "/booking/admin/analytics-filter?search=Guest1&status=all&from=1/1/2027&to=12/31/2027&page=1&limit=100", { token: AT });
  assert.equal(search.body.total, 10, "Guest10..19 by guest name, counted server-side");
  const byPrice = await h.api("GET", "/booking/admin/analytics-filter?status=all&from=1/1/2027&to=12/31/2027&page=1&limit=3&sort=price:desc", { token: AT });
  assert.deepEqual(byPrice.body.data.map((b) => b.price), [5260, 5250, 5240]);
  const byGuest = await h.api("GET", "/booking/admin/analytics-filter?status=all&from=1/1/2027&to=12/31/2027&page=1&limit=2&sort=guest:desc", { token: AT });
  assert.equal(byGuest.body.data[0].userId.firstName, "Guest26");
  const window = await h.api("GET", "/booking/admin/analytics-filter?status=all&from=1/5/2027&to=1/9/2027&page=1&limit=100", { token: AT });
  assert.equal(window.body.total, 5, "date window narrows the total");
  assert.deepEqual(secretKeys(all.body), [], "joined users carry no secrets, listings no embedding");
  const sameDay = await h.api("GET", "/booking/admin/analytics-filter?status=all&from=1/5/2027&to=1/5/2027", { token: AT });
  assert.equal(sameDay.body.success, false, "legacy toDate guard kept");
});

test("booking history (users-by-host): unpaginated by default, paged/sorted/searched on request", async () => {
  const whole = await h.api("GET", "/booking/users-by-host?hostId=all&search=&from=1/1/2027&to=12/31/2027", { token: AT });
  assert.equal(whole.status, 200, JSON.stringify(whole.body).slice(0, 200));
  assert.equal(whole.body.data.length, 20, "20 confirmed bookings → 20 guests (pending ones excluded)");
  assert.equal(whole.body.total, 20);
  assert.equal(whole.body.limit, 0);
  const page = await h.api("GET", "/booking/users-by-host?hostId=all&from=1/1/2027&to=12/31/2027&page=2&limit=8&sort=totalAmountSpent:desc", { token: AT });
  assert.equal(page.body.data.length, 8);
  assert.equal(page.body.totalPages, 3);
  const top = await h.api("GET", "/booking/users-by-host?hostId=all&from=1/1/2027&to=12/31/2027&page=1&limit=1&sort=totalAmountSpent:desc", { token: AT });
  assert.equal(top.body.data[0].userId.firstName, "Guest26");
  assert.equal(top.body.data[0].totalBookings, 1);
  const found = await h.api("GET", "/booking/users-by-host?hostId=all&search=guest2&from=1/1/2027&to=12/31/2027&page=1&limit=50", { token: AT });
  assert.ok(found.body.total >= 5 && found.body.data.every((r) => /^Guest2/.test(r.userId.firstName) || /guest2/.test(r.userId.email)), JSON.stringify(found.body.data.map((r) => r.userId.firstName)));
  const one = await h.api("GET", `/booking/users-by-host?hostId=${GUESTS[3]._id}&from=1/1/2027&to=12/31/2027`, { token: AT });
  assert.equal(one.body.total, 1);
  assert.equal(one.body.data[0].userId.email, "guest3@lists.test");
  const junk = await h.api("GET", "/booking/users-by-host?hostId=not-an-id&from=1/1/2027&to=12/31/2027", { token: AT });
  assert.equal(junk.status, 200);
  assert.equal(junk.body.total, 0);
});

test("host listings (admin-filter): sort + a total that honours the search", async () => {
  const one = await h.api("GET", "/properties/admin-filter?search=hosty&page=1&limit=10", { token: AT });
  assert.equal(one.status, 200);
  assert.equal(one.body.total, 1, "the count is the searched count (was the unsearched one)");
  assert.equal(one.body.data[0].email, "hosty@lists.test");
  assert.equal(one.body.data[0].allPropertyCount, N);
  assert.deepEqual(secretKeys(one.body), []);
  const none = await h.api("GET", "/properties/admin-filter?search=nobody-here&page=1&limit=10", { token: AT });
  assert.equal(none.body.total, 0);
  assert.equal(none.body.totalPages, 1);
  const sorted = await h.api("GET", "/properties/admin-filter?page=1&limit=10&sort=allPropertyCount:desc", { token: AT });
  assert.equal(sorted.body.data[0].email, "hosty@lists.test");
  assert.equal(sorted.body.sort, "allPropertyCount:desc");
});

test("transactions (payment/fetch): legacy searchList kept, paging/sort/search server-side, filtered total", async () => {
  const legacy = await h.api("GET", "/payment/fetch?paymentType=all&search=&searchList=amount-desc", { token: AT });
  assert.equal(legacy.status, 200);
  assert.equal(legacy.body.data.length, N, "unpaginated by default");
  assert.equal(legacy.body.data[0].amount, (7000 + 26 * 10) * 100);
  assert.equal(legacy.body.sort, "amount:desc", "searchList mapped onto the sort contract");
  const page = await h.api("GET", "/payment/fetch?paymentType=all&page=2&limit=10&sort=createdAt:asc", { token: AT });
  assert.equal(page.body.data.length, 10);
  assert.equal(page.body.total, N);
  assert.equal(page.body.data[0].paymentId, "pay_l10");
  const refunds = await h.api("GET", "/payment/fetch?paymentType=refunded&page=1&limit=100", { token: AT });
  assert.equal(refunds.body.total, 14);
  const search = await h.api("GET", "/payment/fetch?paymentType=all&search=pay_l2&page=1&limit=100", { token: AT });
  assert.equal(search.body.total, 7, "pay_l20..26 (ids are zero-padded)");
  const byTitle = await h.api("GET", "/payment/fetch?paymentType=all&search=Villa 05&page=1&limit=100", { token: AT });
  assert.equal(byTitle.body.total, 1);
  assert.equal(byTitle.body.data[0].propertyId.title, "Villa 05");
  const dated = await h.api("GET", "/payment/fetch?paymentType=all&from=6/5/2026&to=6/9/2026&page=1&limit=100", { token: AT });
  assert.equal(dated.body.total, 5);
  assert.equal(JSON.stringify(page.body).includes('"embedding"'), false);
});

test("reviews admin list: filters/search in the pipeline, stats over the filtered set, paging + sort", async () => {
  const whole = await h.api("GET", "/hostData/review/admin?flagged=false&stars=all&search=&property=all", { token: AT });
  assert.equal(whole.status, 200, JSON.stringify(whole.body).slice(0, 200));
  assert.ok(whole.body.data.length >= N);
  assert.equal(whole.body.reviewCount, whole.body.data.length);
  const five = await h.api("GET", "/hostData/review/admin?stars=5&page=1&limit=100", { token: AT });
  assert.ok(five.body.data.every((r) => r.rating === 5));
  assert.equal(five.body.averageRating, "5.00", "average over the filtered set");
  const page = await h.api("GET", "/hostData/review/admin?stars=all&page=2&limit=10&sort=createdAt:asc", { token: AT });
  assert.equal(page.body.data.length, 10);
  assert.equal(page.body.data[0].content, "Review number 10 of the stay");
  assert.equal(page.body.reviewCount, page.body.total);
  const search = await h.api("GET", "/hostData/review/admin?search=Guest07&page=1&limit=100", { token: AT });
  assert.equal(search.body.total, 1);
  assert.equal(search.body.data[0].user.firstName, "Guest07");
  const byProperty = await h.api("GET", "/hostData/review/admin?property=Villa 1&page=1&limit=100", { token: AT });
  assert.equal(byProperty.body.total, 10);
  const byRating = await h.api("GET", "/hostData/review/admin?page=1&limit=3&sort=rating:desc", { token: AT });
  assert.deepEqual(byRating.body.data.map((r) => r.rating), [5, 5, 5]);
  const dated = await h.api("GET", "/hostData/review/admin?checkin=7/3/2026&checkout=7/6/2026&page=1&limit=100", { token: AT });
  assert.equal(dated.body.total, 4);
});

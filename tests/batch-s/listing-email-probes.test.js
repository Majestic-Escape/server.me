// Independent follow-up review probes (reviews/r1-email-probes-2026-10-12.cjs,
// 2026-10-12), kept verbatim as regression tests: notifications go to the host
// account's CURRENT e-mail (not a stale listing copy), and an e-mail address
// never grants a user private access to a host-less legacy listing.
const test = require('node:test');
const assert = require('node:assert/strict');
process.env.E2E_REAL_SPACES = '0';
process.env.LISTING_CHANGE_MOCK = '1';
const h = require('./setup');
let adminToken;
test.before(async () => {
  await h.start();
  adminToken = h.adminToken(await h.makeAdmin());
});
test.after(async () => { await h.stop(); });

test('approval of a legacy stale-email listing notifies current host address', async (t) => {
  const host = await h.makeUser({ role: 'host', firstName: 'Current', email: 'current-contact@review.invalid' });
  const listing = await h.makeListing(host, {
    status: 'processing', title: 'Quiet garden cottage',
    hostEmail: 'retired-contact@review.invalid',
    address: { city: 'Panaji', state: 'Goa' },
  });
  h.resetEmails();
  const r = await h.api('PATCH', `/properties/admin/approve/${listing._id}`, { token: adminToken });
  assert.equal(r.status, 200);
  const recipient = h.sentEmails().find(x => x.templateId === 25)?.recipientEmail;
  t.diagnostic(`Synthetic expected recipient: ${host.email}; actual: ${recipient}`);
  assert.equal(recipient, host.email, 'approval must not send to the stale copied email');
});

test('host account email update is reflected in approval notification recipient', async (t) => {
  const host = await h.makeUser({ role: 'host', firstName: 'Changed', email: 'prior-contact@review.invalid' });
  const listing = await h.makeListing(host, {
    status: 'processing', title: 'Quiet hill cottage', address: { city: 'Panaji', state: 'Goa' },
  });
  const updatedEmail = 'updated-contact@review.invalid';
  const update = await h.api('PUT', `/hosts/${host._id}`, { token: adminToken, body: { email: updatedEmail } });
  assert.equal(update.status, 200, `account email update fixture must succeed: ${JSON.stringify(update.body)}`);
  h.resetEmails();
  const r = await h.api('PATCH', `/properties/admin/approve/${listing._id}`, { token: adminToken });
  assert.equal(r.status, 200);
  const recipient = h.sentEmails().find(x => x.templateId === 25)?.recipientEmail;
  t.diagnostic(`Synthetic expected updated recipient: ${updatedEmail}; actual: ${recipient}`);
  assert.equal(recipient, updatedEmail, 'account email change must not leave approval notifications pointing at the old email');
});

test('a reused account email does not grant private access to a host-less legacy listing', async (t) => {
  const originalEmail = 'legacy-contact@review.invalid';
  const original = await h.makeUser({ role: 'host', firstName: 'Original', email: originalEmail });
  const legacy = await h.makeListing(original, {
    host: null, status: 'processing', title: 'Quiet woodland cottage',
    description: 'Unpublished cottage renovation plan',
    address: { street: 'House 14 Bracken Lane', city: 'Panaji', state: 'Goa', latitude: 15.5, longitude: 73.8 },
  });
  const changed = await h.api('PUT', `/hosts/${original._id}`, {
    token: adminToken, body: { email: 'new-legacy-contact@review.invalid' },
  });
  assert.equal(changed.status, 200);
  const different = await h.makeUser({ firstName: 'Different', email: originalEmail });
  const r = await h.api('GET', `/properties/user-properties/${encodeURIComponent(originalEmail)}`, {
    token: h.userToken(different),
  });
  assert.equal(r.status, 200);
  const row = r.body.listings.find(x => String(x._id) === String(legacy._id));
  t.diagnostic(`Different account matches old email; private legacy row returned: ${!!row}; precise street returned: ${!!row?.address?.street}`);
  assert.equal(!!row?.address?.street, false, 'email-only legacy fallback must not expose precise location to a different account');
});

test('scheduled reminders resolve the current host account e-mail when they send', async () => {
  const { reminderRecipient, reviewHostRecipient } = require('../../utils/agenda').__recipients;
  const Booking = require('../../models/Booking');
  const host = await h.makeUser({ role: 'host', firstName: 'Remind', email: 'remind-now@review.invalid' });
  const listing = await h.makeListing(host, { status: 'incomplete', title: 'Quiet lake cottage', hostEmail: 'remind-then@review.invalid' });
  // a job scheduled with the old address sends to the current one
  assert.equal(await reminderRecipient({ propertyId: String(listing._id), hostEmail: 'remind-then@review.invalid' }), host.email);
  // listing gone or host-less → nobody (never a stale address)
  assert.equal(await reminderRecipient({ propertyId: '0123456789abcdef01234567', hostEmail: 'remind-then@review.invalid' }), null);
  // jobs from before propertyId was stored: no identity → no host e-mail
  // (an address alone does not identify the host)
  assert.equal(await reminderRecipient({ hostEmail: 'old-job@review.invalid' }), null);
  const guest = await h.makeUser({ firstName: 'Reviewer', email: 'reviewer@review.invalid' });
  const b = await Booking.create({ userId: guest._id, hostId: host._id, propertyId: listing._id, checkIn: new Date('2026-01-01'), checkOut: new Date('2026-01-02'), price: 1, subTotal: 1, status: 'confirmed', paymentStatus: 'paid' });
  await require('../../models/User').updateOne({ _id: host._id }, { $set: { email: 'remind-changed@review.invalid' } });
  assert.equal(await reviewHostRecipient({ bookingId: String(b._id), hostEmail: 'remind-now@review.invalid' }), 'remind-changed@review.invalid');
});

// Follow-up review probe (reviews/r1-reminder-fallback-probe-aa7b709.cjs), verbatim.
test('review reminder must not fall back to stale email when its host account no longer exists', async (t) => {
  const host = await h.makeUser({ role: 'host', firstName: 'Former', email: 'retired@review.invalid' });
  const guest = await h.makeUser({ firstName: 'Guest', email: 'guest-reminder@review.invalid' });
  const listing = await h.makeListing(host, { status: 'inactive', title: 'Quiet meadow cottage' });
  const Booking = require('../../models/Booking');
  const User = require('../../models/User');
  const b = await Booking.create({
    userId: guest._id, hostId: host._id, propertyId: listing._id,
    checkIn: new Date('2025-01-01'), checkOut: new Date('2025-01-02'),
    price: 9000, subTotal: 9000, status: 'confirmed', paymentStatus: 'paid',
  });
  await User.deleteOne({ _id: host._id }); // synthetic in-memory fixture only
  const { reviewHostRecipient } = require('../../utils/agenda').__recipients;
  const recipient = await reviewHostRecipient({ bookingId: String(b._id), hostEmail: 'retired@review.invalid' });
  t.diagnostic(`Missing account; recipient resolves to saved stale address: ${recipient === 'retired@review.invalid'}`);
  assert.equal(recipient, null, 'no account must mean no host email, not the saved address');
});

test('reminder recipients fail closed across every unresolvable case; never a saved address', async () => {
  const { reminderRecipient, reviewHostRecipient } = require('../../utils/agenda').__recipients;
  const Booking = require('../../models/Booking');
  const User = require('../../models/User');
  const ListingProperty = require('../../models/ListingProperty');
  const SAVED = 'saved-copy@review.invalid';
  const host = await h.makeUser({ role: 'host', firstName: 'Matrix', email: 'matrix-host@review.invalid' });
  const guest = await h.makeUser({ firstName: 'Matrixguest', email: 'matrix-guest@review.invalid' });
  const listing = await h.makeListing(host, { status: 'incomplete', title: 'Quiet river cottage' });
  const mk = (over = {}) => Booking.create({ userId: guest._id, hostId: host._id, propertyId: listing._id, checkIn: new Date('2025-02-01'), checkOut: new Date('2025-02-02'), price: 1, subTotal: 1, status: 'confirmed', paymentStatus: 'paid', ...over });
  // normal: the current account address
  const ok = await mk();
  assert.equal(await reviewHostRecipient({ bookingId: String(ok._id), hostEmail: SAVED }), host.email);
  // legacy job without bookingId: the id is recovered from the rating link
  assert.equal(await reviewHostRecipient({ hostEmail: SAVED, params: { userUrl: `https://x.test/write-a-review?booking=${ok._id}` } }), host.email);
  // no identity at all
  assert.equal(await reviewHostRecipient({ hostEmail: SAVED }), null);
  // booking deleted
  const gone = await mk();
  await Booking.deleteOne({ _id: gone._id });
  assert.equal(await reviewHostRecipient({ bookingId: String(gone._id), hostEmail: SAVED }), null);
  // booking without a host id (raw write: the schema requires one)
  const nohost = await mk();
  await Booking.collection.updateOne({ _id: nohost._id }, { $unset: { hostId: '' } });
  assert.equal(await reviewHostRecipient({ bookingId: String(nohost._id), hostEmail: SAVED }), null);
  // account without an address (raw write)
  const blank = await h.makeUser({ role: 'host', firstName: 'Blank', email: 'blank@review.invalid' });
  await User.collection.updateOne({ _id: blank._id }, { $unset: { email: '' } });
  const bb = await mk({ hostId: blank._id });
  assert.equal(await reviewHostRecipient({ bookingId: String(bb._id), hostEmail: SAVED }), null);
  // lookup failure (an id that cannot be cast) → null, never the saved address
  assert.equal(await reviewHostRecipient({ bookingId: 'not-an-object-id', hostEmail: SAVED }), null);
  assert.equal(await reminderRecipient({ propertyId: 'not-an-object-id', hostEmail: SAVED }), null);
  // listing reminder: host-less listing and deleted host account
  const hostless = await ListingProperty.create({ title: 'Hostless reminder', status: 'incomplete' });
  assert.equal(await reminderRecipient({ propertyId: String(hostless._id), hostEmail: SAVED }), null);
  await User.deleteOne({ _id: host._id });
  assert.equal(await reminderRecipient({ propertyId: String(listing._id), hostEmail: SAVED }), null);
});

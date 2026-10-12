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
  // jobs from before propertyId was stored keep their address
  assert.equal(await reminderRecipient({ hostEmail: 'old-job@review.invalid' }), 'old-job@review.invalid');
  const guest = await h.makeUser({ firstName: 'Reviewer', email: 'reviewer@review.invalid' });
  const b = await Booking.create({ userId: guest._id, hostId: host._id, propertyId: listing._id, checkIn: new Date('2026-01-01'), checkOut: new Date('2026-01-02'), price: 1, subTotal: 1, status: 'confirmed', paymentStatus: 'paid' });
  await require('../../models/User').updateOne({ _id: host._id }, { $set: { email: 'remind-changed@review.invalid' } });
  assert.equal(await reviewHostRecipient({ bookingId: String(b._id), hostEmail: 'remind-now@review.invalid' }), 'remind-changed@review.invalid');
});

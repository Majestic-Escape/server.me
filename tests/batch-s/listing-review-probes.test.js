// Independent review probes (reviews/r1-review-probes-2026-10-12.cjs, 2026-10-12),
// kept verbatim as regression tests: former-host access after reassignment
// (e-mail portfolio, legacy list, booking route), repeat-booking snapshots,
// recorded cancellation terms, and one guest-entitlement rule for the detail
// and booking routes.
const test = require('node:test');
const assert = require('node:assert/strict');
process.env.E2E_REAL_SPACES = '0';
process.env.LISTING_CHANGE_MOCK = '1';
const h = require('./setup');
let oldHost, newHost, guest, adminToken, oldToken, newToken, guestToken, transferred;
const Booking = () => require('../../models/Booking');

test.before(async () => {
  await h.start();
  oldHost = await h.makeUser({ role: 'host', firstName: 'Previous', email: 'previous@review.invalid' });
  newHost = await h.makeUser({ role: 'host', firstName: 'Next', email: 'next@review.invalid' });
  guest = await h.makeUser({ firstName: 'Guest', email: 'guest@review.invalid' });
  oldToken = h.userToken(oldHost);
  newToken = h.userToken(newHost);
  guestToken = h.userToken(guest);
  adminToken = h.adminToken(await h.makeAdmin());
  transferred = await h.makeListing(oldHost, {
    status: 'processing', title: 'Quiet cottage',
    description: 'A quiet cottage by the coast',
    address: { street: 'House 9 Coral Lane', city: 'Panaji', state: 'Goa', latitude: 15.5, longitude: 73.8 },
  });
  const moved = await h.api('PUT', `/prop-listing/${transferred._id}`, {
    token: adminToken, body: { host: String(newHost._id) },
  });
  assert.equal(moved.status, 200, `admin reassignment fixture must succeed: ${JSON.stringify(moved.body)}`);
  const edited = await h.api('PUT', `/properties/update-listing-property/${transferred._id}`, {
    token: newToken, body: { description: 'Unreleased renovation schedule' },
  });
  assert.equal(edited.status, 200, 'new owner must be able to edit the fixture');
});
test.after(async () => { await h.stop(); });

test('former host cannot read transferred private listing through email portfolio', async (t) => {
  const r = await h.api('GET', `/properties/user-properties/${encodeURIComponent(oldHost.email)}`, { token: oldToken });
  assert.equal(r.status, 200);
  const row = r.body.listings.find(x => String(x._id) === String(transferred._id));
  t.diagnostic(`Former-owner portfolio contains transferred row: ${!!row}; exact street retained: ${!!(row && row.address && row.address.street)}`);
  assert.equal(!!row, false, 'reassignment must remove former-owner portfolio access');
});

test('new host sees reassigned listing without client-supplied hostEmail synchronization', async () => {
  const r = await h.api('GET', `/properties/user-properties/${encodeURIComponent(newHost.email)}`, { token: newToken });
  assert.equal(r.status, 200);
  assert.equal(r.body.listings.some(x => String(x._id) === String(transferred._id)), true, 'new owner portfolio must contain the transferred listing');
});

test('former host cannot read new draft through legacy hostEmail-filtered list', async (t) => {
  const r = await h.api('GET', `/prop-listing/?hostEmail=${encodeURIComponent(oldHost.email)}`, { token: oldToken });
  assert.equal(r.status, 200);
  const row = r.body.listings.find(x => String(x._id) === String(transferred._id));
  t.diagnostic(`Former-owner legacy list contains transferred row: ${!!row}; new unpublished description retained: ${!!(row && row.description === 'Unreleased renovation schedule')}`);
  assert.equal(!!row, false, 'email equality must not grant read access to another host current listing');
});

function bookingFields(listing, overrides = {}) {
  return {
    userId: guest._id, hostId: oldHost._id, propertyId: listing._id,
    status: 'confirmed', paymentStatus: 'paid', source: 'local', action: 'user',
    price: 9000, subTotal: 18000, guests: 1, cancellationPolicy: 'strict',
    checkIn: new Date('2020-01-01'), checkOut: new Date('2020-01-03'),
    ...overrides,
  };
}

test('historical booking host is not entitled to current new-owner private listing', async (t) => {
  const b = await Booking().create(bookingFields(transferred));
  const r = await h.api('GET', `/booking/${b._id}`, { token: oldToken });
  assert.equal(r.status, 200, 'former host may retain their historical booking record');
  const row = r.body.data.propertyId;
  t.diagnostic(`Historical host receives new draft description: ${row.description === 'Unreleased renovation schedule'}; exact street retained: ${!!row.address.street}`);
  assert.equal(row.description, undefined, 'booking host role must not grant ownership of reassigned current listing');
});

test('repeat guest mobile trip must keep the selected booking snapshot', async (t) => {
  const l = await h.makeListing(oldHost, { status: 'inactive', delist: 'host', title: 'Synthetic repeat stay' });
  const earlier = await Booking().create(bookingFields(l, {
    listingSnapshot: { checkinTime: '14', checkoutTime: '10', cancellationType: { strict: true }, selectedRules: ['Earlier booked rule'] },
  }));
  await Booking().create(bookingFields(l, {
    checkIn: new Date('2024-01-01'), checkOut: new Date('2024-01-03'),
    listingSnapshot: { checkinTime: '18', checkoutTime: '12', cancellationType: { flexible: true }, selectedRules: ['Later booked rule'] },
  }));
  const trip = await h.api('GET', `/booking/${earlier._id}`, { token: guestToken });
  const stay = await h.api('GET', `/properties/${l._id}`, { token: guestToken });
  assert.equal(trip.status, 200);
  assert.equal(stay.status, 200);
  assert.equal(trip.body.data.propertyId.checkinTime, '14');
  // This is the real current mobile trip consumer's precedence.
  const displayed = stay.body.data.checkinTime ?? trip.body.data.propertyId.checkinTime;
  t.diagnostic(`Selected booking check-in: ${trip.body.data.propertyId.checkinTime}; shared property view: ${stay.body.data.checkinTime}; mobile display: ${displayed}`);
  assert.equal(displayed, '14', 'property-level latest snapshot must not override another trip contract');
});

test('legacy booking cancellation view must match recorded booking policy', async (t) => {
  const l = await h.makeListing(oldHost, {
    status: 'processing', title: 'Synthetic legacy stay', cancellationType: { flexible: true },
  });
  const b = await Booking().create(bookingFields(l));
  const r = await h.api('GET', `/booking/${b._id}`, { token: guestToken });
  assert.equal(r.status, 200);
  t.diagnostic(`Recorded policy: ${r.body.data.cancellationPolicy}; displayed cancellationType: ${JSON.stringify(r.body.data.propertyId.cancellationType)}`);
  assert.equal(r.body.data.propertyId.cancellationType.strict, true, 'legacy booked terms must not use the current listing cancellation policy');
});

for (const variant of [{ source: 'ical', action: 'user' }, { source: 'local', action: 'host' }]) {
  test(`excluded booking variant must not reveal hidden exact address: ${variant.source}/${variant.action}`, async (t) => {
    const l = await h.makeListing(oldHost, {
      status: 'processing', title: 'Quiet valley cottage',
      address: { street: 'House 17 Fern Lane', city: 'Panaji', state: 'Goa', latitude: 15.5, longitude: 73.8 },
    });
    const b = await Booking().create(bookingFields(l, variant));
    const detail = await h.api('GET', `/properties/${l._id}`, { token: guestToken });
    const viaBooking = await h.api('GET', `/booking/${b._id}`, { token: guestToken });
    assert.equal(detail.body.access, 'public', 'the detail route correctly denies this booking variant');
    assert.equal(viaBooking.status, 200, 'caller retains their own booking record');
    t.diagnostic(`Detail access: ${detail.body.access}; exact street exposed through booking: ${!!viaBooking.body.data.propertyId.address.street}`);
    assert.equal(viaBooking.body.data.propertyId.address.street, undefined, 'booking and detail routes must apply the same qualifying guest predicate');
  });
}

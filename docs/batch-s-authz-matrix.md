# Batch S — route / action authorization matrix

Legend: **anon** = no token · **guest** = the booking's guest (`booking.userId`) ·
**other user** = any other authenticated user · **host** = the booking's /
listing's host · **admin** = id present in the `Admin` collection (or a
`User` with `role: "admin"`), not banned. Bare JWT claims never grant admin.
Every row was exercised by `tests/batch-s/authz.test.js` (40 cases) plus the
booking/payment suites.

## Booking (`/api/v1/booking`)

| Action | anon | other user | guest | host | admin | Notes |
|---|---|---|---|---|---|---|
| `POST /` create guest booking | 401 | — | 201 (self) | 201 (as guest) | 403 | identity from token; price/nights/status server-side |
| `POST /` host block (`action: "host"`) | 401 | 403 | 403 | 201 (own listing) | 403 | stored as before (confirmed/paid/₹0) |
| `GET /:bookingId` | 401 | 403 | 200 | 200 | 200 | |
| `PUT /:bookingId` (whitelisted) | 401 | 403 | 403 | 403 | 200 | adults/children/infants/guestData/flag only |
| `DELETE /:bookingId` | 401 | 403 | 403 | 403 | 200 | paid guest bookings must be refunded first (409) |
| `POST /updateStatus` (post-payment notify) | 401 | 403 | 200 once | 403 | 200 | 409 unless payment already recorded |
| `PATCH /instant/confirm` | 401 | 403 | 200 (no-op) | 403 | 200 | 409 for manual listings / unpaid |
| `PATCH /host/confirm` | 401 | 403 | 403 | 200 | 200 | requires paid; conditional pending→confirmed |
| `PATCH /host/cancel` (reject, refund) | 401 | 403 | 403 | 200 | 200 | refund once; gateway failure → 502, state unchanged |
| `PATCH /host/terminate` (refund) | 401 | 403 | 403 | 200 | 200 | same |
| `PATCH /user/terminate` | 401 | 403 | 200 | 403 | 200 | refund only inside policy window |
| `PATCH /admin/cancel` (refund) | 401 | 403 | 403 | 403 | 200 | |
| `POST /admin-modify` | 401 | 403 | 403 | 403 | 200 | date/property moves re-reserve nights (409 on overlap) |
| `PATCH /modal-close` | 401 | 403 | 200 | 403 | 200 | no-op |
| `PATCH /update-flag` | 401 | 403 | 403 | 200 | 200 | email goes to the booking host |
| `POST /unblock-dates/:propertyId` | 401 | 403 | 403 | 200 (own listing) | 200 | was anonymous |
| `GET /data` (own bookings) | 401 | scoped to self | scoped to self | scoped to self | any `userId` | `userId` query ignored for non-admins |
| `GET /user/:userId`, `GET /host/:hostId` | 401 | 403 unless self | self | self | any | |
| `GET /filter`, `/analytics-filter`, `/analytics-stats-filter`, `/revenue-filter`, `/filter-active-bookings` | 401 | scoped to caller as host | scoped | scoped to own listings | unscoped | `hostId` query cannot widen scope |
| `GET /` (all), `/admin/analytics-filter`, `/hostEmails`, `/users-by-host` | 401 | 403 | 403 | 403 | 200 | |
| `GET /generate-pdf` (demo PDF) | 401 | 200 | 200 | 200 | 200 | was anonymous Chromium launch |
| `GET /check-dates/:propertyId`, `/blocked-dates/:propertyId` | 200 | 200 | 200 | 200 | 200 | public reads, unchanged (404 on malformed id) |

## Payment (`/api/v1/payment`)

| Action | anon | other user | guest | host | admin | Notes |
|---|---|---|---|---|---|---|
| `POST /create-order` | 401 | 403 | 200 | 403 | 403 | amount = server quote; PRICE_CHANGED / AMOUNT_MISMATCH / DATES_UNAVAILABLE / LISTING_INACTIVE → 409 |
| `POST /verify-payment` | 401 | 403 | 200 | 403 | 403 | signature + gateway amount/order/currency/status; idempotent |
| `GET /booking?id=` | 401 | 403 | 200 | 200 | 200 | |
| `GET /payment/:id` | 401 | 403 | 200 | 200 | 200 | |
| `GET /fetch` (all transactions) | 401 | 403 | 403 | 403 | 200 | was anonymous |
| `GET /schedule-cron` | 401 | 401 | 401 | 401 | 401 | only `Authorization: Bearer $CRON_SECRET` |
| `POST /paymentforpayout/payout/update` (webhook) | HMAC only | | | | | pay-in events applied idempotently |

## Listing (`/api/v1/properties`) — mutations

| Action | anon | other host | listing host | admin |
|---|---|---|---|---|
| `POST /create-listing-property` | 401 | 403 (hostEmail ≠ own) | 200 | 200 |
| `PUT /update-listing-property/:id` | 401 | 403 | 200 | 200 |
| `PATCH /update-kyc-property/:id` (id = host id) | 401 | 403 | 200 | 200 |
| `POST /timings` | 401 | 403 | 200 | 200 |
| `PATCH /host/delist/:id`, `/host/reactivate/:id` | 401 | 403 | 200 | 200 |
| `PATCH /admin/approve/:id`, `/admin/delist/:id`, `PUT /admin-update-property/:id`, `GET /admin/filtered-listings`, `/admin/processing-listings` | 401 | 403 | 403 | 200 |
| `POST /`, `PUT /:id` (legacy `Property` model, unused) | 401 | 403 | 403 | 200 |
| `GET /:id` and other reads | 200 | 200 | 200 | 200 |

## Calendar sync (`/api/v1/calendarSync`)

| Action | anon | other host | listing host | admin |
|---|---|---|---|---|
| `POST /saveCalendar` (attach iCal → imports confirmed blocks) | 401 | 403 | 200 | 200 |
| `GET /ics/:secret.ics` | by secret | | | |

## Identity edge cases (tested)
* Expired token → 401 `AUTH_TOKEN_EXPIRED`; malformed token → 403 `AUTH_TOKEN_INVALID` (unchanged middleware semantics).
* User token with `tokenVersion` mismatch → 401 `TOKEN_INVALIDATED`.
* Banned user → 403 `USER_BANNED` on every authenticated route (now including create-order/verify-payment).
* Admin-shaped JWT whose id is not an `Admin` (or is banned) → 401; user token with a forged `admin: 1` claim → not admin (403 on admin routes).

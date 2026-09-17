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
| `POST /` create guest booking | 401 | — | 201 (self) | 201 (as guest) | 403 | identity from token; price/nights/status server-side; 503 MAINTENANCE while the cutover gate is on |
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
| `PATCH /admin/cancel` (refund) | 401 | 403 | 403 | 403 | 200 | also refunds a queued (needsAttention) booking |
| `GET /admin/attention`, `PATCH /admin/attention/resolve` | 401 | 403 | 403 | 403 | 200 | S.1 operational queue |
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

---

# Batch A2 — admin tools + trust-boundary hardening (2026-09-17)

Every row below is exercised by `tests/batch-s/trust-boundary.test.js`,
`tests/batch-s/admin-tools.test.js` and `tests/batch-s/admin-tools-cost.test.js`
(24 cases on the replica-set harness with the Spaces and KYC-provider fakes;
the cost suite asserts operation-count ceilings per action). Same legend as above; **self** = the user
the request is about (query email / body userId / form owner).

## Profile (`/api/v1/accounts`) — was anonymous

| Action | anon | other user | self | admin | Notes |
|---|---|---|---|---|---|
| `GET /?email=` | 401 | 403 | 200 | 200 | email compared case-insensitively |
| `PUT /?email=` | 401 | 403 | 200 | 200 | closed whitelist: `dob, phoneNumber, profilePicture, address{street,city,state,postalCode,country}, languages, about`. **Never** `firstName/lastName` (admin-managed), `email, role, status, kyc, bank, tokenVersion, _id`. Duplicate phone → 409 `PHONE_IN_USE` |

## Host KYC (`/api/v1/kyc`, `/api/v1/pan-kyc`) — was anonymous

| Action | anon | other user | self | admin | Notes |
|---|---|---|---|---|---|
| `POST /kyc/form` | 401 | 403 (body.hostId ≠ own) | 200 | 200 | idempotent (one form per host); `hostId/hostEmail/status/isVerified` from the server, body whitelisted to `personalInfo, acceptedTerms` |
| `PUT /kyc/update-form/:id` | 401 | 403 | 200 | 200 | whitelist `personalInfo, acceptedTerms, status`; `documentInfo`/`gstInfo`/`hostId`/`hostEmail` stripped; `status:"completed"` needs a server-verified document, else saved as `pending` + 409 `KYC_INCOMPLETE` |
| `GET /kyc/form/:hostId`, `GET /kyc/user/:hostId` | 401 | 403 | 200 | 200 | |
| `GET /kyc/form-kyc/:formId` | 401 | 403 | 200 | 200 | |
| `POST /pan-kyc/verify` | 401 | 403 | 200/422 | 200/422 | validation (≤ 4 MiB, base64, jpeg/png/pdf) → `KYC_FORM_REQUIRED` → **provider guard** (one in flight, cooldown, daily ceiling → 429 `KYC_RATE_LIMITED`) → OCR + status → **server verdict** writes `documentInfo` (`verified` / `needs_review` / `failed` → 422 `DOCUMENT_NOT_VERIFIED`) |
| `POST /kyc/verify/gst` | 401 | 403 | 200 | 200 | PAN/GSTIN format checked before any provider call; positive verdict writes masked `gstInfo` |
| `PATCH /kyc/verify-status`, `/kyc/verify-gst-status` | 401 | 403 | 200 / 409 | 200 / 409 | **confirm-only**: body ignored; 409 `VERIFICATION_NOT_FOUND` unless the server already verified |
| `POST /kyc/generate-url`, `GET /kyc/verify/pan`, `GET /kyc/:transactionId/details` | 401 | 403 | 403 | 200 | Digitap sandbox endpoints, cost credits |

Verdict table (`services/kycVerdict.js`): `http_response_code === 200` and `result.status` active/valid **and** the holder's name matches (PAN: provider `name_match`; voter/passport: local token match against the document name) → `verified`; active but name mismatch, or 200 without validity fields → `needs_review` (unverified until an admin marks it); provider error / no record / inactive → `failed`. A replaced document (new fingerprint) resets verification; a retry of the same bytes keeps it. Guard defaults: `KYC_MAX_ATTEMPTS_PER_DAY=5`, `KYC_ATTEMPT_COOLDOWN_SECONDS=30`, `KYC_INFLIGHT_LEASE_SECONDS=120`.

## Uploads (`/api/v1/uploads`) — was anonymous

| Action | anon | other user | owner | admin | Notes |
|---|---|---|---|---|---|
| `POST /` (listing photos) | 401 | 200 | 200 | 200 | keys `listings/<actorId>/<uuid>-<name>` (owner-bound, unique) |
| `POST /profile?userId=` | 401 | 403 | 200 | 200 | keys `profiles/<userId>/<uuid>-<name>` |
| `DELETE /delete {url}` | 401 | 403 | 200 | 200 | own upload / own listing photo / own profile picture; foreign reference to the same object → 409 `OBJECT_IN_USE`; legacy unreferenced keys admin-only; non-bucket or path-confusing URLs → 400 `INVALID_KEY` |
| `POST /generate-presigned-url` | 401 | 403 | 403 | 200 | dead (`SPACE_NAME` unset) |

## Bank details & hosts (`/api/v1/hostData`, `/api/v1/hosts`)

| Action | anon | other user | self | admin |
|---|---|---|---|---|
| `PUT/GET /hostData/bank/:hostId` | 401 | 403 | 200 | 200 |
| `GET /hostData/`, `GET /hostData/review/admin` | 401 | 403 | 403 | 200 |
| `GET /hosts/`, `/stats`, `/growth`, `/top-performing`, `/activity`, `/distribution`, `/report`, `/export` | 401 | 403 | 403 | 200 |
| `PUT /hosts/:id` | 401 | 403 | 403 | 200 |

## Users (`/api/v1/guests`)

| Action | anon | other user | admin | Notes |
|---|---|---|---|---|
| `GET /` | 401 | 403 | 200 | every non-privileged account (`role:"admin"` and Admin-collection emails hidden), `isHost`/`totalProperties`, search escaped |
| `GET /kyc?id=` | 401 | 403 | 200 | steps-table fields only |
| `PATCH /name/:userId` | 401 | 403 | 200 | transactional with the audit row; `expected` names → 409 `NAME_CHANGED` when stale; privileged target → 403; 400 `INVALID_NAME` |
| `PATCH /ban/:userId` | 401 | 403 | 200 | response `{data:{_id,status}}` (no user dump) |
| `GET /kyc-documents/:hostId` | 401 | 403 | 200 | never base64 / raw OCR; `hasMore` after 20 |
| `GET /kyc-documents/:hostId/:logId/file?mode=view` or `download` | 401 | 403 | 200 | audited (`kyc.document.view` / `.download`) before streaming, 503 if the audit cannot be written; jpeg/png/pdf inline, anything else `application/octet-stream` attachment |
| `PATCH /admin/kyc/:hostId/document-verified {logId}` | 401 | 403 | 200 | only the current `needs_review` upload (409 `NOT_REVIEWABLE`); completes the KYC when terms were accepted |
| `DELETE /delete/:userId` | 404 | 404 | 404 | route removed (no cascade, no UI) |
| `GET /info/:userId`, `GET /guest-by-id` | 401 | 200 | 200 | unchanged self-service reads |

## Listings (`/api/v1/properties`, `/api/v1/prop-listing`)

| Action | anon | other user | listing host | admin | Notes |
|---|---|---|---|---|---|
| `DELETE /properties/admin/:id` | 401 | 403 | 403 | 200 | only `status:"processing"`; `Booking`/`BookingNight`/`Payment`/`HostPayout`/`Review`/`HostReview` rows block (409 `LISTING_HAS_DEPENDENTS`); `ExternalCalendar`/`BookingInterest` rows are cleanup; one transaction with the audit row; after commit: dependent sweep + Spaces photo removal (objects still referenced anywhere are kept), outcomes on the audit row, `scripts/repair-deleted-listings.js` finishes interrupted work |
| `POST /prop-listing/` | 401 | 403 | 403 | 200 | |
| `PUT /prop-listing/:id` | 401 | 403 | 403 | 200 | |
| `DELETE /prop-listing/:id`, `POST /prop-listing/bulk-action` | 404 | 404 | 404 | 404 | routes removed |
| `GET /prop-listing/:id` | 200 | 200 | 200 | 200 | public read; malformed id → 404 (Batch P) |
| `GET /prop-listing/status?email=` | 401 | 403 | 200 | 200 | Batch P: the caller's own stage (`host` id or legacy `hostEmail`), status-only projection; admins may ask for any host. Used to match every listing in the collection |
| `GET /prop-listing/admin/:id` | 401 | 403 | 403 | 200 | Batch P: was anonymous (hostEmail, street, registration number); admin compat sends the token |
| `GET /prop-listing/export` | 401 | 403 | 403 | 200 | Batch P: was anonymous (whole catalogue with hosts); no UI caller |
| `GET /properties/admin-filter` | 401 | 403 | 403 | 200 | Batch P: was anonymous; the admin already sends the token |
| `GET /properties/active/filter/:hostId` | 401 | 403 | 403 | 200 | Batch P: was any authenticated user (host contact details); admin host-profile page only |

## Public catalogue (Batch P — `docs/batch-p-catalogue.md`)
`GET /properties/front/dynamic`, `/properties/dynamic`, `/properties/search-properties` (no dates), `/properties/countstays` are edge-cached under the `listings` tag (`CDN-Cache-Control: public, s-maxage=300, stale-while-revalidate=120`, browsers `max-age=0` + ETag) and serve a card projection; the chat widget's `embedding*` fields never leave the API (model query middleware + sanitiser) and cannot be written through it (undeclared → strict mode drops them). `?fresh=1` + `x-catalogue-fresh: <CATALOGUE_FRESH_SECRET>` bypasses the cache for the site server; without the secret it is a 400.

### Listing reference inventory (evidence for the delete design)
Repo-wide search of `ListingProperty`, `propertyId`, `property:` across models/controllers/services/jobs: `Booking.propertyId`, `BookingNight.propertyId`, `Payment.propertyId`, `HostPayout.propertyId`, `Review.property`, `HostReview.property`, `ExternalCalendar.propertyId`, `BookingInterest.propertyId` (String), `KycHostForm`/`BankDetail` (keyed by host, untouched), `Chat` (by bookingId), legacy `Calendar/Share/Host/Experience` (reference the unused `Property`/`Experience` models). Wishlist lives in the customer site's localStorage; chat conversations live in the separate `majestic-chat` database and already degrade to "Property" when a listing is missing. Writers that can target a pending listing: host calendar blocks and iCal imports — both re-check the listing after inserting and withdraw when it is gone.

## Admin audit trail (`adminauditlogs`)
`user.rename` (before/after names), `listing.delete` (host id, title, photo keys, cleanup and sweep outcomes), `kyc.document.view`, `kyc.document.download` (log id, host id, mime, bytes), `kyc.document.manual_verify`. Written in the same transaction as the change or before the bytes leave the server; never emails, document bytes or full URLs. Indexes: `{targetId, createdAt}`, `{action, createdAt}` — created by `scripts/ensure-indexes.js` together with `kyclogs {userId, type, createdAt}` (`--explain` proves the IXSCAN).

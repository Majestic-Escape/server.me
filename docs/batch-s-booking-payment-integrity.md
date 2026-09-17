# Batch S — server-side booking & payment integrity

Status: implemented on branch `batch-s` (worktree `server.me-batch-s`, cut from
`origin/dev` @ `112e821`). Not pushed, not deployed.

## 1. Threat model (what the browser could do before this batch)

| # | Finding (reconfirmed on `origin/dev`) | Effect |
|---|---|---|
| 1 | `createBooking` spreads `req.body` into `Booking` | client sets `price`, `subTotal`, `nights`, `status`, `paymentStatus`, `userId`, `hostId` |
| 2 | `createOrder` charges the client-supplied `amount` and never loads the booking | pay ₹1 for any stay |
| 3 | `verifyPayment` checks only the HMAC; never compares Razorpay `amount`/`order_id`/`currency` to the booking | a valid signature for a ₹1 order "pays" a ₹58,500 booking |
| 4 | `markBookingAsPaid` sets `paymentStatus: paid` unconditionally, no ownership, no Payment check | mark any booking paid without paying |
| 5 | `confirmBooking` / `confirmInstantBooking` / `updateBooking` (`PUT`) write status/body unconditionally | any authenticated user confirms/edits any booking |
| 6 | Overlap check counts only `paymentStatus: paid`, `findOne` → `save()` (no transaction / unique index); `markBookingAsPaid` never re-checks | two concurrent bookings for the same nights both succeed and both get paid |
| 7 | Host/admin cancel/terminate never read `req.user` | any user refunds any booking (real Razorpay refunds) |
| 8 | Refund flows: no `paid` precondition, no `refundId`, status set before the refund call | double refund on retry; cancelled-but-unrefunded on failure |
| 9 | `create-order`, `verify-payment`, `unblock-dates`, `schedule-cron` have no auth | anonymous payouts trigger; anonymous unblocking of host dates |
| 10 | Admin tokens have no `admin` claim; middleware sets `req.user = decoded` for any non-user token without a DB lookup | no server-side notion of "admin" at all |
| 11 | Malformed ObjectIds reach Mongoose | `CastError` → 500 (`/properties/:id`, every booking route) |
| 12 | Emails go to client-supplied `userEmail` / `hostEmail` | notification spoofing |

## 2. Design

### 2.1 One pricing authority — `services/pricing.js`
`quoteStay({ basePrice, nights })` reproduces **exactly** the formula the
checkout charges today (`BookStay.jsx#calculateTotal`, matched by
`utils/tax.js`): `subTotal = basePrice × nights`, `serviceFee =
round(subTotal × 0.12)`, `gst = basePrice ≤ 7500 ? round(subTotal × 0.05) :
round(subTotal × 0.18)`, `total = subTotal + serviceFee + gst`. Rupee values
are computed with the same `Math.round` steps (parity), then `totalPaise =
Math.round(total × 100)` is the only figure used for Razorpay and for
equality checks. The card / widget / invoice display formulas are untouched.

### 2.2 Server-authoritative booking creation
`POST /booking/` whitelists fields (`propertyId, checkIn, checkOut, adults,
children, infants, guestData, cancellationPolicy, action`). The server
derives `userId` from the token, loads the listing (must exist, be
`active`, and for guests have a host), validates dates (UTC calendar days,
`checkIn < checkOut`, not in the past, ≤ `MAX_BOOKING_NIGHTS`, ≤
`MAX_BOOKING_HORIZON_DAYS`), guest counts (adults ≥ 1, others ≥ 0, `adults +
children ≤ listing.guests`), computes `nights`, `price`, `subTotal` from the
quote and `cancellationPolicy` from the listing. `action: "host"` (calendar
blocks) is allowed only for the listing's host and is stored as today
(`status: confirmed`, `paymentStatus: paid`, `price: 0`) so every existing
reader (`check-dates`, `blocked-dates`, calendars) keeps working.

### 2.3 Race-safe inventory — `BookingNight`
```
BookingNight { propertyId, date (UTC midnight), bookingId, kind, expiresAt }
unique index (propertyId, date)
```
Reservation = (1) reclaim expired holds for the wanted nights
(`deleteMany({... expiresAt: {$lte: now}})` — expiry is decided by comparison,
never by Mongo TTL), (2) `insertMany` one row per night with a
pre-generated `bookingId`, (3) on any duplicate-key error delete our own rows
and answer **409**, (4) only then save the `Booking`. The unique index makes
a single winner a database invariant. Holds carry `expiresAt = now + 30 min`
while unpaid; `create-order` re-asserts and extends the hold; a successful
payment makes the rows permanent (`expiresAt: null`). Cancel / reject /
terminate / unblock delete the rows. A crash between steps leaves only
expiring holds. Adjacent stays (`A: 10→12`, `B: 12→15`) never share a night
because checkout day is excluded, matching the existing `check-dates`
semantics. The legacy overlap query stays as a secondary check for rows that
predate the backfill.

### 2.4 Booking idempotency
The unique night index is also the idempotency lock: when a 409 is caused by
nights that belong to a *pending, unexpired* booking of the **same user with
the same dates**, the existing booking is returned (200) instead of a
conflict. An optional `Idempotency-Key` header is honoured too (`Booking.
idempotencyKey`, unique sparse).

### 2.5 Payment state machine
* `POST /payment/create-order` (auth, booking owner, booking `pending/unpaid`,
  listing `active`, hold still owned): the amount is the **fresh** server
  quote. If the quote no longer equals the booking's stored quote → **409
  `PRICE_CHANGED`** with the new quote (the booking is *not* silently
  repriced). If the client's `amount` disagrees → **409 `AMOUNT_MISMATCH`**.
  One open order per booking: a placeholder `Payment` row is inserted under
  a partial unique index `(bookingId) where status = "created"` *before*
  Razorpay is called; a concurrent request that loses the insert waits for
  and returns the winner's order; a retry returns the existing open order.
* `POST /payment/verify-payment` (auth, owner): HMAC, then the payment is
  fetched from Razorpay and `order_id`, `amount` (integer paise), `currency`
  and status (`captured`/`authorized`) are compared with the stored order.
  Transition is conditional: `Payment {status: created} → paid`, then
  `Booking {paymentStatus: unpaid} → paid` (+ `status: confirmed` for
  instant-book listings), then nights made permanent. Replays return the
  current state; a signature for another order/booking cannot match.
* Webhook `payment.captured` / `order.paid` runs the same
  `applyPaymentSuccess` — callback and webhook racing produce one transition.
* `POST /booking/updateStatus` (legacy client call after payment) now only
  sends the notifications/invoice, once (`notifications.paidAt` guard), and
  only if the server already recorded the payment.
* Refunds go through one `refundBookingPayment()`: conditional
  `paid → refund initiated` (a second caller finds no `paid` row and gets the
  current state), Razorpay refund, then `refund initiated → refunded` with
  `refundId`; a Razorpay failure reverts to `paid`; a DB failure after a
  successful Razorpay refund is logged with the `refundId` for reconciliation
  and retried once.

### 2.6 Authorization
`middleware/authz.js`: `resolveActor(req)` turns the decoded token into
`{ kind: "user" | "admin", id }` — admin only if the id exists in the `Admin`
collection (or a `User` with `role: "admin"`) and is not banned. Guards:
`requireAdmin`, `requireBookingGuest`, `requireBookingHost`,
`requireBookingParty` (guest, host or admin), `requireListingHost`.
Applied per the matrix in §4. Cron: `Authorization: Bearer $CRON_SECRET`.

### 2.7 Input validation
`middleware/validateObjectId.js` for `:id` params (400/404 instead of
CastError 500) on properties, booking and payment routes; body ids validated
in the controllers.

## 3. Compatibility (S ships before D)
The deployed (pre-D) `user.website` sends the same request shapes S accepts
(`Authorization` header on create-order/verify-payment is already sent;
`amount` is still accepted and verified). New failure modes for the old
client: 409 on price change / availability loss → "Unable to initiate
payment" / "someone has already booked" toasts. No shape change is required
in the frontends; Batch D's checkout already handles `PRICE_CHANGED` by
re-quoting. Rollout: set `CRON_SECRET` → deploy S → run backfill (§5) →
create the unique index → deploy D.

## 4. Route/action matrix
See `docs/batch-s-authz-matrix.md` (generated from the route table).

## 5. Migration / backfill
`scripts/backfill-booking-nights.js --dry-run|--apply` materialises nights
for every booking that blocks inventory today (`status ∉ {rejected,
cancelled}` and (`paymentStatus: paid` or host block or iCal) and `checkOut >
now`), reports conflicting rows without choosing a winner, is idempotent
(insert-if-absent), and only creates the unique index when zero conflicts
remain (`--create-index`). Rollback = drop the `bookingnights` collection and
redeploy the previous backend; the collection is additive.

## 6. Database cost / performance (M0, zero revenue)

Per guest booking (average stay ≈ 2–3 nights):

| Step | Before | After |
|---|---|---|
| create booking | 1 `findOne` (overlap) + 1 insert | 1 listing read + 1 `deleteMany` (expired holds, indexed) + 1 `insertMany` (N night rows, one round trip) + 1 `exists` (legacy overlap, indexed) + 1 insert |
| create order | 1 user read + Razorpay + 1 insert (**per attempt**) | 1 booking read + 1 listing read + 2 small night ops + 1 `findOne` + 1 insert + Razorpay + 1 update (retries reuse the row: **0** extra gateway orders) |
| verify | Razorpay fetch + 1 update | Razorpay fetch + 2 reads + 3 conditional updates |
| refund | 3 updates + Razorpay (**per call**, unguarded) | 1 conditional update + Razorpay + 2 updates (**once**) |
| cancel/reject/terminate | 2–4 updates | 1 read + conditional update + `deleteMany(bookingId)` |

Storage: one 80-byte document per night held; indexes `(propertyId, date)`
unique and `bookingId`. At the current volume (tens of bookings/month) this
is a few kilobytes. No polling, no new services, no Redis. Payment/booking
reads gained indexes (`payments.bookingId` partial, `bookings.propertyId+
checkIn+checkOut`) that the existing overlap/report queries already needed.
The only intentional extra network call is the pre-payment re-quote inside
`create-order` (one listing read).

## 7. Rollout (production) — Batch S.1 cutover, no backfill race

**This section is the single canonical order for pushing, deploying and
cutting over.** Pushes mirror deploys: (1) user.website `compat/listing-auth`,
(2) server.me `batch-s`, (3) user.website `shriraj-dev` and admin.site
`shriraj-dev` (Batch D + S.1 UI). Anything elsewhere that lists a different
order is superseded by this table.

Why the earlier sequence had a race: the backfill materialises night rows
for bookings that exist *when it runs*; the pre-S backend keeps writing
bookings (and Razorpay orders) until the Batch S deployment takes every
request, so anything written in between had no night rows. Batch S's
secondary overlap check protected *creates* against those rows, but two
unpaid checkouts straddling the switch could both be paid. The sequence
below closes that: the booking-write gate (`scripts/booking-gate.js`,
honoured only by Batch S) stops Batch S from taking inventory until a
delta reconciliation has run *after* the old backend can no longer write.

| Step | Command / action | Who writes bookings meanwhile |
|---|---|---|
| 1 | Set `CRON_SECRET` on Vercel (`server.me`); keep `RAZORPAY_MOCK`, `EMAIL_DISABLED`, `INVOICE_PDF_DISABLED` unset; optionally `OPS_ALERT_EMAIL` (defaults to `ADMIN_EMAIL`). | old backend |
| 2 | Deploy the frontend compatibility commit (user.website `compat/listing-auth`). | old backend |
| 3 | `node scripts/backfill-booking-nights.js` (dry run) → review the conflict report → resolve by cancelling one side of each genuine double booking (there are none today: 2 future-blocking rows in production) → `node scripts/backfill-booking-nights.js --apply`. **Not** `--create-index` yet. | old backend |
| 4 | `node scripts/booking-gate.js --on --reason="Batch S cutover"`. The old backend ignores it. | old backend |
| 5 | Deploy Batch S. From the moment the alias switches, `POST /booking`, `POST /payment/create-order` and `POST /booking/admin-modify` answer **503 MAINTENANCE** (the checkout shows "Bookings are briefly paused…"); browsing, reads, `verify-payment` and the webhook keep working, so a customer already on the gateway page still completes. | nobody takes new inventory |
| 6 | Wait for in-flight old-backend invocations to drain (Vercel function max duration; 5 min is generous). | nobody |
| 7 | Delta reconciliation: `node scripts/backfill-booking-nights.js --apply --create-index`. It inserts night rows for every inventory-blocking booking the old backend wrote after step 3, replaces rows left by expired holds, reports (and refuses the index on) any night owned by a live Batch S booking or hold, retires stale open orders, and creates all indexes (`bookingnights`, `payments` one-open-order, `bookings.idempotencyKey`, `bookings.needsAttention`, `hostpayouts.bookingId`). Re-run until it exits 0. | nobody |
| 8 | Confirm the running backend logs `[startup] booking/payment integrity indexes present` (redeploy or hit any endpoint after a cold start). | nobody |
| 9 | `node scripts/booking-gate.js --off`. | Batch S |
| 10 | (Optional) enable `payment.captured` / `order.paid` on the Razorpay webhook. Deploy Batch D (`shriraj-dev`). | Batch S |

Expected write pause: steps 5–9, ~10 minutes. Reads are never interrupted.

Proof the delta cannot miss a row: (a) after step 6 nothing but Batch S
writes bookings, and Batch S writes night rows atomically with every
booking or refuses it; (b) with the gate on, Batch S takes no new inventory
during step 7, so the set of inventory-blocking bookings the reconciliation
enumerates is complete and stable except for payments completing on
already-held or already-enumerated bookings, which are idempotent against
it (own rows exist → counted as present; pre-S bookings paid through
`verify-payment` re-secure their nights themselves); (c) the run is
idempotent and refuses to create the unique index while any night has two
live claimants, so a genuine straddle (both sides paid) surfaces as a
conflict for a human, never as a silent double booking. Tested in
`tests/batch-s/cutover.test.js` against gap rows of every kind (paid guest
booking, host block, iCal import) overlapping a paid Batch S booking, a
live hold and an expired hold.

Rollback: `node scripts/booking-gate.js --off` (the old backend ignores it
anyway), redeploy the previous backend build; the additive collections,
fields and indexes are ignored by it. `--rollback` drops `bookingnights`
only if the collection must not persist.

## 8. Evidence summary (all on isolated in-memory MongoDB + mock gateway)

* `npm test` — 65 integration tests (S.1 added cutover/gate, hold semantics per mode, attention queue, payout cycle): 20 simultaneous same-night bookings →
  1×201 / 19×409 / 1 booking / 3 night rows; 20 identical submissions from
  one user → 1 booking; 10 concurrent create-order → 1 gateway order;
  verify ×3 + webhook ×2 racing → one transition, one payment row;
  ₹1 / tampered amount / wrong currency / wrong order / failed status /
  forged signature → refused, order state untouched; host terminate +
  admin cancel racing → one gateway refund; gateway refund failure → state
  unchanged; DB failure after gateway refund → retried and recorded;
  expired hold reclaimed immediately; hold lost before payment → paid but
  flagged, never confirmed; 40-case authorization matrix; backfill dry-run /
  apply / idempotent rerun / index refused on conflict / index created /
  rollback.
* `tests/batch-s/e2e-server.js` + the Batch D checkout in a real browser
  (Playwright, gateway script blocked, mock gateway signing real HMACs):
  triple-click Confirm → one booking priced ₹35,100 by the server, one
  order (reused across attempts), one verified payment, 3 permanent nights,
  emails 34/35/36/36 once, summary page correct; host repricing between view
  and Pay → first Confirm halted ("changed to ₹31,200"), second Confirm
  paid ₹31,200 — the stale figure was never charged.
* `npm run check:js` — 0 undefined identifiers across 132 backend files
  (4 latent ReferenceErrors fixed, including the payout cron's
  createPayout return path).

## 9. Booking state transitions — pre-S vs Batch S

Legend: **I** instant listing, **M** request-to-book (manual). Inventory
column = when the nights are blocked for other guests.

| Step | Pre-S (origin/dev) | Batch S / S.1 | Inventory (S) | Difference |
|---|---|---|---|---|
| Guest submits checkout | client-supplied row incl. `price`, `nights`, `status`, `paymentStatus`; overlap check against *paid* rows only | server prices, validates, stores `pending/unpaid` with a **30-min hold** | blocked from now (hold) | **intentional**: hold; price/status from server |
| Double submit / retry | second row | same booking returned (`replayed`) | unchanged | intentional |
| Pay clicked (create-order) | order for the client amount, new Payment row per click | order for the server quote; hold re-armed 30 min; one open order reused; `PRICE_CHANGED` if repriced | hold extended | intentional |
| Hold expires (abandoned) | n/a (nothing was blocked) | nights free again; the pending booking stays payable later if still free | released | intentional (matches "pending never blocked" before) |
| Payment verified | Payment `paid`; booking untouched until the client calls updateStatus | Payment `paid` **and** booking `paid`; **I** → `confirmed`, **M** → `pending`; amount/order/currency/status checked | permanent | intentional: server, not client, flips the state |
| Client calls `updateStatus` | sets `paid` (unconditionally), e-mails | e-mails once (409 if not paid / under review) | — | same e-mails, now once |
| Client calls `instant/confirm` (**I**) | sets `confirmed` unconditionally | no-op if already confirmed; 409 for **M** or unpaid | — | same end state |
| Host confirms (**M**) | sets `confirmed` unconditionally, anyone | `pending/paid → confirmed`, host or admin only; e-mails 10/18/19 once | — | same end state, authorised |
| Host rejects (**M**) / terminates | status set **before** the refund; refund per call | refund first (once), then `rejected` / `cancelled`; e-mails 11/16/17 or 13/14/15 | released | intentional: no rejected-but-paid rows |
| Guest cancels | `cancelled`; refund if inside policy window | same rule (moderate = days, flexible = hours), refund once, guest only | released | authorised, once |
| Admin cancels | `cancelled` + refund, anyone | admin only, refund once | released | authorised |
| Payment lands but nights lost | impossible to detect (double booking) | booking `pending/paid`, `needsAttention: inventory_conflict`, ops alert once, admin queue; no confirm/notify until resolved | other booking keeps them | **new**: human decision, no auto refund |
| Pre-S open order paid at a client amount | accepted | Payment `paid`, booking **not** paid, `needsAttention: amount_mismatch`, ops alert; admin cancel refunds | hold as is | **new** |
| Host block | row `confirmed/paid/₹0` by anyone | same row, listing host only | permanent | authorised |
| iCal import | rows `confirmed/paid` | same + night rows, best effort on overlap | permanent | same |

## 10. Hold semantics by mode (S.1)

| Mode / event | Blocked from | Released / permanent |
|---|---|---|
| Instant: create | create (30 min hold) | permanent at payment; released on guest cancel, host terminate, admin cancel, hold expiry |
| Request-to-book: create → pay → host decision | create (hold) → permanent at payment, however long the host takes | released on reject / cancel |
| Pay clicked late (hold expired, nights free) | re-held at Pay for 30 min | as above |
| Pay clicked late (nights taken) | — | `409 DATES_UNAVAILABLE`, nothing charged |
| Payment completes after the hold was lost | — | flagged `inventory_conflict`; other booking keeps the nights |
| Retry / double submit | same hold, extended | — |
| Abandoned checkout | until expiry (30 min) | expiry — the pending row itself never expires (unchanged) |
| Host block / iCal | immediately, permanent | unblock / calendar removal |

`/booking/check-dates` now includes live holds, so the calendar never offers
a night the server would refuse.

## 11. Payout cron audit (S.1)

Findings on origin/dev, all fixed in `services/payouts.js`:
1. **Duplicate payout on overlapping runs** — no unique key on
   `hostpayouts.bookingId`; two runs each created a row and each called the
   gateway. Now: unique index + atomic per-row claim (`lockedAt`).
2. **Duplicate payout after an ambiguous outcome** — a 5xx/timeout marked
   the row `failed`; the next day's retry created a second payout under a
   fresh random idempotency key. Now: ambiguous outcomes stay `pending` with
   `lastError`; every retry first lists gateway payouts by
   `reference_id = bookingId` and adopts a live one; idempotency keys are
   deterministic (`bk_<bookingId>_<attempt>`).
3. **Paid hosts for refunded stays** — selection was `status: confirmed`
   only (production has a `confirmed/refunded` row). Now: `confirmed` +
   `paid` + local guest booking.
4. **Payout id lost after a DB failure** — now written with one retry and a
   CRITICAL log.
5. Latent `ReferenceError` in `createPayout` (fixed in S).
Unchanged: window (check-in day, retried two days), amount rule
(`subTotal − MAJESTIC_COMMISSION %`; the hostOffer/KYC-age branch is kept
verbatim although `User.kyc` is a Boolean so it never fires), IMPS to
`BankDetail.fundId`, webhooks advancing `initiated/paid/rejected/reversed`.
Not changed (business decision): a `failed`/`reversed` payout is retried
only while its check-in is inside the 3-day window; afterwards it stays as
is (47 of 65 production rows are `pending` with no gateway id from the
period before bank details existed).

## 12. Decisions that need the owner

* **Stay length / booking horizon**: neither the calendar nor the old
  backend limits them (production max: 32 nights, 120 days ahead). Batch S
  no longer does either by default; `MAX_BOOKING_NIGHTS` /
  `MAX_BOOKING_HORIZON_DAYS` enable a limit if wanted. The only fixed rule
  is the one-year abuse ceiling per request (blocks already had it).
* **Hold length**: 30 minutes (`BOOKING_HOLD_MINUTES`).
* **Attention-queue outcomes** are manual: refund (admin cancel) or keep.
* **Stuck payouts** older than the 3-day window are not retried.

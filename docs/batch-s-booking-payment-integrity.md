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

## 7. Rollout (production)

1. Set `CRON_SECRET` on the Vercel project (the payout cron is refused
   without it) and keep `RAZORPAY_MOCK`, `EMAIL_DISABLED`,
   `INVOICE_PDF_DISABLED` **unset**.
2. Deploy the frontend compatibility commit (user.website `compat/listing-auth`):
   adds `Authorization` headers to listing create/update/kyc/timings and
   calendar-sync calls. Harmless against the old backend.
3. Run `node scripts/backfill-booking-nights.js` (dry run) against production
   with `DB_URI`; review the conflict report; then
   `--apply --create-index`. Additive: the old backend ignores the new
   collection and indexes.
4. Deploy Batch S (`batch-s`). Startup logs `[startup] booking/payment
   integrity indexes present`; if it logs CRITICAL, re-run step 3.
5. (Optional) enable `payment.captured` / `order.paid` events on the existing
   Razorpay webhook; the handler is idempotent with the client callback.
6. Deploy Batch D (`shriraj-dev`), which understands the new 409 codes.

Rollback: redeploy the previous backend build; `node scripts/backfill-
booking-nights.js --rollback` drops the additive `bookingnights` collection
(only needed if the collection should not persist). Payment rows retired as
`failed` by the backfill were stale unpaid orders and need no reversal.

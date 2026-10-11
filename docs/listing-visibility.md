# Listing visibility and publication integrity

Who can read a listing that is not public, and how a listing goes live
(or stops being live). Release 1 of the "more stays from this host / similar
stays nearby" work; the related-stays rows build on these rules.

## Definitions

- **Public listing**: `status: "active"` **and** `ban ≠ true`
  (`utils/listingProjection.js` → `publicListingFilter()` /
  `isPublicListing()`). Every public read uses this: catalogue, search, place
  index / suggestions, the detail and calendar read policy.
- **Not public**: a draft (`incomplete`), in review (`processing`), delisted
  (`inactive` + `delist: "host" | "admin"`) or under a moderation ban
  (`inactive` + `ban: true`).
- **Invariant**: a listing is public only while its host account exists and is
  neither banned nor deactivated.

## Read policy (`services/listingAccess.js`, `utils/sanitizeResponse.js`)

| Viewer | Public listing | Listing that is not public |
| --- | --- | --- |
| anyone | today's public view | **stub** (`access: "public"`) |
| the listing's host | today's response | today's response (`access: "owner"`) |
| an **active** admin | today's response | today's response (`access: "admin"`) |
| guest with a confirmed + paid booking (any time; not iCal rows, not host blocks) | today's public view | **operational view** (`access: "bookedGuest"`) |

- **Stub**: `_id`, masked `title`, first photo, `propertyType`, `placeType`,
  `basePrice`, `address.{city,district,state,country}` (no point at all),
  `host.{_id,firstName,profilePicture}`, `averageRating`, `reviewCount`,
  `status`. It covers exactly the fields the chat pages, contact-host, checkout's
  "no longer available" check and the chat server's host check read.
- **Operational view**: `_id`, title, first photo, type, the address as
  precise as the route allows (approximate on the detail route; exact for a
  confirmed + paid guest on the booking routes), check-in / check-out hours,
  cancellation terms, the house rules **recorded on the booking**
  (`Booking.listingSnapshot`, captured when the booking is made), the public
  host fields. Never the current `description`, rules or amenities — a past
  guest must not read the host's unpublished draft. Bookings made before the
  snapshot existed show no rules (intentional sparse fallback).
- Both views are **built from the sanitized full document** (masking needs the
  street / `line1` / `line2`) and are allow-lists.
- The access marker is sent only for a listing that is not public, as a
  top-level `access` next to `data` on `GET /properties/:id`.

Routes:

| Route | Auth | Notes |
| --- | --- | --- |
| `GET /properties/:id` | `authMiddleware.soft` | lazy: the session is resolved only for a listing that is not public (no user lookup on the common path); a stale / invalid token is anonymous (never a 401 on a public page) |
| `GET /prop-listing/:id` | `authMiddleware.optional` (unchanged codes) | owner / admin checked first (stored document); `?hostEmail=` only narrows the owner's own read |
| `GET /booking/check-dates/:id`, `/booking/blocked-dates/:id` | `soft` | not public + not entitled → `404 LISTING_NOT_PUBLIC` before any calendar / SyncGuard work; unknown id unchanged (empty) |
| `GET /properties/get-timings/:id` | host or admin | `{ _id, checkinTime, checkoutTime }` only (was the raw listing to any signed-in user) |
| `GET /properties/id-and-name/:hostId` | admin | cards, newest first, ≤ 50 (was anonymous full documents; no client used it) |
| `GET /properties/admin/active` | admin | was any signed-in user (raw documents with exact streets); the admin reviews page is the only caller |
| `GET /properties/active/:hostId` | signed in | the host themself / an admin: unchanged; anyone else: the host's public cards |

Card reads select `CARD_MASK_CONTEXT` (`address.street`, `line1`, `line2`) next
to `CARD_PROJECTION` so `sanitizeProperty` can mask a title quoting the
listing's own address; the sanitizer strips those fields again.

`authz.isAdmin` is false for a deactivated (or banned) admin record — in
`requireAdmin`, every "host or admin" check, the read policy, booking views and
the PII response filter. `delist` (moderation provenance) is stripped from every
public / guest view like `ban`.

## Publication (`services/listingPublish.js`)

The only code that sets `status: "active"`, changes a listing's host, or
bans / unbans a host's listings. Each operation is one MongoDB transaction that
first writes the host's user document (`listingFence += 1`); concurrent
operations on the same host conflict there and are retried against the
winner's committed state (`withTransaction`). No compensation, no
write-then-verify: a crash before commit applies nothing. Cache notifications
and e-mails run after the commit, each failure-isolated.

| Operation | Allowed |
| --- | --- |
| admin approve / admin create as active | `processing` or `inactive` (not banned) → `active`, host eligible (exists, not banned, not deactivated); clears `delist`; already-live → no-op (no write, no e-mail) |
| host relist (`/host/reactivate`) | only `inactive` + `delist: "host"` + not banned, by its host; admin-delisted keeps the old `200 {listing:"adminDelist"}` answer; anything else `409` (`LISTING_NOT_RELISTABLE`, `LISTING_NEEDS_REVIEW`, `LISTING_BANNED`) |
| host delist (`/host/delist`) | only a live listing, by its host (ownership in the write filter); records `delist: "host"`; `409 LISTING_NOT_LIVE` otherwise |
| admin delist (`/admin/delist`) | any listing except a never-submitted draft (`409`) → `inactive`, `delist: "admin"`, ban marker cleared (the admin decision replaces it) |
| ban (`PATCH /guests/ban/:id {active:true}`) | account banned + live listings → `inactive, ban:true`, one transaction |
| unban (`{active:false}`) | account restored; listings still carrying the ban marker (= the ones the ban took down) → `active`; one an admin delisted meanwhile lost the marker and stays delisted |
| host reassignment (admin edit of `host`) | both hosts fenced (ascending id); a live listing only to an eligible host; conditional on the old host / status; clears the ban marker |

The delist kind comes from the route; `?hostSide` is ignored. `active` must be
a strict boolean on the ban route (`400 INVALID_BAN_FLAG`). Generic edits never
write `ban` / `delist`, and an admin's generic edit never changes `status` (the
edit page sends back the status it loaded — stale after a concurrent approve /
delist / ban); an echoed `host` is ignored; a host edit is
conditional on `{_id, host: caller}` at the write. `PUT /hosts/:id` refuses a
`status` change (`400 STATUS_NOT_EDITABLE`) — standing changes go through the
ban flow. The never-routed `toggleHostStatus`, `bulkAction` and
`bulkActionPListings` handlers were removed.

Legacy rows: an `inactive` listing with neither `delist` nor `ban` recorded
(delisted before provenance existed, or set inactive by an admin edit) cannot be
relisted by its host; it needs an admin approval.

## Audit (release gate)

`node scripts/audit-listing-invariants.js [--confirm-db=<name>] [--json]` —
read-only; exit 2 on a hard violation (banned / deactivated / missing host with
a live listing, `active` + `ban:true`), and lists the informational legacy rows.
Running it against production, and any repair it suggests, needs the owner's
explicit authorisation.

## Tests

`tests/batch-s/listing-visibility.test.js`, `tests/batch-s/listing-publish.test.js`
(deterministic interleavings via `listingPublish.__setTestHooks`).

# Batch P — public catalogue: payload diet, edge caching, change notifications

## Why
On 2026-09-18 the home page's listing request (`GET /properties/front/dynamic`) weighed 674 KB for 16 listings: 93 % of it was the chat widget's `embedding` vector (3072 floats per listing, written straight into `listingproperties` and read back with `$vectorSearch`), which the API never uses but every `.lean()` query returned. Nothing was cacheable (`no-store` on every response), `listingproperties` had no indexes, and the host dashboard's stage call read the whole collection on every load.

## What the API guarantees now
- **The vector never leaves the API and can never be written through it.** `models/ListingProperty.js` excludes `embedding`, `embeddingUpdatedAt`, `embeddingVersion` from every `find*`/populate unless a caller selects `+embedding`; aggregations that return listing documents `$project` them out; `utils/sanitizeResponse.js` strips them again. The paths stay undeclared on the schema, so strict mode keeps dropping them from `$set` / `new Model(body)` — a request body can neither overwrite nor null the widget's vector (`tests/batch-s/catalogue.test.js`, "vector").
- **Card projection** (`utils/listingProjection.js`) for `front/dynamic`, `dynamic` and `search-properties`; envelopes unchanged; pages capped at 50; newest first with an `_id` tiebreaker (`{status, createdAt, _id}` index → `SORT_MERGE`, no in-memory sort — `scripts/ensure-indexes.js --explain`).
- **Date searches use the night ledger** (`bookingnights`: held = `expiresAt` null or in the future; kinds booking/block/ical). Cancelled bookings and expired holds no longer hide listings.
- **Edge cache** (`utils/httpCache.js`) only on the three pure-public reads, only on 200:
  `Cache-Control: public, max-age=0, must-revalidate` (browsers revalidate; Express ETags → 304), `CDN-Cache-Control: public, s-maxage=300, stale-while-revalidate=120` (Vercel's edge for the API domain **and** the customer site's edge, which proxies `/api/v1/*` through an external rewrite), `Vercel-Cache-Tag: listings`, `Vary: Origin`. Date-filtered searches, `/properties/:id`, every host/admin read and every error stay `no-store`.
  Kill switch: `CATALOGUE_CACHE_DISABLED=1` — on Vercel an env change applies to the **next deployment**, so it is "set → redeploy/promote", not instantaneous; for an emergency before that, promote the previous known-good deployment.
- **Fresh bypass for the site server**: `?fresh=1` + `x-catalogue-fresh: <CATALOGUE_FRESH_SECRET>` → `no-store` (used when the site regenerates a page after a purge, so a stale edge copy can never refill its Data Cache). Without a valid secret the answer is **400** — never a cacheable status, so the parameter can neither prime a stale entry nor bypass the cache for anyone else. Any CDN can still be made to miss with unknown query strings; that is no worse than the previous fully uncached state and each miss is now a ~10 KB indexed read.

## Change notifications (`services/listingChanged.js`)
`notifyListingChanged(ids, reason)` — awaited by the write handler, never throws, ≤ 4 s total (1.5 s per request), logs ids and outcome codes only — runs in parallel:
1. `invalidateByTag(["listings", "listing:<id>", …])` from `@vercel/functions` (the API project's edge; runtime credentials, no token; no-op outside Vercel), 16 tags per call;
2. `POST $SITE_REVALIDATE_URL` with `x-revalidate-secret: $REVALIDATE_SECRET` and `{ tags }`, 20 tags per call (`listings` + 19 ids first, then 20 per batch).

**Semantics, stated honestly:** a purge marks entries STALE. The next request may still be served the old copy while the edge revalidates in the background; the request after that is fresh. The 5-minute TTL (+ 2 minutes stale-while-revalidate) is the bound when a notification is lost. Booking, checkout and `/properties/:id` are never cached, so a stale card cannot bypass booking correctness.

Env (server project): `SITE_REVALIDATE_URL=https://majesticescape.in/api/revalidate`, `REVALIDATE_SECRET`, `CATALOGUE_FRESH_SECRET`. Unset → the site call is skipped (one log line); the TTL is the bound.

## ListingProperty mutation inventory
Predicate: **notify when the listing was publicly visible before the write or is after it** (`status === "active"`). Everything else leaves the caches alone — a host clicking through the draft wizard must not cause misses.

| Write path | Route | Class | Notifies |
|---|---|---|---|
| `approveListing` | `PATCH /properties/admin/approve/:id` | PUBLIC_CHANGE (processing → active) | ✔ `approve` |
| `deListing` host side | `PATCH /properties/host/delist/:id?hostSide=true` | PUBLIC_CHANGE | ✔ `delist` |
| `deListing` admin side | `PATCH /properties/admin/delist/:id` | PUBLIC_CHANGE | ✔ `admin-delist` |
| `reactivate` (now persists the status it reports) | `PATCH /properties/host/reactivate/:id` | PUBLIC_CHANGE | ✔ `reactivate` |
| `adminUpdateListingProperty` | `PUT /properties/admin-update-property/:id` | PUBLIC_CHANGE when active before/after, else NON_PUBLIC | ✔ conditional `admin-update` |
| `updateListingProperty` (wizard PUTs on every step) | `PUT /properties/update-listing-property/:id` | PUBLIC_CHANGE when active before/after, else NON_PUBLIC (drafts) | ✔ conditional `host-update` |
| `timing` | `POST /properties/timings` | PUBLIC_CHANGE when active (stay page) | ✔ conditional `timing` |
| `banUser` / unban | `PATCH /guests/ban/:userId` | PUBLIC_CHANGE for the flipped ids | ✔ `ban` / `unban` (ids read first, indexed) |
| `submitReview` / `updateReview` | `POST /review/`, `PATCH /review/update` | PUBLIC_CHANGE (rating on cards) when active | ✔ `review` / `review-update` |
| `PropListingController.createPListing` | `POST /prop-listing/` | PUBLIC_CHANGE only if created `active` | ✔ conditional `admin-create` |
| `PropListingController.updatePListing` | `PUT /prop-listing/:id` | PUBLIC_CHANGE when active before/after | ✔ conditional `admin-prop-update` |
| `adminDeleteListing` | `DELETE /properties/admin/:id` | NON_PUBLIC (only `processing` listings are deletable) | ✘ |
| `createListingProperty` | `POST /properties/create-listing-property` | NON_PUBLIC (`incomplete`) | ✘ |
| `updateKycProperty`, `completeKycForm`, `submitBankDetails` (`kycStatus` / `bankDetails` flags) | KYC / bank routes | NON_PUBLIC (flags are not on cards or stay pages) | ✘ |
| chat widget embedding writes | raw driver, outside this API | EMBEDDING_ONLY | ✘ |
| `scripts/*`, `delete.js`, `loadData.js` | operator scripts | manual | run `ensure-indexes`/purge by hand if used |

## How the customer site reaches the API (verified on production)
The site's browser code calls `https://server.majesticescape.in/api/v1` directly (cross-origin; `NEXT_PUBLIC_API_BASE_URL` in its build), which is why `Vary: Origin` matters: each origin gets its own edge entry with the right `Access-Control-Allow-Origin`. The site's `/api/v1/:path*` rewrite is dead in production (`BACKEND_URL` is unset there, so it points at `localhost` and Vercel answers 404 `DNS_HOSTNAME_RESOLVED_PRIVATE`) — nothing uses it, and the `CDN-Cache-Control` choice keeps working if it ever comes back. The site's server-side fetches (`/stay/[id]`, the home prefetch) use `BACKEND_URL || NEXT_PUBLIC_API_BASE_URL` and therefore also hit the API domain directly.

## Cold start
`index.js` no longer requires `aws-sdk` (a dead `s3` object) or `cors`; the S3 client (`config/digitalOcean.config.js`) is built on first use behind a proxy with the same call shape; `puppeteer-core` and `utils/generateInvoicePDF` (`@sparticuz/chromium`) load inside the handlers that render PDFs. `[boot] modules loaded in N ms` is logged at the end of `index.js` for before/after evidence; first-use tests cover the invoice module and the real S3 client's offline URL signing.

## Indexes (create-only, `scripts/ensure-indexes.js`)
`listingproperties`: `{status:1, createdAt:-1, _id:-1}`, `{host:1}`, `{hostEmail:1}` — plus the Batch A2 `kyclogs` / `adminauditlogs` indexes. `--explain` asserts the home query plan is `IXSCAN … SORT_MERGE` (no blocking `SORT`).

## Closed with the release
`GET /properties/` (bare, no live consumer) returns active listings only, as cards; `POST /review/` requires the booking's guest, `POST /review/guest` the booking's host, `PATCH /review/update` an admin (its only caller is the admin Reviews page).

## Flagged, not changed here
`getCustomSearch` `guests` filter uses `$gte` on the listing's `guests`; agenda opens a second Mongo connection per instance; `updatedAt` is never maintained; `bookingnights` has no date-first index (the date search scans the `{propertyId,date}` index — fine at current volume, re-measure with `explain` as bookings grow).

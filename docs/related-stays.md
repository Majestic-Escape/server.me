# Related stays ("More stays hosted by …", "Similar stays nearby")

## Why
A guest on a stay page had nowhere to go next. The page now offers the
same host's other stays and the stays around it. Website only (the mobile
app is not in use). Built on the listing visibility rules in
docs/listing-visibility.md: public inventory only, public data only.

## API contract (additive)
`GET /api/v1/properties/:id/related` (anonymous; no new data, every field is
already on the public search cards)

```json
{ "host": [Card ≤ 12], "nearby": [Card ≤ 8],
  "nearbyScope": "near" | "mixed" | "wide" | null,
  "sourceHostId": "<host id>" | null }
```

`Card` is an explicit allow-list (`cardOf`): `_id`, masked `title`,
`propertyType`, `photos` (the first one only), `address.{city, district,
state}` plus the **approximate** `latitude`/`longitude` (only as a valid
pair), `basePrice`, `guests`, `bedrooms`, `averageRating`, `reviewCount`;
nearby cards add `distanceKm` (0.1 km, rounded after ranking). Never: the
street, `line1`/`line2`, the exact point, the description, the host object or
e-mail. `sourceHostId` is public (the detail response carries the host id);
the site hides the host row when it differs from the host it is showing.

| Request | Response |
|---|---|
| malformed id | 404 (shared `validateParam`) |
| any query other than a single `fresh=1` | 400 `INVALID_PARAM`, before any DB work |
| `?fresh=1` without the site's `x-catalogue-fresh` secret | 400 (`utils/httpCache.js`) |
| unknown / not-public source (`status ≠ active` or `ban:true`) | 200 empty rows, `sourceHostId:null`, `no-store`, one indexed read |
| public source | 200, edge-cached 5 min under the `listings` tag (`CDN-Cache-Control: public, s-maxage=300, stale-while-revalidate=120`); the bypass (`?fresh=1` + secret) is `no-store` |
| race detected (below) | 200 empty rows, `no-store` |
| DB error / response-filter failure | 500, `no-store`, no CDN header or tag, no internals |

Every listing change already purges the `listings` tag
(services/listingChanged.js), so a delisted / banned / edited stay leaves
the rows with the next edge refresh (stale-while-revalidate: up to ~2 min
after the purge while the edge refetches).

## Ranking (services/relatedStays.js, pure, never mutates its input)
- **Distances use the public approximate points only** (`approximateLocation`,
  the same points the cards show). The exact location never influences what
  is returned or its order.
- **Host row** — the source's host (non-null), the source excluded; best
  first: rating key (`reviewCount > 0 ? averageRating : −1`) ↓, `reviewCount` ↓,
  `createdAt` ↓, `_id` ↑. At most 12.
- **Nearby row** — every other public stay with a valid point, minus the
  source and the host row:
  - near ring `d ≤ 25 km`, in 5 km bands (`[0,5) [5,10) [10,15) [15,20) [20,25]`);
  - only when fewer than 4 stays are that near, the wide ring
    `25 < d ≤ 250 km` (the search's own nearest-stays cut-off) is appended,
    in 25 km bands;
  - inside a ring: band ↑, similarity ↓, distance ↑, `_id` ↑. At most 8.
- **Similarity (0–3)**, valid values only (missing never matches missing):
  same normalised property type; price within ±35 % of the source's
  (inclusive, both > 0); guests within ±2 (inclusive, both > 0).
- Boundaries (25 / 250 km, band edges, 0.65× / 1.35×, ±2) are inclusive with
  a 1e-9 tolerance; the haversine's last-bit error is ≈ 1e-13 km.
- `nearbyScope` describes the cards actually returned: all ≤ 25 km →
  `near`, none → `wide`, both → `mixed`, no cards → `null`. The site shows
  "More options farther away" for `mixed` and `wide` — it never claims
  "within 25 km" or "closest".

## Reads and races
`relatedFor(id)` runs at most **three** listing queries and nothing else:

| | Query | Notes |
|---|---|---|
| Q1 | `findOne({_id, status:"active", ban≠true})`, ranking projection | `_id` index; a non-public source ends here (1 read) |
| Q2 | `find({status:"active", ban≠true})`, ranking projection (10 fields) | index `{status, createdAt, _id}`; no titles, text or photos |
| Q3 | `find({_id ∈ picked + source, status:"active", ban≠true})`, card projection + mask context + `host` | skipped when nothing was picked |

A listing may change between Q2 and Q3. Q3 re-checks everything it shows:
- the source must still be public with the **same host and the same public
  point** — otherwise the response fails closed (empty, `no-store`), so a
  reassigned stay never shows another host's stays under the old host's name;
- every card must still be public (a delisted / banned stay is dropped);
- host-row cards must still belong to the source's host (a reassigned stay
  leaves the host row and is not moved to "nearby");
- distances are recomputed from the points being emitted, the ranking runs
  again on what is left, and `nearbyScope` is recomputed.

Rows can only shrink (no refill query). After a concurrent change they may
not be the global optimum until the next refresh; they are always eligible
and correctly attributed.

## Cost (measured, tests/batch-s/related-stays.test.js)
- Edge hit: 0 DB operations. Edge miss: ≤ 3 listing queries, 0 other
  collections. Unknown / non-public id: 1 indexed read.
- The site renders the rows on the server inside the stay page's ISR
  (revalidate 3600 s, tags `listings` + `listing:<id>`), so most guests never
  reach the endpoint; the browser only calls it when the server render could
  not get the rows.
- Local (mongodb-memory-server, test client and API in one process), 15
  requests each: 2,000 live listings p95 ≈ 58–90 ms; 5,000 live listings
  p95 ≈ 126–163 ms (target 150 ms; at the target, not under it on every
  run). Payload ≈ 4.8–5.7 KB for 20 cards (budget 40 KB).
- At 5,000: Q2 ≈ 40 ms, public points ≈ 26 ms (one HMAC per listing),
  ranking ≈ 5 ms. Production had 19 live listings at the 2026-10-12 audit.

**Scale path** (same as search, docs/place-search.md): past a few thousand
live listings, prefilter Q2 by a bounding box around the source's public
point widened by the maximum approximation offset (results stay a function
of public points only), memoise public points per `(id, lat, lng)`, and
later a 2dsphere index on the **public** point. The ranking code is
unchanged.

## Tests
`tests/batch-s/related-stays.test.js`: golden boundaries, host ordering,
ring / scope rules, 300 seeded randomized rounds (bounded, deterministic,
no self or duplicates, near before wide, input not mutated — a failure
prints its seed); input validation; non-public sources (processing,
inactive, `active` + `ban:true`, unknown); card allow-list, masking of an
address inside a title, public points and distances that agree with them;
cache headers; ≤ 3 queries; races (source delisted / reassigned / moved,
candidate delisted / moved past 250 km / reassigned); response-filter and
DB failures; the 2,000 / 5,000 budget.

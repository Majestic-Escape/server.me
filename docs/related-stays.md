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
  "sourceHostId": "<host id>" | null,
  "unavailable": true            // only on a fail-closed answer (below) }
```

`Card` is an explicit allow-list (`cardOf`): `_id`, masked `title`,
`propertyType`, `photos` (the first one only), `address.{city, district,
state}` plus the **approximate** `latitude`/`longitude` (only as a valid
pair), `basePrice`, `guests`, `bedrooms`, `averageRating`, `reviewCount`;
nearby cards add `distanceKm` (0.1 km, rounded after ranking). Never: the
street, `line1`/`line2`, the exact point, the description, the host object or
e-mail. `sourceHostId` is public (the detail response carries the host id);
the site hides the host row when it differs from the host it is showing.
`unavailable: true` marks "no answer could be given" (the source is not
public, or it changed while the rows were built) as opposed to "this stay has
nothing related": the site never keeps it as the page's rows — its server
render passes `null` and the browser asks again.

| Request | Response |
|---|---|
| malformed id | 404 (shared `validateParam`) |
| any query other than a single `fresh=1` | 400 `INVALID_PARAM`, before any DB work |
| `?fresh=1` without the site's `x-catalogue-fresh` secret | 400 (`utils/httpCache.js`) |
| unknown / not-public source (`status ≠ active` or `ban:true`) | 200 empty rows, `sourceHostId:null`, `unavailable:true`, `no-store`, one indexed read |
| public source | 200, edge-cached 5 min under the `listings` tag (`CDN-Cache-Control: public, s-maxage=300, stale-while-revalidate=120`); the bypass (`?fresh=1` + secret) is `no-store` |
| race detected (below) | 200 empty rows, `unavailable:true`, `no-store` |
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
`relatedFor(id)` runs at most **four** listing queries per cache miss and nothing else
(three when the first 5 km band decides the nearby row — the dense case; one for an
unknown / non-public source). The four-query budget is owner-approved (2026-10-15).
Driver-command counts are measured at the tested sizes (one command per query), not a
guarantee for arbitrarily large cursors:

| | Query | Notes |
|---|---|---|
| Q1 | `findOne({_id, status:"active", ban≠true})`, ranking projection | `_id` index; a non-public source ends here (1 read) |
| Q2 | `find({status:"active", ban≠true, $or:[{host: source host}, {lat/lng in the box}]})`, ranking projection (10 fields) | index `{status, createdAt, _id}`; no titles, text or photos; the box (`poolFilter`) is centred on the source's **public** point and reaches 250 km + 1 km (> the 350 m maximum approximation offset), so every stay whose public point can be within 250 km is in the pool and the result is the same as ranking the whole inventory (tested); near a pole or across the antimeridian the whole public inventory is the pool |
| Q2a / Q2b | Q2 in two steps, **same rows as one read of the box** (tested: seeded sources on both paths and across the 5 km edge equal a whole-inventory ranking). Q2a reads the host's stays + the box of the **first 5 km band** (5 km + 1 km). When at least 8 eligible stays (not the source, not in the host row) have their public point in that band, they decide the nearby row: bands sort first, so the row is the band's best 8, and with ≥ 4 near stays the wide ring is never appended (`firstBandDecides`). Otherwise Q2b reads the **rest** of the 250 km box (`$nor` the Q2a filter — without concurrent changes the two reads do not overlap) | a dense area costs its first band + the host's stays instead of its whole 250 km box. A sparse area pays an extra round trip that returns little **but is a second full scan for MongoDB**: without a spatial index Q2a and Q2b each examine every live listing (5,001 live → 10,002 examined) |
| Q3 | `find({_id ∈ picked + source, status:"active", ban≠true})`, card projection + mask context + `host`, `photos` sliced to the first | skipped when nothing was picked; the description stays in the read because masking treats title + description + rules as one text (identical to the search cards) |

Q2a and Q2b are **not one snapshot**. A stay changed between them can be in
neither read (moved into the first band; given to the source's host) or in both
(moved out of the band; taken from the source's host while outside the band).
The rows may then be smaller or not optimal; they are never wrong — Q3 reads
unique ids and the rows are rebuilt from the emitted documents (tested: five
between-read cases — no duplicates, no other host's stay in the host row,
every distance agrees with the emitted point).

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

## Cost
**What is bounded, and what is not** (measured: `tests/batch-s/related-stays.test.js`
"cost", driver command monitoring + `explain("executionStats")`).

| (5,001 live listings, two-step read; cost report 2026-10-15) | Sparse (few stays within 5 km) | Dense (every stay inside the box) |
|---|---|---|
| Mongoose queries | 4 (Q1, Q2a, Q2b, Q3) | 3 (Q1, Q2a, Q3) — the first band decides |
| Driver commands (`find` + `getMore`) | 4 (one per query; pool reads use `batchSize(20000)`) | 3 |
| Documents returned to Node by the pool reads | 101 (Q2a) + 0 (Q2b) | 211 (Q2a; the old single read returned 5,001) |
| **Documents MongoDB examines for the pool reads** | **10,002** (Q2a 5,001 + Q2b 5,001 — two full scans: IXSCAN `status_1_createdAt_-1__id_-1`, then FETCH applying the predicate) | **5,001** (Q2a) |

- **Two-step read, per pool query** (cost report `poolQueries`, explain executionStats of the queries actually run):
  sparse 5,000 → Q2a examined 5,001 / returned 101 + Q2b examined 5,001 / returned 0 = **10,002 examined**;
  dense 5,000 → Q2a only, 5,001 examined / 211 returned; a host owning 1,000 stays → 2,001 + 2,001 examined.
- **Measured after the two-step read** (`npm run perf:related`, cost report, `PERF_PRIORITY=high`, 2026-10-15):
  dense 5,000 → 3 queries, 233 documents / 50 KB returned to Node (was 5,023 / 850 KB), service p50 / p95
  26 / 32 ms; dense 2,000 → 93 documents; sparse 2,000 / 5,000 → 4 queries, same documents as before
  (55 / 115); a host owning 1,000 stays → 2,023 documents (unchanged, no document read twice); 20 concurrent
  dense-2,000 requests 0.30 s wall (was ~1.03 s). Perf gate, 5 interleaved runs each: 5,000-dense median p95
  41–53 ms (old read 108–154 ms, same runs).
- **Dense areas (perf gate D8).** Before the two-step read a dense box was
  transferred and ranked whole (5,001 documents in the perf fixture). Now a
  source with ≥ 8 eligible stays within 5 km reads that band + its host's
  stays only. What this does **not** fix: a source whose own host owns a
  large portfolio still reads all of it (the host row ranks every one of the
  host's stays); a first band holding thousands of stays is still read whole;
  and MongoDB still *examines* every live listing for each read (no spatial
  index — see the scale path; an index alone would not have fixed the dense
  case either, because every stay in a dense box is a candidate).
- The box **reduces what is transferred to Node and ranked** for spread
  inventory. It does **not** reduce what MongoDB examines: with the declared
  indexes (`{status, createdAt, _id}`, `{host}`) the spatial branch has no
  index, so Q2 is **O(live listings)** server-side, exactly like search
  (docs/place-search.md), and a dense box is unbounded by any fixed candidate
  count. The "abuse cost" of an edge miss is therefore *not* bounded by the
  box.
- Edge hit: 0 DB operations. Unknown / non-public id: 1 indexed read.
- The site renders the rows on the server inside the stay page's ISR
  (revalidate 3600 s, tags `listings` + `listing:<id>`), so most guests never
  reach the endpoint; the browser only calls it when the server render could
  not get the rows.
- The endpoint has no rate limit of its own (none of the catalogue reads
  has; `Vary: Origin` lets a caller miss the edge on purpose). A platform
  rate limit is a separate, cross-cutting decision.
- Production had 19 live listings at the 2026-10-12 audit: the scan is
  microseconds there.

**Scale path (verified, not shipped).** An index on
`{ status: 1, "address.latitude": 1, "address.longitude": 1 }` turns the
plan into `OR(IXSCAN host_1, IXSCAN spatial)` and MongoDB examines the
candidates only — same 11 candidates, **11 documents examined instead of
5,001** (the "cost" test creates the index, asserts the equality of the
candidate set and the drop, and removes it). It is deliberately **not**
added to the schema: production indexes are created by an explicit,
owner-run step (`scripts/ensure-indexes.js`; `autoIndex` is off), it would
change planner choices on the busiest collection for no benefit at 19 live
listings, and the query itself would not change (so the equivalence tests
still hold). Add it when live listings reach the low thousands, together
with memoised public points (one HMAC per listing per miss: ≈ 26 ms at
5,000). A dense region still needs a candidate cap or the 2dsphere index
below; either changes ranking input and needs its own equivalence proof.
Later: a 2dsphere index on the **public** point.

## Performance gate (separate from the functional tests)
`npm run perf:related` (`tests/perf/related-stays.perf.js`; **not** part of
`npm test`, which runs files in parallel and would measure other test files).
- Budget: **p95 ≤ 150 ms** at 2,000 and 5,000 live listings, payload < 40
  KB. Worst case for the box (every bulk listing inside it). Gate = median
  of 3 rounds × 15 requests of the nearest-rank p95; the environment (node,
  OS, CPU, RAM, local mongodb-memory-server with client and API in one
  process) is printed with the result.
- It first samples the whole machine's CPU; above 35 % busy
  (`PERF_MAX_BUSY`) it fails as **INCONCLUSIVE** instead of reporting a
  number that describes other programs. `PERF_BUDGET_MS` overrides the
  budget for a slower declared environment.
- A green functional run says nothing about the 150 ms target — only this
  gate does, on an idle machine. Results are recorded in
  `tests/pw-final/evidence/related-stays-2026-10.md`.

## Tests
`tests/batch-s/related-stays.test.js`: golden boundaries, host ordering,
ring / scope rules, 300 seeded randomized rounds (bounded, deterministic,
no self or duplicates, near before wide, input not mutated — a failure
prints its seed); input validation; non-public sources (processing,
inactive, `active` + `ban:true`, unknown); card allow-list, masking of an
address inside a title, public points and distances that agree with them;
cache headers; ≤ 4 queries; the first-band read (dense sources read the band + the host's stays, sparse ones the rest of the box, rows equal a whole-inventory ranking on both paths); races (source delisted / reassigned / moved —
answered `unavailable` — candidate delisted / moved past 250 km /
reassigned); response-filter and DB failures; the box contains every point
within 250 km + the offset at six latitudes and 72 bearings, falls back at
a pole / the antimeridian, and the API rows equal a whole-inventory ranking
with stays straddling 250 km; the cost test (driver commands, examined documents, spatial-index scale path).

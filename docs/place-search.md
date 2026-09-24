# Place-aware stay search

## Why
Until 2026-09 `GET /properties/search-properties?location=` was an unanchored
case-insensitive substring regex over `address.city|district|state`. The data
it matched is typed by hosts (after Google Places pre-fills it) and is messy:
of the 19 active listings in production, three had `city: "Goa"` (the village
was only in `district`), one had a taluka (`Bardez`) as its city, districts
held neighbourhoods and junk (`North`, `Beach`, `Kutch `), and names differ
from how people search (`Panaji` vs "Panjim", `Madgaon` vs "Margao",
`Vasco` / `Vasco Da Gama`). "panjim" found nothing, "goa" found listings by
substring, "pan" matched Pandeypur, typos found nothing and an empty place
gave an empty page. Coordinates, on the other hand, come from Google Places
in the host wizard and were present on every active listing.

## How it works
1. **Gazetteer** — `data/places/places.json`, built at dev time by
   `scripts/build-places.js` from GeoNames India + `data/places/overrides.json`
   (see `data/places/README.md`): 36 states/UTs, 763 districts, the 12 Goa
   talukas, every Goa settlement/beach/island, Indian towns of 5k+, curated
   popular destinations. Stable ids: `st:<slug>` (states), `gn:<geonameid>`.
   Loaded with a static `require` (bundled by Vercel), indexed lazily
   (~30 ms once per instance), never touches the database.
2. **Listing classification** (`services/placeSearch.classify`) — every active
   listing gets `{ state, district, taluka, localities }`:
   - `state` from the dropdown text; `city` / `district` text that names a
     gazetteer place in that state wins (host-declared, strict);
   - a real-looking city name the gazetteer lacks becomes a **live place**
     `l:<state>:<slug>` (findable the moment the listing is active — no
     release needed for a new village);
   - otherwise (text says only "Goa", a taluka, junk) the listing belongs to
     its nearest settlement within 5 km and every settlement within 1.5 km;
   - district / taluka come from the text or from the nearest settlement;
   - big towns (50k+) also claim listings inside their radius
     (≈ 1.5 + 1.2·√(pop/10k) km, +0.35 km privacy tolerance) **in the same
     taluka/district** — Caranzalem is in Panaji, Porvorim across the river
     is not.
   Classifications are memoised per (id, address) in-process.
3. **Query resolution** (`utils/places.resolveQuery`), precedence
   `placeId` (a chosen suggestion, authoritative) > `lat,lng` (near me) >
   `location` text:
   - exact name/alias ("panjim", "Vasco", "Madgaon", "Bombay", "Coorg"),
     space-insensitive ("vascodagama"), diacritics folded;
   - generic words stripped ("candolim beach", "near baga", "Goa, India");
   - a 6-digit PIN code ("403001", "403 001") matches the listings with that PIN;
   - parent-qualified ("Colva, Goa", "panaji north goa");
   - ties: state > own-name over alias-only > 100k+ city > district/taluka >
     smaller locality > has stays > stays within 50 km > curated > population;
     namesakes elsewhere are returned as `alternatives`;
   - typos (≤ 1 edit for 4–7 chars, ≤ 2 from 8) auto-correct only when one
     candidate clearly wins (unique, or prominent, or the only one with/near
     stays, or 10× the population); otherwise `suggestions`, no guess;
   - anything else → the legacy literal substring match (text mode).
4. **Results** (`services/placeSearch.plan`) — one list, then pages:
   - `place`: exactly the listings in the place that pass every filter,
     newest first (`createdAt` desc, `_id` desc — the old order);
   - `nearby`: **only when that whole filtered set is empty** (never because
     a later page is empty), the listings passing every filter — dates,
     guests, price, type, amenities… — nearest first within 250 km, with
     `reason`: `no_inventory` (no stays there at all), `filters` (stays there,
     none match the filters), `dates` (none free on those nights);
   - `near`: near me, nearest first within 250 km;
   - `text` / `all`: the legacy behaviour.
   Distances (`distanceKm`, numeric, 0.1 km) and the nearby order are
   measured from each listing's **public approximate point**
   (`approximateLocation`), so search reveals nothing the stay page doesn't.

## API contract (additive)
`GET /properties/search-properties` — new optional params `placeId`, `lat`,
`lng`; response `{ data, pagination, search }` where
`search = { mode, query, place:{id,name,type,label}|null, corrected,
alternatives[], reason|null, nearestKm|null, suggestions[] }` and cards carry
`distanceKm` in `nearby` / `near` mode. Old clients (current site build,
mobile prototype) send `location` and get better results in the same shape.

Validation (`utils/searchParams.js`): every scalar arrives once as a string
(arrays / `[$ne]` objects / repeats → 400 `INVALID_SEARCH_PARAM`); counts and
amounts are numbers; `lat`/`lng` both or neither, in range, not (0,0),
re-rounded to 2 decimals; `placeId` matches `^(st|gn|l):…`; `location` ≤ 200.
Room counts are "at least", amenities "all of" (site `amenities[]=` or
mobile `a,b`), `minPrice` / `maxPrice` apply independently. Dates:
`yyyy-MM-dd` (calendar-checked) or an ISO time, rounded to the nearest UTC
midnight — older site builds sent the browser's local midnight, i.e. the
previous UTC day in India, and checked the wrong nights.

`GET /places/index` — the site's suggestion index: `{ version, labels,
rows: [id, name, type, labelIndex, "alias|…", stays, populationK] }`
(states, districts, talukas, Goa places, 50k+ cities, curated destinations,
anything with stays, live places). No coordinates, no listing ids. ~44 KB
gzip. `countstays` uses the same rules ("Panjim" counts `Panaji` listings).

## Cost
| Read | DB operations | Notes |
|---|---|---|
| search, no dates | 2 (aggregate, card find) | edge-cached 5 min, tag `listings` |
| search with dates | 3 (bookingnights distinct, aggregate, card find) | `no-store` as before |
| page past the end | ≤ 2 (no card find) | |
| `places/index`, `countstays` | 1 | edge-cached 5 min, tag `listings` |

The aggregate is `$match {status:"active"}` (index `{status, createdAt, _id}`)
+ `$facet { inv: location fields, open: non-date filters → _id }`; strict,
nearby, near-me and text modes all run on it. No Redis, no Atlas Search, no
geo index, no paid API. Measured (tests/batch-s/place-search.test.js):
resolution p95 ≈ 2 ms; 3,000 listings classify in ~150 ms cold / ~5 ms
memoised, plan in ~25 ms.

**Scale path:** the aggregate returns every active listing's location fields
(~150 B each). Past ~5,000 active listings add a GeoJSON point + 2dsphere
index and prefilter by the place's bounding box (strict) / `$geoNear`
(nearby) — the plan/classification code is unchanged.

## Privacy / security invariants (tested)
- Exact coordinates never influence output: distances and nearby order use
  the approximate point; the exact pair never appears in a response.
- Draft / processing / inactive listings never appear in search, counts or
  the index.
- Near-me coordinates are rounded to ~1 km by the client and again here.
- No parameter can become a Mongo operator; regex input is literal.

## Limits (known)
- GeoNames coordinates for some small villages are approximate; text wins
  whenever the host's text names a place.
- A settlement neither in GeoNames nor typed as a city by any host (e.g.
  Ashwem) resolves to text mode; add it to `overrides.json` (`include`,
  or a curated place) if searched for.
- Only Latin-script names are matched.

# Place gazetteer (`places.json`)

Generated — do not edit by hand. Source: **GeoNames** (https://www.geonames.org/),
licensed **CC BY 4.0** (https://creativecommons.org/licenses/by/4.0/); the
customer site credits it in the footer. Curated additions and display names
live in `overrides.json`.

## Rebuild (dev machine only — production never downloads anything)
```sh
mkdir /tmp/geonames && cd /tmp/geonames
curl -fsSLO https://download.geonames.org/export/dump/IN.zip && unzip IN.zip
curl -fsSLO https://download.geonames.org/export/dump/admin1CodesASCII.txt
curl -fsSLO https://download.geonames.org/export/dump/admin2Codes.txt
cd <server.me> && node scripts/build-places.js --src /tmp/geonames
npm test   # place-search.test.js pins the behaviour
```
`places.json` records the sha256 of every input (`source`). The current file
was built on 2026-09-24 from IN.txt `41f6d63f…`, admin1 `1da92a63…`, admin2
`63a82be9…`.

## Ids are permanent
`st:<slug>` for states, `gn:<geonameid>` for everything else — GeoNames ids
never change between dumps, so links, recent searches and home cards keep
working after a rebuild. If a place is merged or removed, add
`"old id": "new id"` to `overrides.json` → `redirects`.

## Adding a place people search for
- A GeoNames place below the population cut-off: add its `gn:` id to
  `include` (and to `names` for a display name / aliases).
- A popular destination: add `{ name, state }` to `popular` (resolved by name
  at build time; the build fails if it is not in the dump).
- A village only hosts know: nothing to do — the first active listing whose
  city names it creates a live place (`l:<state>:<slug>`) at request time.

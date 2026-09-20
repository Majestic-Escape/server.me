# Image pipeline — pre-generated display variants on the Spaces CDN

Listing photos and profile pictures used to be shown through Vercel's runtime
Image Optimization (`/_next/image` → transform → Spaces master). The Hobby
quota (5,000 transformations / month) ran out and every uncached photo
answered `402` on both sites. Since this change a photo is a **sanitised
master plus a fixed set of WebP display sizes**, all rendered at upload time by
this API and served straight from the Spaces CDN. Viewing a photo involves no
Vercel transformation, no server.me invocation, no database read and no
Redis (this API has none).

```
before   browser → /_next/image (Vercel optimizer, quota) → Spaces master
after    browser → <bucket>.blr1.cdn.digitaloceanspaces.com/<master key>/v1/w<width>.webp
```

## Objects and naming (`services/storage.js`)

| object | key | content | cache |
|---|---|---|---|
| master | `listings/<ownerId>/<uuid>-<name>.<ext>` (legacy: `<timestamp>-<name>`) | `sanitizeImage()` output — metadata stripped, orientation baked, QR-checked, ≤ 6000 px, JPEG q85 / PNG / WebP q85 | `public, max-age=31536000, immutable` |
| variant | `<master key>/v1/w<width>.webp`, width ∈ 160 320 640 960 1280 1600 1920 2560 3840 | WebP from the master: Lanczos, never wider than the master, aspect and alpha kept, no metadata | same |

* The database stores the **master URL only** (`ListingProperty.photos[]`,
  `User.profilePicture`); variant URLs are derived, identically, by this API
  (`variantKey`) and the site (`user.website/src/lib/spaces-image.js`). The
  contract is `tests/batch-s/fixtures/image-variant-vectors.json`, generated
  by `tests/batch-s/image-variants.test.js` (`WRITE_VECTORS=1`) and asserted by
  the site's `scripts/check-image-loader.mjs`.
* Every width key exists for every photo. A master narrower than a width is
  stored under that key at its own width (same bytes reused, one encode), so a
  URL never has to be guessed and nothing is upscaled.
* The set name (`v1`) is part of the key: a change of widths or quality ships
  as `v2` beside `v1` instead of overwriting objects that browsers and the CDN
  may keep for a year. Old sets are removed by `--prune`.
* Masters and variants are immutable because keys are unique per upload; a
  replaced profile picture or photo gets a new key, the old objects are
  deleted (`deleteImages`).

## Quality and size (measured, `docs`-adjacent evidence in the closure report)

SSIM/PSNR against the master resized with Lanczos to the same width, 40
production photos (exterior, interior, foliage, low light, portrait, small
sources) plus a text/sign PNG and a transparent PNG, at 640/960/1280/1920 px:

| setting | SSIM (luma) mean / min | PSNR mean / min | bytes vs today |
|---|---|---|---|
| q70 (cards today) | 0.964 / 0.910 | 38.7 / 34.9 dB | ×0.93 |
| q75 (today) | 0.966 / 0.914 | 39.2 / 35.4 dB | ×1.00 |
| q82 | 0.976 / 0.929 | 41.2 / 37.9 dB | ×1.32 |
| **q85 (shipped ≤ 1600 px)** | 0.979 / 0.941 | 42.2 / 39.1 dB | ×1.51 |
| q90 | 0.986 / 0.961 | 44.3 / 41.9 dB | ×2.05 |

Shipped: **q85** for 160–1600 px, **q82** for 1920–3840 px (only ever viewed
downscaled on high-DPR screens), libwebp effort 3 (same SSIM/PSNR as 4 for
~25 % less CPU), no "smart" chroma subsampling (+60 % CPU, lower luma PSNR on
text). Low-light photos, the worst case today (35 dB), gain the most.

Cost per 12 MP photo on one core: sanitise ~1.0 s + 9 variants ~2.7 s
(≈ 4 s CPU), peak RSS ≈ 200–300 MB; variants ≈ 2.0 MB per 12 MP photo,
≈ 1.4× the master bytes averaged over the production sample (1.1 MB per
original). The API processes one file at a time per request; the site
uploads in batches of 3, two requests in flight.

## Requests

* `POST /uploads/` (≤ 20 files, 5 MB each) and `POST /uploads/profile`:
  every file is sanitised first (a refused file fails the request before
  anything is stored); then per file: master PUT, variants rendered one at a
  time and uploaded three in flight. A failed **master** fails the request and
  the objects already stored for it are removed. A failed **variant** keeps
  the photo (logged `upload: variant(s) not stored`); the site falls back to
  the master for that size and the backfill heals it.
* `DELETE /uploads/delete { url }` — a master or variant URL names the photo;
  ownership is checked on the master; master + derived variants + anything
  under `<master key>/` are deleted (idempotent).
* Listing deletion (`services/listingDeletion.js`) and the repair script use
  `storage.deleteImages`, so a listing's photos take their variants with them;
  a photo counts as removed only when every object under it went.
* Decoded-raster guard: `limitInputPixels` 40 MP (a crafted 20000×20000 PNG is
  refused with `413 IMAGE_TOO_LARGE` before decoding).

## Backfill (owner-run, dry run by default)

```
node scripts/image-variants-backfill.js --uri="<DB_URI>"                 # report only
node scripts/image-variants-backfill.js --uri="<DB_URI>" --apply         # write missing variants
node scripts/image-variants-backfill.js --uri="<DB_URI>" --apply --retry # only masters that failed
node scripts/image-variants-backfill.js --uri="<DB_URI>" --prune         # orphan variants (report)
node scripts/image-variants-backfill.js --uri="<DB_URI>" --prune --apply # delete them
```

* Reads listing photos + profile pictures, LISTs each master's variant prefix,
  renders only the missing widths from the master read from the bucket (never
  the CDN), validates size + MD5 (ETag) + content type after each PUT.
* State file (`image-variants-backfill.state.json`): done / failed masters;
  Ctrl-C finishes the masters in flight and saves; a rerun resumes; a finished
  run does nothing on the next run. `--limit=N`, `--concurrency=2`,
  `--recheck`, `--only=<substring>`, `--report=<file>`.
* Reports dangling references (master missing), undecodable masters, masters
  that still carry metadata (→ `scripts/strip-image-metadata.js --apply`).
* Needs `DO_SPACES_KEY/SECRET` for `--apply`/`--prune`; the database is never
  written; nothing secret is printed.

## Site (`user.website`)

`MediaImage` (`src/components/ui/media-image.tsx`) = `next/image` with the
Spaces loader: next/image still builds the srcset from `sizes`, lazy-loads,
reserves layout and preloads `priority` images; every candidate URL is a CDN
variant. A missing variant (403 from Spaces — not negatively cached by the
CDN) makes the `<img>` error once and re-render with the master served as-is,
never through `/_next/image`; a missing master surfaces the caller's
`onError` (the lightbox's "Image unavailable"). The shared `AvatarImage`
serves profile pictures as 160/320 px variants; `MediaImg` covers raw
previews. Static/foreign images keep the default next/image path (a custom
global loader would have switched Vercel's optimizer off for them).

Rollback: `NEXT_PUBLIC_IMAGE_VARIANTS=off` at build time (or revert the site
deploy) puts every media image back on `/_next/image`; the objects in the
bucket are inert.

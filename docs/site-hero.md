# Homepage hero — admin-managed banner

The home page banner used to be static files in the site repository: every
change needed a developer, a build and a deploy. Admins now prepare the
desktop and mobile artwork in **Settings → Homepage banner**, look at the
real result, and publish; the site shows it within about a minute, without a
deploy and without Vercel Image Optimization (whose quota is exhausted).

```
admin   POST /api/v1/site/admin/hero/:slot/draft   (image → master + AVIF/WebP renditions, a draft)
        POST /api/v1/site/admin/hero/publish        (drafts → live, one transaction)
site    GET  /api/v1/site/hero  (ISR, tag site-hero) → <picture> of CDN renditions, bundled banner otherwise
visitor browser → <bucket>.blr1.cdn.digitaloceanspaces.com/site/hero/<slot>/<uuid>.jpg/v1/w<width>.avif
```

A **banner** is two artworks — desktop (≥ 768 px) and mobile — and **one
description** (alt text) that fits both. The first custom banner needs both;
after that either slot can be replaced; *Restore bundled default* returns
both to the site's built-in banner. A custom/default mix never exists.

## What the API guarantees

- **Admins only.** Every `/site/admin/*` route runs `[authMiddleware, requireAdmin]` before any parsing; the public read has no admin data.
- **One lossy generation, measured quality.** Every output is encoded from one decoded, upright, cropped, flattened sRGB raster:
  - AVIF q60 effort 4 (primary) and WebP (`variantWebp` + smart chroma) for every rendition width;
  - a JPEG q95 4:4:4 master (long-term source, last-resort fallback);
  - a 24 px WebP placeholder (≈ 300 B).
- **The exact box, never upscaled.** The image is cropped to 1920:740 or 530:720 around the admin's focal point (within 1% it is used whole); more than 35% off needs an explicit "use anyway"; smaller than the box (1920×740 / 530×720, 1% slack) is refused; the master and renditions are capped at 3840 / 1600 px.
- **Safe retries.** Every mutation carries a server-issued op token and records a receipt in the same transaction as the change and its audit row (`services/siteHeroOps.js`): a retry after a lost response returns the recorded result — even if other admins changed the banner since — and is never applied or audited twice.
- **One image job at a time** (the lease), really cancelled at its budget (sharp timeouts, `ManagedUpload.abort()`), unable to install after it lost the lease.
- **Nothing referenced is ever deleted.** Objects live under the protected `site/` prefix: `storage.deleteObjects` refuses them unless the hero service or its sweep asks explicitly, users can't reference them (`isOurImageUrl`), `/uploads/delete` answers 409, maintenance scripts filter them out. Cleanup is the sweep's job.

## Quality and speed (measured, sharp 0.34.5, in-memory, the real banners)

| | desktop w1920 KB / SSIM-Y / p1 | mobile w1060 |
|---|---|---|
| previous static AVIF q55 | 192 / .9858 / .928 | (old artwork) |
| listing pipeline (WebP, 2 generations) | 252 / .9869 / .936 | 188 / .9836 / .908 |
| **hero AVIF q60 e4** | **222 / .9885 / .942** | **141 / .9893 / .942** |
| JPEG master q95 4:4:4 | SSIM .9996 (q92 was .9995) | .9953 (q92 was .9933) |

AVIF q62 costs +5% bytes for +.001; effort 6 saves 1% for 2.5–3.5× the CPU.
Local processing: the 2805 px desktop art ~11 s, the 1060 px mobile art ~4 s.

## Routes

| Route | anon | user / host | admin | Notes |
|---|---|---|---|---|
| `GET /site/hero` | 200 | 200 | 200 | `{version, alt, desktop, mobile}`; CDN `s-maxage=300`, `Vercel-Cache-Tag: site-hero`; `?fresh` needs `x-catalogue-fresh` |
| `GET /site/admin/hero` | 401 | 403 | 200 | full state, drafts, spec, a fresh op token; no-store; may start the sweep |
| `GET /site/admin/hero/ops/:opId` | 401 | 403 | 200 | processing / completed / failed / unknown — own operations only |
| `POST /site/admin/hero/:slot/draft` | 401 | 403 | 201 | multipart `image` (≤ 4 MB) + `opToken`, `expectedDraftOpId`, `focalX/Y`, `acceptRatio`, `clientReencoded` |
| `DELETE /site/admin/hero/:slot/draft` | 401 | 403 | 200 | `{opToken, expectedDraftOpId}` |
| `POST /site/admin/hero/publish` | 401 | 403 | 200 | `{opToken, expectedVersion, slots:{desktop?,mobile?}, alt}` |
| `PATCH /site/admin/hero/alt` | 401 | 403 | 200 | `{opToken, expectedVersion, alt}`; custom banner only |
| `POST /site/admin/hero/restore-default` | 401 | 403 | 200 | `{opToken, expectedVersion}`; drafts are kept |
| `GET /site/cron/hero-sweep` | 401 | 401 | 401 | Vercel Cron (`Bearer CRON_SECRET`), daily 21:15 UTC |

Error codes: `HERO_VERSION_CONFLICT`, `HERO_DRAFT_CHANGED`, `HERO_DRAFT_EXPIRED` (409), `HERO_BUSY` (409, `retryAfter`), `HERO_BOTH_SLOTS_REQUIRED`, `HERO_NO_SLOTS`, `INVALID_ALT`, `INVALID_FOCAL`, `INVALID_FIELDS` (400), `HERO_RATIO_CONFIRM`, `HERO_TOO_SMALL`, `IMAGE_NOT_ALLOWED` (422), `HEIC_NOT_SUPPORTED`, `UNSUPPORTED_FORMAT`, `UNSUPPORTED_FILE_TYPE` (415), `FILE_TOO_LARGE`, `IMAGE_TOO_LARGE` (413), `OP_TOKEN_*` (400/403), `OP_EXPIRED` (410), `OP_ID_REUSED` (422), `HERO_TOO_MANY_OPS` (429), `STORAGE_ERROR` (502), `HERO_TIMEOUT`, `HERO_OUTCOME_UNKNOWN`, `AUDIT_UNAVAILABLE` (503).

## Data

One document `sitesettings/home_hero` (no new index): `version`, `alt`, `desktop`, `mobile`, `draft.{desktop,mobile}` (7-day expiry), `retired[]`, `receipts[]` (≥ 7 days, ≤ 500), `lease`, `lastSweepAt`. Objects: `site/hero/<slot>/<uuid>.jpg` + `…/v1/w<key>.{avif,webp}` — a rendition of an actual width *w* lives under the smallest standard width ≥ *w* (1060 → `w1280`); the site derives the same keys (`tests/batch-s/fixtures/hero-renditions-vectors.json`).

## Outcome rules

| Outcome | Server | Admin UI |
|---|---|---|
| Conflict (version / draft changed / expired) | nothing changed | "Reload latest and review again", edits kept |
| Committed, notification failed | stays published; `notified: {site, cdn}` = confirmed status per channel | "Published — refresh pending" |
| Commit outcome unknown / response lost | **deletes nothing**; 503 `HERO_OUTCOME_UNKNOWN` | polls the operation: completed = done; unknown = nothing applied → retry |
| Failure before anything was installed | its objects deleted, failure receipt, lease released | the message, retry with a new action |

## Sweep (`services/siteHeroSweep.js`)

Once per window (compare-and-set on `lastSweepAt`): expired drafts leave the document (system audit row), then objects under the prefix that are unreferenced **and** either retired more than 24 h ago or uploaded more than 24 h ago are deleted; a retired record is pulled only after a fresh listing confirms its objects are gone. Triggered by the daily cron, after a publish/restore and by an admin read (6 h window); `node scripts/site-hero-sweep.js --uri=… [--apply]` by hand (dry run by default). Objects become *eligible* 24 h after they stop being referenced and are deleted by a later successful run — with the Hobby cron (once a day, ±59 min) that can take more than a day.

## Cost

No new service, no Redis. Mongo: public read ≤ 1 op per CDN/data-cache miss; a draft ≈ 13 ops including its state read; a publish ≈ 10; the admin page 2; the sweep a handful per day. Spaces: 2 formats × rendition widths + master per draft (≈ 15 PUTs desktop, ≈ 7 mobile), ≈ 1–4 MB per version, deleted a day after retirement.

## Rollout / kill switches

Backward compatible: the public read returns nulls until something is published, and the site falls back to its bundled banner. *Restore bundled default* is the instant lever; the site's `HERO_DYNAMIC=off` (redeploy) ignores the API entirely. `SITE_HERO_PREFIX=_qa/site/hero/<run>/` isolates a local QA run (ignored in production). Tunables for tests: `SITE_HERO_LEASE_MS`, `SITE_HERO_BUDGET_MS`, `SITE_HERO_PUT_TIMEOUT_MS`, `SITE_HERO_WARMUP=off`.

## Limits and follow-ups

- Tablets (768–1023 px) show the desktop art.
- QR detection has a size floor (measured: ≥ 100 px codes on a 1920 px banner are caught). Admins are trusted — it is a consistency rule.
- Drafts are public-read under unguessable keys.
- The listing pipeline still encodes variants from a re-encoded master (two generations); the hero's single-generation approach could be applied there.
- Not measured on Vercel yet: a 3840 px draft's duration and memory (targets < 60 s, < 1 GB).

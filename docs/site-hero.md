# Homepage hero — admin-managed banner

The home page banner used to be static files in the site repository: every
change needed a developer, a build and a deploy. Admins now prepare the
desktop and mobile artwork in **Settings → Homepage banner**, look at the
real result, and publish; the site shows it within about a minute, without a
deploy and without Vercel Image Optimization (whose quota is exhausted).

```
admin   POST /api/v1/site/admin/hero/:slot/draft   (image → master + AVIF/WebP renditions, a draft)
        POST /api/v1/site/admin/hero/publish        (drafts → live, one transaction)
site    GET  /api/v1/site/hero  (ISR, tag site-hero) → <picture> of the renditions, bundled banner otherwise
visitor browser → majesticescape.in/_hero/<slot>/<uuid>.jpg/v1/w<width>.avif
        (site rewrite, cached at Vercel's edge) → <bucket>.blr1.cdn.digitaloceanspaces.com/site/hero/…
```

**Delivery.** The site serves the renditions from its own domain (`/_hero/…`,
a rewrite in user.website `next.config.ts` that forwards only the exact shape
of a rendition to the Spaces CDN; `vercel.json` opts the path into Vercel's
edge cache, which honours the objects' `s-maxage`). Measured locally, a
second origin costs a first visit a new connection before the LCP image
(connect + TLS ≈ 100–250 ms on desktop, `tests/pw-final/evidence/site-hero-perf-notes.md`);
the page's own connection has none. The objects are immutable, so a repeat
visit makes no request at all (today's static files revalidate on every
visit). The site's `HERO_DELIVERY=cdn` links the CDN directly instead; either
way the first fallback step goes straight to the Spaces origin.

A **banner** is two artworks — desktop (≥ 768 px) and mobile — and **one
description** (alt text) that fits both. The first custom banner needs both;
after that either slot can be replaced; *Restore bundled default* returns
both to the site's built-in banner. A custom/default mix never exists.

## What the API guarantees

- **Admins only.** Every `/site/admin/*` route runs `[authMiddleware, requireAdmin]` before its own work; the public read has no admin data. What is parsed before authentication: the image upload is read only after it (multer is route middleware); JSON and urlencoded bodies — like on every route of this API — are parsed by the global parsers in `index.js` first (limit 50 MB there; on Vercel the platform's 4.5 MB request cap applies first), so a malformed anonymous JSON body is answered by the global error handler, not a 401.
- **One lossy generation, measured quality.** Every output is encoded from one decoded, upright, cropped, flattened sRGB raster:
  - AVIF q60 effort 4 (primary) and WebP (`variantWebp` + smart chroma) for every rendition width;
  - a JPEG q95 4:4:4 master (long-term source, last-resort fallback);
  - a 24 px WebP placeholder (≈ 300 B).
- **The exact box, never upscaled.** The image is cropped to 1920:740 or 530:720 around the admin's focal point (within 1% it is used whole); more than 35% off needs an explicit "use anyway"; narrower than the box (1920 / 530 px — exact) is refused, the height keeps the 1% slack of the ratio tolerance (1920×733 is used whole). The master is capped at 3840 / 1600 px; the renditions browsers are offered at **2560** / 1600 px — the widest file the static hero ever had: a 2× laptop (1440 px → 2880 needed) gets the 2560 px it got before, and the desktop byte budget (≤ today + 20%) holds (a 2805 px rendition was +33%). Recommended artwork: 2880×1110 desktop and 1060×1440 mobile; the draft notes *below recommended* under 90% of that width.
- **Safe retries.** Every mutation carries a server-issued op token and records a receipt in the same transaction as the change and its audit row (`services/siteHeroOps.js`): a retry after a lost response returns the recorded result — even if other admins changed the banner since — and is never applied or audited twice. The "no receipt yet" condition is part of every update's filter, so two copies of one request sent at once apply once and both answer with the result. A commit error is treated as *unknown* (nothing deleted) unless the driver says the transaction was rolled back — the driver leaves some commit errors (write concern) unlabelled although they applied. At most 500 receipts, and a receipt still inside its 30-minute retry window is never evicted, also under concurrency (the same rule is in the update filter; the loser gets 429).
- **One image job at a time** (the lease), really cancelled at its budget (sharp timeouts, `ManagedUpload.abort()`), unable to install after it lost the lease. The lease records the request's fingerprint: only the very same request is told "processing"; its id with other content is `OP_ID_REUSED`.
- **Nothing referenced is ever deleted.** Objects live under the protected `site/` prefix: `storage.deleteObjects` refuses them unless the hero service or its sweep asks explicitly, users can't reference them (`isOurImageUrl`), `/uploads/delete` answers 409, maintenance scripts filter them out. Cleanup is the sweep's job.

## Quality: verified for every upload

A fixed encoder setting can't promise quality (or size) for artwork nobody has measured, so every rendition is **verified while the draft is prepared** (`services/siteHeroImage.js`, `encodeVerified`). It is scored against the prepared raster at its width: SSIM-Y mean and 1st percentile, and chroma PSNR (`services/imageQuality.js`), unrounded.

1. **The floor, always.** A rendition must be at least as good, on every measure, as today's static hero pipeline would make of the same artwork (`scripts/optimize-static-images.mjs`: AVIF q55 effort 6, WebP q75 effort 5). If no setting tried beats today's encode on every measure, today's encode itself is used. "No drop in quality" therefore holds by construction for every upload.
2. **The plan's targets.** AVIF: SSIM-Y ≥ 0.986 desktop (at least every value today's static files measured, 0.983–0.986) or ≥ 0.988 mobile, p1 ≥ 0.94, chroma ≥ 43 dB. WebP: SSIM-Y ≥ 0.985, p1 ≥ 0.93. The encoder starts from the per-width setting measured on the real banners and, if that misses the targets, tries one step up (+6 quality), but only when the step still fits the size budget. That makes at most three encodes per rendition.
3. **The size budget.** Today's static files + 20% at the widths the static hero had (desktop 1280 / 1920 / 2560 px: 153,074 / 236,004 / 302,665 bytes), and 150 KB for mobile at 1060 px.

**Acceptance policy.** A draft whose renditions miss the targets, or exceed the budget, is prepared and flagged: `BELOW_QUALITY_TARGET` / `OVER_BYTE_BUDGET`, with the widths, bytes and scores. Publishing it needs the admin's explicit confirmation (`acknowledgeShortfall`; otherwise `409 HERO_ACK_REQUIRED`), and the confirmation is audited. With `SITE_HERO_QUALITY_POLICY=strict`, such a draft is refused at preparation instead (`422 HERO_QUALITY_LIMIT` / `HERO_BYTE_BUDGET`, with actionable advice); nothing is kept and the live banner is untouched. **Which mode ships is the owner's decision**; the default is the confirmation mode.

**Measured locally** (`tests/pw-final/evidence/audit/verified-encode-profile-v2.json`):

| Artwork | Preparation time | Result |
|---|---|---|
| Designer desktop (2805 px) | ~26 s | every target met; w1280 is **792 bytes (0.5%) over its budget** at the only setting that meets the targets there (q62 effort 8) — flagged |
| Designer mobile | ~16 s | every target met, within budget |
| Grain-heavy 3840 px stress image | ~39 s | within every budget; 4 renditions below target — flagged |

Before verification, a desktop draft took about 11 s. Durations on Vercel are unmeasured (deployment check).

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

Error codes: `HERO_VERSION_CONFLICT`, `HERO_DRAFT_CHANGED`, `HERO_DRAFT_EXPIRED`, `HERO_WRONG_ENVIRONMENT`, `HERO_ACK_REQUIRED` (409), `HERO_BUSY` (409, `retryAfter`), `HERO_BOTH_SLOTS_REQUIRED`, `HERO_NO_SLOTS`, `INVALID_ALT`, `INVALID_FOCAL`, `INVALID_FIELDS` (400), `HERO_RATIO_CONFIRM`, `HERO_TOO_SMALL`, `IMAGE_NOT_ALLOWED`, `HERO_QUALITY_LIMIT`, `HERO_BYTE_BUDGET` (422, strict policy), `HEIC_NOT_SUPPORTED`, `ANIMATED_AVIF_NOT_SUPPORTED`, `UNSUPPORTED_FORMAT`, `UNSUPPORTED_FILE_TYPE` (415), `FILE_TOO_LARGE`, `IMAGE_TOO_LARGE` (413), `OP_TOKEN_*` (400/403), `OP_EXPIRED` (410), `OP_ID_REUSED` (422), `HERO_TOO_MANY_OPS` (429), `STORAGE_ERROR` (502), `HERO_TIMEOUT`, `HERO_OUTCOME_UNKNOWN`, `AUDIT_UNAVAILABLE`, `HERO_CLEANUP_BACKLOG` (503).

## Data

One document `sitesettings/home_hero` (no new index): `namespace` (the key prefix of the environment that created it — see *Environments*), `version`, `alt`, `desktop`, `mobile`, `draft.{desktop,mobile}` (7-day expiry; each carries `encoding` — the setting, bytes, scores and floor of every rendition — plus `overBudget` / `belowTarget`), `retired[]` (until the sweep confirms deletion), `pending[]` (≤ 200, never trimmed: when full, new image jobs get `HERO_CLEANUP_BACKLOG` until the sweep has run), `receipts[]` (≥ 7 days, ≤ 500), `lease`, `lastSweepAt`. The admin read and the operation lookup never load the bookkeeping arrays (projections; measured with a full document: 1.2 KB and 0.3 KB instead of 148 KB). Objects: `site/hero/<slot>/<uuid>.jpg` + `…/v1/w<key>.{avif,webp}` — a rendition of an actual width *w* lives under the smallest standard width ≥ *w* (1060 → `w1280`); the site derives the same keys (`tests/batch-s/fixtures/hero-renditions-vectors.json`).

## Outcome rules

| Outcome | Server | Admin UI |
|---|---|---|
| Conflict (version / draft changed / expired) | nothing changed | "Reload latest and review again", edits kept |
| Committed, notification failed | stays published; `notified: {site, cdn}` = confirmed status per channel | "Published — refresh pending" |
| Commit outcome unknown / response lost | **deletes nothing**; 503 `HERO_OUTCOME_UNKNOWN` | polls the operation: completed = done; `unknown` = no receipt and no running job *so far* (a banner change can still be committing) → "not confirmed"; the retry repeats the same request (same token), so it can only apply once |
| Failure before anything was installed | its objects deleted, failure receipt, lease released | the message, retry with a new action |

## Sweep (`services/siteHeroSweep.js`)

It deletes **only what this database recorded as its own and no longer needs** — never an object merely because nothing references it:

- `retired`: live art that was replaced or restored away, and drafts that were replaced, discarded or expired, each recorded in the very update that let go of it; kept 24 h (cached pages, open tabs), then deleted;
- `pending`: an image job's master key, recorded before its first upload and cleared by the install; what remains belongs to a job that crashed, timed out or failed and is deleted a day later.

Anything the document still points at (the live pair, every draft) is never deleted; a live or draft URL that does not parse to a key stops the run; only keys under this environment's prefix are touched; a record is pulled only after a fresh listing confirms its objects are gone (a listing that ends early is an error, not a short list); a record naming keys outside this prefix is kept and counted (`foreign`) — it is another environment's to act on. Objects no record names are left alone and counted (`unrecorded`). A document that belongs to another environment is not swept at all (`skipped: "other-environment"`, nothing written). Once per window (compare-and-set on `lastSweepAt`); triggered by the daily cron, after a publish/restore and by an admin read (6 h window). By hand (dry run by default; a dry run writes nothing): `node scripts/site-hero-sweep.js --uri=… [--apply]` — against the **production** database run it as production: `SITE_HERO_PRODUCTION=1 node scripts/site-hero-sweep.js --uri=… [--apply]` (it prints the environment and prefix it runs as). Objects become *eligible* 24 h after they are let go of and are deleted by a later successful run — with the Hobby cron (once a day, ±59 min) that can take more than a day.

**Environments.** Every environment shares the bucket, so only production writes `site/hero/` (the namespace the site reads): a Vercel production deployment (`VERCEL_ENV=production`) or an explicit `SITE_HERO_PRODUCTION=1` (a maintenance script run against the production database). Everything else — a developer's machine, a Vercel preview, a QA run — uses `SITE_HERO_PREFIX` when it is a valid `_qa/site/hero/<name>/`, otherwise `_qa/site/hero/dev/`. A non-production server therefore can neither overwrite nor sweep the live banner's objects, even with a copy of the production database. The admin page shows which namespace a server uses; a production server that shows `_qa/…` is missing `VERCEL_ENV` (set `SITE_HERO_PRODUCTION=1`).

The **document** is bound to an environment too: it records the prefix of the environment that created it (`namespace`). A server that is not production never changes a document of another namespace (`409 HERO_WRONG_ENVIRONMENT`, nothing written) and never sweeps it — so a laptop or a preview that points at the production database (a copied `.env`, a restored backup) can neither put up objects the live site can't show nor drop production's cleanup records. Production is authoritative: it takes over a document created under another namespace (e.g. by a production server before its environment variable was set). A document from before this rule is bound by its first change.

The real-bucket QA harness (`tests/batch-s/setup.js`, `E2E_REAL_SPACES=1`) refuses to start without a `_qa/site/hero/<run>/` prefix or with any production signal, and sets `SPACES_WRITE_PREFIX=_qa/`: the storage layer then refuses every put and delete outside `_qa/`, whatever route or script asks. The e2e server listens on 127.0.0.1 only and answers `/seed` (admin tokens) only to its own site/admin origins.

## Cost

No new service, no Redis. Mongo: public read ≤ 1 op per CDN/data-cache miss (projected, ≈ 1 KB); a draft ≈ 13 ops including its state read; a publish ≈ 11; the admin page 2; an operation lookup 1 (≈ 0.3 KB); the sweep ≈ 6 plus 2 per expired draft, per day (one update pulls every confirmed record). Spaces: 2 formats × rendition widths + master per draft (≈ 15 PUTs desktop, ≈ 7 mobile), ≈ 1–4 MB per version, deleted a day after retirement.

## Rollout / kill switches

Backward compatible: the public read returns nulls until something is published, and the site falls back to its bundled banner. *Restore bundled default* is the instant lever; the site's `HERO_DYNAMIC=off` (redeploy) ignores the API entirely; `HERO_DELIVERY=cdn` (redeploy) serves the renditions from the CDN host instead of the site's `/_hero` path. `SITE_HERO_PREFIX=_qa/site/hero/<run>/` isolates a QA run (see *Environments*). Tunables for tests: `SITE_HERO_LEASE_MS`, `SITE_HERO_BUDGET_MS`, `SITE_HERO_PUT_TIMEOUT_MS`, `SITE_HERO_WARMUP=off`, `SPACES_WRITE_PREFIX` (the QA harness), `LISTEN_HOST` (the e2e server), `SITE_HERO_BYTE_BUDGET_SCALE` (tests). Policy: `SITE_HERO_QUALITY_POLICY=strict` (see *Quality*).

## Limits and follow-ups

- Tablets (768–1023 px) show the desktop art.
- QR detection has a size floor relative to the banner (the scan runs on a ≤ 1200 px copy): on a 1920 px banner codes of 100 px and up are caught; on a 3840 px banner 100–120 px codes pass and 160 px and up are caught. A decode with an empty payload is not a QR code (jsQR occasionally reads an empty version-1 symbol out of dithered noise — 3 of 40 noisy animated GIFs in the audit); listings keep the original rule. Admins are trusted — it is a consistency rule.
- Animated GIF and WebP uploads use their first frame (with a notice). Animated AVIF (an image sequence, brand `avis`) cannot be decoded by this sharp build at all, so it is refused with `ANIMATED_AVIF_NOT_SUPPORTED` and asked for a still export.
- Drafts are public-read under unguessable keys.
- The listing pipeline still encodes variants from a re-encoded master (two generations); the hero's single-generation approach could be applied there.
- Not measured on Vercel yet: a 3840 px draft's duration and memory (targets < 60 s, < 1 GB); the `/_hero` edge cache (expect `x-vercel-cache: HIT` after the first request per region).
- `warmUp` after a publish fetches the AVIF renditions from the Spaces CDN edge nearest the server — not the site's `/_hero` edge cache that visitors hit (the first visitor per Vercel region still fills it).

# SyncGuard — Release-Gate Report

| | |
|---|---|
| Feature | SyncGuard: Majestic Escape's own OTA calendar-sync hub (iCal) with commitment-time verification |
| Gate run | 2026-10-03 → 2026-10-04, local only |
| Verdict | **READY FOR READ-ONLY PRODUCTION PREFLIGHT** (§A) |
| Design / runbook | [`docs/syncguard.md`](syncguard.md) — §20–§25 log every review finding and fix |
| Earlier closure report | [`docs/syncguard-closure.md`](syncguard-closure.md) — superseded where this report differs |
| Evidence (outside the repos) | `D:\majestic-escape\tests\syncguard-evidence\` (logs, JSON, JSONL, screenshots); scripts in `D:\majestic-escape\tests\syncguard-ui\` and `…\syncguard-perf\` |

Nothing was pushed, merged or deployed. No production write, migration or
OTA change was made. The production read-only preflight was **not
authorized** and was not run; the only production contact in the whole gate
was one anonymous public GET of `/api/v1/properties/dynamic` (listing count
for the cost model).

---

## A. Verdict

**READY FOR READ-ONLY PRODUCTION PREFLIGHT**

Every local gate passed on the final commits: 214/214 SyncGuard tests; the full backend
suite 524/525, where the one failure is a pre-existing KYC timing race in unchanged code (§D);
races 12 × 25 rounds with invariants; 40/40 mutations caught; 493/493 real-browser checks
across 11 widths and the admin page; builds, typechecks and project checks clean; the last of
six independent adversarial reviews found no double-booking path, and the defects the final
runs exposed were fixed with failing-first tests. What remains before deployment is outside
local verification: the read-only production preflight (needs your authorization) and the
owner decisions listed in §T.

**READY FOR DEPLOYMENT is not claimed:** the production read-only preflight
has not been authorized or run (§L).

---

## B. Exact commits tested

| Repository (worktree) | Branch | Base | Final commit |
|---|---|---|---|
| server.me (`server.me-syncguard`) | `feat/syncguard` | `origin/dev` 1e8448f (fast-forward) | **4ea094c** |
| user.website (`user.website-syncguard`) | `feat/syncguard` | 2a8afe6 (`origin/dev` is +2 footer-only commits; `git merge-tree` clean) | **6830ebb** |
| admin.site (`admin.site-syncguard`) | `feat/syncguard-attention` | ca3972f (fast-forward) | **e87c673** |

Backend commits (oldest first): 93fa7e4 feature · d74b8b1 · 4412c85 first
review · 1dd2ea4 closure · 36d035c D1–D4 · 00d62bf D5–D6 · 574e55b docs ·
28c4c02 second review · 7fc0569 L6b · 477e56a R1–R8 · 3dd5612 X1–X8 ·
eba500c F1–F4 · 19b655a G1–G3 · 4ea094c G1b. Diff vs base: 61+ files,
≈ 12.4 k insertions. Site: db65830 · 0cf0c22 · 4786834 · c81a019 · f3a3aa3 ·
6830ebb. Admin: a4156a1 · 06fcd40 · e87c673.

---

## C. Requirement coverage (requirement → implementation → test → runtime evidence)

| Requirement | Implementation | Automated tests | Runtime evidence |
|---|---|---|---|
| Never double-book a single-unit night | unique `(propertyId,date)` night ledger; `inventory.reserveNights` + `importedOverlap`; paid owners never displaced (`ledger.js`, `inventory.js`) | `syncguard-races` (12 scenarios × 25 rounds, DB invariants each round), `-shared-nights`, `-booking`, review-fix suites | `races-25-final.log`, `races.jsonl` |
| Re-verify OTA calendars before committing a guest | `prebook.ensureVerified`: 2 min at Confirm, 30 s at Pay / admin move / admin keep; unconditional re-fetch; raced pass re-read; `BEYOND_SYNC_HORIZON` | `-booking`, `-races` (5b), review2 H1/L4/M6, review3 R4 | `booking.jsonl`; UI "couldn't confirm" checks |
| Idempotent, safe reconciliation (no release on failure / emptiness / truncation / one absence) | `reconcile.js` (§3 policy), anomaly rule, started stays, host-held rows | `-reconcile`, `-failure-matrix` (23 failure modes byte-identical), `-chaos` | `reconcile.jsonl`, `failure-matrix.jsonl`, `chaos.jsonl` |
| No echo loops between OTAs | destination feeds, REFLECTED UIDs, possible echoes (coverage + "served after visible"), promotion | `-loops`, `-topology` (2/3/5 channels) | `loops.jsonl`, `topology.jsonl` |
| Conflicts never silently hidden | `ota_conflict` admin item (per-booking `adminFlaggedFor`, owed until landed), host e-mail, cross-OTA overlap notice | `-review-fixes`, review2 H2, review3 R5/R6, review4 X3/X6/F3 | admin UI suite, `ops.jsonl` |
| Broken sync cannot look healthy | timestamp-derived health (PENDING/HEALTHY/PARTIAL/DEGRADED/STALE/BROKEN/NEEDS_ATTENTION; outbound NOT_CONFIRMED/WAITING/OPENED/ACTIVE/QUIET); bookings restricted from first failure; scheduler STALE + daily e-mail | `-ops`, `-scheduler`, review2 M2/L6/L12 | UI main/states suites; admin page |
| Calendar URLs and feed tokens are credentials | masked URLs, no URL/token in logs/journal/API, 256-bit tokens, rotation, stop-link, SSRF guard | `-redteam`, `-ssrf`, `-export`, review3 R1 | `redteam.jsonl`; token-absence UI checks |
| Tenant isolation | connection → listing → host (or admin); 404 for others (no oracle) | `-host`, `-redteam`, authz matrix, review3 R1 (stop-export by another account → 404) | `host.jsonl` |
| Old clients keep working (mobile app, old web page) | legacy `saveCalendar` contract; refusals as 200 `success:false`; safe link replacement | `-host` legacy tests, review2 H3, review3 R2/R2b, review4 X1/X1b/F1/G1 | old-frontend/new-backend UI check (earlier gate run) |
| No paid service / no Redis | MongoDB leases + flags; Vercel cron + optional GitHub clock | — | §J |

---

## D. Test results (final commits)

| Command | Result | Duration |
|---|---|---|
| `SYNCGUARD_EVIDENCE=1 npm test` (server.me, all `tests/batch-s/*.test.js`) | **524 / 525 pass — the 1 failure is `trust-boundary` "provider cost guard", a pre-existing race (below); same suite on base 1e8448f: 311 / 311** | 392 s (base 347 s) |
| of which SyncGuard suites (`syncguard-*.test.js`) | **214 / 214 pass (22 files)** | — |
| `SYNCGUARD_RACE_ROUNDS=25 node --test tests/batch-s/syncguard-races.test.js` (at 6263381, same production code) | **12 / 12 scenarios × 25 rounds pass (59 s)** | 59 s |
| `npm run check:js` (server) | OK (203 files) | — |
| Mutation testing (`syncguard-perf/mutate.js`, 40 mutations of critical protections; run at 6263381 — production code identical to 4ea094c, which only changed a test fixture) | **40 / 40 killed** | 424 s |
| Failing-first proofs | every review-fix test was run against the commit before its fix and failed on its own assertion: review2 17/17 (574e55b) + L6b (28c4c02); review3 9/9 (7fc0569); review4 7/7 (477e56a); review5 X4/X6/F1/F3/F4 (3dd5612); review6 G1–G3 (eba500c), G1b (19b655a) | `review*-failing-first.txt` |
| user.website `check:js`, `check:search`, `check:ux`, `check:hero` | all OK | — |
| user.website `tsc --noEmit` | 0 errors | — |
| user.website `next lint` | 4 errors / 67 warnings — base 2a8afe6: 4 / 68 (no new problem; SyncGuard folder lint-clean) | — |
| user.website `next build` | OK; `/host/dashboard/calendar` 20.9 kB, first load 281 kB | 50 s |
| admin.site `check:js`, `check:hero`, `check:joined`, `check:support-inbox` | all OK | — |
| admin.site `tsc --noEmit` | 0 errors | — |
| admin.site lint | base ESLint config is broken (flat config in `.eslintrc.json`, pre-existing); changed files linted with a temporary config: 1 pre-existing error, none new | — |
| admin.site `next build` | OK; `/dashboard/calendar-sync` 6.51 kB | 45 s |

**The one full-suite failure** (`trust-boundary.test.js` "provider cost guard",
failed in all four full branch runs, never alone): `panKycController` sends a
provider-failure response and only then, in `finally`, clears the KYC
in-flight marker; the test reads the marker as soon as the response arrives,
so under load it can still be set. `services/kycGuard.js` and
`controllers/panKycController.js` are byte-identical to base; it passes alone
on both trees; in three interleaved rounds under the same load the branch
failed it once and base once failed a different pre-existing test
(`site-hero-ops` lease). The branch's larger suite (525 vs 311 tests) raises
the parallel load. Not changed (unrelated product code; the rules forbid
editing it to make a flaky test green) — owner follow-up.

Two SyncGuard tests failed once each in the final full runs and were
root-caused: the 5-OTA loop simulation (a real stale-clock defect, N1, fixed)
and the failure matrix's gzip bomb (the fixture compressed 40 MB inside the
request and hit the fetch deadline under load — fixture fixed, assertion
kept). Both then passed 3 × under heavy concurrent load.

Flaky-test causality (interleaved base 1e8448f vs branch, `flaky-compare.txt`;
run on the branch as of the second review — later commits add no timers or
start-up work): normal load — `site-hero-ops` failed 1/6 on base and 1/6 on
the branch (the same pre-existing lease test); place-search p95 base
1.6–7.4 ms, branch 1.6–5.7 ms (limit 10 ms). High load (6 heavy suites,
concurrency 16) — base 2 failures in 1 of 3 runs, branch 0 of 3. Conclusion:
no flakiness caused by SyncGuard. Once during the gate, `check:search` /
`check:joined` / `check:support-inbox` failed while two Next builds ran
concurrently; they passed in 5 later runs including under a build — not
reproduced.

---

## E. Real browser results

Production builds served locally (`next start`), the isolated e2e backend
(in-memory MongoDB, :5005/:5056) and a fake OTA (:5099); Chromium via
Playwright; the backend restarted between batches (connect rate limit).
Final run on server 4ea094c / site 6830ebb / admin e87c673
(`ui-final.txt`):

| Suite | Widths | Result |
|---|---|---|
| Host panel main (`syncguard-ui.mjs`) | 360, 390, 768, 1024, 1440, 1920 | 240 / 240 |
| Extras: timeout, slow network, double-click, Back/Forward, focus trap, names, 44 px targets, stale/anomaly/overlap, storage (`-extra`) | 320, 375, 640 (= 1280 at 200 % zoom), 1920 | 95 / 95 |
| Cross-OTA overlap banner (`-overlap`) | 360, 390, 768, 1440 | 36 / 36 |
| New states: PARTIAL, OPENED, disconnect keeps link, Stop link (`-states`) | 360, 768, 1440 | 54 / 54 |
| Admin "Calendar sync" page (`syncguard-admin-ui.mjs`) | 360, 768, 1024, 1280 | 68 / 68 |

Checks include: no horizontal overflow, nothing spilling out of cards,
accessible names on every control, ≥ 44 px touch targets, focus trapped in
dialogs and returned on Escape, no page errors, no calendar URL or feed
token in the page, readable announced errors, nothing saved on failure, one
request on double-click, reduced motion. Screenshots:
`tests/syncguard-evidence/ui/*.png` (94 files). Earlier gate runs also
covered: new frontend + old backend (graceful 404s), old frontend + new
backend (refused-link messages shown), the explain dialog via Playwright MCP.
Found by the UI pass and fixed: L6b ("Link in use" never appeared after a
chat preview).

---

## F. Concurrency / race results

`syncguard-races` — 12 scenarios × 25 rounds, invariants after every round
(I1 one owner per night, I2 no paid booking over an OTA night, I3 at most one
payment per booking, I4 no duplicate import rows, I5 nothing reopened):
two guests at once; direct vs OTA booking together; OTA booking on an
unpaid hold racing create-order; OTA booking on paid nights; OTA booking
during payment verification with duplicate callbacks/webhooks; admin date
move vs OTA booking; Pay re-reading a 60-s-old calendar; host unblock vs
sync; OTA cancel vs guest booking; duplicated sweeps; lost lease mid-fetch;
crash mid-reconcile. Also: fencing (`-chaos`), lease revocation on URL change
(D5), raced passes never stamping "verified" (L2) and never counting as a
verification (R4), "Stop link" racing a reconnect (X5), hold-before-switch
(G1/G1b). Result: 12 / 12 scenarios × 25 rounds pass (59 s).

---

## G. Security results

* **SSRF** (`-ssrf`, `-redteam`): https only; IP literals in every encoding,
  private/loopback/link-local/metadata/CGNAT/NAT64/6to4/Teredo/ULA ranges,
  mixed DNS answers refused; socket pinned to the validated address
  (rebinding proven closed); redirects ≤ 3, re-validated; 2 MB cap on the wire
  and after decompression; error/redirect bodies closed, never drained (H4).
* **Parser DoS**: zone-name regex freeze (C1: 4.9 s → ≤ 51 ms), BYMONTHDAY bomb
  (M1: 3 s / 415 MB → 6 ms / 2 MB), EXDATE line (R3: 2.1–4.5 s → 17–39 ms),
  zone caches bounded (74 → 2 MB); per-file rule/occurrence/event budgets.
* **Auth / RBAC / tenant matrix**: every connection route resolves connection
  → listing → host or admin; others get 404 (no existence oracle); the new
  `stop-export` route included (R1). Bearer header only (no CSRF vector).
  Rate limits: connect 20/10 min/account (now including legacy replacement
  attempts, X2), Sync now 1/min, 10 connections/listing, 100/account.
* **Tokens / secrets / privacy**: feed tokens 256-bit, never returned except
  in the owner's own export link, never logged; inbound URLs masked; journal
  carries no URL/token/guest data; disconnected live links listed without the
  token and revocable (R1); public GitHub Actions log prints success flags
  only (D8); docs name no cluster hosts (D9).
* Security observations outside SyncGuard were reported to the owner
  separately (not in this public repository).

---

## H. Performance (before vs after)

Measured on this machine (Windows, Node 24, in-memory replica set) on the
final code, 2026-10-04. Base = 1e8448f. CPU ranges are two runs on a machine
other sessions were also using (the test client and fake OTA share the
process, so these are upper bounds). `perf-backend.json`,
`perf-cpu-per-op.json`.

| Measure | Base | Branch |
|---|---|---|
| Load every route module (cold) | 680 ms, heap 37.5 MB | 629 ms, heap 36.9 MB |
| Confirm (`POST /booking`), listing without calendars | 22.6 ms, 7 DB ops | 24.1 ms, 9 DB ops |
| Pay (`create-order`), listing without calendars | 23.8 ms, 10 DB ops | 24.6 ms, 12 DB ops |
| Confirm with 1 stale calendar re-read / 3 calendars | — | 37 ms (15 ops) / 41 ms (23 ops) + the OTAs' own latency (≤ 8 s deadline) |
| Unchanged poll (20 events) | — | 4 DB ops, 6.2–8.6 ms CPU |
| Poll with one changed event | — | 23 DB ops, 27–63 ms CPU |
| Daily full pass, 10 / 100 / 300 events | — | 66 / 516 / 1 516 ops; 84–159 ms CPU (20 events) |
| An OTA fetching its Majestic feed | — | 5 DB ops, 0.6–9.4 ms CPU |
| Sweep of 100 due calendars | — | 0.28 s, 417 ops, 100 fetches |
| Parse 30 / 200 / 800-event Airbnb-shaped feeds | — | median 0.4 / 1.5 / 2.6 ms; peak heap ≤ 3.2 MB |

---

## I. Browser / tab resources

Host calendar page, base build vs final SyncGuard build (6830ebb), same
listing and backend, medians of 5 Chromium loads (2026-10-04,
`frontend-perf.mjs`): load 94 vs 102 ms; DOMContentLoaded 23 vs 27 ms; script
transfer 997 vs 1 005 KB; JS heap 11.8 vs 11.9 MB; long tasks 0 vs 0; idle CPU
5 vs 4 ms per 15 s; idle requests 0 vs 0; request count on load 122 vs 122;
SyncGuard starts no timer. 100 open/close cycles of the dialogs (CDP
listener counts, `leak-deep.mjs`): window / document / body / element
listeners 28 / 151 / 139 / 209 at 0, 50 and 100 cycles; DOM nodes 474
throughout; heap plateaus 12.8 → 13.7 → 13.8 MB; no calendar request after
leaving the page. Bundle: calendar route 12.4 → 20.9 kB, first load
261 → 281 kB; guest pages unchanged; admin page 6.5 kB.

---

## J. Database / infrastructure cost

Per connected listing per day (1.5 calendars, 15-min cadence, 5 % of polls
see a change, one full pass with ~20 events, each OTA fetching its Majestic
feed ~12×): ≈ 900 DB operations, ≈ 1.2–2.0 s Node CPU (upper bound; sized at
2.0 s below), 144
outbound calendar fetches, ~18 feed requests. Pending work (an unconfirmed
disappearance, an echo under review, an owed admin flag) makes the affected
calendar's polls unconditional until it clears — Airbnb sends no ETag, so
for Airbnb nothing changes.

| Connected listings | OTA fetches/day | DB ops/day (avg/s) | Node CPU/month | First limit reached |
|---|---|---|---|---|
| 19 (live listings today) | 2.7 k | 17 k (0.2) | ≈ 11–19 min | none |
| 10 | 1.4 k | 9 k (0.1) | ≈ 6–10 min | none |
| 100 | 14 k | 90 k (1) | ≈ 1–1.7 h | none |
| 1 000 | 144 k | 0.9 M (10; sweep peaks > 100) | ≈ 10–17 h | Vercel Hobby active CPU (4 h/month ≈ 240–400 connected listings); Atlas M0 100 ops/s (sweeps throttled) and 10 GB/week transfer |
| 10 000 | 1.4 M | 9 M (104) | ≈ 100–167 h | paid compute tier or a dedicated worker, and a dedicated Mongo tier |

Plan facts (vendor docs, 2026-10-03): Vercel Hobby — 4 active-CPU h, 360 GB-h
memory, 1 M invocations per month, 300 s max, **non-commercial use only**;
Atlas M0 — 100 ops/s, 500 connections, 0.5 GB, 10 GB in / 10 GB out per
rolling 7 days. **No Redis and no paid service is added.**

---

## K. Scheduler evidence

Trigger-agnostic scheduler (`nextSyncAt`, 5-min leases, oldest due first,
bounded concurrency, deadline-aware): `-scheduler` and `-ops` suites
(duplicate sweeps, starvation, lease expiry, fencing, STALE derivation).
Triggers: daily Vercel cron (full pass) — on Hobby the only guaranteed
clock; optional 10-min GitHub Actions clock (inert until the owner sets the
secret); calendar views, host actions, commitment checks and feed requests
nudge. The scheduler state (HEALTHY / DEGRADED / STALE) and the calendars that
need a look are on the admin **Calendar sync** page; the daily cron e-mails
ops when the clock is STALE (at most once per 20 h, L12). **Safety does not
depend on the scheduler**: every booking re-verifies at commitment.

---

## L. Migration evidence

`scripts/syncguard-migrate.js`: preflight (read-only) → deploy → `--apply`
→ `--create-indexes`. Tests (`-migrate`): preflight writes nothing; `--apply`
deterministic and idempotent (second run byte-identical); index creation
refuses while conflicts remain; every legacy feed URL keeps serving.
**Dev cluster preflight (read-only, re-run on the final code 2026-10-04)**: 4 Airbnb import
connections, 26 legacy rows, 8 wrong-host rows, 7 listings with duplicate
legacy feeds (20 links), **0 unique-index conflicts**, 31 repairs, no human
decisions. **Production preflight: not authorized, not run.** The script
refuses a cluster it is not told to target (`--confirm-db=master-db`).
The `--apply` backfill added during the gate was removed again (F2: it could
mark owed admin flags as done; SyncGuard has never run in production).

---

## M. Rollback evidence

Kill switches (no redeploy): `syncguard-flags.js --pause` (no fetches; blocks
stay; bookings of connected listings refused while unverifiable) and
`--propagation-off` (feeds carry Majestic-native events only). Frontend
rollback is always safe (legacy endpoint unchanged). Backend code rollback
requires `--rollback-prepare` first — proven with the real old code: without
it a two-calendar listing reopened a booking; with it nothing reopened;
`--rollback-undo` reverses it. After a backend rollback every per-connection
Majestic link answers 404 and legacy feeds return to their old behaviour
(500) — documented (§14).

---

## N. Independent review results

Six adversarial passes beyond my own; every credible finding was reproduced,
fixed and regression-tested (test failing on the pre-fix commit), then the
fix itself re-reviewed:

| Pass | Scope | Findings | Outcome |
|---|---|---|---|
| Review 1 (pre-gate) | whole feature | 6 + 5 low | fixed (§20) |
| Gate self-audit | whole feature | D1–D9 | fixed (§21) |
| Review 2 | gate code | C1, H1–H4, M1–M8, L1–L12 (+ L6b from the UI pass) | fixed; M5, M8, L3, L8, L10, L11 kept as documented trade-offs (§22) |
| Review 3 | review-2 fixes | R1 High (reconnect killed the OTA's link), R2 Medium (legacy replaced a merely failing link → nights sold), R3–R8 | fixed (§23) |
| Review 4 | R-fixes | X1 Medium (403s made a link "reset" → 201 on OTA-sold nights), X2–X8 | fixed (§24) |
| Review 5 | X-fixes | F1 High (a dead link with no stays replaced by another listing's link → 201), F2 Medium (backfill could hide owed admin flags), F3, F4 | fixed (§25) |
| Review 6 | F-fixes | **no double-booking path**; G1 Low-Med, G2 cost, G3 info | fixed (§25); self-audit added G1b |
| Final full runs | everything | N1 Low (background refresh reused the request's timestamp); a test fixture timing out under load | fixed (§25); stress-tested |

The double-booking findings of reviews 3–5 were all introduced by the
mobile-app link-replacement feature added for review 2 (H3). It now needs
both a persistent 404/410 and proof of the same listing; otherwise the new
link is added beside the dead one and bookings stay refused.

---

## O. Remaining Majestic-controlled risks

1. **Narrow echo window** — an event from a site without reservation markers
   on nights Majestic stopped exporting less than ~one poll + 1 h earlier is a
   possible echo: it blocks Majestic and raises conflicts but is withheld from
   other OTAs for up to 6 h; another OTA could sell those nights then.
2. **Slow re-exporting calendars** can bounce a promoted block; visible to the
   host, cleared on that OTA.
3. **Blocks kept on disconnect are forwarded to a new link of the same site**
   (M8) — a visible over-block until the host releases it.
4. **Mobile-only host with a reset link whose stays all changed UIDs** — the
   new link is added beside the dead one; the listing refuses direct
   bookings until the host disconnects the dead link in the web panel
   (availability loss, never a double sale); it may also show an overlap
   notice.
5. **Daily-pass repairs** — leftover night rows after a crash, conflict
   banners after the other side is resolved: safe direction only.
6. **Propagation speed without the external clock** — Vercel Hobby cron is
   daily; bookings stay safe, cross-OTA propagation is slower.
7. **Not yet exercised on production data** — the production preflight needs
   authorization.

No path inside Majestic's control is known that reopens an occupied night,
hides a conflict, shows a broken calendar as healthy, or lets a late worker
overwrite newer state.

---

## P. Unavoidable OTA / iCal limitations

* When an OTA **publishes** a new booking in its export (Majestic re-verifies
  the feed at commitment, not the OTA's internal state).
* When an OTA **fetches** Majestic's feed (Airbnb ~3 h, Booking.com ~2 h, Vrbo
  ~30 min, Agoda "several times a day"): a night sold on Majestic can be sold
  again on the OTA inside that window. This is the irreducible iCal window;
  only official APIs remove it. **No 100 % protection is claimed.**
* Undocumented OTA behaviour: re-export of imported blocks, cancellation as
  removal vs `STATUS:CANCELLED`, UID stability, reservation markers on double
  sales.
* MakeMyTrip / Goibibo publish no iCal; OTA APIs are not open to Majestic today.
* Real feed shapes: only 2 Airbnb feeds exist on the dev cluster (both parsed
  correctly by the final parser on 2026-10-04, 0 unreadable entries,
  read-only); other OTAs' shapes are **externally limited**.

---

## Q. Trade-offs

| Trade-off | Why |
|---|---|
| Fail-closed commitment: a listing whose connected calendar cannot be checked takes no direct bookings | a single-unit night must not be sold twice |
| Up to 8 s extra at Confirm/Pay when a calendar must be re-read (typically 0.3–2 s) | paid only by a guest about to pay |
| Freed dates reopen later than reality (≥ 2 h; ≥ 12 h after a mass disappearance; held/started stays only by the host or at checkout) | false "blocked" costs hours; false "free" costs a double booking |
| Possible echoes block Majestic and are withheld from other OTAs ≤ 6 h | forwarding every uncovered event recreates OTA phantom loops |
| Non-Airbnb mirrors of paid bookings alert the admin (M5) | a real double sale there looks identical |
| Mobile-app link replacement only with proof of the same listing | a wrong replacement could sell nights; refusing bookings is safe |
| Imported stays cannot be cancelled from Majestic booking tools | they are the OTA's bookings |
| Feed tokens visible in Vercel request logs | inherent to URL-subscribed calendars; rotation / stop mitigate |
| Calendar route +8.5 kB (12.4 → 20.9 kB; first load 261 → 281 kB) | dialogs could be lazy-loaded later |

---

## R. Exact promotion steps (owner decides; nothing done)

1. Authorize and run the **read-only production preflight**:
   `node scripts/syncguard-migrate.js --confirm-db=master-db` with the
   production connection string; review the report (expect 0 conflicts).
2. Push the three branches and open PRs into `dev`; let CI run.
3. Promote through the usual pipeline (dev → dev-deployment → production
   branches); deploy **server.me first** (old frontends and the mobile app keep
   working).
4. `node scripts/syncguard-migrate.js --apply`, then `--create-indexes`;
   confirm the `[startup] SyncGuard indexes` warning is gone.
5. Verify `PUBLIC_HOSTNAME`; fetch one legacy feed URL (expect 200
   `text/calendar`).
6. Deploy admin.site, then user.website.
7. Optional 10-min clock: set `CALENDAR_SYNC_CRON_SECRET` (Vercel + GitHub),
   the `SYNCGUARD_SWEEP_URL` variable, and merge the workflow to `main`.
8. Watch the admin **Calendar sync** page for a week.

---

## S. Exact rollback steps

1. First resort: `node scripts/syncguard-flags.js --pause` (or
   `--propagation-off`) — no redeploy, no released dates.
2. Frontends: redeploy the previous user.website / admin.site deployment
   (always safe).
3. Backend code: `node scripts/syncguard-migrate.js --rollback-prepare`
   **first**, then redeploy the previous server.me deployment; tell hosts
   their Majestic links are paused (per-connection links answer 404).
4. Return: redeploy SyncGuard, `--rollback-undo` (or `--apply`).

---

## T. Final statement

| Statement | Evidence? |
|---|---|
| No known Majestic-controlled path reopens a genuinely occupied night | **Yes** — race suite (12 × 25 rounds with invariants), failure matrix, chaos, six adversarial reviews (the last found none), 40/40 mutations caught |
| No known genuine OTA conflict is silently hidden | **Yes** — paid conflicts reach the admin queue per booking until landed (X3/X6/F3/R5), host e-mail, cross-OTA overlaps shown; the only non-alerting case is Airbnb's verified "Not available" mirror of a paid booking (shown to the host) |
| Broken synchronization cannot remain falsely healthy | **Yes** — health derived from timestamps, PARTIAL/OPENED states, restriction from the first failure, STALE clock e-mail; UI-verified |
| Tenant isolation remains intact | **Yes** — authz matrix incl. the new stop-export route (404 for others, no oracle) |
| Performance / resource use within budget | **Yes, at today's scale and up to ≈ 240–400 connected listings on Vercel Hobby** — beyond that a compute change is needed (§J); Confirm/Pay +2 DB ops, latency within noise |
| No new Redis / paid infrastructure required | **Yes** — MongoDB only; GitHub Actions clock free for this public repo (optional) |
| Browser / tab resource behaviour has not regressed | **Yes** — no timers, no idle requests, listeners/DOM flat over 100 cycles; route bundle +8.5 kB |

What cannot be supported: protection inside the OTA-controlled windows (§P),
and production-data behaviour, because the read-only production preflight
was not authorized.

**Owner actions** (pre-existing, outside SyncGuard; security items reported
to the owner separately): decide on Vercel Hobby's non-commercial terms;
fix the broken admin ESLint config; the mobile app shows a generic "Request
failed with status code 409" for booking refusals (follow-up); the
403-vs-404 listing-ownership difference elsewhere in the API (listing IDs are
public); the KYC in-flight marker is released after the response is sent (the
"provider cost guard" test race, §D).

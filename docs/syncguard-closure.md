# SyncGuard — Feature Closure Report

| | |
|---|---|
| Feature | **SyncGuard** — Majestic Escape's own OTA calendar-sync hub (replaces a paid channel manager for single-unit stays) |
| Date | 2026-10-03 |
| Status | **Built, tested, independently reviewed — LOCAL ONLY.** Nothing pushed, merged or deployed; no production database, migration, OTA listing or calendar connection touched. |
| Design / runbook | [`docs/syncguard.md`](syncguard.md) (architecture, policies, migration, rollout, rollback, cost, runbook, review log §20) |
| Reviewer guide | §5 lists every commit, file and test; §13 gives the commands to reproduce every number in this report |
| **Superseded in part** | The release-gate verification that followed this report found and fixed 9 more defects and re-measured everything: see [`docs/syncguard-release-gate.md`](syncguard-release-gate.md) and `docs/syncguard.md` §21. Where the two disagree, the release-gate report is current (notably: Pay re-verifies calendars read more than **30 s** earlier, not 2 min; timed events follow the noon rule; 214 SyncGuard tests at the end of the gate; six independent reviews in all). |

Contents
1. [The problem this feature solves](#1-the-problem-this-feature-solves)
2. [What was planned vs what was implemented](#2-what-was-planned-vs-what-was-implemented)
3. [How it works now (After)](#3-how-it-works-now-after)
4. [Property X — the mandatory scenario, end to end](#4-property-x--the-mandatory-scenario-end-to-end)
5. [Evidence](#5-evidence)
6. [Adversarial challenge, self-audit and the independent review](#6-adversarial-challenge-self-audit-and-the-independent-review)
7. [Cost](#7-cost)
8. [Security](#8-security)
9. [Reliability: Majestic guarantees vs OTA-controlled limits](#9-reliability-majestic-guarantees-vs-ota-controlled-limits)
10. [Trade-offs and drawbacks](#10-trade-offs-and-drawbacks)
11. [Residual risks](#11-residual-risks)
12. [What is local-only, and what promotion would do](#12-what-is-local-only-and-what-promotion-would-do)
13. [How to reproduce the verification](#13-how-to-reproduce-the-verification)
14. [Follow-ups](#14-follow-ups)

---

## 1. The problem this feature solves

### 1.1 Business problem

Majestic Escape has no revenue and cannot pay for a channel manager, yet its
hosts list the same single-unit property on Airbnb, Agoda, Booking.com, Vrbo
and others. Without synchronisation, a night sold on one site stays sellable
on the others → **double bookings**: a guest turned away at the door, a
refund, a penalty from the OTA, a host who stops trusting Majestic.

### 1.2 What Majestic actually had (verified on `origin/dev` 1e8448f, not assumed)

Every item below was reproduced against the unmodified code (real HTTP
against an in-memory replica set and a local ICS server) or read from the
code / dev cluster (read-only). Full table: `docs/syncguard.md` §0.

```text
Before:
  OTA ──(host pastes ONE iCal URL)──► node-cron timer registered inside a save
                                      request (never fires on Vercel)
                                      └─► "best effort" import; an empty 200
                                          response cancels everything
  Majestic ──► export URL ──► HTTP 500 (always)
```

| # | Verified defect | Consequence |
|---|---|---|
| D1 | Export **always returned 500** (`ical is not a function`) | No OTA ever received a single Majestic booking — every Majestic sale could be resold on every OTA |
| D2 | One host's save synced **every host's** calendars inside one request | Cross-tenant work, unbounded latency |
| D3 | Imported rows attributed to the **saving** host (dev cluster: 8 such rows) | Wrong ownership |
| D4 | A second calendar per property was silently ignored | Airbnb + Agoda on one listing → one of them never imported |
| D5 | One valid **empty** 200 response cancelled every import and reopened its nights | A blip at an OTA reopened booked nights for sale |
| D6 | SSRF: host-supplied URL fetched with no scheme/address/redirect/size limits | The backend could be pointed at internal addresses |
| D7 | Export secret minted on every calendar page mount (dev: 7 listings with duplicates) | Token sprawl |
| D8 | No real scheduler on Vercel (timer inside a request; instance frozen afterwards) | Inbound sync effectively never ran |
| D9 | No provenance (which connection/channel/event) | Nothing explainable, nothing reconcilable |
| D10 | Import night claims "best effort": collisions with Majestic holds/bookings silently dropped | OTA double-sales invisible |
| D11 | Export would echo imports back to their origin, leak `Booking <ObjectId>`, churn DTSTAMP | Loops, data leak |
| D12 | No health / error / freshness state | Broken calendars looked fine |
| D13 | `node-ical` date handling depended on the server time zone (all-day RRULE + EXDATE shifted a day under `TZ=Asia/Kolkata`) | Wrong nights blocked |
| D14 | Admin attention UI labelled every non-`amount_mismatch` reason "dates taken during payment" | Misleading ops UI |

**Double-booking windows before SyncGuard:** outbound never happened (D1);
inbound never ran on schedule (D8); an empty or partial feed reopened every
imported date at once (D5); OTA bookings colliding with Majestic
holds/bookings were dropped silently (D10). In practice, **nothing protected
a Majestic listing from being sold twice.**

### 1.3 What the feature changes, in one paragraph

Every OTA calendar a host connects is imported safely (source-aware,
validated, never trusting an empty or broken response), protects Majestic's
own inventory through the same atomic night ledger direct bookings use, is
**re-verified at the moment a guest commits** (Confirm / Pay / admin move —
fail-closed), and every OTA gets **its own Majestic feed** carrying Majestic
bookings plus every *other* OTA's bookings — never its own events back, never
unproven echoes, never guest data. Health is honest in both directions, and
every block is explainable ("why is Oct 12 unavailable?").

---

## 2. What was planned vs what was implemented

Status vocabulary (as required by the review comments, point 15):
**IMPLEMENTED + VERIFIED** · **NOT APPLICABLE** (+ evidence) ·
**EXTERNALLY LIMITED** (+ evidence) · **BLOCKED** (+ exact reason).
"Test" names refer to `tests/batch-s/syncguard-*.test.js` unless stated.

### 2.1 The original brief (55 sections)

| § | Requirement | Status | Implementation → evidence |
|---|---|---|---|
| 0 | Establish exact baseline | IMPLEMENTED + VERIFIED | §1.2 above; probe on unmodified code; dev cluster read-only (`docs/syncguard.md` §0) |
| 1 | Fix / harden existing ICS export first | IMPLEMENTED + VERIFIED | `exportFeed.js`: valid ICS, `text/calendar`, all-day exclusive DTEND, deterministic body, ETag/304, opaque HMAC UIDs, "Not available" only. Test: export "the export is fixed…" |
| 2 | Replace the lazy in-process scheduler | IMPLEMENTED + VERIFIED | DB-driven `sync.nextSyncAt`, 5-min leases, Vercel daily full pass, optional 10-min external clock, nudges, heartbeat. Tests: scheduler (6) |
| 3 | Source-aware connections | IMPLEMENTED + VERIFIED | `ExternalCalendar` extended (channel, name, status, urlHash, export.*, sync.*, stats.*); ≤ 10 per listing; same URL twice refused. Tests: reconcile "same calendar connected twice…", host suite |
| 4 | Source-aware imported events | IMPLEMENTED + VERIFIED | `Booking.external` provenance + unique `(connectionId, key)`. Test: reconcile "same UID from two different connections…" |
| 5 | Safe reconciliation state machine | IMPLEMENTED + VERIFIED | `reconcile.js` (exact policy in `docs/syncguard.md` §3). Tests: reconcile (14+3), acceptance |
| 6 | Modifications leave no ghost blocks | IMPLEMENTED + VERIFIED | `releaseOutside` then claim. Tests: reconcile "MODIFIED without a ghost night", 8-step harness step 3 |
| 7 | Destination-specific exports | IMPLEMENTED + VERIFIED | One feed per connection: natives + other connections' genuine imports. Tests: export "destination feeds…", acceptance points 5–6 |
| 8 | Prevent transitive ghost loops | IMPLEMENTED + VERIFIED (heuristic residual in §11) | Evidence levels REFLECTED / POSSIBLE ECHO / GENUINE, promotion after 6 h uncovered. Tests: loops (7), review-fixes F5 |
| 9 | Majestic-generated event provenance | IMPLEMENTED + VERIFIED | UID namespace `me-<HMAC>@sync.majesticescape.in`; reflected copies dropped. Test: loops "true reflection…" |
| 10 | Reliable inbound polling | IMPLEMENTED + VERIFIED; cadence EXTERNALLY LIMITED | Vercel Hobby cron runs at most daily (±59 min, [V] docs) → optional GitHub clock every 10 min (inert until the owner sets a secret); safety never depends on cadence (row 13) |
| 11 | Event-triggered fast path (OTA e-mails) | **BLOCKED** — foundation only | Exact reason: no OTA documents a stable notification format; verified inbound mail with SPF/DKIM verdicts + signed webhooks is paid or needs DNS changes; adding a paid service needs explicit justification. The internal hook exists (`syncConnection(id,{force:true})`). `docs/syncguard.md` §16 |
| 12 | Immediate source reconciliation | IMPLEMENTED + VERIFIED | Connect test, URL change, "Sync now", stay-calendar views, feed requests (background nudge), commitment checks all trigger syncs |
| 13 | Live pre-booking protection | IMPLEMENTED + VERIFIED | `ensureVerified()` at Confirm (> 2 min old) and Pay / admin move (> 30 s old, release gate D3) → re-fetch with 8 s deadline → failure = 409 `AVAILABILITY_UNVERIFIED`. Tests: booking (11+4) |
| 14 | State the fundamental limitation | IMPLEMENTED (documentation) | §9 below; `docs/syncguard.md` §10 |
| 15 | Atomic Majestic booking | IMPLEMENTED + VERIFIED | Existing Batch S unique night ledger reused; imports go through it; `importedOverlap` guard. Test: booking "two direct bookings in the same millisecond…" |
| 16 | OTA event vs direct booking race | IMPLEMENTED + VERIFIED | `ledger.claimNights` classifies every collision. Tests: booking "OTA event appears while the guest is paying…", shared-nights races |
| 17 | Temporary holds / payment | IMPLEMENTED + VERIFIED | Imports displace unpaid holds; `secureHold`/`securePermanent` refuse import-covered nights; late payment → `inventory_conflict` queue, never confirmed. Tests: booking, shared-nights |
| 18 | Single-unit vs multi-unit | NOT APPLICABLE | Unique `(propertyId, date)` ledger + no unit count on `ListingProperty`: every listing is single-unit; Booking.com/Agoda themselves only offer iCal for one-unit room types |
| 19 | Sync health / freshness | IMPLEMENTED + VERIFIED | `health.js`: PENDING / HEALTHY / DEGRADED / STALE (180 min) / BROKEN / NEEDS_ATTENTION / DISCONNECTED; outbound NOT_SET_UP / NOT_CONFIRMED / WAITING / ACTIVE / QUIET. UI suite |
| 20 | Fail-safe stale behaviour | IMPLEMENTED + VERIFIED | Stale never shows green; commitment fails closed; failures never release. Tests: reconcile "failures never change reservations…", booking 11 min / 1 h / 12 h / 23 h |
| 21 | Full reconciliation | IMPLEMENTED + VERIFIED | Daily `mode=full`: unconditional fetch, re-claims nights, clears released rows' nights, repairs a changed status. Tests: shared-nights "a later full pass…", review-fixes F2 |
| 22 | Host connection UX | IMPLEMENTED + VERIFIED | Calendar-sync panel: 3-step wizard, two directions shown separately, explain dialog, safe disconnect. UI suite 200/200, MCP checks |
| 23 | Provider guidance | IMPLEMENTED + VERIFIED | `channels.js` per-provider steps and refresh times (Airbnb, Booking.com, Agoda, Vrbo, MakeMyTrip/Goibibo, generic) |
| 24 | Nice UX without performance damage | IMPLEMENTED + VERIFIED | No polling, no timers (measured), one GET, refresh on focus/after actions; route +~19.5 KB gzip |
| 25 | SSRF | IMPLEMENTED + VERIFIED | `safeFetch.js` (§8). Tests: ssrf (10), host "connect validation…" |
| 26 | ICS parser hardening | IMPLEMENTED + VERIFIED | Own bounded reader `icsReader.js` (limits in §8). Tests: ics (18), review-fixes F1/F3 |
| 27 | Export token security | IMPLEMENTED + VERIFIED | 256-bit, unique index, rotation kills the old token at once, disconnect revokes. Test: export "rotation kills…" |
| 28 | RBAC / authorisation | IMPLEMENTED + VERIFIED | connection → listing → `listing.host` or admin; others get 404. Test: host "tenant isolation…" |
| 29 | Multi-tenant isolation | IMPLEMENTED + VERIFIED | Same test; per-host fetch cap; sync work never crosses listings (fixes D2) |
| 30 | No external dashboard scraping | NOT APPLICABLE (complied) | No OTA login, no scraping, no Playwright against OTA dashboards anywhere |
| 31 | Future official OTA API adapters | IMPLEMENTED (interface) / adapters EXTERNALLY LIMITED | Reconciliation consumes normalised events `{key, uid, startDay, endDay, status, transparent, summaryKind}`; an API adapter plugs in without touching inventory. Adapters impossible today: no API access (row 32) |
| 32 | API capability research | IMPLEMENTED | `docs/syncguard.md` §9, §15: Airbnb partner-only; Booking.com paused for new providers; Expedia/Vrbo no direct property connections; Agoda questionnaire + certification + pilot; MMT via business development |
| 33 | Observability | IMPLEMENTED + VERIFIED | `CalendarSyncLog` transitions (90-day TTL), structured logs without URLs/tokens, explain endpoint, admin overview API |
| 34 | Actual reliability metrics | IMPLEMENTED + VERIFIED (API) | `stats.*` counters per connection + totals in `GET /calendarSync/admin/overview`. No admin UI page yet (§14) |
| 35 | Cost / resource budget | IMPLEMENTED + VERIFIED | Measured per operation; estimated at 10 / 100 / 1k / 10k listings (§7) |
| 36 | Safe HTTP caching | IMPLEMENTED + VERIFIED | Inbound ETag/Last-Modified with 304 handling (validators dropped while confirmations are pending or after a raced pass); outbound ETag/304. Tests: reconcile "304…", ssrf "conditional requests" |
| 37 | Retry policy | IMPLEMENTED + VERIFIED | Backoff 5 min → 6 h; permanent errors → BROKEN + one host e-mail; no hammering at commitment (30 s) |
| 38 | Sync locking | IMPLEMENTED + VERIFIED | Lease + token-conditional release + fencing before reconcile + revision-conditional row writes. Tests: reconcile "fencing…", scheduler "a sweep killed mid-run…", review-fixes "release that loses its revision race…" |
| 39 | Backwards compatibility | IMPLEMENTED + VERIFIED | Legacy `POST /saveCalendar` contract unchanged (mobile app); every legacy feed URL keeps working. Tests: host "legacy saveCalendar…", export "legacy duplicate export rows…" |
| 40 | Migrations | IMPLEMENTED + VERIFIED | `scripts/syncguard-migrate.js` preflight / apply / create-indexes / rollback-prepare / rollback-undo. Tests: migrate (4) + review-fixes migration; dev-cluster preflight run read-only |
| 41 | Failure matrix | IMPLEMENTED + VERIFIED | Network (refused, DNS failure, DNS slowness, timeout, slow loris), feed (500, HTML, truncated, oversize, bomb, empty, unreadable event), process (killed sweep, frozen worker, crash between writes), DB (raced writes), booking (holds, payment races), security (SSRF variants, tenancy) — mapped in §5.3 |
| 42 | Real browser testing | IMPLEMENTED + VERIFIED | Scripted Playwright against the production build: 200/200 (5 widths) + 36/36 overlap banner (4 widths); Playwright MCP interactive checks |
| 43 | Real end-to-end calendar harness | IMPLEMENTED + VERIFIED | Test: acceptance "8-step provider harness (brief §43)" |
| 44 | Property X acceptance | IMPLEMENTED + VERIFIED | §4 below; test: acceptance "Property X…" |
| 45 | External reality | IMPLEMENTED (documentation) | `docs/syncguard.md` §9 with [V]/[U] sourcing |
| 46 | Production rollout | **BLOCKED** — awaiting owner permission (by instruction) | Step-by-step plan in `docs/syncguard.md` §13 and §12 below |
| 47 | Rollback | IMPLEMENTED + VERIFIED | Kill switches; `--rollback-prepare` proven with the **real** pre-SyncGuard code (without it: 1 booking reopened; with it: 0). Test: migrate "rollback…" |
| 48 | Documentation | IMPLEMENTED | `docs/syncguard.md` (546 lines) + this report |
| 49–53 | Plan → adversarial plan review → implement → verify → adversarial challenge → self-audit | IMPLEMENTED | §6 |
| 54 | Final closure report | IMPLEMENTED | This document |
| 55 | Git / deployment restrictions | COMPLIED | Local commits only (§12) |

### 2.2 The 15 mandatory review comments

| # | Review point | Status | Evidence |
|---|---|---|---|
| 1 | Pre-booking must not fail open (11 min / 1 h / 12 h / 23 h stale, timeout, recovery during booking) | IMPLEMENTED + VERIFIED | Booking: 4 generated tests "N min stale + refresh times out → AVAILABILITY_UNVERIFIED, nothing held" (N = 11, 60, 720, 1380) + "stale source recovers during booking" + "another worker is syncing…"; MCP checkout message check |
| 2 | 1→0 and 2→0 feeds protected; explicit CANCELLED higher confidence | IMPLEMENTED + VERIFIED | Reconcile: 3 generated tests "1 / 2 / 30 → 0 (valid empty feed) is an ANOMALY…" + "explicit STATUS:CANCELLED releases at once" |
| 3 | Echo heuristics never hide a real conflict; only the Majestic UID proves reflection; ambiguous events protect inventory and surface conflicts; "feed was fetched" is not proof | IMPLEMENTED + VERIFIED | Loops: "true reflection…", "rewritten UID…", "genuine OTA double-sale … NEVER hidden", "partial overlap…"; echo.js never reads fetch logs; review fix F5 also reports cross-OTA overlaps |
| 4 | Public ICS GET must not fan out into synchronous OTA fetches | IMPLEMENTED + VERIFIED | Export "hammering a public feed never fans out" (background nudge only, bounded by lease + 15-min freshness) |
| 5 | Disconnect must not create a false safe state | IMPLEMENTED + VERIFIED | Host "safe disconnect…", "disconnect with releaseBlocks…", "reconnect … revives…", "URL replacement with active bookings…"; UI suite disconnect checks |
| 6 | Scheduler heartbeat / clock failure visibility | IMPLEMENTED + VERIFIED | Scheduler "liveness: no sweep for 31 min / 1 h / 5 h shows DEGRADED → STALE" |
| 7 | Prevent starvation; costs at 10/100/1k/10k | IMPLEMENTED + VERIFIED | Scheduler "fairness under a budget…", "due query stays indexed at 10,000 connections"; §7 |
| 8 | Migration real-data preflight, idempotent, rollback preparation | IMPLEMENTED + VERIFIED (dev data); production preflight **BLOCKED** pending permission | Dev cluster preflight read-only (0 conflicts, 8 wrong-host rows, 7 duplicate legacy feeds); migrate tests |
| 9 | URL / secret handling (masking, rotation, CSRF) | IMPLEMENTED + VERIFIED | Masked as host + "/…" + last 4 chars; rotation 404s the old token at once; Bearer-only auth (cookie ignored). Host "auth posture…", export "rotation…", UI "saved inbound URL is masked" |
| 10 | Streaming size limits | IMPLEMENTED + VERIFIED | SSRF "size limits hold on the wire and after decompression" (gzip bomb refused without inflating) |
| 11 | Date/time correctness incl. New York DST | IMPLEMENTED + VERIFIED | ICS: VALUE=DATE + exclusive DTEND, UTC/TZID date-times, IST mapping, "America/New_York across DST (spring 2027-03-14, fall 2026-11-01)", RRULE, EXDATE, RECURRENCE-ID, "date-only nights never shift, whatever the process time zone" |
| 12 | Honest two-direction UI + exact restriction message | IMPLEMENTED + VERIFIED | UI suite: inbound/outbound shown separately, "overall not green while outbound unconfirmed", "outbound: waiting for first request (not 'verified')", restriction banner text |
| 13 | Mandatory test list | IMPLEMENTED + VERIFIED | Item-by-item mapping in §5.3 |
| 14 | Final adversarial gate | IMPLEMENTED | Own pass + independent reviewer → 11 findings, all fixed with failing-first tests (§6) |
| 15 | Closure table, Majestic residual risks separated from OTA limits | IMPLEMENTED | This section, §9 and §11 |

---

## 3. How it works now (After)

```text
 Airbnb / Booking.com / Agoda / Vrbo / any .ics   (host pastes each export URL)
        │
        ▼
 safeFetch   https only · every DNS answer must be public · socket pinned to the
        │    validated address · redirects re-validated (≤ 3) · 2 MB cap while
        │    streaming (wire + decompressed) · one deadline (DNS included)
        ▼
 icsReader   own bounded RFC 5545 reader → normalised events (UTC day numbers)
        ▼
 reconcile   per-connection state machine · echo evidence · conflict tiers
        ▼
 Booking(source:"ical", external:{…})  +  BookingNight (unique night ledger)
        │                                       ▲ atomic claims
        ▼                                       │
 Majestic availability ◄── direct bookings, holds, host blocks
        │                  └─ ensureVerified() at Confirm / Pay / admin move
        ▼
 exportFeed  one feed per connection: Majestic bookings + other OTAs' genuine
             bookings · never the destination's own events · never possible
             echoes · never unpaid holds · opaque UIDs · no guest data
```

Key policies (exact rules in `docs/syncguard.md` §3–§7):

* **Release only on evidence.** Explicit `CANCELLED`/`TRANSPARENT` → released at
  once. Plain disappearance → after ≥ 3 successful syncs over ≥ 2 h. Whole set
  vanishing (1→0, 2→0, …) or ≥ 50 % of ≥ 3 → **anomaly**: ≥ 4 syncs over ≥ 12 h
  or host confirmation, host e-mailed once. A stay that has **already started**
  is never released by disappearance alone. Failures, HTML, truncation,
  over-limit, unreadable events never release anything.
* **Commitment-time verification** (fail-closed): a source verified within
  2 min (Confirm) or 30 s (Pay, admin move) is trusted; otherwise it is re-fetched (8 s); failure → 409
  `AVAILABILITY_UNVERIFIED` (instant and request-to-book). Host blocks need no
  verification.
* **One ledger.** Imports claim nights in the same unique `(propertyId, date)`
  ledger as direct bookings. Live unpaid holds are displaced by a real OTA
  booking (guest refused at Pay before money moves). Paid Majestic booking vs
  OTA booking → conflict, admin `ota_conflict` + host e-mail, exactly once.
  Shared nights (import + host block) stay protected by `importedOverlap`.
* **Loop prevention.** Majestic UIDs coming back are dropped (proof). Events
  whose nights we export to that OTA are *possible echoes*: they still block
  Majestic and still raise conflicts but are not forwarded to other OTAs until
  promoted (6 h uncovered).
* **Imported rows belong to the OTA.** Generic cancel/delete/move endpoints
  refuse them (409 `EXTERNAL_BOOKING`); they end by OTA cancellation or the
  host's explicit release.
* **Honest health.** Inbound and outbound are shown separately; outbound can
  only be "link in use, requested by an app identifying itself as X" — never
  "verified in the OTA".

---

## 4. Property X — the mandatory scenario, end to end

Property X is connected to **Airbnb, Agoda and a generic calendar**. Person A
books on Airbnb, check-in Oct 12, checkout Oct 13. Proven by
`syncguard-acceptance.test.js` → "Property X: Person A books Airbnb 12→13 Oct
— points 1–10 proven" (evidence: `tests/syncguard-evidence/acceptance.jsonl`,
scenario `property-x`).

| # | Required proof | What happens | Asserted |
|---|---|---|---|
| 1 | Majestic detects it | Next Airbnb sync parses `Reserved 12→13` | `stats.added = 1` |
| 2 | Attributed to Airbnb | Row has `external.channel = AIRBNB`, its connection id, the Airbnb UID, the **listing's** host | exact values |
| 3 | Oct 12 unavailable on Majestic | Night row owned by the import; `/booking/check-dates` lists Oct 12 | ledger `{Oct 12: ical:AIRBNB}` |
| 4 | Not duplicated | 3 more syncs (unchanged feed → hash skip, 2 reads + 2 writes each) | still 1 row |
| 5 | Airbnb's feed does not mirror it back | Airbnb destination feed | `[]` |
| 6 | Agoda / generic feeds expose it | Both destination feeds | `["Oct 12..Oct 13"]` |
| 7 | Majestic explains the block | `GET …/explain?date=Oct 12` → "Airbnb", timeline `added` (host UI: click the date) | channel label + timeline |
| 8 | A direct booking cannot take Oct 12 | `POST /booking` | **409** |
| 9 | Airbnb feed fails later → block stays | 503, then a hanging response | ledger unchanged; Agoda still receives the block |
| 10 | Cancellation releases safely | Airbnb feed becomes empty (1→0 = anomaly) | blocked at +30/+90/+240/+480 min, released at +760 min (≥ 4 syncs over ≥ 12 h); Agoda feed empties; a direct booking then gets **201** |

The 8-step provider harness (brief §43) additionally proves: modification
12→15 releases 12 and blocks 15 with no ghost night; a 500 changes nothing; a
one-off empty feed reopens nothing; an explicit `CANCELLED` releases at once;
replays create no duplicates; a paid Majestic booking appears in every
destination feed immediately.

---

## 5. Evidence

### 5.1 Commits (local only, not pushed)

| Repository (worktree) | Branch (base) | Commits | Diff vs base |
|---|---|---|---|
| `server.me` (`server.me-syncguard`) | `feat/syncguard` (from `origin/dev` 1e8448f) | `93fa7e4` feat: SyncGuard · `d74b8b1` fix: imported-night check for guest bookings only · `4412c85` fix: independent review findings · (+ this report) | 50 files, +7 968 / −681 |
| `user.website` (`user.website-syncguard`) | `feat/syncguard` (from `origin/dev` 2a8afe6) | `db65830` host panel · `0cf0c22` cross-site overlap banner | 12 files, +1 110 / −168 |
| `admin.site` (`admin.site-syncguard`) | `feat/syncguard-attention` (from `origin/dev` ca3972f) | `a4156a1` `ota_conflict` attention label | 1 file, +9 / −2 |

### 5.2 Files

**Backend — new:** `services/calendarSync/{channels, safeFetch, icsReader,
reconcile, ledger, echo, engine, prebook, exportFeed, connections, health,
notify, flags, journal, util, index}.js`, `models/CalendarSyncLog.js`,
`models/CalendarSyncState.js`, `scripts/syncguard-migrate.js`,
`scripts/syncguard-flags.js`, `.github/workflows/calendar-sync-clock.yml`,
`docs/syncguard.md`, `docs/syncguard-closure.md`, 12 test files +
`tests/batch-s/syncguard-helpers.js`.
**Backend — changed:** `models/ExternalCalendar.js` (extended in place),
`models/Booking.js` (`external` subdocument + unique partial index),
`controllers/calendarsyncController.js` (rewritten; legacy contract kept),
`routes/calendarSyncRoutes.js`, `middleware/cronAuth.js` (`anyOf`),
`services/inventory.js` (`importedOverlap` in `reserveNights` / `secureHold` /
`securePermanent`), `services/attention.js` (`ota_conflict`),
`services/payments.js` + `controllers/bookingLifecycleController.js` +
`controllers/bookingController.js` (commitment verification, imported-row
guard), `services/startupChecks.js`, `index.js`, `vercel.json` (daily full
pass), `tests/batch-s/setup.js`, `tests/batch-s/e2e-server.js`.
**Site:** `calendar/components/calendar-sync/*` (panel, wizard, card, copy
field, disconnect dialog, explain dialog, status pill, api, status texts),
`calendar/page.jsx` (old import/export card removed, panel mounted),
`src/lib/query-keys.ts`, `BookStay.jsx` (one checkout message).
**Admin:** `src/app/dashboard/bookings/bookings-page.jsx`.

**Migrations:** none run anywhere except the in-memory test databases. The
dev-cluster preflight (read-only, cluster host verified to be the dev
cluster before use) was the only contact with a real database; production
was never touched.

### 5.3 Tests

**Backend SyncGuard suites — 121 tests in 12 files** (all `node:test`, real
HTTP against the real Express app, in-memory MongoDB replica set, a fake OTA
HTTP server):

| File | Tests | Covers |
|---|---|---|
| `syncguard-ics.test.js` | 18 | parser: dates, TZ, DST, RRULE/EXDATE/RECURRENCE-ID, limits, bombs, duplicates, hashing |
| `syncguard-ssrf.test.js` | 10 | URL/IP/DNS/pinning/redirect/size/deadline/status/test-flag refusal |
| `syncguard-reconcile.test.js` | 17 | state machine, 1/2/30→0, flapping, failures, 304, fencing, crash safety, legacy adoption |
| `syncguard-booking.test.js` | 15 | commitment verification (4 stale ages), races, payment, conflicts, admin move |
| `syncguard-export.test.js` | 6 | feed correctness, destinations, hammering, rotation, revocation |
| `syncguard-loops.test.js` | 7 | reflections, double-sales never hidden, 3-channel convergence |
| `syncguard-host.test.js` | 13 | tenancy, auth posture, cron auth, rate limits, disconnect/reconnect, URL replacement, explain |
| `syncguard-scheduler.test.js` | 6 | liveness, duplicate sweeps, killed sweep, fairness, 10k index use, cost |
| `syncguard-migrate.test.js` | 4 | preflight/apply/idempotence/indexes/rollback with the real old code |
| `syncguard-acceptance.test.js` | 2 | Property X, 8-step harness |
| `syncguard-shared-nights.test.js` | 6 | shared-night double-booking paths (self-audit finding) |
| `syncguard-review-fixes.test.js` | 17 | every independent-review finding (each fails on the pre-fix code) |

**Mandatory test list (review point 13) → where it is proven**

| Mandatory case | Test |
|---|---|
| 1 event → empty valid feed; 2 events → empty valid feed | reconcile "1 → 0…", "2 → 0…" (also "30 → 0") |
| disappears → returns → disappears | reconcile "disappear → return → disappear: the confirmation count restarts" |
| same UID from two connections | reconcile "same UID from two different connections are two different events" |
| same OTA connected twice | reconcile "same calendar connected twice is refused (also under a concurrent double click)…" |
| URL replacement with active bookings | host "URL replacement with active bookings…" |
| disconnect with active future bookings | host "safe disconnect…" + UI suite disconnect checks |
| true / rewritten-UID / ambiguous reflection | loops "true reflection…", "reflection with a rewritten UID…", "reflection with merged dates…", review-fixes F5 (×2) |
| genuine conflict on identical dates; genuine partial overlap | loops "genuine OTA double-sale … NEVER hidden", "genuine OTA booking partially overlapping…"; booking "genuine OTA double-sale of a paid Majestic night…"; review-fixes F5 cross-OTA |
| scheduler outage | scheduler "liveness…" |
| worker lease expires during fetch; stale worker late write | reconcile "fencing…"; scheduler "a sweep killed mid-run…"; review-fixes "a release that loses its revision race…" |
| public export hammered | export "hammering a public feed never fans out…" |
| rotation while OTA uses the old token | export "rotation kills the old token immediately…"; UI "rotation: old link returns 404 immediately" |
| stale prebooking refresh failure | booking ×4 generated (11 min / 1 h / 12 h / 23 h) + "create-order refuses when the calendar cannot be verified" |
| OTA event during payment callback; callback after hold loss | booking "OTA event appears while the guest is paying…", "payment callback after the hold was lost…"; shared-nights "race: payment landing…" |
| cross-tenant Sync Now / token rotation | host "tenant isolation: host B can do nothing to host A's connections or listing" |
| all SSRF variants; decompression bomb | ssrf (10); reconcile "failures never change reservations: … bomb" |
| all timezone/date cases | ics (VALUE=DATE, exclusive DTEND, UTC, TZID, IST, New York DST, RRULE, EXDATE, RECURRENCE-ID, modified occurrence, process-TZ independence) |
| browser refresh / back during setup | UI "after refresh: 'Finish setup' offered"; MCP Back/Forward check (§5.4) |
| mobile / tablet / desktop; keyboard-only; reduced motion | UI suite at 360/390/768/1024/1440; "keyboard: Enter opens, Escape closes, focus returns"; "reduced motion: dialog not animated" |

Tests assert database state (booking rows, the night ledger, feed contents)
as well as HTTP results. With `SYNCGUARD_EVIDENCE=1` the suites that record
evidence write JSONL with DB snapshots to
`D:\majestic-escape\tests\syncguard-evidence\` (outside the repositories).

**Runs (final code):**

| Run | Result |
|---|---|
| SyncGuard suites (12 files) | **121 / 121 pass** (inside each full run below; evidence regenerated with `SYNCGUARD_EVIDENCE=1` → 10 JSONL files) |
| Full backend regression (every `tests/batch-s` suite, 432 tests; final code) | **430 / 432** at concurrency 3 (and 429 / 432 at the default 16-way parallelism). Every failure is a CPU-timing test in a suite SyncGuard does not touch: `site-hero-ops` "lease" + "storage" (fail at the same rate on the unmodified base commit — §11 A7) and, only under 16-way load, the `place-search` p95 micro-benchmark (20 ms vs 10 ms limit; 14/14 with p95 ≈ 4 ms when run alone). **0 SyncGuard failures in every full run.** The last full run before the review fixes was 415 / 415 |
| Review-fix tests against the **pre-fix** code (proof they catch the bugs) | **15 of 17 fail** as intended — F4 by crashing the test process (`Unhandled Rejection: simulated database outage`), the DNS test by hanging until the 120 s test timeout (no DNS deadline); the 2 that pass are the skip-ahead equivalence check and the loop-protection control, which must pass on both versions |
| Scripted Playwright, production build, 5 widths (360/390/768/1024/1440) | **200 / 200** (40 checks per width) |
| Scripted Playwright, cross-site overlap banner, 4 widths | **36 / 36** |
| Site production build / lint | build exit 0; ESLint clean on the calendar-sync components |

### 5.4 Browser evidence (Playwright)

* **Scripted suite** (`tests/syncguard-ui/syncguard-ui.mjs`, production build
  on :3000, isolated e2e backend, fake OTA): invalid/malicious URLs refused and
  nothing saved; connect; masked URL; copy link; refresh mid-setup; honest
  inbound vs outbound; Sync now + its rate limit; explain dialog; broken source
  → "Not working" + restriction message + dates kept; element-level spill check
  (the "Needs attention"/"Not set up yet" pill overflow you reported is fixed
  and guarded); token rotation; keyboard; safe disconnect (warning,
  acknowledgement, second confirmation, kept blocks, guests still refused);
  reconnect; reduced motion; no polling; no timers; no page errors.
  Screenshots: `tests/syncguard-evidence/ui/*.png`.
* **Playwright MCP (interactive, real Chromium):** 12-width sweep (zero
  spill); checkout shows the `AVAILABILITY_UNVERIFIED` message instead of
  booking when a calendar cannot be checked, and books after recovery; after
  the review fixes: the cross-site overlap banner and "Action required / Needs
  attention" state on the right card (`mcp-390-overlap.png`); **Back/Forward
  during the connect wizard** → wizard closes, page returns to "Not
  connected", 0 connections saved, the typed URL is not in browser storage.
  Console errors seen were only the local chat service (`:3002`) not running.

### 5.5 Concurrency evidence

Two direct bookings in the same millisecond → one 201, one 409; concurrent
duplicate sweeps → each connection fetched once; concurrent double-click
connect → one connection; a worker frozen past its lease cannot apply its
older response (fencing) and returns `LEASE_LOST`; a release that loses its
revision race frees no night; a crash between night release and row update
leaves a block, never a hole; OTA booking landing during checkout → the hold
is displaced and Pay refused before any money moves; payment landing after
that → paid but flagged `inventory_conflict`, never confirmed, admin "keep"
refused.

### 5.6 Security evidence

See §8; every item is backed by a test in `syncguard-ssrf`, `syncguard-host`,
`syncguard-export` or `syncguard-review-fixes`.

---

## 6. Adversarial challenge, self-audit and the independent review

### 6.1 Defects found by my own adversarial passes and self-audit (all fixed + tested)

| Found | Fix |
|---|---|
| **Shared-night double booking**: an import sharing a night with a host block owned no ledger row; after the host unblocked, Pay on an old pending booking returned 200 and opened an order | `importedOverlap` in `reserveNights` / `secureHold` / `securePermanent` / admin keep (`syncguard-shared-nights`) |
| Displacement race: a hold being extended at the moment an OTA booking claimed the night stayed "shared" | `secureHold` / `securePermanent` refuse import-covered nights |
| Admin "modify booking" moved guests onto unverified nights | `ensureVerified` on admin moves |
| Parked (rollback) imports counted as Majestic-native in feeds | `$nin: ["ical","ical_parked"]` |
| URL masking leaked up to 10 path characters (Vrbo secret in the path) | host + last 4 characters |
| 3-channel reflection convergence stalled | covered possible echoes follow the normal rule; risk judged once at disappearance |
| Migration `--apply` crashed when indexes already existed; adoption relied on the index | duplicates resolved in the same update; explicit duplicate check |
| No anomaly e-mail; fetcher abusable by one account | exactly-once anomaly e-mail; 100 connections per account |
| Invalid connection id crashed the process (unhandled rejection) | ids validated before use |
| Unchanged polls cost 3 writes | fencing only when reconciling (2 writes) |
| Pinning test did not really prove pinning; parser TZ-dependent (node-ical) | real proof via `_requestOnce`; own reader |
| UI: grid not refreshed after connect; 40 px touch targets; pill overflow (your screenshot) | refresh callback; 44 px; nowrap pills, wrapping rows, `min-w-0` |

### 6.2 Independent adversarial review (separate read-only reviewer)

The reviewer's verdict on the pre-fix code was "not safe to ship as it
stands". Every claim was re-verified against the code (none was a false
positive), fixed, and covered by a test that **fails on the pre-fix code and
passes now**:

| # | Severity | Finding | Fix | Measured after |
|---|---|---|---|---|
| 1 | High | A host's calendar could block the event loop for **28.4 s** (rules walked from the year 400; per-rule cap only) or grow memory ~110 MB per sync (time-zone cache keyed by any capitalisation) | skip-ahead for rules without COUNT; 200 000-iteration budget per file; canonical capped zone caches | 44 ms; memory flat (55→97 MB, same as the control) |
| 2 | High | Cancel / terminate / delete / move endpoints accepted imported OTA rows → nights reopened, never restored; a guest booked the OTA-booked nights (201) | 409 `EXTERNAL_BOOKING` on every such endpoint; reconciliation repairs a live row's status | guest booking → 409; nights intact |
| 3 | Medium | A longer `CANCELLED` copy of an event hid the confirmed copy | blocking copy always wins; blocking copies merge | all orders → confirmed 10–12 |
| 4 | Medium | "Sync now" + a DB error → unhandled rejection → process exit | rejection handled | process stays up |
| 5 | Medium | Real Agoda/Booking.com booking on recently freed nights withheld from other OTAs up to 6 h+; cross-OTA overlaps never reported | echo window tied to the previous successful read of that feed (−1 h, clamp 1–72 h); overlaps → NEEDS_ATTENTION + one host e-mail + panel banner | real booking propagates at once; overlap banner verified in browser |
| 6 | Low-Med | Airbnb mirror of a paid booking blocked that booking's own admin move / keep | mirror linked to the same booking is ignored for that booking only | move + keep succeed; others still blocked |
| L1 | Low | Raced pass still saved the feed hash; lease-expired worker could free nights before its revision check | no hash/validators after a race; revision-conditional row write before freeing nights | converges next poll; no hole |
| L2 | Low | DNS lookup had no deadline | bounded by the request deadline | 300 ms deadline honoured |
| L3 | Low | Migration-retired duplicates kept rows `active` (invisible) | → `orphaned` (visible, still blocking, host-releasable) | — |
| L4 | Low | OTA dropping a stay at check-in → remaining nights released after 2 h | started stays never released by disappearance alone | still blocked after 4 h / 5 syncs |
| L5 | Low | Legacy re-save forced a sync with no rate limit | 1 per minute per connection | no extra fetches |

Checked by the reviewer and found sound: SSRF (all address classes, pinning,
redirects, caps, http refused on Vercel), host authorisation (404 for others),
256-bit tokens + no URL/token in logs, export dates identical under
UTC/IST/New York/Honolulu, scheduler lease + fencing, pause-switch refusal,
304 handling, unreadable/mass-disappearance rules, reflected UIDs, rollback
parking.

### 6.3 The review's 10 adversarial questions (point 14)

| Question | Answer |
|---|---|
| Reopen a genuinely occupied night? | Failures/empty/truncated feeds never release; whole-set disappearance waits ≥ 12 h; started stays never auto-release; generic cancel endpoints refuse imports (F2); shared nights guarded; a lost race frees nothing. Remaining path: the OTA itself removes a real booking from its feed for > 2 h (OTA-controlled) |
| Make a genuine booking look like an echo? | Only a Majestic UID is proof. A possible echo still blocks Majestic and raises conflicts; the only effect is delayed propagation in a narrow window (§11 A1) |
| Make a broken connection look healthy? | Health derives from timestamps; STALE after 180 min; BROKEN after failures; outbound never claims "verified" |
| Host bypasses stale protection? | Commitment fails closed for guest bookings; only disconnecting (with an explicit acknowledgement, blocks kept) restores bookability |
| Scheduler silently stops? | Heartbeat → DEGRADED → STALE in the admin overview; bookings stay safe (commitment verification) |
| Starve a connection? | Oldest-due first, every processed connection moves ~15 min ahead, failures back off; tested at 10 000 connections |
| Duplicate propagation among three OTAs? | Destination feeds exclude the destination's own events and all possible echoes; 3-channel test converges with no growth |
| Fetcher as SSRF / proxy / DoS? | §8; per-account caps; per-file CPU budget (F1); no synchronous fan-out from public GETs |
| Late worker overwrites newer state? | Fencing + revision-conditional writes + token-conditional lease release |
| Rollback releases inventory? | Proven with the real old code; `--rollback-prepare` parks rows so the old code cannot reopen them |

---

## 7. Cost

**Measured per operation** (Mongo op count, in-memory replica set):

| Operation | Reads | Writes |
|---|---|---|
| Unchanged poll (hash skip) | 2 | 2 |
| 304 Not Modified | 2 | 2 |
| Changed feed, one new event | 14 | 6 |
| Failed fetch | 2 | 3 |
| Idle sweep | 2 | 2 |
| Feed GET by an OTA | 5 | ≤ 1 (throttled) |
| Stay-calendar nudge | 3 | 0 |

Due query at 10 000 connections: index scan, **100 documents examined for 100
due** (no collection scan).

**Estimated** (1.5 connections per listing, 15-min cadence, 10-min external
clock, OTAs fetching each feed ~24×/day, ~20 KB per feed):

| Listings | OTA fetches/day | Mongo ops/day | Network/day | Compute (Vercel) | Mongo tier |
|---|---|---|---|---|---|
| 10 | ~1 400 | ~9 k | ~30 MB | negligible | M0 fine |
| 100 | ~14 000 | ~85 k (~1/s) | ~0.3 GB | ~1 CPU-min/day | M0 fine |
| 1 000 | ~144 000 | ~0.8 M (~10/s) | ~3 GB | ~12 CPU-min/day, concurrency ≈ 16 — check Hobby active-CPU allowance | M0 borderline |
| 10 000 | ~1.4 M | ~8 M (~95/s) | ~30 GB | needs a dedicated worker, longer cadence for idle calendars (safety does not depend on cadence) | dedicated tier |

Note on the brief's assumptions: the backend runs on **Vercel serverless**
(not Railway), the database is **MongoDB Atlas** (not Supabase), and there is
**no Redis** — SyncGuard adds none of them. **No paid service added.**
Frontend: no timers, no polling (measured), one GET per panel load; host
calendar route ≈ +19.5 KB gzip; guest pages unchanged except one message.

---

## 8. Security

* **SSRF:** https only (http only under test flags, refused on Vercel); no
  credentials; no IP literals in any encoding; no internal suffixes; default
  ports only; **every** DNS answer must be public (private, loopback,
  link-local/metadata, CGNAT, multicast, reserved, IPv4-mapped, NAT64, 6to4,
  Teredo, ULA, documentation ranges refused; mixed answers refused); the
  socket connects to the validated address (no rebinding window — proven);
  ≤ 3 redirects, each re-validated; 2 MB cap on the wire and after
  decompression (bomb refused without inflating); one deadline for the whole
  exchange including DNS; per-file parser CPU budget.
* **Tenant isolation / RBAC:** connection → listing → `listing.host` (or
  admin) on every route; others get 404 (no existence oracle); Bearer header
  only (cookies ignored → no CSRF vector); no cross-listing work (D2 fixed);
  imported rows cannot be cancelled through generic booking endpoints.
* **Tokens:** 256-bit export tokens, unique index, rotation invalidates the
  old one at once, disconnect revokes, legacy tokens keep working. Inbound
  URLs are treated as credentials: stored server-side only, returned masked,
  never logged, never kept in browser storage. Platform note: feed tokens are
  in the URL path, so Vercel's own request logs see them (unavoidable for
  URL-subscribed calendars; rotate if a log export leaks).
* **PII:** feeds carry only dates + "Not available" with opaque UIDs; SUMMARY
  and DESCRIPTION from OTAs are never stored (only a reserved/blocked hint);
  the journal stores hashed UIDs, no URLs, no guest data.
* **Abuse limits:** connect attempts 20 / 10 min per account; Sync now and
  legacy re-save 1 / min per connection; 10 connections per listing, 100 per
  account.

---

## 9. Reliability: Majestic guarantees vs OTA-controlled limits

**Majestic guarantees (all tested):** atomic night claims (one owner per
night); no direct booking committed against a connected calendar that could
not be re-verified at that moment; no release on failure, emptiness,
truncation, one-off absence or check-in-day disappearance; explicit, logged,
host-confirmed releases; conflicts surfaced (paid-booking conflicts to admin
+ host, cross-OTA overlaps to the host), never silently suppressed; health
that cannot stay green when stale; feeds that change the moment Majestic's
state changes; no echo back to an OTA's own feed; bounded outbound traffic
and parser cost; no PII in feeds; idempotent, crash-safe, race-safe
reconciliation.

**OTA-controlled (cannot be guaranteed by any iCal-based system):**

* When an OTA **publishes** a new booking in its export. Majestic re-verifies
  the OTA's *feed* at commitment, not the OTA's internal state.
* When an OTA **fetches** Majestic's feed — Airbnb ~3 h, Booking.com ~2 h,
  Vrbo ~30 min, Agoda "several times a day" ([V] documentation). A night sold
  on Majestic can be sold again on an OTA inside that window. This is the
  irreducible double-booking window of iCal; only official APIs remove it.
* Whether an OTA re-exports imported blocks, how it signals cancellation
  (removal vs `STATUS:CANCELLED`), whether UIDs stay stable on modification,
  whether a double-sale carries a reservation marker (undocumented).
* MakeMyTrip / Goibibo publish no iCal (channel managers only).

---

## 10. Trade-offs and drawbacks

| Trade-off | Why it is acceptable | Can it be removed later? |
|---|---|---|
| **Fail-closed commitment**: a listing whose connected calendar cannot be checked takes no direct bookings until the host fixes or disconnects it | A single-unit night must not be sold twice; the host is e-mailed and told exactly why | Only with OTA APIs (a reliable source of truth) |
| Up to **8 s** extra at Confirm (last check > 2 min old) and at Pay (> 30 s old, so in practice every Pay) — typically 0.3–2 s | Paid only by a guest about to pay; the money moment re-reads the calendars | Shorter with a faster clock; gone with push APIs |
| Freed dates reopen **later** than reality (≥ 2 h; ≥ 12 h when a calendar empties; started stays only at checkout or by host) | False "still blocked" costs a few hours of sellability; false "free" costs a double booking | Partly, with OTA cancellation webhooks/APIs |
| Possible echoes **block Majestic** even when they are only mirrors | A hidden real booking is worse than a duplicate block; mirrors of our own bookings never block the booking itself (F6) | With API reservation identities |
| Possible echoes are **not forwarded** to other OTAs for up to 6 h (narrow window, §11 A1) | Forwarding every uncovered event recreates self-sustaining phantom loops between OTAs that re-export imports | With reservation markers / APIs |
| Inbound cadence depends on configuration: Vercel Hobby cron is daily; the 10-min clock needs a GitHub secret | Safety does not depend on cadence (commitment verification); cadence only affects propagation speed | Yes — configure the clock, or a dedicated worker |
| Some repairs wait for the **daily full pass** (leftover night rows after a crash, a status changed outside SyncGuard, conflict banners after the other side is resolved) | All are in the safe direction (extra block or stale warning, never a hole) | Yes, with a more frequent full pass |
| Imported stays **cannot be cancelled from Majestic booking tools** (409 `EXTERNAL_BOOKING`) | They are the OTA's bookings; cancelling them locally reopened OTA-booked nights (F2) | By design |
| Feed tokens visible in Vercel request logs | Inherent to URL-subscribed calendars | No (rotation mitigates) |
| Host calendar route +≈ 19.5 KB gzip | Lazy-loading dialogs would recover part of it | Yes (follow-up) |
| Admin metrics are API-only (`/calendarSync/admin/overview`); the mobile app shows no sync health (legacy contract only) | Kept scope to what the brief required; data is available | Yes (follow-ups) |
| No e-mail fast path | No documented OTA formats; verified inbound mail costs money | When a free verified path exists |

---

## 11. Residual risks

### A. Majestic-controlled residual risks (accepted, documented)

1. **Narrow echo window.** An event from a provider without a verified
   reservation marker (Booking.com, Agoda, Vrbo, generic) on nights Majestic
   stopped exporting less than ~one poll + 1 h before it was first seen is a
   *possible echo*: it blocks Majestic and raises conflicts, but is not
   forwarded to the *other* OTAs until promoted (6 h uncovered). In that window
   another OTA could sell the same nights. (Airbnb reservations carry
   `Reserved` and are never treated as echoes.)
2. **Slow re-exporting calendars.** Two calendars that both re-export imported
   blocks and refresh slower than ~6 h can bounce a promoted block between
   them; it is visible to the host with its source and cleared by unblocking it
   on that OTA.
3. **Propagation speed if the external clock is not configured** — inbound
   sync then relies on the daily pass + nudges (calendar views, feed GETs,
   commitment checks). Bookings remain safe; cross-OTA propagation is slower.
4. **Daily-pass repairs** (see trade-offs) — safe direction only.
5. **Not yet exercised against production data**: the production preflight,
   migration and deployment need your permission. The dev-cluster preflight
   found 0 conflicts.
6. **Vercel Hobby active-CPU allowance at ~1 000 listings** must be checked
   before that scale.
7. **Pre-existing, unrelated flaky test**: `site-hero-ops.test.js` (its
   "lease" and "storage" cases need image encoding to finish inside a 1.5 s
   test lease) fails intermittently under CPU load. Measured fairly by
   interleaving runs of the **unmodified base commit** `1e8448f` and this
   branch (base, branch, base, branch …): base failed 2 of 4, branch 2 of 4 —
   the same rate. No SyncGuard module starts timers or work at load (the
   in-process ticker is opt-in via `SYNC_INPROCESS_INTERVAL_MS`), and no
   site-hero file is changed.

No other path inside Majestic's control was found that reopens an occupied
night, hides a conflict, shows a broken calendar as healthy, or lets a late
worker overwrite newer state.

### B. Unavoidable OTA / iCal timing limitations

The OTA-controlled items in §9: OTA publish lag, OTA refresh intervals of
Majestic's feed (the irreducible iCal double-booking window), undocumented
re-export/cancellation/UID behaviour, no iCal for MakeMyTrip/Goibibo, no OTA
API access for Majestic today.

---

## 12. What is local-only, and what promotion would do

**Local only:** all commits in §5.1 (three worktrees under `D:\majestic-escape\`),
test evidence under `D:\majestic-escape\tests\syncguard-evidence\`, the UI
scripts under `D:\majestic-escape\tests\syncguard-ui\`. Nothing pushed, merged,
deployed; no production migration; no OTA listing or calendar connection
changed. Real Airbnb feed shapes were only *observed* (read-only GET of
existing URLs) to verify the block marker.

**Promotion (owner decides; full plan in `docs/syncguard.md` §13):**

1. Read-only preflight on production: `node scripts/syncguard-migrate.js
   --confirm-db=master-db` (verify the connection string points at the
   production Atlas cluster); review the report.
2. Deploy `server.me` first (old frontends and the mobile app keep working —
   legacy `saveCalendar` contract unchanged).
3. `--apply`, then `--create-indexes`; confirm the startup warning is gone.
4. Check `PUBLIC_HOSTNAME`; fetch one legacy feed URL (expect 200 `text/calendar`).
5. Deploy `admin.site` (attention label) and `user.website` (panel, checkout message).
6. Optional 10-min clock: set `CALENDAR_SYNC_CRON_SECRET` (Vercel + GitHub),
   the `SYNCGUARD_SWEEP_URL` variable, and merge the workflow to `main`.
7. Watch `GET /calendarSync/admin/overview` for a week.

**What changes for people at promotion:** every existing Majestic feed URL
starts returning Majestic bookings (it returned 500 before) — OTAs begin
blocking Majestic-sold nights; hosts see the Calendar sync panel; hosts with a
dead OTA link cannot take direct bookings on that listing until they fix or
disconnect it (e-mailed once); guests see "we couldn't confirm these dates"
instead of a booking when a connected calendar cannot be checked; admins see
`ota_conflict` items for genuine OTA double-sales.

**Rollback:** kill switches first (`scripts/syncguard-flags.js --pause` /
`--propagation-off`, no redeploy); frontend rollback is always safe; a
backend code rollback requires `--rollback-prepare` **first** (proven with the
real old code).

---

## 13. How to reproduce the verification

```bash
# backend (worktree D:\majestic-escape\server.me-syncguard)
node --test --test-timeout=120000 --test-force-exit tests/batch-s/syncguard-*.test.js   # 121 tests
SYNCGUARD_EVIDENCE=1 npm test                                                         # full regression + JSONL evidence
node --test --test-name-pattern="F1|F2|F3|F4|F5|F6|low" tests/batch-s/syncguard-review-fixes.test.js

# browser (production build on :3000, e2e backend :5005/:5056, fake OTA :5099)
#   cd user.website-syncguard && npx next build && npx next start -p 3000
#   cd server.me-syncguard && SYNC_ALLOW_HTTP=1 SYNC_TEST_ALLOW_LOOPBACK=1 node tests/batch-s/e2e-server.js
#   node D:\majestic-escape\tests\syncguard-ui\fake-ota.js
node D:/majestic-escape/tests/syncguard-ui/syncguard-ui.mjs 390 768 1440   # restart the backend between batches (connect rate limit)
node D:/majestic-escape/tests/syncguard-ui/syncguard-ui.mjs 360 1024
node D:/majestic-escape/tests/syncguard-ui/syncguard-ui-overlap.mjs 360 390 768 1440
```

To prove the review-fix tests catch the bugs: check out the pre-review
versions of the source files changed in `4412c85`
(`git checkout d74b8b1 -- $(git diff --name-only d74b8b1 4412c85 -- services controllers scripts)`),
run `syncguard-review-fixes.test.js` (use `--test-name-pattern` per group:
the F4 test kills the process on the old code), then
`git checkout 4412c85 -- services controllers scripts`.

---

## 14. Follow-ups

1. **Owner actions before/at promotion:** production preflight; deploy order;
   `PUBLIC_HOSTNAME` check; external clock secret + workflow on `main`; check
   Vercel Hobby active CPU before ~1 000 listings; security follow-ups from
   earlier releases were reported to the owner separately.
2. **Mobile app:** show connection health (it uses the legacy endpoint and
   gets protection, but no health UI).
3. **Admin UI for `/calendarSync/admin/overview`** (scheduler status, health
   distribution, counters).
4. **Lazy-load the calendar-sync dialogs** (recover part of the +19.5 KB).
5. ~~Remove unused `node-ical` / `node-cron` dependencies~~ — corrected at the release gate: both are still used (`node-cron` by `controllers/paymentController.js`; `node-ical` by `syncguard-export.test.js` as an independent parser of Majestic's feed). Nothing to remove.
6. **Official APIs** when available (Agoda pilot first) — the adapter
   interface is ready; this is the only way to close the OTA-side window.
7. Stabilise the pre-existing `site-hero-ops` lease test (raise its 1.5 s
   test lease) — unrelated to SyncGuard.

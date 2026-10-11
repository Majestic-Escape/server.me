# SyncGuard — Majestic Escape's own calendar-sync hub

Status: built on branch `feat/syncguard` (worktree `server.me-syncguard`, cut
from `origin/dev` @ `1e8448f`, content-identical to production
`cdrx/server/phase-1`), with companion branches `feat/syncguard` in
`user.website` and `feat/syncguard-attention` in `admin.site`. **Local only —
not pushed, not deployed, no production data touched.**

SyncGuard replaces a paid channel manager for single-unit stays. It imports
every OTA calendar a host connects, protects Majestic's own inventory with
them, re-verifies them at the moment a guest commits, and gives every OTA its
own Majestic feed carrying everyone else's bookings — never echoing an OTA's
own events back to it.

It is iCal-based today. The booking core never sees iCal: it calls
`calendarSync.ensureVerified()` at commitment and reads `Booking` /
`BookingNight` rows. Source events are normalised (`{key, uid, startDay,
endDay, status, transparent, summaryKind}`) before reconciliation, so an
official OTA API adapter can later produce the same events without touching
inventory logic.

---

## 0. Verified baseline (before SyncGuard)

Reproduced on the unmodified code (`origin/dev` 1e8448f) through real HTTP
against an in-memory replica set and a local ICS server, or read from the
code / dev cluster (read-only).

### 0.1 Hosting facts that differ from the task brief

| Brief assumed | Verified fact | Evidence |
|---|---|---|
| Backend on Railway | `server.me` is a **Vercel serverless function** (`vercel.json`, `@vercel/node`); `server.majesticescape.in` → `*.vercel-dns-016.com`. Railway hosts only the chat services. | `vercel.json`, `nslookup` |
| Postgres / Supabase | **MongoDB Atlas** via Mongoose 7.8 (replica set; transactions available). No Supabase in `server.me`. | `package.json`, `index.js` |
| Redis | Not used by `server.me`. SyncGuard adds none. | grep |
| `node-cron` every 5 min | Timer registered **inside a save request**, per instance, closure-bound to one host; on Vercel an instance is frozen between requests → effectively never fires. | controller |

### 0.2 Confirmed defects

| # | Defect | Proof |
|---|---|---|
| D1 | Export always **500** (`ical is not a function`, `ical = require("node-ical")`) — no OTA ever received a Majestic booking | probe: `EXPORT GET: 500 "Server error"` |
| D2 | One host's save synced **every** host's calendars inside one request | probe: host A's save fetched host B's feed |
| D3 | Imported rows got the **saving host's** `userId/hostId` | probe; dev cluster: 8 such rows |
| D4 | A second calendar per property silently ignored | probe |
| D5 | One valid **empty** 200 response cancelled every import and released its nights | probe: `before=2 … after one empty 200 feed=0` |
| D6 | SSRF: host URL fetched with no scheme/address/redirect/size limits | probe: loopback path fetched |
| D7 | Export secret minted on every calendar-page mount; duplicates (dev: 7 listings) | probe: 3 concurrent saves → 3 secrets |
| D8 | No real scheduler on Vercel | code |
| D9 | No provenance (connection, channel, per-calendar identity) | model |
| D10 | Import night claims "best effort": collisions with Majestic holds/bookings silently dropped, no conflict recorded | `inventory.ensureNightsBestEffort` |
| D11 | Export would have echoed imports back to their origin, leaked `Booking <ObjectId>`, churned DTSTAMP | code |
| D12 | No health / error / freshness state | code |
| D13 | `node-ical` date handling depends on server TZ (all-day RRULE + EXDATE shift a day under `TZ=Asia/Kolkata`) | probe |
| D14 | Admin attention UI labelled every non-`amount_mismatch` reason "dates taken during payment" | admin.site |

### 0.3 Double-booking windows before SyncGuard

Outbound never happened (D1); inbound never ran on schedule (D8); an empty or
partial feed reopened every imported date at once (D5); OTA bookings
colliding with Majestic holds/bookings were dropped silently (D10).

### 0.4 Inventory semantics

Every listing is **single-unit**: the unique `(propertyId, date)` index on
`bookingnights` allows one owner per night and `ListingProperty` has no unit
count. iCal's busy/free model fits exactly; there is no quantity to invent.
(Booking.com and Agoda themselves only offer iCal for one-unit room types.)

---

## 1. Architecture

```
 Airbnb / Booking.com / Agoda / Vrbo / any .ics   (host-pasted export URLs)
        │
        ▼
 safeFetch   https only · DNS pinned · every hop re-validated · 2 MB cap
        │    (wire + decompressed, streaming) · one 10 s deadline
        ▼
 icsReader   bounded RFC 5545 reader → normalised source events (UTC days)
        ▼                   (an OTA API adapter would emit the same events)
 reconcile   per-connection state machine (§3) · echo evidence (§4)
        ▼
 Booking(source:"ical", external:{…})  +  BookingNight (unique night ledger)
        │                                     ▲ atomic claims (Batch S)
        ▼                                     │
 Majestic availability ◄── direct bookings, holds, host blocks
        │                  └─ ensureVerified() at Confirm / Pay / admin move (§7)
        ▼
 exportFeed  per-connection feed: Majestic-native + other connections'
             genuine imports · never the destination's own events · never
             possible echoes · never unpaid holds · opaque UIDs · no PII
```

## 2. Data model (additive, backwards compatible)

### 2.1 `ExternalCalendar` — a connection (extended in place)

`kind:"import"` rows are connections (inbound URL + outbound token);
`kind:"export"` rows remain the pre-SyncGuard property feed (Majestic-native
only); `kind:"import_parked"` exists only during a rollback (§14).

New fields: `channel`, `name`, `hostId` (audit; authorisation always re-reads
`listing.host`), `status` (`active`/`disconnected`), `disconnectedAt`,
`disconnectReason`, `disconnectMode` (`keep`/`release`), `urlHash`,
`exportScope`, `canonical`, `export.{lastServedAt, lastServedAgent,
servedCount, hostConfirmedAt, rotatedAt}`, `sync.{nextSyncAt, leaseUntil,
leaseToken, firstAttemptAt, lastAttemptAt, lastSuccessAt, lastChangeAt,
lastFullAt, lastHttpStatus, lastErrorCode, lastErrorAt, consecutiveFailures,
contentHash, eventCount, pendingMissing, pendingEchoes, anomaly, anomalyAt,
anomalyAlertedAt, warnings, alertedAt, lastDurationMs, manualAt}`, `stats.*`
counters. Indexes: `{propertyId,kind}`, `{kind,status,sync.nextSyncAt}`,
unique partial `secret`, unique partial `canonical_legacy_export`, unique
partial `one_active_url_per_listing`.

### 2.2 `Booking.external` — provenance of an imported row

`{connectionId, channel, key, uid, state, kind, fingerprint, firstSeenAt,
lastChangedAt, missingSince, missingSyncs, missingMass, releasedAt,
releaseReason, echo:{suspect, since, uncoveredSince, promotedAt},
conflict:{at, kind, withBookingIds, nights, likelyMirror, notifiedAt}, rev}`.
`source:"ical"`, `sourceId:UID`, `status`, `paymentStatus` keep their meaning
for every existing reader. Blocking states: `active`, `missing`, `orphaned`;
released: `cancelled`, `removed`, `released`. Unique partial index
`external_connection_key (external.connectionId, external.key)`.

### 2.3 `CalendarSyncLog` (TTL 90 days) and `CalendarSyncState`

The log holds **transitions only** (added / modified / missing / removed /
cancelled / conflict / anomaly / connection created / URL changed / token
rotated / disconnected / host released / prebook refused), never one row per
poll; UIDs stored as a short hash. Needed because Vercel Hobby keeps runtime
logs for an hour and "why was Oct 12 blocked?" must be answerable later.
`CalendarSyncState` is a single heartbeat document written once per sweep.

## 3. Reconciliation state machine and exact release policy

| Observation | Action |
|---|---|
| New UID | insert row (`active`), claim nights (§6) |
| Same UID, same fingerprint | no write |
| Same UID, new dates | update row; nights outside the new range released first; new nights claimed — **no ghost night** |
| `STATUS:CANCELLED` (any calendar) or `TRANSP:TRANSPARENT` (OTA calendars) for a known event in a validated feed | released **at once** (explicit, high confidence). A *generic* calendar's "free" (`TRANSPARENT`) entries still block: personal calendars mark busy/free inconsistently |
| Same dates reappear under a **new UID** while the old UID left the same feed (providers that re-issue UIDs) | the existing row is **re-keyed** (`rekeyed` in the journal): no second row, nothing released, no anomaly |
| Known event absent while other live future events of the feed remain | `missing` (still blocking); released after **≥ 3 successful syncs over ≥ 2 h** |
| The **whole set** of live future events vanishes (any count — 1→0, 2→0, 30→0), or ≥ 50 % of ≥ 3 vanish at once | **ANOMALY**: nothing reopens; host e-mailed once; released only after **≥ 4 successful syncs over ≥ 12 h**, or when the host explicitly confirms the cancellation |
| A possible echo vanishes while its nights are still covered by our export or another channel's live import | normal rule (it protected nothing on its own); risk is judged once, at the moment of disappearance |
| Fetch failure, non-200/304, HTML instead of a calendar, truncated, malformed, over limits, SSRF refusal | **no reconciliation**; last known state stays; backoff 5 min → … → 6 h |
| One event unreadable (bad date) | treated as present-but-unknown, never as absent |
| 304 / unchanged meaning (hash of normalised events — Airbnb's body churns) | no reconciliation; a pending confirmation forces the next fetch to be unconditional |
| Reappearance | confirmation count restarts |
| A stay that has **already started** (check-in ≤ today on the property's calendar, India — not UTC) vanishes | `missing` (still blocking) but **never released by disappearance alone** (some feeds drop a stay at check-in); it ends at checkout, by an explicit `CANCELLED`, or by the host; it never counts towards an anomaly |
| A live row whose `status` was changed outside SyncGuard (old client, manual edit) | repaired by the next reconciliation that sees the event (`status_repaired`, nights re-claimed) — the feed decides |

Every row write is conditional on `external.rev`; a worker that was frozen
past its lease aborts before reconciling (lease renewed with its token or
nothing is written). A release first retires the row (conditional on its
revision — a worker whose lease expired frees nothing) and only then deletes
its nights; a crash in between leaves extra night rows (a block, never a
hole) that the daily full pass removes. If any row write of a pass loses its
revision race, the feed's content hash and validators are **not** saved, so
the next poll reconciles again instead of skipping an unchanged feed, and
`sync.lastSuccessAt` is **not** stamped (a commitment check must not trust a
pass whose write was lost); the connection is retried 60 s later. The
stale-worker check runs before reconciling; a worker frozen *during* a
reconcile can still insert rows and claim nights (only additions — every
release is revision-conditional), so the worst case is an extra block until
the next pass.

Imported rows are the OTA's: the generic booking endpoints (host reject /
terminate, guest terminate, admin cancel / delete / date move) refuse them
with 409 `EXTERNAL_BOOKING`. Ending one is done by the OTA (cancel there) or
by the host's explicit release under Calendar sync.

## 4. Loop prevention — evidence levels

* **Destination feeds**: connection K's feed = Majestic-native events (paid
  bookings incl. request-to-book awaiting the host, host blocks) + genuine
  imports of every *other* connection, including orphaned ones. Never K's own
  imports, never possible echoes, never unpaid holds.
* **REFLECTED** (proven): the UID is in Majestic's namespace
  `me-<HMAC>@sync.majesticescape.in` → dropped.
* **POSSIBLE ECHO** (not proof): every night is covered by what Majestic
  exports to that same connection now, or exported to it since our previous
  successful read of that feed minus 1 h of OTA export lag (clamped to
  1 h–72 h; 72 h on a first sync). A new event was absent at that previous
  read, so a reflection can only come from something exported since then;
  a real booking taken on nights freed *before* it is genuine and propagates
  at once (this window was a flat 72 h until the independent review — §20,
  finding 5). A genuine OTA
  double-sale can look identical, so a possible echo **still blocks** and
  **still raises a conflict** when it overlaps a paid Majestic booking; it is
  only withheld from propagation, which breaks Airbnb→Majestic→Agoda→Majestic
  cycles whatever the OTA does to UIDs or ranges. Events the provider marks as
  reservations are never echoes; for Airbnb (whose block marker
  `Airbnb (Not available)` was verified on real feeds) only marked blocks can
  be echoes, and a marked-block mirror of a paid booking is shown to the host
  as a "likely mirror" without an alert e-mail. A possible echo also needs
  the destination (or legacy) feed to have been **requested after** the
  booking became visible with its current dates (a Majestic booking: when it
  was paid — or created, for a host block — or last moved by an admin; an
  import: when its dates last changed) — an OTA cannot copy what it never
  fetched. A
  request is necessary, never sufficient (anyone with the URL can fetch it):
  its absence makes an event genuine, its presence alone never makes one an
  echo. While a calendar service fetched the link in the last 12 h, requests
  from unrecognised apps (chat previews, browsers) are not recorded.
* **Promotion**: a possible echo becomes genuine once its nights have been
  covered neither by our export nor by any other connection's live import for
  6 h (≥ 2 × Airbnb's 3 h refresh). The "other connections" test stops two
  mutual reflections being promoted together.
* **Cross-OTA overlaps** (rows of two *different* connections — two rows of
  one feed, e.g. a UID the provider re-issued, never count): a genuine event
  whose nights another connection's import already holds is recorded as
  `external_overlap`, shown as NEEDS_ATTENTION and e-mailed to the host once.
  A *possible echo* overlapping another connection's import is usually that
  OTA copying the other booking out of our feed — but a real double sale on
  an OTA without reservation markers looks identical — so it is recorded as
  a likely mirror and shown on the card as an informational note (no e-mail,
  no health change). Only an Airbnb event carrying its verified "Not
  available" block marker is a known mirror and is not recorded. Inventory
  is protected either way (both rows block).
* **Legacy property feed**: Majestic-native events only (destination unknown).

## 5. Scheduler (trigger-agnostic, no authoritative clock)

* `sync.nextSyncAt` per connection; 5-min lease via one conditional
  `findOneAndUpdate`; expired leases reclaimable; release is token-conditional.
* `runDue()`: oldest `nextSyncAt` first (index-backed — 100 docs examined for
  100 due among 10 000), bounded concurrency, deadline-aware, leftovers stay
  due; every processed connection moves ~15 min (±20 %) ahead → no starvation;
  failures back off.
* Triggers: Vercel cron daily full pass (`/api/v1/calendarSync/cron/sweep?mode=full`,
  `CRON_SECRET`); optional external clock every 10 min
  (`.github/workflows/calendar-sync-clock.yml`, scoped
  `CALENDAR_SYNC_CRON_SECRET`, inert until configured); stay calendar views
  (background, connections older than 5 min); host actions; commitment checks;
  feed requests (background nudge only); `SYNC_INPROCESS_INTERVAL_MS` ticker
  on long-running hosts (never on Vercel).
* Liveness: `CalendarSyncState` heartbeat + derived `schedulerStatus()`
  (HEALTHY / DEGRADED after 2 × interval without a sweep or overdue work /
  STALE after 4 h) in `GET /calendarSync/admin/overview` and on the admin
  **Calendar sync** page (clock state with its consequence, counts by state,
  a most-urgent-first list of calendars that need a look — listing, site,
  state, reason, last good check — and protection counters; no URLs or
  tokens). Connection health is derived from timestamps too, so a dead clock
  can never look green.
* The daily full pass e-mails the ops recipients when the clock is STALE,
  at most once per 20 h (`CalendarSyncState.clockAlertAt`), so a dead clock
  does not depend on someone opening the admin page.
* Connection health (host card, admin page). Inbound: PENDING (never read),
  HEALTHY, PARTIAL (read, but some entries could not be fully understood —
  an unsupported repeat rule blocks only its first date, an unreadable date
  blocks nothing, an unknown time zone is read as India time; the card says
  which), DEGRADED (last check failed, retrying), STALE (no success for
  longer than the cadence allows), BROKEN (permanent failure: 404/410, not a
  calendar, refused), NEEDS_ATTENTION (anomaly or conflict). Outbound:
  NOT_CONFIRMED, WAITING (host says it is saved, never requested), OPENED
  (requested, but not by an app identifying as a calendar service),
  ACTIVE, QUIET (no request for 12 h). Guests' bookings are restricted from
  the **first** failed check (the card says so), not only when BROKEN.
* A host replacing a calendar URL revokes any in-flight lease: a sync of the
  OLD calendar still running cannot stamp the connection "verified" (its
  lease-conditional finish writes nothing) and the new calendar is synced at
  once.
* **Safety does not depend on the scheduler**: bookings re-verify at
  commitment (§7). The scheduler only affects how quickly cross-OTA
  propagation and conflict detection happen.
* Kill switches (`opsflags`, no redeploy, `scripts/syncguard-flags.js`):
  `calendar_sync_paused` — no fetches; imported blocks stay; bookings of
  connected listings are refused while unverifiable (safe). `calendar_propagation_off`
  — feeds carry Majestic-native events only; **this reopens cross-OTA dates on
  the OTAs** (they stop seeing each other's bookings), so use it only if
  propagation itself is causing harm.

## 6. Night ledger integration

Imports claim nights with `kind:"ical", expiresAt:null`. Collisions are
classified: expired hold → reclaimed; live unpaid hold → the external booking
wins (the guest is refused at create-order before paying, or a payment
already in flight lands in the existing `inventory_conflict` queue); paid
Majestic booking → conflict (admin attention `ota_conflict` + host e-mail,
exactly once); host block / other import → shared. "Paid" is decided by the
owning booking's payment status, not by the night row's expiry: a paid
booking whose rows are still hold-style (the moment between payment and
making the nights permanent, or a crash there) is never displaced; an admin
date move claims the new nights permanently at once; Confirm never reclaims
the expired-looking night rows of a paid booking either. An admin who
resolves an alert re-arms it: a *new* conflict on that booking (another kind,
or nights / bookings it did not cover before) alerts again; an unchanged one
— including a stay in progress whose past nights drop off day by day — does
not. The admin item must actually land: while a booking carries another
open item, or if flagging fails, the conflict stays owed for that booking.
Each booking that landed is recorded (`conflict.adminFlaggedFor`, never
flagged again for that conflict); `conflict.adminFlaggedAt` once all have.
Owed flags of stays not yet over count as pending work
(`sync.pendingFlags`), so the next ordinary poll fetches the whole calendar
(no conditional request — a 304 would skip the reconciliation; the same now
holds for pending confirmations and echo reviews) and retries them. A
booking that left the conflict (cancelled) owes nothing: once every booking
still in conflict is queued, the conflict is marked flagged. Likewise only
possible echoes of stays not yet over count as `sync.pendingEchoes` (a past
stay leaves the feed and can never be reviewed again). A daily full pass
re-asserts nights and clears night rows of released imports.

**Shared nights.** An import that shares a night with a host block or a
booking owns no ledger row for it; when that other owner releases the night
the ledger shows it free until the next full pass. So the ledger alone is not
enough: `inventory.reserveNights` — the one primitive behind Confirm, Pay
(`secureHold` / `securePermanent`), admin "keep" and admin date moves — also
refuses any night covered by a live imported row (including rows parked for a
rollback). Found in the final self-audit (Pay after a host unblock returned
200 and opened an order); proven and fixed with
`tests/batch-s/syncguard-shared-nights.test.js`. Host blocks are exempt
(blocking an already-blocked night cannot double-book it). One exception
inside that check: a *possible echo* that SyncGuard linked to the very
booking being checked (it collided with that booking's own nights when it
arrived — the OTA mirroring the Majestic booking back) does not stop that
booking's own admin "keep" or date move; it still blocks everyone else.

## 7. Direct-booking protection (commitment policy)

Atomicity stays the database's job (unique night index): two simultaneous
guests → one 201, one 409.

At **Confirm** (`POST /booking`), **Pay** (`POST /payment/create-order`) and an
**admin date move** (`/booking/admin-modify`):

* a connection verified recently is trusted — within **2 minutes** at
  Confirm (it only takes a 30-minute hold), within **30 seconds** at Pay and
  for an admin date move (where a guest is committed for real), so in
  practice every Pay re-reads the calendars;
* any older connection is re-fetched now (8 s deadline) and the request waits
  for the outcome (or for another worker's in-flight sync); this re-fetch is
  **unconditional** (no ETag / If-Modified-Since), so a wrong 304 can never
  count as "verified";
* a re-read whose writes lost a race (another worker changed a row
  meanwhile) is read once more; a second race counts as **not verified**;
* an admin "keep" of an alert that is not itself an OTA conflict
  re-verifies the calendars like a date move (30 s) before confirming;
* on a listing with connected calendars, a stay ending more than **730 days**
  ahead is refused with 409 `BEYOND_SYNC_HORIZON` — imports and exports cover
  two years, so beyond that nothing could be verified or forwarded;
* if that required refresh fails or times out, the request is refused with
  409 **`AVAILABILITY_UNVERIFIED`** — instant *and* request-to-book — whatever
  the age of the last success (tested at 11 min, 1 h, 12 h, 23 h); a source
  that failed seconds ago is not hammered (30 s);
* an OTA booking found that way claims its nights first → 409 `DATES_UNAVAILABLE`.

Why these windows: direct bookings are rare (tens a month), so verification
costs at most one OTA request per connection per Confirm/Pay, and the
≈0.3–2 s fetch is paid only by a guest about to pay. A Confirm only holds
nights (released at Pay if an OTA booking appears meanwhile), so 2 min is
enough there; at Pay a 2-minute trust window let a night an OTA published in
that window become a paid double booking (release gate, D3), so it is 30 s —
long enough only for an in-flight sync or a double click to count. A
single-unit night must not be sold twice; conversion comes second.
Host blocks need no verification. A host can restore bookability of a listing
whose calendar is dead only by disconnecting it (with the acknowledgement in
§8.3).

## 8. Security and privacy

### 8.1 SSRF (`services/calendarSync/safeFetch.js`)
https only (`webcal://` normalised; `http://` only with test flags, refused on
Vercel); no credentials in URLs; no IP-literal hosts in any encoding; no
single-label/internal suffixes; default ports only; every DNS answer must be
public unicast (RFC 1918, loopback, link-local/metadata, CGNAT, multicast,
reserved, IPv4-mapped, NAT64, 6to4, Teredo, ULA, documentation ranges
refused; mixed answers refused); the socket connects to the **validated**
address (no rebinding window — proven by test); redirects manual (≤ 3) and
re-validated; an error or redirect response is closed at once, never read
or drained; no proxy env; 2 MB cap enforced while streaming on the wire and
after decompression (gzip bomb refused without inflating); one deadline for
the whole exchange. A refused source never modifies reservation state.

### 8.2 Parser limits
2 MB, ≤ 50 000 lines, ≤ 5 000 VEVENTs, ≤ 800 current/future events, 2-year
horizon, RRULE only DAILY/WEEKLY/MONTHLY/YEARLY (others → first occurrence +
warning), ≤ 5 000 total occurrences, ≤ 20 000 iterations per rule **and
≤ 200 000 for all rules of one file** (rules without COUNT jump straight to
the window, so a rule from the year 400 costs nothing; worst measured file
≈ 0.1 s). Time-zone formatters are cached per *canonical* zone with capped
caches (Intl accepts any capitalisation of a zone name). Duplicate copies of
one event starting the same day: a blocking copy always wins over a
cancelled/transparent one, two blocking copies merge to the longer stay.
SUMMARY and DESCRIPTION are never stored — only a reserved/blocked hint.
DNS resolution is bounded by the request's deadline.

**Nights from timed events** (all-day `VALUE=DATE` events are taken as
written): instants are mapped to the property's calendar (Asia/Kolkata), and a
timed event blocks every hotel night it touches — a start before noon also
blocks the previous night (its guest has not checked out), an end after noon
also blocks that day's night (the next guest may be checking in). A stay
14:00 → 11:00 therefore blocks exactly its nights; an event that ends 23:30
blocks that night too (release gate, D2: it was under-blocked). Recurrence is
expanded from the DTSTART date itself, so BYDAY / EXDATE / RECURRENCE-ID keep
their meaning. Time-zone names over 128 characters are unknown zones (never
regex-scanned), parameter values are cut at 256 characters, BYDAY lists are
deduplicated (≤ 7) and BYMONTHDAY lists capped (≤ 62 parts) — each candidate
day counts against the rule budget. EXDATE values are capped at 1 000 per
event and 10 000 per file: past a cap the event's exceptions are ignored (all
its dates block — over-blocking) and the card is PARTIAL. Zone names are
memoised (case-insensitively) and at most 100 *unknown* names are tried per
file (validating an invalid zone is the expensive case); further unseen names
read as India time, with the unknown-zone warning.

### 8.3 Authorisation, tokens, logs
The legacy `POST /saveCalendar` (old web page, mobile app) answers a refused
link (not https, not public, not a calendar, rate limited) as
`200 {success:false, code, message}` — those clients show `message` only for a
2xx `success:false` and print a generic "Request failed…" on a 4xx; auth and
ownership failures keep their 401/403/404. A new link pasted there for a
site replaces that site's existing link in the same connection only when
both hold: the old link has answered **404/410 for hours** (≥ 3 failures in a
row, nothing good for ≥ 6 h — 401/403 never count: bot walls answer 403
too), and the new link is **provably the same listing** (it shows at least
one event the old link showed that is still blocking or was released in the
last 90 days; an old link that never showed anything proves nothing). The
mobile app has no other way to fix a reset link; connect-attempt rate limits
apply and a failed attempt changes nothing. The old link's bookings that the
new link does not show are held (`external.hostHold`) **before** the URL is
switched — if the switch then fails, the hold is undone; if anything fails
in between, the worst left behind is a hold (over-blocking) — until the
host confirms them. In every other case the new link is added
beside the old one: the dead link keeps refusing direct bookings (and its
rows may raise an overlap notice with the new link's) until the host
disconnects it in the web panel — availability is lost, never a night
double-sold.

Every host endpoint resolves connection → listing → `listing.host` (or admin);
another listing's connection answers 404 (no oracle); auth is Bearer-header
only (cookies ignored — no CSRF vector). Rate limits: connect attempts 20 /
10 min per account, Sync now 1/min per connection (also applied to the
legacy `saveCalendar` re-save of the same link), 10 connections per
listing, 100 per account. Export tokens 256-bit, unique index, rotation kills
the old token immediately; disconnecting an import does **not** revoke its
outbound link (the OTA must keep seeing Majestic's bookings, or it would sell
those nights again — the host removes the link on the OTA when they stop
listing there); legacy 128-bit tokens keep working. A link fetched in turn by
two different calendar services is stamped on every change of requester
(otherwise at most once per 2 min), bounded by the feed rate limit. Feeds: dates + "Not available" only, opaque UIDs. Inbound URLs are
returned masked (host + last 4 characters) and never logged; journal/logs
carry no URLs, tokens or guest data. **Platform note**: feed URLs contain
their token in the path, so Vercel's own request logs see it (unavoidable for
URL-subscribed calendars); rotate a link if a log export leaks.

### 8.4 Safe disconnect
Disconnecting requires acknowledging that the OTA may still take bookings
Majestic can no longer see. Imported blocks are **kept** (`orphaned`, still
blocking and still forwarded to other OTAs) unless the host explicitly
chooses "Release them now" and confirms the OTA listing is no longer selling.
Kept blocks can be released later only by explicit host action; reconnecting
the same calendar revives the connection and its blocks; audit rows are kept.
The connection's Majestic link keeps serving after the disconnect (§8.3);
the panel lists it under "Disconnected sites" (when it was last requested,
never the link itself) with **Stop link…** (`POST
/connections/:id/stop-export`: revoked at once — the token stays a revocable
credential). Reconnecting the same calendar keeps the same link, so the OTA's
saved copy keeps working; after a stop, reconnecting issues a new one (the
reconnect write is conditional on the link it read, so a stop landing at
the same moment is never undone). Stopping twice is harmless.
Kept blocks are forwarded to every other connection, including a *new* link
of the same site: if that site later cancels the stay, its mirror of the kept
block can hold the nights until the host releases the kept block — a
visible over-block, accepted because not forwarding kept blocks could let a
second listing on that site sell nights the first one had booked (§22, M8).

## 9. External facts the design rests on (researched 2026-10-03)

[V] = official documentation or observed on a real feed; [U] = third-party.

| Fact | Status |
|---|---|
| Vercel Hobby cron: once a day, ±59 min, no retries, may fire twice | [V] |
| Vercel Fluid (Hobby): 300 s max; `waitUntil` works in Express, same timeout | [V] |
| GitHub `schedule`: ≥ 5 min, delayed/dropped under load, default branch only, free for public repos, disabled after 60 days without activity | [V] |
| Airbnb imports external calendars every **3 h**; Booking.com every **2 h**; Vrbo every **30 min**; Agoda "several times a day" | [V] |
| Booking.com and Agoda offer iCal only for one-unit room types; Vrbo ≤ 5 calendars, 365 days | [V] |
| MakeMyTrip / Goibibo: no iCal documentation (channel managers only) | [V] (absence) |
| Airbnb feed: no ETag/Last-Modified, `no-store`, body changes between identical fetches, `VALUE=DATE`, blocks `Airbnb (Not available)`, UID `<12hex>-<32hex>@airbnb.com` | [V] observed |
| Airbnb reservations exported as `Reserved` | [U] |
| Whether OTAs re-export imported blocks; cancellation as removal vs `STATUS:CANCELLED`; UID stability on modification | [U] undocumented |
| OTA APIs: Airbnb partner programme only; Booking.com paused for new providers, no direct property connections; Expedia/Vrbo no direct property connections; Agoda questionnaire + certification + 2–3 property pilot; MMT via business development manager | [V] |
| Booking-notification e-mail formats: undocumented by every OTA | [U] |

## 10. Guarantees vs external limitations

**Majestic guarantees (tested)**: atomic night claims; no direct booking
committed against a calendar that could not be re-verified at that moment;
idempotent, source-aware reconciliation; no release on failure, emptiness,
truncation or one-off absence; explicit, logged, host-confirmed releases;
conflicts surfaced (never silently suppressed); health that cannot stay green
when stale; feeds that change the moment Majestic's state changes; no echo
back to an OTA's own feed; bounded outbound traffic; no PII in feeds.

**OTA-controlled (cannot be guaranteed)**: when an OTA publishes a new booking
in its export (the residual window: an OTA sells a night and has not yet
published it when a Majestic guest commits — Majestic re-verifies the feed,
not the OTA's internal state); when an OTA fetches Majestic's feed (Airbnb
3 h, Booking.com 2 h, Vrbo 30 min, Agoda several times a day) — a night sold
on Majestic can be double-sold on an OTA inside that window; whether an OTA
re-exports imported blocks; whether a genuine OTA double-sale is published
with a reservation marker.

**Heuristic residual (Majestic-controlled, accepted)**: an event from a
provider without a verified reservation marker (Booking.com, Agoda, Vrbo,
generic) on nights Majestic stopped exporting less than about one poll + 1 h
before it was first seen is a *possible echo*: it blocks Majestic and raises
conflicts, but is withheld from the *other* OTAs' feeds until promoted (6 h
uncovered). In that narrow window another OTA could sell the same nights.
The alternative (propagating every uncovered event at once) recreates
self-sustaining phantom-block loops between OTAs that re-export imported
blocks (§4). Airbnb reservations carry `Reserved` and are never echoes.

## 11. Not applicable

Multi-unit quantity sync (no listing has more than one unit); Redis (leases
and flags live in MongoDB); Google Calendar as an intermediary (not used; a
host may still connect one as a generic calendar).

## 12. Migration (`scripts/syncguard-migrate.js`)

Order: **preflight (read-only) → deploy → `--apply` → `--create-indexes`**.

* Preflight (default mode) reports what apply would change, every unique-index
  conflict, and the decisions only a human can make. Run on the dev cluster
  2026-10-03: 4 import connections needing defaults, **8 wrong-host rows**,
  7 listings with duplicate legacy feeds (20 secrets, all kept serving),
  **0 conflicts**, no human decisions.
* `--apply` is deterministic and idempotent (second run: no-op, byte-identical
  data): defaults (channel, urlHash, status, name, hostId, schedule, outbound
  token); duplicate active imports of one URL on one listing → the oldest stays,
  others retired in the same update (safe with or without indexes); imports of
  deleted listings retired; oldest legacy feed per listing marked canonical
  (every legacy secret keeps working); D3 host attribution repaired; legacy
  rows adopted into the listing's single connection (duplicate UIDs kept under
  their own key). Imported rows with no connection at all are reported, never
  released.
* `--create-indexes` refuses (nothing half-created) while any unique conflict
  remains; idempotent.
* The new backend works before the migration (lazy adoption on first sync);
  the migration makes it complete and creates the invariants.

## 13. Rollout (proposed — owner decides)

1. Read-only preflight on production (`--confirm-db=master-db`, and verify the
   connection string points at the production Atlas cluster); review the report.
2. Deploy `server.me` (backend first: the old frontends keep working — the
   legacy `saveCalendar` contract is unchanged, the mobile app included).
3. `--apply`, then `--create-indexes`; confirm `[startup] SyncGuard indexes`
   warning is gone.
4. Verify `PUBLIC_HOSTNAME` (feed URLs are completed with `/api/v1` if it is
   missing) and fetch one legacy feed URL (expect 200 `text/calendar`).
5. Deploy `admin.site` (attention label) and `user.website` (host panel,
   checkout message).
6. Optional: set `CALENDAR_SYNC_CRON_SECRET` in Vercel and GitHub, set the
   `SYNCGUARD_SWEEP_URL` variable, and merge the workflow to `main`.
7. Watch `GET /calendarSync/admin/overview` (health distribution, scheduler,
   counters) for a week.

What changes for people at promotion: every legacy feed URL starts returning
Majestic bookings (it returned 500 before); hosts with a dead Airbnb link
cannot take direct bookings on that listing until they fix or disconnect it
(they are e-mailed once); hosts see the new Calendar sync panel; guests see a
"couldn't confirm these dates" message instead of a booking when a connected
calendar cannot be checked.

## 14. Rollback

* Preferred: kill switches (§5) — no redeploy, no released dates.
* Frontend rollback: safe at any time (old UI uses the unchanged legacy
  endpoint).
* Backend code rollback: run `node scripts/syncguard-migrate.js
  --rollback-prepare` **first**. The pre-SyncGuard sync cancels every imported
  row of a listing missing from its one calendar; the preparation leaves one
  connection per listing visible to it and parks the others' rows
  (`source:"ical_parked"` — availability readers ignore `source`, so they keep
  blocking). Proven with the real old code: without preparation it reopened a
  booking on a two-calendar listing; with it, nothing reopened.
  `--rollback-undo` (or the next `--apply`) reverses it.
* Data: everything is additive; nothing is deleted; legacy URLs keep working.
* What OTAs see after a backend rollback: every per-connection Majestic link
  (the new tokens) answers 404 — OTAs stop receiving Majestic bookings
  through it — and legacy property feeds return to their old behaviour
  (500 before SyncGuard). Prefer the kill switches; if the code must be
  rolled back, tell hosts their Majestic links are paused.

## 15. Official API roadmap

Majestic cannot connect to OTA APIs today (§9). Realistic order: Agoda
(published partner questionnaire + certification + 2–3 live property pilot);
Booking.com when it reopens to new connectivity providers; Airbnb only by
invitation; Expedia/Vrbo via their partner programme. Each would be a new
adapter producing the same source events (and, where offered, quantity/ARI
for multi-unit listings).

## 16. E-mail fast path — foundation only

Not built: no OTA documents a stable notification format (third-party parsers
sell AI extraction precisely because layouts change); inbound providers with
SPF/DKIM verdicts and signed webhooks cost money (Postmark, SendGrid) or need
DNS changes (Cloudflare Email Routing) or have tiny free tiers (Mailgun: one
route). The internal hook exists: anything that learns "this source changed"
calls `syncConnection(id, {force:true})` (as Sync now, URL changes and
commitment checks do). A future verified notification would add a short
provisional block and call it.

## 17. Cost (measured per operation; estimated per scale)

Measured on the final code (release gate, 2026-10-03; in-memory replica set,
Mongoose op count; Node CPU via `process.cpuUsage()` — an upper bound, the
test client and fake OTA share the process). Evidence:
`tests/syncguard-evidence/perf-*.json` (outside the repo).

| Operation | DB ops | Node CPU | Wall |
|---|---|---|---|
| Unchanged poll (20-event calendar) | 4 | ≤ 6.1 ms | ≈ 9 ms |
| Poll with one changed event | 21 | ≤ 33 ms | 35–87 ms |
| Daily full pass, 20 / 100 / 300 events | 65 / 515 / 1 515 | ≤ 69 ms (20) | 0.19 / 0.5 / 1.25 s |
| An OTA fetching its Majestic feed | 5 (+ ≤ 1 throttled write) | ≤ 8.9 ms | 10–15 ms |
| First sync of a 300-event calendar (once) | 1 231 | — | 2.1 s |
| Sweep of 100 due calendars | 417 (≈ 4 each), 100 fetches | — | 0.41 s |
| Confirm (`POST /booking`), listing without calendars | 9 (base: 7) | — | 22–26 ms (base 23–24) |
| Pay (`create-order`), listing without calendars | 12 (base: 10) | — | 35–38 ms (base 29–31) |
| Confirm, 1 / 3 calendars re-read | 15 / 23 | — | 35 / 48 ms + the OTAs' own latency (≤ 8 s) |
| Due query at 10 000 connections | index scan, 100 examined for 100 due | | |
| Parse 30 / 200 / 330 events | — | 0.6 / 2 / 3 ms | heap ≤ 3.2 MB |
| Load every route module (cold) | — | 723 ms (base 746) | heap 36.8 MB (base 37.5) |

Per connected listing per day (1.5 calendars, 15-min cadence via a 10-min
clock, 5 % of polls see a change, one full pass with ~20 events, each OTA
fetching its Majestic feed ~12×): ≈ 900 DB operations, ≈ 1.3 s Node CPU
(upper bound), 144 outbound calendar fetches, ~18 feed requests.

| Connected listings | OTA fetches/day | DB ops/day (avg/s) | Node CPU/month (upper bound) | Invocations/month | First limit reached |
|---|---|---|---|---|---|
| 19 (live listings today) | 2.7 k | 17 k (0.2) | ≈ 13 min | ≈ 15 k | none |
| 10 | 1.4 k | 9 k (0.1) | ≈ 7 min | ≈ 10 k | none |
| 100 | 14 k | 90 k (1) | ≈ 1.1 h | ≈ 58 k | none |
| 1 000 | 144 k | 0.9 M (10; sweep peaks > 100) | ≈ 11 h | ≈ 0.55 M | Vercel Hobby active CPU (4 h/month ≈ 360 connected listings); Atlas M0 100 ops/s (sweeps throttled, not broken) and 10 GB/week transfer |
| 10 000 | 1.4 M | 9 M (104) | ≈ 110 h | ≈ 5.4 M | needs a paid compute tier or a dedicated worker and a dedicated Mongo tier |

Plan facts verified 2026-10-03 (vendor docs): Vercel Hobby — 4 active-CPU
hours, 360 GB-h memory and 1 M function invocations per month, 300 s maximum
duration, **non-commercial use only**; Atlas M0 — 100 ops/s, 500
connections, 0.5 GB, 10 GB in / 10 GB out per rolling 7 days. GitHub Actions
on this public repository: standard runners at no cost (144 short runs/day).

Cadence: 15 minutes stays appropriate while the plan absorbs it (≈ 300
connected listings on Vercel Hobby). Beyond that: move compute, or slow down
idle calendars (no future events / unchanged for 24 h → hourly). Safety does
not depend on cadence (§7); only cross-OTA propagation latency does.
SyncGuard adds no Redis and no paid service.

Browser (host calendar page, base vs SyncGuard build, same listing and
backend, medians of 5 Chromium loads): load 101–178 ms vs 108–113 ms; script
transfer 997 vs 1 005 KB; JS heap 12.3 vs 12.3 MB; DOM nodes 586 vs 739;
listeners 890 vs 469; long tasks 0–2 vs 0; idle CPU 5 vs 5–6 ms per 15 s;
idle requests 0 vs 0; no timer of its own. 100 open/close cycles of the
dialogs: actual listeners on window/document/body/elements unchanged (29 /
155 / 139 / 212), DOM nodes unchanged, heap plateaus (13.8 → 15.1 → 15.3 MB);
no calendar request after leaving the page. Admin page: 6.5 kB route.

## 18. Runbook

* "Why is Oct 12 blocked?" — host: click the date (explain dialog); API:
  `GET /calendarSync/properties/:id/explain?date=YYYY-MM-DD`.
* Health of everything — `GET /calendarSync/admin/overview` (admin).
* A connection is BROKEN — the host was e-mailed; ask them to copy a fresh
  link (`PATCH` URL in the panel) or disconnect it.
* NEEDS_ATTENTION (mass disappearance) — dates stay blocked 12 h; if the OTA
  confirms cancellations the host can release them in the panel.
* `ota_conflict` in the admin queue — a genuine double booking: contact the
  host; refund via admin cancel or resolve "keep" (flag only).
* A connection shows "overlaps one on another connected site" — two OTAs
  report the same nights; the host checks both sites. Nothing to release:
  both rows block.
* "Cancel" on an imported stay answers `EXTERNAL_BOOKING` — by design: cancel
  it on the OTA (released automatically) or release the dates in Calendar
  sync (host, or admin acting on the listing's connection).
* Scheduler STALE — check the GitHub workflow / Vercel cron; bookings stay
  safe (commitment verification), propagation slows.
* Pause everything — `node scripts/syncguard-flags.js --pause`.

## 19. Metrics (per connection `stats.*`, totals in the admin overview)

attempts, successes, failures, notModified, unchanged, added, modified,
removed, cancelled, missingPending, echoes, promoted, reflected, conflicts,
holdsDisplaced, repaired, raced, prebookChecks, prebookRefused,
prebookPrevented (direct bookings stopped by an imported OTA booking).

## 20. Independent adversarial review (2026-10-03)

A separate reviewer (read-only, no repo edits) attacked the finished code
with its own experiments. Every finding was re-verified against the code
before fixing; each fix has a regression test in
`tests/batch-s/syncguard-review-fixes.test.js` that **fails on the pre-fix
code and passes after** (verified by running the suite against both).

| # | Severity | Finding (verified) | Fix |
|---|---|---|---|
| 1 | High | A listing owner's calendar could block the event loop for 28 s (rules walked from the year 400; cap per rule, not per file) or grow memory ~110 MB per sync (time-zone cache keyed by any capitalisation) | rules without COUNT skip to the window; 200 000-iteration budget per file; canonical, capped zone caches. Measured: 28.4 s → 44 ms; memory flat |
| 2 | High | Host/guest/admin cancel, delete and date-move endpoints accepted imported OTA rows: nights reopened, unchanged feed never restored them; a guest booked the OTA-booked nights (201) | those endpoints refuse imported rows (409 `EXTERNAL_BOOKING`); reconciliation repairs a live row's status (`status_repaired`) |
| 3 | Medium | A longer `CANCELLED` copy of an event with the same UID and start hid the confirmed copy | a blocking copy always wins; two blocking copies merge |
| 4 | Medium | "Sync now" left a derived promise without a rejection handler: a database error in a sync would crash the process | handled (reproduced: old code printed `Unhandled Rejection` and the test process died) |
| 5 | Medium | A real Agoda/Booking.com booking on nights Majestic freed within 72 h was a possible echo for up to 6 h+ (not sent to other OTAs); cross-OTA overlaps were never reported | echo window = since the previous successful read of that feed (−1 h, clamp 1–72 h); cross-OTA overlaps → NEEDS_ATTENTION + one host e-mail + panel banner |
| 6 | Low-Med | An Airbnb mirror of a paid Majestic booking blocked that booking's own admin date move and "keep" | `importedOverlap` ignores a possible echo linked to the same booking; it still blocks everyone else |
| L1 | Low | A pass whose row write lost a race still saved the feed hash (update not retried until the feed changed or the daily pass); a lease-expired worker could free nights before its revision check | hash/validators not saved when a race occurred; release = conditional row write first, nights after |
| L2 | Low | DNS lookup had no deadline | bounded by the request deadline |
| L3 | Low | Migration-retired duplicate connections left their rows `active` (invisible, unreleasable) | they become `orphaned` (still blocking, host-releasable) |
| L4 | Low (suspicion) | An OTA that drops a stay at check-in got the remaining nights released after 2 h | a started stay is never released by disappearance alone |
| L5 | Low | The legacy `saveCalendar` re-save forced a sync with no rate limit | 1 per minute per connection (same limit as Sync now) |

Not changed (documented): two slow (> 6 h) calendars that both re-export
imported blocks can bounce a block between them after promotion — OTA
behaviour; the block is visible to the host with its source and is cleared
by unblocking it on that OTA (Majestic cannot release an event a live feed
still reports); the narrow echo window in §10.

## 21. Release-gate verification (2026-10-03)

The finished feature was re-verified end to end (requirement → code → test →
runtime evidence) by a second pass whose job was to break it. Every defect
below was proven by a test that fails on the previous code; all are fixed.

| # | Severity | Defect | Fix |
|---|---|---|---|
| D1 | Medium | A provider re-issuing a UID (or a reservation + block in one feed) raised a false "two sites report the same nights" alarm and e-mail | only rows of a *different* connection count |
| D2 | High | Timed events under-blocked (an occupation ending after noon left that night bookable) | noon rule (§8.2) |
| D3 | High | Pay / admin move trusted a 2-minute-old calendar read: a night an OTA sold meanwhile could be paid twice | 30 s at money moments (§7) |
| D4 | Medium | A real double sale between two OTAs without reservation markers was recorded nowhere | recorded as a likely mirror, shown to the host |
| D5 | Medium | Replacing a URL during an in-flight sync let the old worker stamp the connection "verified" with old data for 15 min | URL change revokes the lease |
| D6 | Medium (ops) | Operator view ignored conflicts and named no listing; API only | richer overview + admin page |
| D7 | Low (UX) | Old clients showed "Request failed…" for refused links | legacy refusals as 200 `success:false` |
| D8 | Low (privacy) | Public Actions log printed calendar counters | prints success flags only |
| D9 | Low (privacy) | Public docs named database cluster hosts | removed |

Also proven in this pass: 23 fetch-failure modes leave inventory byte-
identical; 15 double-booking races (×25 rounds, DB invariants after every
round); 2-, 3- and 5-channel loop topologies converge with no growth and no
immortal phantoms; SSRF forms, DNS answers, rebinding and redirect chains;
authorization matrix with no oracle on connection ids; failure recovery at
every write step; 24 mutations of critical protections all caught by a
failing test.

## 22. Second independent adversarial review (2026-10-03)

A second reviewer attacked the release-gate code with its own experiments.
Each fix below has a regression test in
`tests/batch-s/syncguard-review2-fixes.test.js`, and every one of the 18 was
seen failing on its own assertion before its fix (17 against commit 574e55b,
L6b against 28c4c02) and passing after it.

| # | Severity | Finding (verified) | Fix |
|---|---|---|---|
| C1 | Critical | A very long time-zone name froze the parser (4.9 s per sync; regex scan); zone caches grew to 74 MB | names > 128 chars are unknown zones, parameters capped at 256 chars; measured 4.9 s → 24–51 ms, cache memory 74 → 2 MB |
| H1 | High | Admin "keep" of an inventory conflict confirmed without re-reading the OTA calendars | re-verifies (30 s) first; refused 409 if an OTA now holds the nights |
| H2 | High | After an admin resolved an alert, a new OTA conflict on the same booking never alerted again (and unchanged ones were re-reported daily) | resolve re-arms the alert; only new or changed conflicts report |
| H3 | High | The mobile app (legacy endpoint) could not replace a reset Airbnb link; the card showed bookings as open until BROKEN | replaces a BROKEN same-site link in place; restricted from the first failure |
| H4 | High | Error and redirect bodies were drained to the end (an endless body kept a socket and CPU busy) | closed at once |
| M1 | Medium | A BYMONTHDAY list of 200 000 entries took 3 s / 415 MB | lists bounded, each candidate counted; 6 ms / 2 MB |
| M2 | Medium | Entries the parser could not fully read left the card green; a generic calendar's "free" entries released real blocks | PARTIAL state with the reason; generic `TRANSPARENT` still blocks |
| M3 | Medium | A double sale on a site that had never requested its Majestic link was graded a "likely copy" (no alert) | an echo needs the feed to have been requested after the booking existed |
| M4 | Medium | Disconnecting an import also killed the OTA's Majestic link: the OTA could resell Majestic's nights | the outbound link keeps working |
| M5 | Medium | A non-Airbnb OTA that re-exports blocks raises an alert for every mirrored paid booking | **kept**: a genuine double sale there looks identical; an alert is the safe side, and H2 prevents repeats |
| M6 | Medium | Stays beyond the 2-year sync horizon were bookable and missing from feeds | `BEYOND_SYNC_HORIZON` on listings with calendars |
| M7 | Medium | A provider re-issuing every UID on every fetch created a new row each time | same dates + vanished old UID → re-keyed row |
| M8 | Medium | Blocks kept on disconnect are forwarded to a new link of the same site and can hold a mirror there | **documented** (§8.4): the alternative risks a double booking |
| L1 | Low | A paid booking with hold-style night rows could be displaced by an import | decided by the owner's payment status |
| L2 | Low | A pass that lost a write race still stamped `lastSuccessAt` | not stamped; retried in 60 s |
| L3 | Low | A worker frozen during a reconcile can still insert and claim | **documented** (§3): additions only, healed next pass |
| L4 | Low | Commitment checks used conditional GETs (a wrong 304 counted as verified) | unconditional |
| L5 | Low | "Stay already started" was judged in UTC (released ~02:00–05:30 IST) | property's calendar day |
| L6 | Low | Any request (a chat preview) showed "Link in use" and green protection | OPENED state; only calendar services count |
| L6b | Low | (found by the release-gate UI pass after the L6 fix) a calendar service's request right after a preview was not recorded for 2 min, and a later preview turned "in use" back into "opened" | requester changes always recorded; previews ignored while a calendar service fetched in the last 12 h |
| L7 | Low | The journal's 90-day expiry index was not in the startup check | added |
| L8 | Low | The guest message says "try again in a few minutes" even for a permanently broken link | **kept**: the owner specified that text |
| L9 | Low | The rollback plan did not say feeds go 404/500 after a backend rollback | documented (§14) |
| L10 | Low | Timed events at midnight UTC or before noon block one extra night | **kept**: over-blocking is the safe side of the noon rule |
| L11 | Low | An admin date move ignores a possible echo linked to that booking even on sites without reservation markers | **kept**: that echo already raised an `ota_conflict` when it arrived, so the admin is told before acting |
| L12 | Low | A dead clock was visible only on the admin page; cost rests on Vercel Hobby (non-commercial) | daily e-mail to ops when STALE; plan terms → owner decision |

## 23. Re-review of the second review's fixes (2026-10-03)

A third reviewer attacked commits 28c4c02 and 7fc0569 with its own
experiments. Every finding was reproduced; each fix has a regression test in
`tests/batch-s/syncguard-review3-fixes.test.js` and all 9 tests fail on the
pre-fix code (7fc0569) on their own assertion and pass after.

| # | Severity | Finding (verified) | Fix |
|---|---|---|---|
| R1 | High | Reconnecting a disconnected calendar issued a new Majestic link, so the OTA's saved link went dead (the OTA could resell Majestic's nights); a disconnected connection's live link could not be revoked or even seen | reconnect keeps the link; disconnected live links are listed and can be stopped |
| R2 | Medium | The legacy endpoint replaced a link that was only rate-limited (BROKEN after 5 failures of any kind); the old link's bookings were then released by the missing rules and the nights sold | replace only on "not found / access refused"; the old link's unseen bookings are held until the host confirms |
| R3 | Medium-Low | A 2 MB EXDATE line cost 2.1–4.5 s of parsing (unknown zone resolved per value) | EXDATE caps (over-block past them), zone memo, ≤ 100 zone validations per file; measured 21–39 ms |
| R4 | Low | A booking-time sync that lost a write race still counted as verified (the booking of a night the OTA had just extended returned 201) | read again once; a second race → `AVAILABILITY_UNVERIFIED` |
| R5 | Low | An OTA double sale arriving while another admin item was open on the booking never reached the admin queue | `conflict.adminFlaggedAt` only when the item lands; owed until then |
| R6 | Low | A resolved conflict re-alerted every day while the stay was in progress | only new nights / bookings / kind count as a change |
| R7 | Low | Confirm reclaimed the expired-looking night rows of a paid booking (crash between paid and permanent) | paid owners excluded, as in the import ledger |
| R8 | Nit | "Fetched after it existed" used creation time: a stay an admin moved counted as already seen by the OTA | visible-since = paid / created / last admin date move (`datesChangedAt`); imports: last date change |

Re-measured after the fixes: the reviewer's parser cases (2 MB EXDATE lines,
2 MB parameters, 99 k folded lines) 17–58 ms; 4 900 events with distinct
unknown zones 493 → 226 ms (now ordinary per-event time conversion, bounded
by the 5 000-event file cap).

## 24. Re-review of the R1–R8 fixes (2026-10-03)

A fourth reviewer attacked commit 477e56a. Each fix has a regression test in
`tests/batch-s/syncguard-review4-fixes.test.js`; the suite was run against
477e56a (failures recorded in the release-gate evidence) and passes after.

| # | Severity | Finding (verified) | Fix |
|---|---|---|---|
| X1 | Medium | R2 not closed: two 403s made a working link "reset"; the legacy save replaced it with another listing's link and a guest booked nights the OTA had sold (201) | replace only after ≥ 3 × 404/410 over ≥ 6 h **and** when the new link shows one of the old link's live bookings; otherwise added beside |
| X2 | Low | The replace path's rate limit counted nothing; every failed attempt set `hostHold` and bumped every row's revision | attempts are journalled (limited like connects); hold set only after a successful replacement |
| X3 | Low-Med | One OTA sale over two paid bookings, one with another open item: the other was re-flagged on every pass after the admin resolved it | per-booking `adminFlaggedFor` |
| X4 | Low | Deploying would re-open conflicts already resolved (no `adminFlaggedAt` on older rows) | not applicable — SyncGuard never ran in production, so no such rows exist; the backfill first added for it was removed (§25, F2) |
| X5 | Low | "Stop link" racing a reconnect could be undone | reconnect write conditional on the link it read |
| X6 | Low | An owed admin flag was retried only by the daily pass (up to ~24 h) | `sync.pendingFlags` makes ordinary polls reconcile and re-check it |
| X7 | Nit | A date match could release a held row under another listing's link | closed by X1 (replacement only for the same listing) |
| X8 | Nit | Dialog errors survived "Keep"; stopping twice answered 404; §8.2 wording | fixed |

## 25. Re-review of the X1–X8 fixes (2026-10-04)

A fifth reviewer attacked commit 3dd5612. The tests below are in
`tests/batch-s/syncguard-review4-fixes.test.js`; each fails on 3dd5612 on
its own assertion and passes after.

| # | Severity | Finding (verified) | Fix |
|---|---|---|---|
| F1 | High | A dead link with no upcoming stays could be replaced by **another listing's** link; the connection looked healthy and a guest booked (201) | "same listing" must be proven against every event the old link ever showed; no evidence → added beside (bookings stay refused) |
| F2 | Medium | The `--apply` backfill marked conflicts still owed to the admin as flagged (every run after deploy) | backfill removed: the rows it targeted cannot exist |
| F3 | Low-Med | `pendingFlags` could stay > 0 for ever (a booking in the conflict cancelled after a partial landing; a stay that ended while owed), keeping polls unconditional | flagged once every booking still in conflict is queued; only stays not yet over count |
| F4 | Low | On replacement, a stay the old link had already dropped could be released by the new link's first sync before it was held | hold set before that sync |
| — | (test) | X6 exercised no ETag: a 304 still skipped the owed retry by one poll | pending work forces an unconditional fetch; X6 now serves ETag/304 |

A sixth, scoped review of eba500c found no double-booking path; its three
minor findings were fixed (tests in the same file fail on eba500c and pass
after):

| # | Severity | Finding (verified) | Fix |
|---|---|---|---|
| G1 | Low-Med | If writing the hold failed after the URL switch, a retry took the "same link" path and the hold was lost | hold first, then switch (undone if the switch fails) |
| G2 | Low (cost) | A possible echo of a past stay kept `pendingEchoes` > 0 for ever: every poll a full download + reconcile | only stays not yet over count |
| G3 | Info | One UID seen long ago (a row released 400 days earlier) proved "same listing" | evidence must be blocking or released ≤ 90 days ago |
| N1 | Low | (found by the final full run: the 5-OTA loop simulation failed once under load) the background refresh a feed request starts reused the request's timestamp, so a delayed sync stamped what it imported with a stale time — "seen by the OTA" could be judged on the wrong clock | each background sync reads the clock when it runs; the loop simulators disable the background refresh (they drive every sync on their own clock); stress-tested 3 × under heavy concurrent load |

Accepted (documented, §8.3): a genuinely reset link whose stays all changed
UIDs is added beside the dead one; the listing refuses direct bookings until
the host disconnects the dead link in the web panel (availability loss, not
a double booking).

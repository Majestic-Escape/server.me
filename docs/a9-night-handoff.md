# A9: a night a live import still covers is handed to it, never freed

## The defect

Dated search reads the night ledger (`BookingNight`, one row per listing night, unique). An imported (iCal) booking that arrives on a night someone else already owns (a host block, a paid booking, another import, a hold) only *shares* that night and gets no row. When the owner let the night go, every release path deleted the row, so:

- dated search offered the night (no row),
- `/booking/check-dates` and checkout refused it (`inventory.importedOverlap`),
- until the next full calendar pass re-claimed it (daily, 00:45 UTC).

Reproduced on hosted staging on 2026-11-28: a host blocked a night, an imported calendar covered it, the host unblocked it, and search offered the stay while checkout answered 409. Disconnecting one of two calendars that cover the same nights left 79 such nights at once.

## The fix

`services/inventory.js` `releaseNights(bookingId, { keep })`, used by every release path:

1. A night that a live import covers (the same set `importedOverlap` blocks on; a live booking's own OTA mirror is not an heir) changes owner to that import in one conditional update. Search never sees it free, not even between two writes.
2. Write, then validate: the heir is re-read; nights it no longer covers (a sync shortened, moved or cancelled it meanwhile) are released again the same way.
3. Delete, then validate: when no heir was found, imports are looked up again after the delete; one that arrived in between gets the night.
4. It returns the rows handed over; a failed admin date move takes them back (`takeBack`) before restoring its old nights.

`services/calendarSync/ledger.js`: `releaseAll` / `releaseOutside` go through it; `claimNights` takes over a permanent row whose owner is cancelled or rejected (or an import that no longer covers the night), never a live local owner (a block or booking being written); an import cancelled while its own claim ran releases its nights. `secureHold` and the full-pass clean-up also go through `releaseNights`.

## Remaining windows (not closed here)

- An import caught between its own two writes (Booking written, nights not yet claimed) while a release deletes the row: dated search can offer the night for milliseconds; check-dates and checkout already refuse it (no double sale). The same milliseconds exist today for every brand-new import on a free night; closing them means the importer claiming nights before writing the Booking (a separate change).
- A sync that dies between those two writes leaves the night free until the next full pass (pre-existing importer behaviour).
- A night shared by an import and an unpaid hold that later expires (only after a displacement race) shows free until the next claim or full pass; the detector reports it as `expired_hold_row`.

## Rollout

1. With the owner's approval, merge to `dev`, then `dev-deployment` (staging). On staging repeat the A9 scenario (host block, overlapping import, unblock) and check that search, check-dates and checkout agree.
2. Production: deploy the code. No migration and no flag: the change only affects what happens at the next release of each night.
3. Existing holes (written before the fix) are not healed by the code. Find and repair them (below). Until then they also heal at the next full pass.
4. Dated search in the chat (`RAG_DATED_SEARCH`) stays off until the detector reports 0 in production after the repair.

Rollback: revert the commit. Rows handed to imports stay owned by imports, which is what checkout already enforces, so no data needs reverting.

## Repair of existing holes

Read-only detector (run with a read-only database user):

    node scripts/a9/find-missing-import-nights.js --uri "<mongodb uri incl. database>"

Two-step repair (needs a write user and its own approval):

    node scripts/a9/repair-missing-import-nights.js --root . --uri "<uri>" --plan-out plan.json      # dry run, writes nothing
    node scripts/a9/repair-missing-import-nights.js --root . --uri "<uri>" --apply --plan plan.json  # exactly that plan

The plan has one item per listing night, for the lowest-id covering import (the heir `releaseNights` would pick). Apply re-checks each night at the moment of writing: a night still without a row goes to the import; the same expired unpaid hold the dry run saw changes owner in place; a live checkout hold that appeared after the dry run is skipped (never displaced); a hold whose booking was paid since is skipped, and if the payment lands during the move the row goes back to the paid booking, permanent. Any skip exits with code 4. Re-run the detector afterwards: expect 0.

Alternative without the script: force a full pass of the affected connection (its `claimNights` re-takes free nights). It follows the importer's rules, which displace live unpaid checkout holds on those nights.

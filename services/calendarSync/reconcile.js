// Reconciliation state machine for one import connection
// (docs/syncguard.md §3). Transport-independent: it consumes normalised
// source events ({key, uid, startDay, endDay, status, transparent,
// summaryKind}) — today from icsReader, tomorrow from an OTA API adapter.
//
// Release policy (exact):
//   STATUS:CANCELLED / TRANSP:TRANSPARENT for a known event in a validated
//     feed ............................................ released at once
//   plain disappearance while other future events of the feed remain
//     .................. released after ≥ 3 successful syncs over ≥ 2 h
//   the WHOLE set of live future events vanishes (any count: 1→0, 2→0,
//     30→0), or ≥ 50 % of ≥ 3 vanish at once ............ ANOMALY:
//     released after ≥ 4 successful syncs over ≥ 12 h, or when the host
//     explicitly confirms the cancellation
//   a failed, truncated, unreadable or over-limit fetch never counts; an
//   unreadable event counts as present; reappearance resets the count.
//   A stay that has already started is never released by disappearance
//   alone (some feeds drop a stay at check-in): it ends at checkout, by an
//   explicit CANCELLED, or by the host.
//
// Invariants:
//   * one Booking row per (connection, key) — unique index + E11000 = "lost a race";
//   * every row write is conditional on `external.rev`, so a worker whose
//     lease expired cannot overwrite newer state;
//   * a release first retires the row (conditional on its revision, so a
//     worker whose lease expired changes nothing) and only then frees its
//     nights: a crash in between leaves a block, never a hole, and the
//     daily full pass removes the leftover night rows;
//   * a live row's status is the feed's to decide: one changed elsewhere is
//     repaired (status_repaired);
//   * a replayed sync writes nothing.
const mongoose = require("mongoose");
const Booking = require("../../models/Booking");
const BookingNight = require("../../models/BookingNight");
const ExternalCalendar = require("../../models/ExternalCalendar");
const ledger = require("./ledger");
const echo = require("./echo");
const journal = require("./journal");
const attention = require("../attention");
const notify = require("./notify");
const { hasVerifiedBlockMarker } = require("./channels");
const { fingerprint, localDay, DEFAULT_TZ } = require("./icsReader");
const { isMajesticUid, nightsOf, dayDate, utcDayNumber, dayStr, DAY_MS } = require("./util");

const MISSING = { syncs: 3, ms: 2 * 3600_000 };
const MISSING_ANOMALY = { syncs: 4, ms: 12 * 3600_000 };
const MASS = { minRows: 3, share: 0.5 };
const LIVE = ["active", "missing", "orphaned"];

function rowDays(row) {
  return { startDay: dayStr(utcDayNumber(row.checkIn)), endDay: dayStr(utcDayNumber(row.checkOut)) };
}

async function updateRow(row, set, stats, unset) {
  const res = await Booking.updateOne(
    { _id: row._id, "external.rev": row.external.rev || 0 },
    { $set: { ...set, updatedAt: new Date() }, $inc: { "external.rev": 1 }, ...(unset ? { $unset: unset } : {}) },
  );
  if (!res.matchedCount) {
    stats.raced += 1;
    return false;
  }
  row.external.rev = (row.external.rev || 0) + 1;
  return true;
}

// Rows imported before SyncGuard have no connection. They are adopted by the
// property's only connection (or by UID when there are several) and their
// host attribution is repaired (defect D3).
async function adoptLegacy({ conn, listing, feedUids }) {
  const activeConnections = await ExternalCalendar.countDocuments({ propertyId: conn.propertyId, kind: "import", status: { $ne: "disconnected" } });
  const filter = { propertyId: conn.propertyId, source: "ical", "external.connectionId": { $exists: false } };
  if (activeConnections > 1) filter.sourceId = { $in: [...feedUids] };
  const legacy = await Booking.find(filter).sort({ status: 1, _id: 1 }).select("_id sourceId status createdAt").lean();
  let adopted = 0;
  for (const b of legacy) {
    const external = (key) => ({
      connectionId: conn._id,
      channel: conn.channel,
      key,
      uid: b.sourceId,
      state: b.status === "cancelled" || b.status === "rejected" ? "cancelled" : "active",
      kind: "unknown",
      fingerprint: null, // first sight takes the MODIFIED path, which re-asserts the nights
      firstSeenAt: b.createdAt || new Date(),
      lastChangedAt: new Date(),
      missingSyncs: 0,
      rev: 0,
    });
    const adopt = (key) => Booking.updateOne({ _id: b._id, "external.connectionId": { $exists: false } }, { $set: { userId: listing.host, hostId: listing.host, external: external(key) } });
    // A second legacy row with the same UID (old races) keeps blocking under
    // its own key; absent from the feed, it goes through the normal missing
    // → confirmation path instead of being dropped. Checked here (the unique
    // index may not exist yet — before the migration); the index error is
    // only the race backstop.
    const dupKey = `${b.sourceId}#legacy-${b._id}`;
    const taken = await Booking.exists({ "external.connectionId": conn._id, "external.key": b.sourceId, _id: { $ne: b._id } });
    let res;
    try {
      res = await adopt(taken ? dupKey : b.sourceId);
    } catch (err) {
      if (!(err && err.code === 11000)) throw err;
      res = await adopt(dupKey);
    }
    adopted += res.modifiedCount;
  }
  return adopted;
}

async function reconcile({ conn, listing, parsed, now = new Date(), mode = "incremental", propagation = true }) {
  const stats = { added: 0, modified: 0, unchanged: 0, revived: 0, cancelled: 0, missingNew: 0, missingPending: 0, removed: 0, reflected: 0, echoes: 0, promoted: 0, conflicts: 0, holdsDisplaced: 0, shared: 0, raced: 0, legacyAdopted: 0, repaired: 0, rekeyed: 0 };
  const transitions = [];
  const today = utcDayNumber(now);
  const pid = new mongoose.Types.ObjectId(String(conn.propertyId));
  const events = parsed.events;
  const unreadable = new Set(parsed.unreadableUids || []);
  const feedKeys = new Set(events.map((e) => e.key));
  const feedUids = new Set(events.map((e) => e.uid).filter(Boolean));

  stats.legacyAdopted = await adoptLegacy({ conn, listing, feedUids });

  const rows = await Booking.find({
    "external.connectionId": conn._id,
    $or: [{ "external.state": { $in: LIVE } }, { "external.key": { $in: [...feedKeys] } }],
  }).lean();
  const byKey = new Map(rows.map((r) => [r.external.key, r]));

  let coverage; // lazily computed (two or three indexed queries), only when needed
  const getCoverage = async () => {
    if (coverage === undefined) coverage = await echo.coverageFor({ connection: conn, now, propagation });
    return coverage;
  };
  const toReport = [];
  const verifiedMarker = hasVerifiedBlockMarker(conn.channel);
  const base = (e) => ({ propertyId: pid, connectionId: conn._id, channel: conn.channel, uid: e.uid || e.key, startDay: e.startDay, endDay: e.endDay });

  async function claim(row, e, possibleEcho) {
    const nights = nightsOf(e.startDay, e.endDay, { today });
    const res = await ledger.claimNights({ propertyId: pid, bookingId: row._id, nights, now });
    if (res.displacedHolds.length) {
      stats.holdsDisplaced += res.displacedHolds.length;
      transitions.push({ ...base(e), type: "hold_displaced", bookingId: row._id, details: { holds: res.displacedHolds.map((h) => h.bookingId) } });
    }
    stats.shared += res.shared.length;
    // Sharing nights with another CONNECTION's import is a cross-site
    // overlap (two rows of the same feed — a UID the provider re-issued, a
    // reservation plus a block — are one source talking about itself).
    //   genuine event            → reported (host e-mail, NEEDS_ATTENTION)
    //   possible echo            → recorded as a likely mirror: usually this
    //                              OTA copying the other site's booking out of
    //                              Majestic's feed, but a real double sale on
    //                              an OTA without reservation markers looks
    //                              exactly the same, so it is shown to the host
    //                              (no e-mail) instead of being dropped
    //   verified block marker    → the provider itself says "blocked, not a
    //                              reservation": a known mirror, not recorded
    const knownBlock = possibleEcho && verifiedMarker && e.summaryKind === "blocked";
    const externalOverlap = knownBlock ? [] : res.shared.filter((s) => s.kind === "import" && s.connectionId !== String(conn._id));
    const hit = res.paidConflicts.length ? res.paidConflicts : externalOverlap;
    if (hit.length) {
      const kind = res.paidConflicts.length ? "paid_booking" : "external_overlap";
      // Never suppressed: a possible echo overlapping a paid booking is a
      // conflict too. Only its *alert* is skipped when the provider's
      // verified block marker says the OTA has merely blocked the nights.
      const likelyMirror = kind === "paid_booking" ? knownBlock : possibleEcho;
      const nightsList = [...new Set(hit.flatMap((c) => c.nights))].sort();
      const withIds = hit.map((c) => new mongoose.Types.ObjectId(c.bookingId));
      const prev = row.external.conflict;
      // New = another kind, or nights / bookings it did not have before.
      // Nights of a stay in progress drop off one a day: that is not new.
      const had = (list) => new Set((list || []).map(String));
      const prevNights = had(prev && prev.nights);
      const prevWith = had(prev && prev.withBookingIds);
      const changed = !(prev && prev.kind === kind && !!prev.likelyMirror === likelyMirror && nightsList.every((n) => prevNights.has(n)) && withIds.every((id) => prevWith.has(String(id))));
      if (changed) {
        const conflict = { at: now, kind, withBookingIds: withIds, nights: nightsList, likelyMirror, notifiedAt: null, adminFlaggedAt: null, adminFlaggedFor: [] };
        await updateRow(row, { "external.conflict": conflict }, stats);
        row.external.conflict = conflict;
        stats.conflicts += 1;
        transitions.push({ ...base(e), type: "conflict", bookingId: row._id, details: { kind, likelyMirror, with: withIds.map(String), nights: nightsList, possibleEcho } });
      }
      // Reported when the conflict is new or changed (the admin queue is
      // re-armed once an item is resolved, so an unchanged conflict seen
      // again by the daily full pass must not re-alert), or while the host
      // e-mail is still owed.
      const cur = row.external.conflict || {};
      const flagOwed = kind === "paid_booking" && !cur.adminFlaggedAt;
      const owed = changed || !cur.notifiedAt || flagOwed;
      // only the paid bookings not yet in the admin queue for this conflict
      const queued = had(cur.adminFlaggedFor);
      const toFlag = changed ? res.paidConflicts : flagOwed ? res.paidConflicts.filter((c) => !queued.has(String(c.bookingId))) : [];
      // every booking still in conflict is queued (the others were cancelled
      // meanwhile): nothing is owed any more
      if (!changed && flagOwed && !toFlag.length && res.paidConflicts.length) {
        await Booking.updateOne({ _id: row._id, "external.conflict.at": { $ne: null } }, { $set: { "external.conflict.adminFlaggedAt": now } });
        row.external.conflict = { ...cur, adminFlaggedAt: now };
      }
      if (kind === "paid_booking" && !likelyMirror && owed) toReport.push({ row, kind, conflicts: toFlag, nights: nightsList, possibleEcho });
      // Two OTAs reporting the same nights (this event not a possible echo):
      // one of them may have sold them twice. Majestic cannot know which; the
      // host is told once. Inventory is already protected (both rows block).
      if (kind === "external_overlap" && !likelyMirror && owed) toReport.push({ row, kind, conflicts: [], overlaps: hit, nights: nightsList, possibleEcho: false });
    } else if (row.external.conflict && row.external.conflict.at) {
      await updateRow(row, { "external.conflict": null }, stats);
      row.external.conflict = null;
      transitions.push({ ...base(e), type: "conflict_cleared", bookingId: row._id });
    }
  }

  async function release(row, reason, state) {
    // Row first, conditional on its revision: a worker whose lease expired
    // (the row has moved on) frees nothing. A crash before the nights are
    // freed leaves a block, never a hole; the full pass removes it.
    const ok = await updateRow(row, { status: "cancelled", "external.state": state, "external.releasedAt": now, "external.releaseReason": reason, "external.missingSince": null }, stats);
    if (!ok) return false;
    await ledger.releaseAll(row._id);
    transitions.push({ ...base({ uid: row.external.uid, key: row.external.key, ...rowDays(row) }), type: state, bookingId: row._id, details: { reason } });
    return true;
  }

  // A provider that re-issues an event's UID (the same dates under a new
  // key, the old key gone from this very feed) is still the same booking:
  // the row is re-keyed instead of a new one being created — a feed doing
  // this on every fetch would otherwise add a row per event per sync and
  // keep the old ones "missing" (and the calendar in anomaly) for ever.
  const twins = new Map(); // "startDay|endDay" → live rows absent from this feed
  for (const r of rows) {
    if (!LIVE.includes(r.external.state) || feedKeys.has(r.external.key)) continue;
    const d = rowDays(r);
    const k = `${d.startDay}|${d.endDay}`;
    if (!twins.has(k)) twins.set(k, []);
    twins.get(k).push(r);
  }

  // --- events present in the feed -----------------------------------------------
  for (const e of events) {
    let row = byKey.get(e.key);
    if (isMajesticUid(e.uid)) {
      stats.reflected += 1; // provably our own event coming back
      if (row && LIVE.includes(row.external.state)) await release(row, "reflected_majestic_uid", "cancelled");
      continue;
    }
    // TRANSP:TRANSPARENT ("free time") releases for an OTA, as RFC 5545
    // means. A generic calendar is connected precisely to block dates, and
    // some apps mark all-day entries "free" by default — so there it blocks.
    if (e.status === "cancelled" || (e.transparent && conn.channel !== "GENERIC_ICAL")) {
      if (row && LIVE.includes(row.external.state) && (await release(row, e.transparent ? "transparent" : "cancelled_by_source", "cancelled"))) stats.cancelled += 1;
      continue;
    }
    const fp = fingerprint(e);
    const nightsDates = nightsOf(e.startDay, e.endDay, { today });

    if (!row) {
      const twin = (twins.get(`${e.startDay}|${e.endDay}`) || []).shift();
      if (twin && (await updateRow(twin, { sourceId: e.uid || e.key, "external.key": e.key, "external.uid": e.uid || e.key, "external.state": "active", "external.missingSince": null, "external.missingSyncs": 0, "external.missingMass": false }, stats))) {
        transitions.push({ ...base(e), type: "rekeyed", bookingId: twin._id, details: { from: twin.external.key } });
        Object.assign(twin.external, { key: e.key, uid: e.uid || e.key, state: "active", missingSince: null, missingSyncs: 0, missingMass: false });
        byKey.set(e.key, twin);
        row = twin;
        stats.rekeyed += 1;
      }
    }
    if (!row) {
      const cls = echo.classify(e, conn.channel, await getCoverage(), today);
      const doc = {
        _id: new mongoose.Types.ObjectId(),
        userId: listing.host,
        hostId: listing.host,
        propertyId: pid,
        source: "ical",
        sourceId: e.uid || e.key,
        action: "user",
        checkIn: dayDate(e.startDay),
        checkOut: dayDate(e.endDay),
        nights: nightsDates.length,
        price: 0,
        subTotal: 0,
        currency: "INR",
        status: "confirmed",
        paymentStatus: "paid",
        guests: 0,
        external: {
          connectionId: conn._id,
          channel: conn.channel,
          key: e.key,
          uid: e.uid || e.key,
          state: "active",
          kind: e.summaryKind,
          fingerprint: fp,
          firstSeenAt: now,
          lastChangedAt: now,
          missingSyncs: 0,
          echo: cls.possible ? { suspect: true, since: now, uncoveredSince: null } : undefined,
          rev: 0,
        },
      };
      try {
        await Booking.create(doc);
      } catch (err) {
        if (err && err.code === 11000) {
          stats.raced += 1; // another worker inserted it; the next sync converges
          continue;
        }
        throw err;
      }
      stats.added += 1;
      if (cls.possible) stats.echoes += 1;
      transitions.push({ ...base(e), type: cls.possible ? "added_possible_echo" : "added", bookingId: doc._id, details: { kind: e.summaryKind } });
      await claim(doc, e, cls.possible);
      continue;
    }

    const wasReleased = !LIVE.includes(row.external.state);
    if (!wasReleased && row.external.fingerprint === fp) {
      const set = {};
      if (row.external.state !== "active") Object.assign(set, { "external.state": "active", "external.missingSince": null, "external.missingSyncs": 0, "external.missingMass": false });
      if (row.external.hostHold) set["external.hostHold"] = false; // the feed shows it again: the feed decides
      // Live in the feed but not blocking (changed outside SyncGuard: an old
      // client, a manual database edit): the feed decides, so it blocks again.
      const repairStatus = row.status !== "confirmed";
      if (repairStatus) set.status = "confirmed";
      const isEcho = !!(row.external.echo && row.external.echo.suspect);
      if (isEcho) {
        const r = echo.review(row, e, await getCoverage(), today, now);
        if (r.set) Object.assign(set, r.set);
        if (r.promote) {
          Object.assign(set, { "external.echo.suspect": false, "external.echo.promotedAt": now, "external.echo.uncoveredSince": null });
          stats.promoted += 1;
          transitions.push({ ...base(e), type: "echo_promoted", bookingId: row._id });
        }
      }
      let written = true;
      if (Object.keys(set).length) {
        if (set["external.state"] === "active") transitions.push({ ...base(e), type: "reappeared", bookingId: row._id });
        written = await updateRow(row, set, stats);
        if (written && repairStatus) transitions.push({ ...base(e), type: "status_repaired", bookingId: row._id, details: { from: row.status } });
      } else stats.unchanged += 1;
      // a conflict still owed to the admin queue is re-checked on every poll
      const c0 = row.external.conflict;
      const flagOwed = !!(c0 && c0.at && c0.kind === "paid_booking" && !c0.likelyMirror && !c0.adminFlaggedAt);
      if (mode === "full" || (repairStatus && written) || flagOwed) {
        const before = await countOwned(row._id, nightsDates);
        await claim(row, e, isEcho && !set["external.echo.promotedAt"]);
        const after = await countOwned(row._id, nightsDates);
        if (after > before) stats.repaired += after - before;
      }
      continue;
    }

    // MODIFIED (new dates/status) or REVIVED (it was released and is back).
    const cls = echo.classify(e, conn.channel, await getCoverage(), today);
    const prev = rowDays(row);
    const ok = await updateRow(
      row,
      {
        status: "confirmed",
        checkIn: dayDate(e.startDay),
        checkOut: dayDate(e.endDay),
        nights: nightsDates.length,
        "external.state": "active",
        "external.kind": e.summaryKind,
        "external.fingerprint": fp,
        "external.lastChangedAt": now,
        "external.missingSince": null,
        "external.missingSyncs": 0,
        "external.missingMass": false,
        "external.releasedAt": null,
        "external.releaseReason": null,
        "external.echo": cls.possible ? { suspect: true, since: now, uncoveredSince: null } : null,
      },
      stats,
    );
    if (!ok) continue;
    if (wasReleased) stats.revived += 1;
    else stats.modified += 1;
    if (cls.possible) stats.echoes += 1;
    transitions.push({ ...base(e), type: wasReleased ? "revived" : "modified", bookingId: row._id, details: { from: prev } });
    // Old nights outside the new range go first: no ghost night is left.
    await ledger.releaseOutside(row._id, nightsDates);
    await claim(row, e, cls.possible);
  }

  // --- live rows absent from the feed -------------------------------------------------
  const live = rows.filter((r) => LIVE.includes(r.external.state) && utcDayNumber(r.checkOut) > today);
  // A stay that has started is not a future event: its disappearance never
  // releases it on its own and never counts towards an anomaly. "Started"
  // is judged on the property's own calendar (India is ahead of UTC: just
  // after midnight there, a check-in-day stay has started already).
  const localToday = Math.max(today, localDay(now.getTime(), DEFAULT_TZ));
  const started = (r) => utcDayNumber(r.checkIn) <= localToday;
  const absent = live.filter((r) => !feedKeys.has(r.external.key) && !unreadable.has(r.external.uid) && !unreadable.has(r.external.key));
  // A possible echo whose nights are still covered — by what Majestic sends
  // this OTA or by another channel's live import — protects nothing on its
  // own: when it vanishes (the OTA dropped its mirror) it follows the normal
  // rule and does not count towards an anomaly. An uncovered one may be a
  // real booking and is treated like any other event.
  const lowRisk = new Set();
  const isEchoRow = (r) => !!(r.external.echo && r.external.echo.suspect);
  if (live.some(isEchoRow)) {
    const cov = await getCoverage();
    for (const r of live) if (isEchoRow(r) && cov && echo.covered(rowDays(r), [cov.current, cov.others], today)) lowRisk.add(String(r._id));
  }
  const protective = live.filter((r) => !lowRisk.has(String(r._id)) && !started(r));
  const absentProtective = absent.filter((r) => !lowRisk.has(String(r._id)) && !started(r));
  const wholeSetVanished = protective.length >= 1 && absentProtective.length === protective.length;
  const mass = wholeSetVanished || (protective.length >= MASS.minRows && absentProtective.length / protective.length >= MASS.share);
  for (const row of absent) {
    const rowMass = mass && !lowRisk.has(String(row._id)) && !started(row);
    if (row.external.state === "active") {
      if (await updateRow(row, { "external.state": "missing", "external.missingSince": now, "external.missingSyncs": 1, "external.missingMass": rowMass }, stats)) {
        stats.missingNew += 1;
        transitions.push({ ...base({ uid: row.external.uid, key: row.external.key, ...rowDays(row) }), type: "missing", bookingId: row._id, details: { anomaly: rowMass } });
      }
      continue;
    }
    const syncs = (row.external.missingSyncs || 0) + 1;
    // Judged once, at the moment of disappearance (above); later releases
    // of *other* rows do not change how this disappearance is treated.
    const anomaly = !!row.external.missingMass;
    const need = anomaly ? MISSING_ANOMALY : MISSING;
    if (row.external.hostHold) {
      // from a link replaced without the host saying so: only the host releases it
      await updateRow(row, { "external.missingSyncs": syncs }, stats);
      stats.missingPending += 1;
      continue;
    }
    const since = row.external.missingSince ? new Date(row.external.missingSince).getTime() : now.getTime();
    if (syncs >= need.syncs && now.getTime() - since >= need.ms && !started(row)) {
      if (await release(row, anomaly ? "missing_confirmed_after_anomaly" : "missing_confirmed", "removed")) stats.removed += 1;
    } else {
      await updateRow(row, { "external.missingSyncs": syncs }, stats);
      stats.missingPending += 1;
    }
  }

  // Full reconciliation also clears night rows left by released rows.
  if (mode === "full") {
    const released = await Booking.find({ "external.connectionId": conn._id, "external.state": { $nin: LIVE } }).select("_id").lean();
    if (released.length) await BookingNight.deleteMany({ bookingId: { $in: released.map((r) => r._id) } });
  }

  // owed admin flags of stays not over yet (a past stay cannot be re-checked)
  const owedFilter = { "external.connectionId": conn._id, "external.state": { $in: LIVE }, checkOut: { $gt: new Date(today * DAY_MS) }, "external.conflict.kind": "paid_booking", "external.conflict.likelyMirror": { $ne: true }, "external.conflict.adminFlaggedAt": null };
  const [pendingMissing, pendingEchoes, anomalyRow, pendingFlags] = await Promise.all([
    Booking.countDocuments({ "external.connectionId": conn._id, "external.state": "missing", checkOut: { $gt: new Date(today * DAY_MS) } }),
    // possible echoes still under review (a past stay leaves the feed and can never be reviewed again)
    Booking.countDocuments({ "external.connectionId": conn._id, "external.state": { $in: LIVE }, "external.echo.suspect": true, checkOut: { $gt: new Date(today * DAY_MS) } }),
    Booking.exists({ "external.connectionId": conn._id, "external.state": "missing", "external.missingMass": true }),
    Booking.countDocuments(owedFilter),
  ]);

  await journal.record(transitions);
  for (const t of transitions) journal.log(`event_${t.type}`, { connectionId: String(conn._id), propertyId: String(pid), channel: conn.channel, bookingId: t.bookingId && String(t.bookingId), startDay: t.startDay, endDay: t.endDay });

  // Surface real double bookings: admin attention on the Majestic booking
  // (exactly once — services/attention.js) and the host, once per import row.
  for (const c of toReport) await reportConflict({ conn, listing, ...c, now });

  // counted after reporting: what is still owed makes the next poll reconcile
  const stillOwed = toReport.length ? await Booking.countDocuments(owedFilter) : pendingFlags;
  return { stats, pendingMissing, pendingEchoes, pendingFlags: stillOwed, anomaly: anomalyRow ? "MASS_DISAPPEARANCE" : null };
}

async function countOwned(bookingId, nights) {
  if (!nights.length) return 0;
  return BookingNight.countDocuments({ bookingId, date: { $in: nights } });
}

async function reportConflict({ conn, listing, row, kind, conflicts, overlaps, nights, possibleEcho, now }) {
  // The admin queue item must actually land: a booking already carrying
  // another open item cannot be claimed now, and a failure must be retried.
  // Each booking that landed is recorded (adminFlaggedFor) and never flagged
  // again for this conflict; adminFlaggedAt once all of them have.
  const landedIds = [];
  for (const c of conflicts) {
    try {
      const r = await attention.flag(c.bookingId, "ota_conflict", { connectionId: String(conn._id), channel: conn.channel, importBookingId: String(row._id), nights: c.nights, possibleEcho: !!possibleEcho });
      let landed = !!(r && r.flagged);
      if (!landed) {
        const b = await Booking.findById(c.bookingId).select("needsAttention attentionDetails").lean();
        landed = !!(b && b.needsAttention === "ota_conflict" && b.attentionDetails && b.attentionDetails.importBookingId === String(row._id));
      }
      if (landed) landedIds.push(new mongoose.Types.ObjectId(String(c.bookingId)));
    } catch (err) {
      console.error("[syncguard] attention flag failed", err.message);
    }
  }
  if (landedIds.length) {
    const all = landedIds.length === conflicts.length;
    await Booking.updateOne(
      { _id: row._id, "external.conflict.at": { $ne: null } },
      { $addToSet: { "external.conflict.adminFlaggedFor": { $each: landedIds } }, ...(all ? { $set: { "external.conflict.adminFlaggedAt": now } } : {}) },
    );
  }
  const claimed = await Booking.updateOne({ _id: row._id, "external.conflict.at": { $ne: null }, "external.conflict.notifiedAt": null }, { $set: { "external.conflict.notifiedAt": now } });
  if (claimed.modifiedCount) {
    let send;
    if (kind === "external_overlap") {
      const others = await Booking.find({ _id: { $in: (overlaps || []).map((o) => o.bookingId) } }).select("external.channel").lean();
      send = notify.overlap({ listing, channel: conn.channel, otherChannels: [...new Set(others.map((o) => o.external && o.external.channel).filter(Boolean))], nights });
    } else send = notify.conflict({ listing, channel: conn.channel, nights, possible: !!possibleEcho });
    await send.catch((err) => {
      console.error("[syncguard] host conflict e-mail failed", err.message);
      return Booking.updateOne({ _id: row._id }, { $set: { "external.conflict.notifiedAt": null } });
    });
  }
}

// Host-confirmed release of rows Majestic can no longer verify itself
// (missing rows of a live connection, orphaned rows of a disconnected one).
async function hostRelease({ connectionId, states, reason, now = new Date() }) {
  const rows = await Booking.find({ "external.connectionId": connectionId, "external.state": { $in: states } }).select("_id external checkIn checkOut propertyId").lean();
  let released = 0;
  for (const r of rows) {
    // Row first (still in one of the given states), then its nights: a row
    // that a sync has meanwhile seen again keeps them.
    const res = await Booking.updateOne(
      { _id: r._id, "external.state": { $in: states } },
      { $set: { status: "cancelled", "external.state": "released", "external.releasedAt": now, "external.releaseReason": reason, "external.missingSince": null, updatedAt: now }, $inc: { "external.rev": 1 } },
    );
    if (!res.modifiedCount) continue;
    await ledger.releaseAll(r._id);
    released += 1;
  }
  return { released, rows };
}

module.exports = { reconcile, hostRelease, adoptLegacy, MISSING, MISSING_ANOMALY, MASS, LIVE };

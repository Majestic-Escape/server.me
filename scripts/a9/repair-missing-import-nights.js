// PROPOSAL, separate from the code fix; needs its own approval before any run
// outside a test database.
//
// Gives live imported bookings the future nights the ledger shows free (case A9),
// in two steps so a person reviews exactly what will be written:
//
//   1. dry run: writes the plan, changes nothing
//      node repair-missing-import-nights.js --root <server.me> --uri <mongodb uri> --plan-out plan.json
//   2. apply the reviewed plan, and nothing else
//      node repair-missing-import-nights.js --root <server.me> --uri <mongodb uri> --apply --plan plan.json
//
// Apply re-checks every planned night at the moment of writing:
//   - the import is still live and still covers the night, else skipped;
//   - no row → a row for the import (a duplicate means someone took it meanwhile → skipped);
//   - the SAME expired hold row the dry run saw, whose booking is still UNPAID → the row
//     changes owner IN PLACE (one conditional update; never delete + insert, so the night is
//     never without a row and no other writer can take it); if the booking has been PAID
//     since (its row can still carry the expiry: the window between "paid" and "permanent")
//     → skipped, never reclaimed; if the payment lands between that check and the move, the
//     row is moved back in place as permanent (or re-created, if the import released it in
//     that interval and the night is still free) and the night is reported;
//   - a LIVE hold (e.g. a checkout started after the dry run) → skipped, never displaced;
//   - any other owner → skipped.
//   - after every write the import is read again: if a sync cancelled, shortened or moved it in the
//     meantime, its row is released the normal way (handed to another covering import, or freed) and
//     the night is reported as import_changed_after_write, never as claimed.
// Exit code 4 when anything was skipped or restored, so such a run is never mistaken for a clean one.
const fs = require("fs");
const path = require("path");

function load(root) {
  return {
    mongoose: require(path.join(root, "node_modules", "mongoose")),
    Booking: require(path.join(root, "models/Booking")),
    BookingNight: require(path.join(root, "models/BookingNight")),
    inv: require(path.join(root, "services/inventory")),
  };
}
const LIVE_IMPORT = { source: { $in: ["ical", "ical_parked"] }, status: { $nin: ["cancelled", "rejected"] } };
const day = (d) => new Date(d).toISOString().slice(0, 10);
const paidAndLive = (b) => !!b && b.paymentStatus === "paid" && !["cancelled", "rejected"].includes(b.status);

async function plan({ Booking, BookingNight, inv }, now) {
  const today = inv.utcDay(now);
  // Lowest id first, and one item per listing night: when several imports cover a night the plan gives it to
  // the one inventory.releaseNights would pick. (A plan with one item per import made apply report the second
  // import of a night as "skipped, other owner" and exit 4 on a clean repair; found on staging, 2026-11-28.)
  const imports = await Booking.find({ ...LIVE_IMPORT, checkOut: { $gt: today } }).select("_id propertyId checkIn checkOut").sort({ _id: 1 }).lean();
  const items = [];
  const planned = new Set();
  for (const b of imports) {
    const nights = inv.nightsBetween(new Date(Math.max(inv.utcDay(b.checkIn).getTime(), today.getTime())), b.checkOut);
    if (!nights.length) continue;
    const rows = await BookingNight.find({ propertyId: b.propertyId, date: { $in: nights } }).lean();
    const byDay = new Map(rows.map((r) => [r.date.getTime(), r]));
    for (const n of nights) {
      const key = `${b.propertyId}|${n.getTime()}`;
      if (planned.has(key)) continue;
      const r = byDay.get(n.getTime());
      if (!r || (r.expiresAt && r.expiresAt <= now)) planned.add(key);
      if (!r) { items.push({ importId: String(b._id), propertyId: String(b.propertyId), night: day(n), state: "no_row" }); continue; }
      if (!(r.expiresAt && r.expiresAt <= now)) continue; // owned by someone live
      if (paidAndLive(await Booking.findById(r.bookingId).select("paymentStatus status").lean())) continue; // a paid stay, not a hold
      items.push({ importId: String(b._id), propertyId: String(b.propertyId), night: day(n), state: "expired_hold_row", rowId: String(r._id), rowOwner: String(r.bookingId), rowExpiresAt: r.expiresAt.toISOString() });
    }
  }
  return { createdAt: now.toISOString(), liveImports: imports.length, items };
}

// Write, then validate the import. A sync can cancel, shorten or move the import after apply read it and
// before (or just after) the row is written; the importer marks the change first and releases second, so its
// release can run before this write and miss the row. Re-read the import: if it no longer covers the night,
// release its rows the normal way (inventory.releaseNights: handed to another live import that covers the
// night, or freed). Returns null when the import still covers it, else the night's owner afterwards.
async function settleImport({ Booking, BookingNight, inv }, importId, propertyId, date) {
  const t = date.getTime();
  const now = await Booking.findById(importId).select("status checkIn checkOut").lean();
  const live = !!now && !["cancelled", "rejected"].includes(now.status);
  if (live && inv.utcDay(now.checkIn).getTime() <= t && t < inv.utcDay(now.checkOut).getTime()) return null;
  await inv.releaseNights(importId, live ? { keep: inv.nightsBetween(now.checkIn, now.checkOut) } : {});
  const row = await BookingNight.findOne({ propertyId, date }).lean();
  return { importStatus: now ? now.status : "deleted", nightOwner: row ? String(row.bookingId) : null };
}

async function applyPlan({ Booking, BookingNight, inv }, p, now) {
  const results = [];
  for (const it of p.items) {
    const date = new Date(`${it.night}T00:00:00Z`);
    const out = (outcome, extra = {}) => results.push({ ...it, outcome, ...extra });
    const imp = await Booking.findOne({ _id: it.importId, ...LIVE_IMPORT }).select("checkIn checkOut").lean();
    if (!imp || !(inv.utcDay(imp.checkIn).getTime() <= date.getTime() && date.getTime() < inv.utcDay(imp.checkOut).getTime())) { out("skipped_import_changed"); continue; }
    const row = await BookingNight.findOne({ propertyId: it.propertyId, date }).lean();
    if (row && String(row.bookingId) === it.importId) { out("already_owned"); continue; }
    if (row && row.expiresAt && row.expiresAt > now) { out("skipped_live_hold", { holdOwner: String(row.bookingId), holdExpiresAt: row.expiresAt.toISOString() }); continue; }
    if (!row) {
      // The night has no row: insert one for the import (the unique index refuses a second owner).
      try {
        await BookingNight.create({ propertyId: it.propertyId, date, bookingId: it.importId, kind: "ical", expiresAt: null });
        const changed = await settleImport({ Booking, BookingNight, inv }, it.importId, it.propertyId, date);
        out(changed ? "import_changed_after_write" : "claimed", changed || {});
      } catch (err) {
        if (!inv.isDuplicateKeyError(err)) throw err;
        const now2 = await BookingNight.findOne({ propertyId: it.propertyId, date }).lean();
        out(now2 && now2.expiresAt && now2.expiresAt > now ? "skipped_live_hold" : "skipped_changed_owner", { owner: now2 ? String(now2.bookingId) : null });
      }
      continue;
    }
    const planned = it.state === "expired_hold_row" && String(row._id) === it.rowId && row.expiresAt && row.expiresAt <= now;
    if (!planned) { out("skipped_changed_owner", { owner: String(row.bookingId) }); continue; }
    if (paidAndLive(await Booking.findById(row.bookingId).select("paymentStatus status").lean())) { out("skipped_paid_owner", { owner: String(row.bookingId) }); continue; }
    // The row changes owner in place (never delete + insert): the night is never without a row,
    // so search never shows it free and no other writer can take it in between.
    const moved = await BookingNight.updateOne(
      { _id: row._id, bookingId: row.bookingId, expiresAt: { $ne: null, $lte: now } },
      { $set: { bookingId: it.importId, kind: "ical", expiresAt: null } },
    );
    if (!moved.modifiedCount) { out("skipped_changed_owner"); continue; }
    // Write, then validate: a payment that landed between the check and the move gets its row back,
    // in place, PERMANENT (a paid booking's nights carry no expiry: what the payment's finalizeNights
    // would have done had it found the row; with the old expiry, search would offer the night).
    if (paidAndLive(await Booking.findById(row.bookingId).select("paymentStatus status").lean())) {
      const paid = { owner: String(row.bookingId) };
      const back = await BookingNight.updateOne(
        { _id: row._id, bookingId: it.importId },
        { $set: { bookingId: row.bookingId, kind: row.kind || "booking", expiresAt: null } },
      );
      if (back.modifiedCount) { out("restored_paid_owner", paid); continue; }
      // The import released the row meanwhile (cancelled, moved, disconnected): the night is the
      // paid booking's again if nobody else took it; the unique index decides.
      try {
        await BookingNight.create({ propertyId: it.propertyId, date, bookingId: row.bookingId, kind: row.kind || "booking", expiresAt: null });
        out("restored_paid_owner", { ...paid, reinserted: true });
      } catch (err) {
        if (!inv.isDuplicateKeyError(err)) throw err;
        const now2 = await BookingNight.findOne({ propertyId: it.propertyId, date }).lean();
        out("paid_owner_lost_night_needs_review", { ...paid, nightOwner: now2 ? String(now2.bookingId) : null });
      }
      continue;
    }
    const changed = await settleImport({ Booking, BookingNight, inv }, it.importId, it.propertyId, date);
    out(changed ? "import_changed_after_write" : "claimed", changed || {});
  }
  return results;
}

async function main() {
  const args = process.argv.slice(2);
  const opt = (n) => (args.includes(`--${n}`) ? args[args.indexOf(`--${n}`) + 1] : undefined);
  const root = opt("root");
  const uri = opt("uri");
  const apply = args.includes("--apply");
  const planIn = opt("plan");
  const planOut = opt("plan-out");
  if (!root || !uri || (apply ? !planIn : !planOut)) {
    console.error("dry run: --root <server.me> --uri <uri> --plan-out plan.json\napply:   --root <server.me> --uri <uri> --apply --plan plan.json");
    process.exit(2);
  }
  const deps = load(root);
  await deps.mongoose.connect(uri);
  const now = new Date();
  if (!apply) {
    const p = await plan(deps, now);
    fs.writeFileSync(planOut, JSON.stringify(p, null, 1));
    console.log(`dry run: ${p.items.length} night(s) to give back to ${new Set(p.items.map((i) => i.importId)).size} import(s); plan written to ${planOut}; nothing changed`);
  } else {
    const p = JSON.parse(fs.readFileSync(planIn, "utf8"));
    const results = await applyPlan(deps, p, now);
    const count = (o) => results.filter((r) => r.outcome === o).length;
    const flagged = results.filter((r) => r.outcome !== "claimed" && r.outcome !== "already_owned").length;
    console.log(JSON.stringify({ mode: "apply", planned: p.items.length, claimed: count("claimed"), alreadyOwned: count("already_owned"), skippedLiveHold: count("skipped_live_hold"), skippedPaidOwner: count("skipped_paid_owner"), restoredPaidOwner: count("restored_paid_owner"), skippedChangedOwner: count("skipped_changed_owner"), skippedImportChanged: count("skipped_import_changed"), importChangedAfterWrite: count("import_changed_after_write"), needsReview: count("paid_owner_lost_night_needs_review"), results }, null, 1));
    process.exitCode = flagged ? 4 : 0;
  }
  await deps.mongoose.disconnect();
}

if (require.main === module) main().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
module.exports = { load, plan, applyPlan };

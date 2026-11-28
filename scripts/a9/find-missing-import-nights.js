// READ-ONLY. Lists future nights that a live imported (iCal) booking covers but
// that the night ledger shows as free: no BookingNight row, or only a row of an
// unpaid hold that has already expired (search treats both as free; checkout
// refuses them through inventory.importedOverlap). This is case A9.
//
//   node find-missing-import-nights.js --uri "<mongodb uri incl. database>" [--json]
//
// Only find/aggregate reads are issued. Run it with a read-only database user.
// Uses the `mongodb` driver (any v5/v6), e.g. from server.me's node_modules:
//   NODE_PATH=<server.me>/node_modules node find-missing-import-nights.js --uri ...
const { MongoClient } = require("mongodb");

const args = process.argv.slice(2);
const opt = (n) => (args.includes(`--${n}`) ? args[args.indexOf(`--${n}`) + 1] : undefined);
const uri = opt("uri");
if (!uri) { console.error("usage: --uri <mongodb uri including the database name> [--json]"); process.exit(2); }

const DAY = 86_400_000;
const utcDay = (d) => { const x = new Date(d); return Date.UTC(x.getUTCFullYear(), x.getUTCMonth(), x.getUTCDate()); };

(async () => {
  const client = await MongoClient.connect(uri, { readPreference: "secondaryPreferred" });
  const db = client.db();
  const now = new Date();
  const today = utcDay(now);
  // same set inventory.importedOverlap treats as blocking
  const imports = await db.collection("bookings").find(
    { source: { $in: ["ical", "ical_parked"] }, status: { $nin: ["cancelled", "rejected"] }, checkOut: { $gt: new Date(today) } },
    { projection: { propertyId: 1, checkIn: 1, checkOut: 1, source: 1, "external.connectionId": 1, "external.channel": 1 } },
  ).toArray();
  const findings = [];
  for (const b of imports) {
    const nights = [];
    for (let t = Math.max(utcDay(b.checkIn), today); t < utcDay(b.checkOut); t += DAY) nights.push(new Date(t));
    if (!nights.length) continue;
    const rows = await db.collection("bookingnights").find({ propertyId: b.propertyId, date: { $in: nights } }, { projection: { date: 1, bookingId: 1, expiresAt: 1 } }).toArray();
    const byDay = new Map(rows.map((r) => [r.date.getTime(), r]));
    for (const n of nights) {
      const r = byDay.get(n.getTime());
      const state = !r ? "no_row" : r.expiresAt && r.expiresAt <= now ? "expired_hold_row" : null;
      if (!state) continue;
      // An expired hold of a booking that is already paid is a stay, not free (the reserve path keeps it).
      if (state === "expired_hold_row") {
        const owner = await db.collection("bookings").findOne({ _id: r.bookingId }, { projection: { paymentStatus: 1, status: 1 } });
        if (owner && owner.paymentStatus === "paid" && !["cancelled", "rejected"].includes(owner.status)) continue;
      }
      findings.push({ propertyId: String(b.propertyId), importId: String(b._id), connectionId: b.external?.connectionId ? String(b.external.connectionId) : null, source: b.source, night: n.toISOString().slice(0, 10), state, rowOwner: r ? String(r.bookingId) : null });
    }
  }
  await client.close();
  if (args.includes("--json")) { console.log(JSON.stringify(findings, null, 1)); return; }
  const listings = new Set(findings.map((f) => f.propertyId));
  console.log(`checked ${imports.length} live imported bookings; nights shown free but covered by an import: ${findings.length} (listings: ${listings.size})`);
  for (const f of findings) console.log(`  ${f.night}  listing ${f.propertyId}  import ${f.importId}  ${f.state}${f.rowOwner ? ` (row owner ${f.rowOwner})` : ""}`);
})().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });

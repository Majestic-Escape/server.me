// SyncGuard release gate: hotel-night semantics. A calendar night is a
// calendar date, never the side effect of a time-zone conversion. Expected
// values are worked out by hand in each case (property zone: Asia/Kolkata).
// Noon rule for timed values: a start before 12:00 IST also blocks the
// previous night (its guest is still in); an end after 12:00 IST also
// blocks that day's night (the next guest may be checking in).
const { test, before, after } = require("node:test");
const assert = require("node:assert");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const S = require("./syncguard-helpers");
const H = require("./setup");

const ota = new S.FakeOta();
const record = S.evidence("dates");
let ics;
let engine;
let Booking;

before(async () => {
  await H.start();
  await ota.start();
  ics = require("../../services/calendarSync/icsReader");
  engine = require("../../services/calendarSync/engine");
  Booking = require("../../models/Booking");
});
after(async () => {
  await ota.stop();
  await H.stop();
});

const NOW = new Date("2026-10-03T06:00:00Z");
const cal = (...vevents) => ["BEGIN:VCALENDAR", "VERSION:2.0", ...vevents.flatMap((v) => ["BEGIN:VEVENT", ...v, "END:VEVENT"]), "END:VCALENDAR"].join("\r\n");
const nightsOf = (r) => r.events.filter((e) => e.status !== "cancelled" && !e.transparent).map((e) => `${e.uid}:${e.startDay}..${e.endDay}`).sort();

// [case, VEVENT lines, expected "uid:start..end" (end exclusive)]
const CASES = [
  ["VALUE=DATE, exclusive DTEND", ["UID:d1", "DTSTART;VALUE=DATE:20261010", "DTEND;VALUE=DATE:20261012"], "d1:2026-10-10..2026-10-12"],
  ["VALUE=DATE without DTEND = one night", ["UID:d2", "DTSTART;VALUE=DATE:20261010"], "d2:2026-10-10..2026-10-11"],
  ["UTC date-time late evening: 01:30 IST Oct 11 is still the night of Oct 10; 10:30 IST Oct 12 is before noon", ["UID:d3", "DTSTART:20261010T200000Z", "DTEND:20261012T050000Z"], "d3:2026-10-10..2026-10-12"],
  ["UTC date-time, IST same day", ["UID:d4", "DTSTART:20261010T090000Z", "DTEND:20261012T053000Z"], "d4:2026-10-10..2026-10-12"],
  ["floating date-time (no Z, no TZID) = property-local", ["UID:d5", "DTSTART:20261010T140000", "DTEND:20261012T110000"], "d5:2026-10-10..2026-10-12"],
  ["TZID Asia/Kolkata", ["UID:d6", "DTSTART;TZID=Asia/Kolkata:20261010T140000", "DTEND;TZID=Asia/Kolkata:20261012T110000"], "d6:2026-10-10..2026-10-12"],
  ["TZID UTC: 00:30 IST Oct 11 → night of Oct 10; 09:30 IST Oct 12 → before noon", ["UID:d7", "DTSTART;TZID=UTC:20261010T190000", "DTEND;TZID=UTC:20261012T040000"], "d7:2026-10-10..2026-10-12"],
  ["TZID Asia/Tokyo (no DST): 05:30 IST Oct 10 → night of Oct 9; 23:30 IST Oct 11 → the night of Oct 11 is occupied too", ["UID:d8", "DTSTART;TZID=Asia/Tokyo:20261010T090000", "DTEND;TZID=Asia/Tokyo:20261012T030000"], "d8:2026-10-09..2026-10-12"],
  ["TZID America/New_York, spring forward: 15:00 EST Mar 13 = 01:30 IST Mar 14 (night of Mar 13); 11:00 EDT Mar 15 = 20:30 IST", ["UID:d9", "DTSTART;TZID=America/New_York:20270313T150000", "DTEND;TZID=America/New_York:20270315T110000"], "d9:2027-03-13..2027-03-16"],
  ["TZID America/New_York, fall back: 15:00 EDT Oct 31 = 00:30 IST Nov 1 (night of Oct 31); 11:00 EST Nov 2 = 21:30 IST", ["UID:d10", "DTSTART;TZID=America/New_York:20261031T150000", "DTEND;TZID=America/New_York:20261102T110000"], "d10:2026-10-31..2026-11-03"],
  ["Windows zone name (India Standard Time)", ["UID:d11", "DTSTART;TZID=India Standard Time:20261010T140000", "DTEND;TZID=India Standard Time:20261012T110000"], "d11:2026-10-10..2026-10-12"],
  ["month boundary Jan 31 → Feb 2", ["UID:d12", "DTSTART;VALUE=DATE:20270131", "DTEND;VALUE=DATE:20270202"], "d12:2027-01-31..2027-02-02"],
  ["year boundary Dec 31 → Jan 1 (one night)", ["UID:d13", "DTSTART;VALUE=DATE:20261231", "DTEND;VALUE=DATE:20270101"], "d13:2026-12-31..2027-01-01"],
  ["leap day Feb 29 2028", ["UID:d14", "DTSTART;VALUE=DATE:20280229", "DTEND;VALUE=DATE:20280301"], "d14:2028-02-29..2028-03-01"],
  ["timed, property-local check-in 14:00 / checkout 11:00 = exactly its nights", ["UID:d16", "DTSTART;TZID=Asia/Kolkata:20261020T140000", "DTEND;TZID=Asia/Kolkata:20261022T110000"], "d16:2026-10-20..2026-10-22"],
  ["timed, ends exactly at noon = not the next night", ["UID:d17", "DTSTART;TZID=Asia/Kolkata:20261020T120000", "DTEND;TZID=Asia/Kolkata:20261021T120000"], "d17:2026-10-20..2026-10-21"],
  ["timed, morning event 09:00–10:00 = the night it falls in (the previous one)", ["UID:d18", "DTSTART;TZID=Asia/Kolkata:20261020T090000", "DTEND;TZID=Asia/Kolkata:20261020T100000"], "d18:2026-10-19..2026-10-20"],
  ["timed, weekly recurrence keeps its weekday anchor (Mon 09:00 → Sunday nights)", ["UID:d19", "DTSTART;TZID=Asia/Kolkata:20261019T090000", "DTEND;TZID=Asia/Kolkata:20261019T100000", "RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=2"], ["d19:2026-10-18..2026-10-19", "d19:2026-10-25..2026-10-26"]],
  ["stay across the leap day", ["UID:d15", "DTSTART;VALUE=DATE:20280228", "DTEND;VALUE=DATE:20280302"], "d15:2028-02-28..2028-03-02"],
];

test("each date form maps to the intended calendar nights", () => {
  const out = [];
  for (const [name, lines, want] of CASES) {
    const r = ics.parseIcs(cal(lines), { now: NOW });
    const got = nightsOf(r);
    out.push({ name, got });
    assert.deepStrictEqual(got, Array.isArray(want) ? want : [want], name);
  }
  record("date-forms", { cases: out });
});

test("an invalid calendar date is unreadable (kept as 'present but unknown'), never shifted", () => {
  const r = ics.parseIcs(cal(["UID:bad1", "DTSTART;VALUE=DATE:20270229", "DTEND;VALUE=DATE:20270301"], ["UID:bad2", "DTSTART;VALUE=DATE:20261231", "DTEND;VALUE=DATE:20261230"]), { now: NOW });
  assert.deepStrictEqual(r.events, []);
  assert.deepStrictEqual(r.unreadableUids.sort(), ["bad1", "bad2"]);
});

test("recurrence: yearly on Feb 29 only in leap years; monthly on the 31st only in 31-day months; EXDATE and RECURRENCE-ID across a year boundary", () => {
  const r = ics.parseIcs(
    cal(
      ["UID:leap", "DTSTART;VALUE=DATE:20240229", "DTEND;VALUE=DATE:20240301", "RRULE:FREQ=YEARLY"],
      ["UID:m31", "DTSTART;VALUE=DATE:20261031", "DTEND;VALUE=DATE:20261101", "RRULE:FREQ=MONTHLY;BYMONTHDAY=31;COUNT=4"],
      ["UID:wk", "DTSTART;VALUE=DATE:20261224", "DTEND;VALUE=DATE:20261225", "RRULE:FREQ=WEEKLY;COUNT=4", "EXDATE;VALUE=DATE:20261231"],
      ["UID:wk", "RECURRENCE-ID;VALUE=DATE:20270107", "DTSTART;VALUE=DATE:20270108", "DTEND;VALUE=DATE:20270110"],
    ),
    { now: NOW },
  );
  const by = (uid) => r.events.filter((e) => e.uid === uid).map((e) => `${e.startDay}..${e.endDay}`).sort();
  assert.deepStrictEqual(by("leap"), ["2028-02-29..2028-03-01"], "only the leap year within the 2-year horizon");
  assert.deepStrictEqual(by("m31"), ["2026-10-31..2026-11-01", "2026-12-31..2027-01-01", "2027-01-31..2027-02-01", "2027-03-31..2027-04-01"], "30-day months and February skipped (COUNT counts real occurrences)");
  assert.deepStrictEqual(by("wk"), ["2026-12-24..2026-12-25", "2027-01-08..2027-01-10", "2027-01-14..2027-01-15"], "Dec 31 excluded; Jan 7 moved to Jan 8–10");
});

test("the process time zone never changes parsing or the exported feed (fresh processes: UTC, IST, New York, Honolulu, Kiritimati +14)", () => {
  const calText = cal(...CASES.map((c) => c[1]), ["UID:rr", "DTSTART;VALUE=DATE:20261228", "DTEND;VALUE=DATE:20261229", "RRULE:FREQ=DAILY;COUNT=6", "EXDATE;VALUE=DATE:20261231"]);
  const root = path.join(__dirname, "..", "..");
  const script = `
    const ics = require(${JSON.stringify(path.join(root, "services/calendarSync/icsReader"))});
    const feed = require(${JSON.stringify(path.join(root, "services/calendarSync/exportFeed"))});
    const r = ics.parseIcs(process.argv[1], { now: new Date("2026-10-03T06:00:00Z") });
    const items = r.events.map((e) => ({ uid: e.uid + "@x", start: new Date(e.startDay + "T00:00:00Z"), end: new Date(e.endDay + "T00:00:00Z"), stamp: new Date(0) }));
    const body = feed.render(items).replace(/^DTSTAMP:.*$/gm, "");
    process.stdout.write(JSON.stringify({ tz: process.env.TZ, events: r.events.map((e) => e.key + "|" + e.startDay + "|" + e.endDay).sort(), feed: body.match(/^(DTSTART|DTEND).*$/gm) }));
  `;
  const runs = ["UTC", "Asia/Kolkata", "America/New_York", "Pacific/Honolulu", "Pacific/Kiritimati"].map((tz) => JSON.parse(execFileSync(process.execPath, ["-e", script, calText], { env: { ...process.env, TZ: tz }, encoding: "utf8" })));
  for (const r of runs.slice(1)) {
    assert.deepStrictEqual(r.events, runs[0].events, `parse differs under TZ=${r.tz}`);
    assert.deepStrictEqual(r.feed, runs[0].feed, `feed differs under TZ=${r.tz}`);
  }
  assert.ok(runs[0].feed.every((l) => /;VALUE=DATE:\d{8}$/.test(l.trim())), "all-day dates in the feed");
  assert.ok(runs[0].events.includes("rr#2026-12-30|2026-12-30|2026-12-31") && !runs[0].events.some((e) => e.startsWith("rr#2026-12-31")), "RRULE + EXDATE across the year end");
  record("process-tz", { zones: runs.map((r) => r.tz), events: runs[0].events.length, feedLines: runs[0].feed.length });
});

test("end to end: a Dec 31 → Jan 1 and a Feb 29 booking block exactly those nights in the ledger, the guest calendar and every feed", async () => {
  const host = await H.makeUser();
  const listing = await H.makeListing(host);
  const token = H.userToken(host);
  const p = "/dates-e2e.ics";
  ota.events(p, [
    { uid: "NYE@airbnb.com", start: "2026-12-31", end: "2027-01-01", summary: "Reserved" },
    { uid: "LEAP@airbnb.com", start: "2028-02-29", end: "2028-03-01", summary: "Reserved" },
  ]);
  const a = await H.api("POST", `/calendarSync/properties/${listing._id}/connections`, { token, body: { channel: "AIRBNB", url: ota.url(p) } });
  assert.strictEqual(a.status, 201);
  ota.events("/dates-other.ics", []);
  const g = await H.api("POST", `/calendarSync/properties/${listing._id}/connections`, { token, body: { channel: "GENERIC_ICAL", url: ota.url("/dates-other.ics") } });
  assert.deepStrictEqual(Object.keys(await S.nightOwners(listing._id)).sort(), ["2026-12-31", "2028-02-29"]);
  const cd = await H.api("GET", `/booking/check-dates/${listing._id}`);
  assert.ok(cd.body.data.includes("2026-12-31") && cd.body.data.includes("2028-02-29"));
  assert.ok(!cd.body.data.includes("2027-01-01") && !cd.body.data.includes("2028-03-01"), "checkout days stay free");
  const secret = (await require("../../models/ExternalCalendar").findById(g.body.id).lean()).secret;
  const feed = (await H.api("GET", `/calendarSync/ics/${secret}.ics`, {})).body.raw;
  for (const [s, e] of [["20261231", "20270101"], ["20280229", "20280301"]]) {
    assert.ok(feed.includes(`DTSTART;VALUE=DATE:${s}`) && feed.includes(`DTEND;VALUE=DATE:${e}`), `feed carries ${s}..${e}`);
  }
  // the checkout night is bookable by a guest; the booked night is not
  const guest = await H.makeUser();
  const free = await H.api("POST", "/booking", { token: H.userToken(guest), body: H.bookingBody(listing, { checkIn: "2027-01-01", checkOut: "2027-01-02" }) });
  assert.strictEqual(free.status, 201, JSON.stringify(free.body));
  const taken = await H.api("POST", "/booking", { token: H.userToken(await H.makeUser()), body: H.bookingBody(listing, { checkIn: "2026-12-31", checkOut: "2027-01-01" }) });
  assert.strictEqual(taken.status, 409);
  assert.strictEqual(await Booking.countDocuments({ propertyId: listing._id, source: "ical" }), 2);
});

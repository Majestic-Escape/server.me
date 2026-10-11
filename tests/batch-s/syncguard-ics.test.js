// SyncGuard: bounded iCalendar reader (services/calendarSync/icsReader.js).
// Pure unit tests — no database. Run under TZ=UTC and TZ=Asia/Kolkata; the
// results must be identical (the reader never uses local-time getters).
const { test } = require("node:test");
const assert = require("node:assert");
const { parseIcs, IcsError, LIMITS } = require("../../services/calendarSync/icsReader");

const NOW = new Date("2026-10-03T06:00:00Z");
function cal(...events) {
  return ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Test//EN", ...events.flat(), "END:VCALENDAR"].join("\r\n");
}
function ev(lines) {
  return ["BEGIN:VEVENT", ...lines, "END:VEVENT"];
}
const parse = (text, opts = {}) => parseIcs(text, { now: NOW, ...opts });
const codeOf = (fn) => {
  try {
    fn();
  } catch (err) {
    return err instanceof IcsError ? err.code : `other:${err.message}`;
  }
  return "no-error";
};

test("all-day events keep exclusive DTEND; timed events block every IST night they touch (noon rule)", () => {
  const r = parse(
    cal(
      ev(["UID:a@airbnb.com", "DTSTART;VALUE=DATE:20261012", "DTEND;VALUE=DATE:20261013", "SUMMARY:Airbnb (Not available)"]),
      ev(["UID:b@x", "DTSTART;TZID=Asia/Kolkata:20261012T140000", "DTEND;TZID=Asia/Kolkata:20261013T110000"]),
      ev(["UID:c@x", "DTSTART:20261012T200000Z", "DTEND:20261014T050000Z"]), // 01:30 IST Oct 13 → 10:30 IST Oct 14
      ev(["UID:d@x", "DTSTART;TZID=India Standard Time:20261020T140000", "DURATION:P2D"]),
      ev(["UID:e@x", "DTSTART;VALUE=DATE:20261101"]), // no end: one day
      ev(["UID:f@x", "DTSTART;TZID=/mozilla.org/20050126_1/Asia/Kolkata:20261105T090000", "DTEND;TZID=/mozilla.org/20050126_1/Asia/Kolkata:20261105T100000"]),
    ),
    { channel: "AIRBNB" },
  );
  const by = Object.fromEntries(r.events.map((e) => [e.key, e]));
  assert.deepStrictEqual([by["a@airbnb.com"].startDay, by["a@airbnb.com"].endDay, by["a@airbnb.com"].summaryKind], ["2026-10-12", "2026-10-13", "blocked"]);
  assert.deepStrictEqual([by["b@x"].startDay, by["b@x"].endDay], ["2026-10-12", "2026-10-13"]);
  // 01:30 IST Oct 13 is still the night of Oct 12 (before noon); 10:30 IST Oct 14 is before noon
  assert.deepStrictEqual([by["c@x"].startDay, by["c@x"].endDay], ["2026-10-12", "2026-10-14"]);
  // 14:00 IST Oct 20 + 2 days = 14:00 IST Oct 22, after noon: the night of Oct 22 is touched too
  assert.deepStrictEqual([by["d@x"].startDay, by["d@x"].endDay], ["2026-10-20", "2026-10-23"]);
  assert.deepStrictEqual([by["e@x"].startDay, by["e@x"].endDay], ["2026-11-01", "2026-11-02"]);
  // 09:00–10:00 IST Nov 5 happens while the guest of the night of Nov 4 is still in (checkout at noon)
  assert.deepStrictEqual([by["f@x"].startDay, by["f@x"].endDay], ["2026-11-04", "2026-11-05"], "a morning event blocks the night it falls in");
  assert.strictEqual(r.stats.unknownTz, 0);
});

test("cancelled, tentative and transparent events are reported, not dropped", () => {
  const r = parse(
    cal(
      ev(["UID:x1", "DTSTART;VALUE=DATE:20261012", "DTEND;VALUE=DATE:20261013", "STATUS:CANCELLED"]),
      ev(["UID:x2", "DTSTART;VALUE=DATE:20261012", "DTEND;VALUE=DATE:20261013", "STATUS:TENTATIVE"]),
      ev(["UID:x3", "DTSTART;VALUE=DATE:20261012", "DTEND;VALUE=DATE:20261013", "TRANSP:TRANSPARENT"]),
    ),
  );
  const by = Object.fromEntries(r.events.map((e) => [e.key, e]));
  assert.strictEqual(by.x1.status, "cancelled");
  assert.strictEqual(by.x2.status, "tentative");
  assert.strictEqual(by.x3.transparent, true);
});

test("past events are skipped; ongoing stays are kept; far-future beyond the horizon is skipped", () => {
  const r = parse(
    cal(
      ev(["UID:past", "DTSTART;VALUE=DATE:20260901", "DTEND;VALUE=DATE:20260905"]),
      ev(["UID:ending-today", "DTSTART;VALUE=DATE:20261001", "DTEND;VALUE=DATE:20261003"]),
      ev(["UID:ongoing", "DTSTART;VALUE=DATE:20261001", "DTEND;VALUE=DATE:20261006"]),
      ev(["UID:far", "DTSTART;VALUE=DATE:20300101", "DTEND;VALUE=DATE:20300102"]),
    ),
  );
  assert.deepStrictEqual(r.events.map((e) => e.key), ["ongoing"]);
  assert.strictEqual(r.stats.past, 2);
  assert.strictEqual(r.stats.beyondHorizon, 1);
});

test("structural failures are all-or-nothing (never an empty success)", () => {
  assert.strictEqual(codeOf(() => parse("<html><body>Please log in</body></html>")), "NOT_ICALENDAR");
  assert.strictEqual(codeOf(() => parse("")), "NOT_ICALENDAR");
  const truncated = cal(ev(["UID:a", "DTSTART;VALUE=DATE:20261012"])).replace(/END:VCALENDAR$/, "");
  assert.strictEqual(codeOf(() => parse(truncated)), "TRUNCATED");
  const cutInEvent = ["BEGIN:VCALENDAR", "BEGIN:VEVENT", "UID:a", "DTSTART;VALUE=DATE:20261012"].join("\r\n");
  assert.strictEqual(codeOf(() => parse(cutInEvent)), "TRUNCATED");
  assert.strictEqual(codeOf(() => parse(cal("BEGIN:VEVENT", "END:VTODO"))), "MALFORMED");
  // A valid, genuinely empty calendar is fine — reconciliation decides what it means.
  assert.strictEqual(parse(cal()).events.length, 0);
});

test("an unreadable event is 'present but unknown', never 'absent'", () => {
  const r = parse(cal(ev(["UID:bad@x", "DTSTART;VALUE=DATE:20261399", "DTEND;VALUE=DATE:20261401"]), ev(["UID:ok@x", "DTSTART;VALUE=DATE:20261012", "DTEND;VALUE=DATE:20261013"])));
  assert.deepStrictEqual(r.unreadableUids, ["bad@x"]);
  assert.strictEqual(r.stats.invalid, 1);
  assert.deepStrictEqual(r.events.map((e) => e.key), ["ok@x"]);
  // end before start is unreadable too
  const r2 = parse(cal(ev(["UID:rev@x", "DTSTART:20261012T100000Z", "DTEND:20261011T100000Z"])));
  assert.deepStrictEqual(r2.unreadableUids, ["rev@x"]);
});

test("duplicate UIDs: identical copies collapse, conflicting copies all block", () => {
  const r = parse(
    cal(
      ev(["UID:dup", "DTSTART;VALUE=DATE:20261012", "DTEND;VALUE=DATE:20261013"]),
      ev(["UID:dup", "DTSTART;VALUE=DATE:20261012", "DTEND;VALUE=DATE:20261013"]),
      ev(["UID:two", "DTSTART;VALUE=DATE:20261015", "DTEND;VALUE=DATE:20261016"]),
      ev(["UID:two", "DTSTART;VALUE=DATE:20261020", "DTEND;VALUE=DATE:20261022"]),
    ),
  );
  assert.deepStrictEqual(r.events.map((e) => `${e.key} ${e.startDay}`), ["dup 2026-10-12", "two#2026-10-15 2026-10-15", "two#2026-10-20 2026-10-20"]);
  assert.strictEqual(r.stats.duplicateUid, 1);
});

test("missing UID gets a stable content key", () => {
  const a = parse(cal(ev(["DTSTART;VALUE=DATE:20261012", "DTEND;VALUE=DATE:20261013"])));
  const b = parse(cal(ev(["DTSTART;VALUE=DATE:20261012", "DTEND;VALUE=DATE:20261013", "SUMMARY:x"])));
  assert.strictEqual(a.events[0].key, b.events[0].key);
  assert.match(a.events[0].key, /^nouid:/);
});

test("recurrence: bounded expansion with EXDATE and RECURRENCE-ID overrides", () => {
  const r = parse(
    cal(
      ev(["UID:weekly", "DTSTART;VALUE=DATE:20261012", "DTEND;VALUE=DATE:20261013", "RRULE:FREQ=WEEKLY;COUNT=4", "EXDATE;VALUE=DATE:20261019"]),
      ev(["UID:weekly", "RECURRENCE-ID;VALUE=DATE:20261026", "DTSTART;VALUE=DATE:20261027", "DTEND;VALUE=DATE:20261029"]),
    ),
  );
  assert.deepStrictEqual(
    r.events.map((e) => `${e.key} ${e.startDay}..${e.endDay}`),
    ["weekly#2026-10-12 2026-10-12..2026-10-13", "weekly#2026-10-26 2026-10-27..2026-10-29", "weekly#2026-11-02 2026-11-02..2026-11-03"],
  );
});

test("recurrence: weekly BYDAY, monthly BYMONTHDAY, yearly; DTSTART far in the past is cheap", () => {
  const r = parse(
    cal(
      ev(["UID:wk", "DTSTART;VALUE=DATE:20261005", "DTEND;VALUE=DATE:20261006", "RRULE:FREQ=WEEKLY;BYDAY=SA,SU;UNTIL=20261020"]),
      ev(["UID:mo", "DTSTART;VALUE=DATE:20260131", "DTEND;VALUE=DATE:20260201", "RRULE:FREQ=MONTHLY;COUNT=12"]),
      ev(["UID:old", "DTSTART;VALUE=DATE:19000101", "DTEND;VALUE=DATE:19000102", "RRULE:FREQ=DAILY;INTERVAL=7"]),
    ),
  );
  const keys = r.events.map((e) => e.key);
  assert.deepStrictEqual(keys.filter((k) => k.startsWith("wk#")), ["wk#2026-10-10", "wk#2026-10-11", "wk#2026-10-17", "wk#2026-10-18"]);
  // Jan 31 monthly: months without a 31st are skipped (RFC 5545) and COUNT
  // counts only real occurrences: Jan Mar May Jul Aug Oct Dec 2026 + Jan Mar
  // May Jul Aug 2027 = 12; the ones not yet past are listed.
  assert.deepStrictEqual(keys.filter((k) => k.startsWith("mo#")), ["mo#2026-10-31", "mo#2026-12-31", "mo#2027-01-31", "mo#2027-03-31", "mo#2027-05-31", "mo#2027-07-31", "mo#2027-08-31"]);
  const old = keys.filter((k) => k.startsWith("old#"));
  assert.ok(old.length >= 100 && old.length <= 106, `weekly-from-1900 expanded only inside the 2-year window (${old.length})`);
});

test("recurrence bombs are refused or bounded, never expanded without limit", () => {
  const t0 = Date.now();
  // SECONDLY/HOURLY are unsupported → only the first occurrence blocks.
  const r = parse(cal(ev(["UID:bomb", "DTSTART:20261012T000000Z", "DTEND:20261012T000001Z", "RRULE:FREQ=SECONDLY"])));
  assert.strictEqual(r.stats.unsupportedRule, 1);
  assert.strictEqual(r.events.length, 1);
  // COUNT beyond the cap → unsupported (first occurrence only)
  const r2 = parse(cal(ev(["UID:c", "DTSTART;VALUE=DATE:20261012", "RRULE:FREQ=DAILY;COUNT=99999999"])));
  assert.strictEqual(r2.events.length, 1);
  // Many daily rules: the total-occurrence cap trips → whole feed refused.
  const many = [];
  for (let i = 0; i < 10; i++) many.push(ev([`UID:d${i}`, "DTSTART;VALUE=DATE:20261004", "DTEND;VALUE=DATE:20261005", "RRULE:FREQ=DAILY"]));
  assert.strictEqual(codeOf(() => parse(cal(...many))), "TOO_MANY_OCCURRENCES");
  assert.ok(Date.now() - t0 < 2000, "bounded in time");
});

test("size and count limits", () => {
  const big = cal(ev(["UID:x", "DTSTART;VALUE=DATE:20261012", `SUMMARY:${"A".repeat(LIMITS.maxChars)}`]));
  assert.strictEqual(codeOf(() => parse(big)), "TOO_LARGE");
  const lots = [];
  for (let i = 0; i < LIMITS.maxEvents + 1; i++) lots.push(ev([`UID:e${i}`, "DTSTART;VALUE=DATE:20200101"]));
  assert.strictEqual(codeOf(() => parse(cal(...lots))), "TOO_MANY_EVENTS");
  const future = [];
  for (let i = 0; i < LIMITS.maxRelevantEvents + 1; i++) {
    const d = new Date(Date.UTC(2026, 9, 4) + (i % 700) * 86400000).toISOString().slice(0, 10).replace(/-/g, "");
    future.push(ev([`UID:f${i}`, `DTSTART;VALUE=DATE:${d}`]));
  }
  assert.strictEqual(codeOf(() => parse(cal(...future))), "TOO_MANY_EVENTS");
});

test("escaped text, unicode, HTML/script in SUMMARY never leak out (only a hint is kept)", () => {
  const r = parse(cal(ev(["UID:u1", "DTSTART;VALUE=DATE:20261012", "SUMMARY:<script>alert(1)</script>\\, John Smith +91 98765 43210 😀\\nline"])));
  const e = r.events[0];
  assert.deepStrictEqual(Object.keys(e).sort(), ["endDay", "key", "recurring", "startDay", "status", "summaryKind", "transparent", "uid"]);
  assert.ok(!JSON.stringify(r).includes("John"), "no summary text in the output");
  assert.ok(!JSON.stringify(r).includes("script"), "no markup in the output");
});

test("folded lines, quoted params with colons, BOM, LF-only and lower-case properties", () => {
  const text = "﻿BEGIN:VCALENDAR\nVERSION:2.0\nBEGIN:VEVENT\nUID:fold\n ed@x\nDTSTART;X-NOTE=\"a:b;c\";VALUE=DATE:20261012\nDTEND;VALUE=DATE:20261014\nEND:VEVENT\nEND:VCALENDAR\n";
  const r = parse(text);
  assert.deepStrictEqual(r.events.map((e) => [e.key, e.startDay, e.endDay]), [["folded@x", "2026-10-12", "2026-10-14"]]);
});

test("content hash ignores DTSTAMP churn and ordering, changes with dates", () => {
  const a = parse(cal(ev(["UID:1", "DTSTAMP:20261003T000000Z", "DTSTART;VALUE=DATE:20261012"]), ev(["UID:2", "DTSTART;VALUE=DATE:20261015"])));
  const b = parse(cal(ev(["UID:2", "DTSTART;VALUE=DATE:20261015"]), ev(["UID:1", "DTSTAMP:20261003T000500Z", "DTSTART;VALUE=DATE:20261012"])));
  const c = parse(cal(ev(["UID:1", "DTSTART;VALUE=DATE:20261013"]), ev(["UID:2", "DTSTART;VALUE=DATE:20261015"])));
  assert.strictEqual(a.contentHash, b.contentHash);
  assert.notStrictEqual(a.contentHash, c.contentHash);
});

test("America/New_York across DST (spring forward 2027-03-14, fall back 2026-11-01) maps to the right IST night", () => {
  // 2026-11-01 01:30 EDT/EST is ambiguous (repeated hour); 2027-03-14 02:30 does not exist.
  const r = parse(
    cal(
      ev(["UID:fall", "DTSTART;TZID=America/New_York:20261101T013000", "DTEND;TZID=America/New_York:20261102T110000"]),
      ev(["UID:spring", "DTSTART;TZID=America/New_York:20270314T023000", "DTEND;TZID=America/New_York:20270315T110000"]),
      ev(["UID:late", "DTSTART;TZID=America/New_York:20261105T220000", "DTEND;TZID=America/New_York:20261107T100000"]),
    ),
  );
  const by = Object.fromEntries(r.events.map((e) => [e.key, e]));
  // 01:30 New York on Nov 1 (first, EDT) = 05:30Z = 11:00 IST Nov 1 — before noon: the night of Oct 31;
  // 11:00 EST Nov 2 = 16:00Z = 21:30 IST Nov 2 — after noon: the night of Nov 2 too
  assert.deepStrictEqual([by.fall.startDay, by.fall.endDay], ["2026-10-31", "2026-11-03"]);
  // 02:30 (non-existent) resolves to 03:30 EDT = 13:00 IST Mar 14 (after noon: night of Mar 14);
  // 11:00 EDT Mar 15 = 15:00Z = 20:30 IST Mar 15 — after noon: the night of Mar 15 too
  assert.deepStrictEqual([by.spring.startDay, by.spring.endDay], ["2027-03-14", "2027-03-16"]);
  // 22:00 EST Nov 5 = 08:30 IST Nov 6 (before noon: still the night of Nov 5);
  // 10:00 EST Nov 7 = 20:30 IST Nov 7 (after noon: the night of Nov 7 too)
  assert.deepStrictEqual([by.late.startDay, by.late.endDay], ["2026-11-05", "2026-11-08"]);
});

test("date-only nights never shift, whatever the process time zone (VALUE=DATE + RRULE + EXDATE)", () => {
  // The node-ical defect from the baseline: under TZ=Asia/Kolkata an all-day
  // RRULE lost dateOnly and its EXDATE keyed the previous day.
  const r = parse(cal(ev(["UID:d", "DTSTART;VALUE=DATE:20261101", "DTEND;VALUE=DATE:20261102", "RRULE:FREQ=WEEKLY;COUNT=3", "EXDATE;VALUE=DATE:20261108"])));
  assert.deepStrictEqual(r.events.map((e) => `${e.startDay}..${e.endDay}`), ["2026-11-01..2026-11-02", "2026-11-15..2026-11-16"]);
});

test("a modified recurring occurrence (RECURRENCE-ID) keeps its key while its dates change", () => {
  const v1 = parse(cal(ev(["UID:rec", "DTSTART;VALUE=DATE:20261012", "DTEND;VALUE=DATE:20261013", "RRULE:FREQ=WEEKLY;COUNT=2"])));
  const v2 = parse(
    cal(
      ev(["UID:rec", "DTSTART;VALUE=DATE:20261012", "DTEND;VALUE=DATE:20261013", "RRULE:FREQ=WEEKLY;COUNT=2"]),
      ev(["UID:rec", "RECURRENCE-ID;VALUE=DATE:20261019", "DTSTART;VALUE=DATE:20261021", "DTEND;VALUE=DATE:20261023"]),
    ),
  );
  const k = "rec#2026-10-19";
  assert.deepStrictEqual([v1.events.find((e) => e.key === k).startDay, v2.events.find((e) => e.key === k).startDay, v2.events.find((e) => e.key === k).endDay], ["2026-10-19", "2026-10-21", "2026-10-23"]);
  const cancelled = parse(cal(ev(["UID:rec", "DTSTART;VALUE=DATE:20261012", "RRULE:FREQ=WEEKLY;COUNT=2"]), ev(["UID:rec", "RECURRENCE-ID;VALUE=DATE:20261019", "DTSTART;VALUE=DATE:20261019", "STATUS:CANCELLED"])));
  assert.strictEqual(cancelled.events.find((e) => e.key === k).status, "cancelled", "a cancelled occurrence is explicit (released at once)");
});

test("unknown TZID falls back to the property zone and is counted", () => {
  const r = parse(cal(ev(["UID:z", "DTSTART;TZID=Mars/Olympus:20261012T100000", "DTEND;TZID=Mars/Olympus:20261013T100000"])));
  assert.strictEqual(r.stats.unknownTz, 2);
  // read as IST: 10:00 Oct 12 (before noon → night of Oct 11) to 10:00 Oct 13 (before noon)
  assert.deepStrictEqual([r.events[0].startDay, r.events[0].endDay], ["2026-10-11", "2026-10-13"]);
});

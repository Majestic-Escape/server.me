// Bounded iCalendar (RFC 5545) reader for SyncGuard (docs/syncguard.md §8).
//
// Why not node-ical: its DATE handling depends on the server's time zone
// (an all-day RRULE event and its EXDATE shift by a day under
// TZ=Asia/Kolkata — docs §0.5), and it offers no resource limits. This
// reader keeps exactly what availability needs and nothing else:
//
//   VEVENT → { key, uid, startDay, endDay (exclusive), status, transparent,
//              summaryKind, recurring }
//
// Days are UTC-midnight day numbers — the same keys as services/inventory.js
// (bookingnights.date). Timed events are mapped to the property's local
// calendar date (Asia/Kolkata unless SYNC_PROPERTY_TZ says otherwise).
// SUMMARY / DESCRIPTION are never returned: OTA descriptions carry guest
// data (reservation links, phone digits); only a reserved/blocked hint is.
//
// Failure is all-or-nothing for structural problems (not a calendar,
// truncated, over limits) so a broken response can never look like "every
// booking was cancelled". A single unreadable event is reported in
// `unreadableUids` so reconciliation treats it as present-but-unknown.
const crypto = require("node:crypto");
const { classifySummary } = require("./channels");

const DAY_MS = 86_400_000;
const LIMITS = {
  maxChars: 2 * 1024 * 1024,
  maxLines: 50_000,
  maxEvents: 5_000, // VEVENT blocks in the file
  maxRelevantEvents: 800, // current/future events after expansion (≥ 2 years of single nights)
  horizonDays: 730,
  maxOccurrencesTotal: 5_000,
  maxRuleIterations: 20_000,
  maxFileRuleIterations: 200_000, // all repeating rules of one file together (~0.1 s of CPU)
  maxCount: 1_000,
  // EXDATE values (each is parsed): past either cap the event's exceptions
  // are ignored — all its dates block (over-blocking, the safe side).
  maxExdatesPerEvent: 1_000,
  maxExdatesTotal: 10_000,
};
const DEFAULT_TZ = process.env.SYNC_PROPERTY_TZ || "Asia/Kolkata";

class IcsError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

// --- day helpers ------------------------------------------------------------
function dayFromYmd(y, m, d) {
  const ms = Date.UTC(y, m - 1, d);
  const back = new Date(ms);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== m - 1 || back.getUTCDate() !== d) return null;
  return Math.floor(ms / DAY_MS);
}
function ymd(day) {
  return new Date(day * DAY_MS).toISOString().slice(0, 10);
}
function dayOfDate(date) {
  return Math.floor(date.getTime() / DAY_MS);
}

// --- time zones ---------------------------------------------------------------
const WINDOWS_ZONES = {
  "india standard time": "Asia/Kolkata",
  utc: "UTC",
  "coordinated universal time": "UTC",
  "gmt standard time": "Europe/London",
  "greenwich standard time": "Atlantic/Reykjavik",
  "w. europe standard time": "Europe/Berlin",
  "central europe standard time": "Europe/Budapest",
  "romance standard time": "Europe/Paris",
  "eastern standard time": "America/New_York",
  "central standard time": "America/Chicago",
  "mountain standard time": "America/Denver",
  "pacific standard time": "America/Los_Angeles",
  "singapore standard time": "Asia/Singapore",
  "arabian standard time": "Asia/Dubai",
  "china standard time": "Asia/Shanghai",
  "tokyo standard time": "Asia/Tokyo",
  "aus eastern standard time": "Australia/Sydney",
  "sri lanka standard time": "Asia/Colombo",
  "nepal standard time": "Asia/Kathmandu",
};
// Formatters are cached per canonical zone. Intl accepts any spelling of a
// zone ("aMeRiCa/new_york"), so a cache keyed by the raw TZID would let one
// calendar grow it without bound; both maps are capped as well.
const TZ_CACHE_MAX = 256;
const zoneCache = new Map(); // lower-cased TZID → canonical zone | null
const fmtCache = new Map(); // canonical zone → formatter
function canonicalZone(tz) {
  const k = String(tz).toLowerCase();
  if (zoneCache.has(k)) return zoneCache.get(k);
  let zone = null;
  try {
    zone = new Intl.DateTimeFormat("en-US", { timeZone: tz }).resolvedOptions().timeZone;
  } catch {
    zone = null;
  }
  if (zoneCache.size >= TZ_CACHE_MAX) zoneCache.clear();
  zoneCache.set(k, zone);
  return zone;
}
function formatter(tz) {
  const zone = canonicalZone(tz);
  if (!zone) throw new RangeError(`Invalid time zone: ${tz}`);
  let f = fmtCache.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
    if (fmtCache.size >= TZ_CACHE_MAX) fmtCache.clear();
    fmtCache.set(zone, f);
  }
  return f;
}
function validTz(tz) {
  return !!canonicalZone(tz);
}
// No real zone name (IANA, Windows or a vendor-prefixed IANA path) comes near
// this length; anything longer is "unknown" before any matching runs — the
// suffix pattern below would otherwise cost O(n²) on a hostile name.
const MAX_TZID_CHARS = 128;
// Memoised (bounded): a file repeats the same few names on every value.
const tzMemo = new Map();
// Unknown names validated per file (validating an invalid zone costs ~50 µs
// through Intl; valid ones are cheap). Past the budget, names not seen yet
// are unknown (India time, with the warning). Resolution ignores case.
const TZ_LOOKUPS_PER_FILE = 100;
let tzLookupsLeft = TZ_LOOKUPS_PER_FILE;
function resolveTz(tzid) {
  if (!tzid) return null;
  const raw = String(tzid);
  if (raw.length > MAX_TZID_CHARS + 2) return null;
  const k = raw.toLowerCase();
  if (tzMemo.has(k)) return tzMemo.get(k);
  if (tzLookupsLeft <= 0) return null;
  const r = resolveTzUncached(raw);
  if (r === null) tzLookupsLeft -= 1;
  if (tzMemo.size >= 256) tzMemo.clear();
  tzMemo.set(k, r);
  return r;
}
function resolveTzUncached(tzid) {
  const t = String(tzid).replace(/^"|"$/g, "").trim();
  if (!t || t.length > MAX_TZID_CHARS) return null;
  if (validTz(t)) return t;
  const win = WINDOWS_ZONES[t.toLowerCase()];
  if (win) return win;
  // e.g. "/mozilla.org/20050126_1/Asia/Kolkata", "(UTC+05:30) Asia/Kolkata"
  const m = t.match(/([A-Za-z]+\/[A-Za-z_+\-]+(?:\/[A-Za-z_+\-]+)?)\s*$/);
  if (m && validTz(m[1])) return m[1];
  return null;
}
function parts(ms, tz) {
  const o = {};
  for (const p of formatter(tz).formatToParts(new Date(ms))) o[p.type] = p.value;
  return { y: +o.year, m: +o.month, d: +o.day, h: +o.hour, mi: +o.minute, s: +o.second };
}
function offsetMs(ms, tz) {
  const p = parts(ms, tz);
  return Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s) - Math.floor(ms / 1000) * 1000;
}
function wallToInstant(y, m, d, h, mi, s, tz) {
  const guess = Date.UTC(y, m - 1, d, h, mi, s);
  const first = guess - offsetMs(guess, tz);
  return guess - offsetMs(first, tz);
}
function localDay(ms, tz) {
  const p = parts(ms, tz);
  return dayFromYmd(p.y, p.m, p.d);
}
function localMinutes(ms, tz) {
  const p = parts(ms, tz);
  return p.h * 60 + p.mi;
}

// --- content lines ------------------------------------------------------------
function unfold(text) {
  const raw = text.split(/\r\n|\n|\r/);
  if (raw.length > LIMITS.maxLines * 2) throw new IcsError("TOO_LARGE", "The calendar has too many lines");
  const lines = [];
  for (const l of raw) {
    if ((l.startsWith(" ") || l.startsWith("\t")) && lines.length) lines[lines.length - 1] += l.slice(1);
    else lines.push(l);
  }
  if (lines.length > LIMITS.maxLines) throw new IcsError("TOO_LARGE", "The calendar has too many lines");
  return lines;
}

const MAX_PARAM_CHARS = 256;
// "NAME;P1=a;P2="b:c":value" → { name, params, value }
function parseLine(line) {
  let i = 0;
  let inQuote = false;
  let colon = -1;
  for (; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') inQuote = !inQuote;
    else if (ch === ":" && !inQuote) {
      colon = i;
      break;
    }
  }
  if (colon < 0) return null;
  const head = line.slice(0, colon);
  const value = line.slice(colon + 1);
  const segs = [];
  let cur = "";
  inQuote = false;
  for (const ch of head) {
    if (ch === '"') inQuote = !inQuote;
    if (ch === ";" && !inQuote) {
      segs.push(cur);
      cur = "";
    } else cur += ch;
  }
  segs.push(cur);
  const name = segs.shift().trim().toUpperCase();
  const params = {};
  for (const seg of segs) {
    const eq = seg.indexOf("=");
    // Parameter values that matter here (VALUE, TZID) are short; an
    // oversized one is cut (bounded work everywhere after this) — a cut TZID
    // is then unknown, falls back to the property zone and is counted.
    if (eq > 0) params[seg.slice(0, eq).trim().toUpperCase()] = seg.slice(eq + 1, eq + 1 + MAX_PARAM_CHARS + 2).trim().replace(/^"|"$/g, "");
  }
  return { name, params, value };
}

function unescapeText(v) {
  return String(v).replace(/\\([\\;,nN])/g, (_, c) => (c === "n" || c === "N" ? "\n" : c));
}

// DATE / DATE-TIME → { kind: "date"|"datetime", day, ms? } or null
function parseDateValue(value, params, propertyTz, warn) {
  const v = String(value || "").trim();
  if (params.VALUE === "DATE" || /^\d{8}$/.test(v)) {
    const m = v.match(/^(\d{4})(\d{2})(\d{2})$/);
    if (!m) return null;
    const day = dayFromYmd(+m[1], +m[2], +m[3]);
    return day === null ? null : { kind: "date", day };
  }
  const m = v.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/);
  if (!m) return null;
  const [y, mo, d, h, mi, s] = [+m[1], +m[2], +m[3], +m[4], +m[5], +m[6]];
  if (dayFromYmd(y, mo, d) === null || h > 23 || mi > 59 || s > 60) return null;
  let ms;
  if (m[7] === "Z") ms = Date.UTC(y, mo - 1, d, h, mi, Math.min(s, 59));
  else {
    let tz = propertyTz;
    if (params.TZID) {
      const resolved = resolveTz(params.TZID);
      if (resolved) tz = resolved;
      else warn("unknownTz");
    }
    ms = wallToInstant(y, mo, d, h, mi, Math.min(s, 59), tz);
  }
  return { kind: "datetime", ms, day: localDay(ms, propertyTz), minute: localMinutes(ms, propertyTz) };
}

function parseDuration(v) {
  const m = String(v || "").trim().match(/^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/);
  if (!m || m[1] === "-") return null;
  const [w, d, h, mi, s] = [m[2], m[3], m[4], m[5], m[6]].map((x) => (x ? Math.min(+x, 100_000) : 0));
  return { days: w * 7 + d, seconds: ((w * 7 + d) * 24 + h) * 3600 + mi * 60 + s };
}

// --- recurrence -----------------------------------------------------------------
const WEEKDAYS = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };

function parseRule(value, propertyTz) {
  const r = {};
  for (const part of String(value).split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0) r[part.slice(0, eq).trim().toUpperCase()] = part.slice(eq + 1).trim().toUpperCase();
  }
  const freq = r.FREQ;
  if (!["DAILY", "WEEKLY", "MONTHLY", "YEARLY"].includes(freq)) return { unsupported: true };
  const known = new Set(["FREQ", "INTERVAL", "COUNT", "UNTIL", "BYDAY", "BYMONTHDAY", "BYMONTH", "WKST"]);
  if (Object.keys(r).some((k) => !known.has(k))) return { unsupported: true };
  const interval = r.INTERVAL ? Number(r.INTERVAL) : 1;
  if (!Number.isInteger(interval) || interval < 1 || interval > 1000) return { unsupported: true };
  let count = null;
  if (r.COUNT !== undefined) {
    count = Number(r.COUNT);
    if (!Number.isInteger(count) || count < 1) return { unsupported: true };
    if (count > LIMITS.maxCount) return { unsupported: true };
  }
  let until = null;
  if (r.UNTIL) {
    const u = parseDateValue(r.UNTIL, {}, propertyTz, () => {});
    if (!u) return { unsupported: true };
    until = u.day;
  }
  let byDay = null;
  if (r.BYDAY) {
    if (freq !== "WEEKLY") return { unsupported: true };
    byDay = [...new Set(r.BYDAY.split(",").map((x) => WEEKDAYS[x.trim()]))];
    if (byDay.some((x) => x === undefined) || byDay.length > 7) return { unsupported: true }; // "1MO" style
  }
  let byMonthDay = null;
  if (r.BYMONTHDAY) {
    if (freq !== "MONTHLY" && freq !== "YEARLY") return { unsupported: true };
    const parts = r.BYMONTHDAY.split(",");
    if (parts.length > 62) return { unsupported: true }; // a hostile list (at most 31 distinct days exist)
    byMonthDay = [...new Set(parts.map(Number))];
    if (byMonthDay.some((x) => !Number.isInteger(x) || x < 1 || x > 31)) return { unsupported: true };
  }
  let byMonth = null;
  if (r.BYMONTH) {
    if (freq !== "YEARLY") return { unsupported: true };
    byMonth = r.BYMONTH.split(",").map(Number);
    if (byMonth.length !== 1 || !Number.isInteger(byMonth[0]) || byMonth[0] < 1 || byMonth[0] > 12) return { unsupported: true };
  }
  return { freq, interval, count, until, byDay, byMonthDay, byMonth };
}

// Occurrence start days of `rule` from `startDay`, limited to days in
// [windowStart, windowEnd]. Bounded by construction (see LIMITS): rules
// without COUNT jump straight to the window, and every iteration of every
// rule of one file draws on one shared `budget`.
function expandRule(rule, startDay, windowStart, windowEnd, budget = { left: Infinity }) {
  const out = [];
  let iterations = 0;
  let produced = 0; // counts toward COUNT from DTSTART
  const stopDay = Math.min(windowEnd, rule.until === null ? Infinity : rule.until);
  const emit = (day) => {
    produced += 1;
    if (day >= windowStart && day <= stopDay) out.push(day);
  };
  const tick = () => {
    iterations += 1;
    budget.left -= 1;
    if (iterations > LIMITS.maxRuleIterations) throw new IcsError("TOO_MANY_OCCURRENCES", "A repeating event in the calendar is too complex");
    if (budget.left < 0) throw new IcsError("TOO_MANY_OCCURRENCES", "The calendar's repeating events are too complex");
  };
  const countLeft = () => rule.count === null || produced < rule.count;
  const s = new Date(startDay * DAY_MS);
  if (rule.freq === "DAILY") {
    let k = 0;
    if (rule.count === null && windowStart > startDay) k = Math.floor((windowStart - startDay) / rule.interval);
    for (; countLeft(); k++) {
      tick();
      const day = startDay + k * rule.interval;
      if (day > stopDay) break;
      emit(day);
    }
  } else if (rule.freq === "WEEKLY") {
    const days = (rule.byDay || [s.getUTCDay()]).slice().sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7)); // Monday-first
    const weekStart0 = startDay - ((s.getUTCDay() + 6) % 7); // Monday of DTSTART's week
    let w = 0;
    if (rule.count === null && windowStart > startDay) w = Math.max(0, Math.floor((windowStart - weekStart0) / 7 / rule.interval) - 1);
    outer: for (; countLeft(); w++) {
      const ws = weekStart0 + w * 7 * rule.interval;
      if (ws > stopDay) break;
      for (const wd of days) {
        tick();
        const day = ws + ((wd + 6) % 7);
        if (day < startDay) continue;
        if (day > stopDay || !countLeft()) break outer;
        emit(day);
      }
    }
  } else {
    // MONTHLY / YEARLY walk calendar months/years from DTSTART.
    const y0 = s.getUTCFullYear();
    const m0 = s.getUTCMonth() + 1;
    const d0 = s.getUTCDate();
    // Without COUNT, periods that end before the window cannot matter:
    // start one period before it (a rule from the year 400 costs nothing).
    let k0 = 0;
    if (rule.count === null && windowStart > startDay) {
      const w = new Date(windowStart * DAY_MS);
      const ahead = rule.freq === "MONTHLY" ? (w.getUTCFullYear() - y0) * 12 + (w.getUTCMonth() + 1 - m0) : w.getUTCFullYear() - y0;
      k0 = Math.max(0, Math.floor(ahead / rule.interval) - 1);
    }
    for (let k = k0; countLeft(); k++) {
      tick();
      let y;
      let m;
      if (rule.freq === "MONTHLY") {
        const idx = m0 - 1 + k * rule.interval;
        y = y0 + Math.floor(idx / 12);
        m = (idx % 12) + 1;
      } else {
        y = y0 + k * rule.interval;
        m = rule.byMonth ? rule.byMonth[0] : m0;
      }
      const first = dayFromYmd(y, m, 1);
      if (first === null || first > stopDay) break;
      const monthDays = (rule.byMonthDay || [d0]).slice().sort((a, b) => a - b);
      for (const md of monthDays) {
        tick(); // every candidate date counts against the budgets, not only every period
        const day = dayFromYmd(y, m, md);
        if (day === null || day < startDay) continue; // Feb 30 etc. are skipped (RFC 5545)
        if (day > stopDay || !countLeft()) break;
        emit(day);
      }
    }
  }
  return out;
}

// --- main -------------------------------------------------------------------------
function parseIcs(text, { now = new Date(), tz = DEFAULT_TZ, channel = "GENERIC_ICAL" } = {}) {
  if (typeof text !== "string") throw new IcsError("NOT_ICALENDAR", "The link did not return a calendar");
  if (text.length > LIMITS.maxChars) throw new IcsError("TOO_LARGE", "That calendar is too large to import");
  tzLookupsLeft = TZ_LOOKUPS_PER_FILE;
  const lines = unfold(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  const firstReal = lines.find((l) => l.trim() !== "");
  if (!firstReal || firstReal.trim().toUpperCase() !== "BEGIN:VCALENDAR") {
    throw new IcsError("NOT_ICALENDAR", "The link did not return a calendar (it may be a web page or a login screen)");
  }

  const stats = { vevents: 0, events: 0, past: 0, beyondHorizon: 0, cancelled: 0, transparent: 0, recurring: 0, expanded: 0, duplicateUid: 0, missingUid: 0, invalid: 0, unknownTz: 0, unsupportedRule: 0, tooManyExceptions: 0 };
  const warn = (k) => {
    stats[k] = (stats[k] || 0) + 1;
  };
  const raw = [];
  const stack = [];
  let ev = null;
  let calendarClosed = false;
  for (const line of lines) {
    if (!line) continue;
    const p = parseLine(line);
    if (!p) continue;
    if (p.name === "BEGIN") {
      const comp = p.value.trim().toUpperCase();
      stack.push(comp);
      if (stack.length > 8) throw new IcsError("MALFORMED", "The calendar is not well-formed");
      if (comp === "VEVENT" && stack.length === 2 && stack[0] === "VCALENDAR") {
        stats.vevents += 1;
        if (stats.vevents > LIMITS.maxEvents) throw new IcsError("TOO_MANY_EVENTS", "The calendar has too many events");
        ev = { props: {}, exdates: [] };
      }
      continue;
    }
    if (p.name === "END") {
      const comp = p.value.trim().toUpperCase();
      if (stack[stack.length - 1] !== comp) throw new IcsError("MALFORMED", "The calendar is not well-formed");
      stack.pop();
      if (comp === "VEVENT" && ev && stack.length === 1) {
        raw.push(ev);
        ev = null;
      }
      if (comp === "VCALENDAR" && stack.length === 0) calendarClosed = true;
      continue;
    }
    if (!ev || stack[stack.length - 1] !== "VEVENT") continue; // VALARM, VTIMEZONE, calendar props
    if (p.name === "EXDATE") ev.exdates.push(p);
    else if (["UID", "DTSTART", "DTEND", "DURATION", "STATUS", "SUMMARY", "TRANSP", "RRULE", "RECURRENCE-ID"].includes(p.name) && !ev.props[p.name]) {
      ev.props[p.name] = p;
    }
  }
  if (!calendarClosed || stack.length) throw new IcsError("TRUNCATED", "The calendar response was cut off");

  const today = dayOfDate(now);
  const windowEnd = today + LIMITS.horizonDays;
  const unreadableUids = new Set();
  const candidates = []; // {key, uid, startDay, endDay, status, transparent, summaryKind, recurring, rid}
  const overrides = new Map(); // uid → Map(ridDay → candidate)
  let occurrencesTotal = 0;
  let exdatesTotal = 0;
  const ruleBudget = { left: LIMITS.maxFileRuleIterations };

  const uidOf = (p) => {
    const v = p.props.UID ? String(p.props.UID.value).trim() : "";
    return v.length > 255 ? `h:${crypto.createHash("sha256").update(v).digest("hex").slice(0, 40)}` : v;
  };

  const masters = [];
  for (const e of raw) {
    const uid = uidOf(e);
    const fail = () => {
      stats.invalid += 1;
      if (uid) unreadableUids.add(uid);
    };
    if (!e.props.DTSTART) {
      fail();
      continue;
    }
    const start = parseDateValue(e.props.DTSTART.value, e.props.DTSTART.params, tz, warn);
    if (!start) {
      fail();
      continue;
    }
    // Nights from instants (timed events; all-day dates are taken as
    // written): a stay that starts before noon, property time, reaches into
    // the previous night — whose guest has not checked out yet — and one
    // that ends after noon reaches into that day's night — the next guest
    // may already be checking in. A timed event therefore blocks every night
    // it touches, never fewer than its calendar dates suggest.
    const NOON = 12 * 60;
    const shift = start.kind === "datetime" && start.minute < NOON ? -1 : 0;
    let endDay;
    if (e.props.DTEND) {
      const end = parseDateValue(e.props.DTEND.value, e.props.DTEND.params, tz, warn);
      if (!end) {
        fail();
        continue;
      }
      if (start.kind === "datetime" && end.kind === "datetime" && end.ms < start.ms) {
        fail();
        continue;
      }
      endDay = end.day + (end.kind === "datetime" && end.minute > NOON ? 1 : 0);
      if (start.kind === "date" && end.kind === "date" && endDay < start.day) {
        fail();
        continue;
      }
    } else if (e.props.DURATION) {
      const dur = parseDuration(e.props.DURATION.value);
      if (!dur) {
        fail();
        continue;
      }
      if (start.kind === "date") endDay = start.day + dur.days;
      else {
        const endMs = start.ms + dur.seconds * 1000;
        endDay = localDay(endMs, tz) + (localMinutes(endMs, tz) > NOON ? 1 : 0);
      }
    } else {
      endDay = start.day + 1; // RFC: an all-day event without an end lasts one day; timed ones block their night (conservative)
    }
    const startDay = start.day + shift;
    if (endDay <= startDay) endDay = startDay + 1;
    const statusRaw = e.props.STATUS ? String(e.props.STATUS.value).trim().toUpperCase() : "CONFIRMED";
    const status = statusRaw === "CANCELLED" ? "cancelled" : statusRaw === "TENTATIVE" ? "tentative" : "confirmed";
    const transparent = !!(e.props.TRANSP && String(e.props.TRANSP.value).trim().toUpperCase() === "TRANSPARENT");
    const summaryKind = classifySummary(channel, e.props.SUMMARY ? unescapeText(e.props.SUMMARY.value).slice(0, 200) : "");
    // anchor: the DTSTART date itself — recurrence rules, EXDATE and
    // RECURRENCE-ID are defined on it; `startDay` may be one night earlier.
    const base = { uid, startDay, endDay, anchor: start.day, status, transparent, summaryKind };
    if (e.props["RECURRENCE-ID"]) {
      const rid = parseDateValue(e.props["RECURRENCE-ID"].value, e.props["RECURRENCE-ID"].params, tz, warn);
      if (!rid || !uid) {
        fail();
        continue;
      }
      if (!overrides.has(uid)) overrides.set(uid, new Map());
      overrides.get(uid).set(rid.day, { ...base, key: `${uid}#${ymd(rid.day)}`, recurring: true });
      continue;
    }
    masters.push({ e, base, startKind: start.kind });
  }

  for (const { e, base } of masters) {
    if (e.props.RRULE) {
      stats.recurring += 1;
      const rule = parseRule(e.props.RRULE.value, tz);
      if (rule.unsupported) {
        // Conservative: the first occurrence still blocks; the host is told.
        stats.unsupportedRule += 1;
        candidates.push({ ...base, key: base.uid || null, recurring: false });
        continue;
      }
      const length = base.endDay - base.startDay;
      const exdays = new Set();
      let exCount = 0;
      let exCapped = false;
      outer: for (const x of e.exdates) {
        for (const v of String(x.value).split(",")) {
          if (exCount >= LIMITS.maxExdatesPerEvent || exdatesTotal >= LIMITS.maxExdatesTotal) {
            exCapped = true;
            break outer;
          }
          exCount += 1;
          exdatesTotal += 1;
          const d = parseDateValue(v, x.params, tz, warn);
          if (d) exdays.add(d.day);
        }
      }
      if (exCapped) {
        exdays.clear();
        stats.tooManyExceptions += 1;
      }
      const shiftDays = base.startDay - base.anchor; // 0 or -1 (noon rule)
      const days = expandRule(rule, base.anchor, today - length - 2, windowEnd, ruleBudget);
      const ov = base.uid ? overrides.get(base.uid) : null;
      for (const day of days) {
        if (exdays.has(day)) continue;
        if (ov && ov.has(day)) continue; // replaced by its RECURRENCE-ID override below
        occurrencesTotal += 1;
        if (occurrencesTotal > LIMITS.maxOccurrencesTotal) throw new IcsError("TOO_MANY_OCCURRENCES", "The calendar's repeating events are too large to import");
        stats.expanded += 1;
        candidates.push({ ...base, startDay: day + shiftDays, endDay: day + shiftDays + length, key: base.uid ? `${base.uid}#${ymd(day)}` : null, recurring: true });
      }
    } else {
      candidates.push({ ...base, key: base.uid || null, recurring: false });
    }
  }
  for (const [, map] of overrides) for (const [, c] of map) candidates.push(c);

  // Keys: missing UIDs get a content key; duplicate UIDs are split by date.
  const groups = new Map();
  for (const c of candidates) {
    if (!c.key) {
      stats.missingUid += 1;
      c.key = `nouid:${crypto.createHash("sha256").update(`${c.startDay}|${c.endDay}|${c.status}`).digest("hex").slice(0, 24)}`;
    }
    if (!groups.has(c.key)) groups.set(c.key, []);
    groups.get(c.key).push(c);
  }
  // Two copies of one event starting the same day: a copy that blocks always
  // wins over one that does not — a cancelled or free duplicate must never
  // hide a booking, whatever the order or the lengths — and two blocking
  // copies merge into the longer stay.
  const blocks = (c) => c.status !== "cancelled" && !c.transparent;
  const better = (a, b) => (blocks(a) !== blocks(b) ? (blocks(a) ? a : b) : b.endDay > a.endDay ? b : a);
  const byKey = new Map();
  for (const [key, list] of groups) {
    const seen = new Set();
    const distinct = list.filter((c) => {
      const sig = `${c.startDay}|${c.endDay}|${c.status}|${c.transparent ? 1 : 0}`;
      if (seen.has(sig)) return false; // exact duplicate VEVENT
      seen.add(sig);
      return true;
    });
    if (distinct.length === 1) {
      const other = byKey.get(key); // a split key of another group can coincide
      byKey.set(key, other ? { ...better(other, distinct[0]), key } : distinct[0]);
      continue;
    }
    stats.duplicateUid += distinct.length - 1;
    for (const x of distinct) {
      const k = `${x.uid || x.key}#${ymd(x.startDay)}`;
      const other = byKey.get(k);
      byKey.set(k, other ? { ...better(other, x), key: k } : { ...x, key: k });
    }
  }

  const events = [];
  for (const c of byKey.values()) {
    if (c.endDay <= today) {
      stats.past += 1;
      continue;
    }
    if (c.startDay > windowEnd) {
      stats.beyondHorizon += 1;
      continue;
    }
    if (c.status === "cancelled") stats.cancelled += 1;
    if (c.transparent) stats.transparent += 1;
    events.push({
      key: c.key,
      uid: c.uid || null,
      startDay: ymd(c.startDay),
      endDay: ymd(c.endDay),
      status: c.status,
      transparent: c.transparent,
      summaryKind: c.summaryKind,
      recurring: !!c.recurring,
    });
  }
  if (events.length > LIMITS.maxRelevantEvents) throw new IcsError("TOO_MANY_EVENTS", "The calendar has too many upcoming events");
  events.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  stats.events = events.length;
  return { events, stats, unreadableUids: [...unreadableUids], contentHash: hashEvents(events, unreadableUids) };
}

function fingerprint(e) {
  return crypto.createHash("sha256").update(`${e.startDay}|${e.endDay}|${e.status}|${e.transparent ? 1 : 0}|${e.summaryKind}`).digest("hex").slice(0, 24);
}
// Identity of the *meaning* of a feed — Airbnb's body changes on every
// fetch (DTSTAMP), so the raw body cannot be used to skip work.
function hashEvents(events, unreadable = new Set()) {
  const h = crypto.createHash("sha256");
  for (const e of events) h.update(`${e.key}|${fingerprint(e)}\n`);
  for (const u of [...unreadable].sort()) h.update(`?${u}\n`);
  return h.digest("hex");
}

// Test hook: the time-zone caches must stay bounded whatever a feed sends.
const _cacheSizes = () => ({ zones: zoneCache.size, formatters: fmtCache.size });

module.exports = { parseIcs, fingerprint, hashEvents, IcsError, LIMITS, DAY_MS, ymd, dayFromYmd, resolveTz, expandRule, parseRule, localDay, DEFAULT_TZ, _cacheSizes };

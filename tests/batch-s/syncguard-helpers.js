// Shared fixtures for the SyncGuard suites: a scriptable fake OTA (real HTTP
// on loopback), ICS builders, DB snapshots and an evidence recorder.
// Loopback/http are allowed only through these test flags (refused on Vercel).
process.env.SYNC_ALLOW_HTTP = "1";
process.env.SYNC_TEST_ALLOW_LOOPBACK = "1";
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const DAY_MS = 86_400_000;
function day(offset, base = Date.now()) {
  return new Date(Math.floor(base / DAY_MS) * DAY_MS + offset * DAY_MS).toISOString().slice(0, 10);
}
const compact = (d) => d.replace(/-/g, "");

// events: [{ uid, start, end, summary?, status?, extra?: [lines] }] (start/end YYYY-MM-DD)
function vcal(events, { prodId = "-//Fake OTA//EN" } = {}) {
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", `PRODID:${prodId}`, "CALSCALE:GREGORIAN"];
  for (const e of events) {
    lines.push("BEGIN:VEVENT", `DTSTAMP:${new Date().toISOString().replace(/[-:]/g, "").slice(0, 15)}Z`);
    if (e.uid) lines.push(`UID:${e.uid}`);
    lines.push(`DTSTART;VALUE=DATE:${compact(e.start)}`, `DTEND;VALUE=DATE:${compact(e.end)}`);
    if (e.summary) lines.push(`SUMMARY:${e.summary}`);
    if (e.status) lines.push(`STATUS:${e.status}`);
    for (const x of e.extra || []) lines.push(x);
    lines.push("END:VEVENT");
  }
  lines.push("END:VCALENDAR");
  return lines.join("\r\n");
}

class FakeOta {
  constructor() {
    this.routes = new Map(); // path -> { status, body, delayMs, hang, headers }
    this.hits = new Map();
  }
  async start() {
    this.server = http.createServer((req, res) => {
      const p = new URL(req.url, "http://x").pathname;
      this.hits.set(p, (this.hits.get(p) || 0) + 1);
      const r = this.routes.get(p);
      if (!r) {
        res.writeHead(404);
        return res.end();
      }
      if (r.handler) return r.handler(req, res); // raw control: resets, trickles, endless or compressed bodies
      if (r.hang) return; // never answers
      // The body is captured when the request ARRIVES (a slow response
      // carries the feed as it was then), then released by delay or gate.
      const body = typeof r.body === "function" ? r.body() : r.body;
      const send = () => {
        if (res.destroyed) return;
        res.writeHead(r.status || 200, { "content-type": "text/calendar", ...(r.headers || {}) });
        res.end(body);
      };
      if (r.gate) r.gate.then(send);
      else if (r.delayMs) setTimeout(send, r.delayMs);
      else send();
    });
    await new Promise((r) => this.server.listen(0, "127.0.0.1", r));
    this.base = `http://127.0.0.1:${this.server.address().port}`;
    return this;
  }
  url(p) {
    return `${this.base}${p}`;
  }
  set(p, spec) {
    this.routes.set(p, spec);
  }
  events(p, events, extra = {}) {
    this.routes.set(p, { body: vcal(events), ...extra });
  }
  count(p) {
    return this.hits.get(p) || 0;
  }
  resetHits() {
    this.hits.clear();
  }
  async stop() {
    if (this.server) {
      this.server.closeAllConnections && this.server.closeAllConnections();
      await new Promise((r) => this.server.close(r));
    }
  }
}

// --- DB snapshots (evidence of state, not just HTTP) --------------------------
async function snapshot(propertyId) {
  const Booking = require("../../models/Booking");
  const BookingNight = require("../../models/BookingNight");
  const ExternalCalendar = require("../../models/ExternalCalendar");
  const [rows, nights, conns] = await Promise.all([
    Booking.find({ propertyId }).sort({ checkIn: 1, _id: 1 }).lean(),
    BookingNight.find({ propertyId }).sort({ date: 1 }).lean(),
    ExternalCalendar.find({ propertyId }).lean(),
  ]);
  const dayOf = (d) => new Date(d).toISOString().slice(0, 10);
  return {
    bookings: rows.map((b) => ({
      id: String(b._id),
      source: b.source,
      action: b.action,
      status: b.status,
      paymentStatus: b.paymentStatus,
      checkIn: dayOf(b.checkIn),
      checkOut: dayOf(b.checkOut),
      hostOk: String(b.hostId),
      ...(b.external ? { channel: b.external.channel, key: b.external.key, state: b.external.state, echo: !!(b.external.echo && b.external.echo.suspect), conflict: b.external.conflict && b.external.conflict.at ? { kind: b.external.conflict.kind, likelyMirror: !!b.external.conflict.likelyMirror } : null, missingSyncs: b.external.missingSyncs || 0, connectionId: String(b.external.connectionId) } : {}),
      needsAttention: b.needsAttention || null,
    })),
    nights: nights.map((n) => ({ date: dayOf(n.date), bookingId: String(n.bookingId), kind: n.kind, hold: !!n.expiresAt })),
    connections: conns.map((c) => ({ id: String(c._id), kind: c.kind, channel: c.channel, status: c.status || "active", health: c.sync ? { failures: c.sync.consecutiveFailures || 0, lastSuccessAt: c.sync.lastSuccessAt || null, anomaly: c.sync.anomaly || null, pendingMissing: c.sync.pendingMissing || 0 } : null })),
  };
}
// Night → owner kind map, e.g. { "2026-10-12": "ical" }
async function nightOwners(propertyId) {
  const s = await snapshot(propertyId);
  const byId = new Map(s.bookings.map((b) => [b.id, b]));
  const out = {};
  for (const n of s.nights) {
    const b = byId.get(n.bookingId);
    out[n.date] = b ? (b.source === "ical" ? `ical:${b.channel || "?"}` : b.action === "host" ? "host" : n.hold ? "hold" : "booking") : "orphan";
  }
  return out;
}

// --- evidence -----------------------------------------------------------------------
// Outside the repo (D:/majestic-escape/tests/syncguard-evidence by default).
const EVIDENCE_DIR = process.env.SYNCGUARD_EVIDENCE_DIR || path.join(__dirname, "..", "..", "..", "tests", "syncguard-evidence");
function evidence(suite) {
  const file = path.join(EVIDENCE_DIR, `${suite}.jsonl`);
  let opened = false;
  return function record(scenario, data) {
    if (process.env.SYNCGUARD_EVIDENCE !== "1") return;
    if (!opened) {
      fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
      fs.writeFileSync(file, "");
      opened = true;
    }
    fs.appendFileSync(file, `${JSON.stringify({ scenario, at: new Date().toISOString(), ...data })}\n`);
  };
}

module.exports = { DAY_MS, day, vcal, FakeOta, snapshot, nightOwners, evidence };

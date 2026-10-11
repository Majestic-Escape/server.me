// SyncGuard release gate: red-team pass on the calendar fetcher and parser.
// Complements syncguard-ssrf.test.js with the remaining URL / DNS / redirect
// forms and hostile payloads, and measures CPU and memory for each payload.
const { test, before, after } = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const { normaliseUrl, resolvePublic, isPublicAddress, safeFetch, _requestOnce } = require("../../services/calendarSync/safeFetch");
const ics = require("../../services/calendarSync/icsReader");
const S = require("./syncguard-helpers");

const record = S.evidence("redteam");
const STRICT = { allowHttp: false, allowLoopback: false };
const codeOf = (fn) => {
  try {
    fn();
    return "ok";
  } catch (e) {
    return e.code || e.message;
  }
};

test("URL forms an attacker would try are refused before any network use", () => {
  const cases = {
    // trailing dots, encodings, confusion
    "https://localhost./c.ics": "PRIVATE_ADDRESS",
    "https://metadata.google.internal./c.ics": "PRIVATE_ADDRESS",
    "https://printer.local./c.ics": "PRIVATE_ADDRESS",
    "https://%31%32%37.0.0.1/c.ics": "PRIVATE_ADDRESS",
    "https://%6c%6f%63%61%6c%68%6f%73%74/c.ics": "PRIVATE_ADDRESS",
    "https://evil.example.org@127.0.0.1/c.ics": "INVALID_URL",
    "https://127.0.0.1#@evil.example.org/c.ics": "PRIVATE_ADDRESS",
    "https://127.0.0.1:443@evil.example.org/c.ics": "INVALID_URL",
    "https://0x7f000001/c.ics": "PRIVATE_ADDRESS",
    "https://017700000001/c.ics": "PRIVATE_ADDRESS",
    "https://127.000.000.001/c.ics": "PRIVATE_ADDRESS",
    // IPv6 literals of every tunnelled kind (hostnames only — but checked anyway)
    "https://[::]/c.ics": "PRIVATE_ADDRESS",
    "https://[0:0:0:0:0:0:0:1]/c.ics": "PRIVATE_ADDRESS",
    "https://[fe80::1]/c.ics": "PRIVATE_ADDRESS",
    "https://[::ffff:a9fe:a9fe]/c.ics": "PRIVATE_ADDRESS",
    "https://[64:ff9b::a9fe:a9fe]/c.ics": "PRIVATE_ADDRESS",
    "https://[2002:a9fe:a9fe::1]/c.ics": "PRIVATE_ADDRESS",
    "https://[2001:0:4136:e378:8000:63bf:3fff:fdd2]/c.ics": "PRIVATE_ADDRESS",
    // schemes and ports
    "file:///etc/passwd": "INVALID_URL",
    "ftp://example.org/c.ics": "INVALID_URL",
    "gopher://example.org/_x": "INVALID_URL",
    "data:text/calendar,BEGIN:VCALENDAR": "INVALID_URL",
    "javascript:alert(1)": "INVALID_URL",
    "ws://example.org/c": "INVALID_URL",
    "http://example.org/c.ics": "HTTPS_REQUIRED",
    "https://example.org:22/c.ics": "INVALID_URL",
    "https://example.org:80/c.ics": "INVALID_URL",
    "https://example.org:8080/c.ics": "INVALID_URL",
    "webcal://calendar.example.org/c.ics": "ok",
    "https://calendar.example.org./c.ics": "ok", // a public name with a trailing dot is fine; DNS decides
  };
  const got = {};
  for (const [u, want] of Object.entries(cases)) {
    got[u] = codeOf(() => normaliseUrl(u, STRICT));
    assert.strictEqual(got[u], want, u);
  }
  record("url-forms", got);
});

test("every private / reserved / tunnelled DNS answer is refused (alone or mixed with a public one)", async () => {
  const privateAnswers = ["127.0.0.1", "127.255.255.254", "0.0.0.0", "10.1.2.3", "172.16.0.1", "192.168.0.1", "169.254.169.254", "100.64.0.1", "198.18.0.1", "192.0.2.1", "198.51.100.1", "203.0.113.1", "224.0.0.1", "255.255.255.255", "::", "::1", "fe80::1", "fd00::1", "fc00::1", "::ffff:10.0.0.1", "::ffff:169.254.169.254", "64:ff9b::7f00:1", "2002:7f00:1::1", "2001:0:4136:e378:8000:63bf:3fff:fdd2", "ff02::1"];
  for (const a of privateAnswers) {
    assert.strictEqual(isPublicAddress(a), false, a);
    for (const answers of [[a], ["93.184.216.34", a]]) {
      const fam = a.includes(":") ? 6 : 4;
      await assert.rejects(
        resolvePublic("cal.example.org", { resolve: async () => answers.map((x) => ({ address: x, family: x.includes(":") ? 6 : fam === 6 ? 6 : 4 })) }),
        (e) => e.code === "PRIVATE_ADDRESS",
        JSON.stringify(answers),
      );
    }
  }
  for (const a of ["93.184.216.34", "2606:2800:220:1:248:1893:25c8:1946", "8.8.8.8"]) assert.strictEqual(isPublicAddress(a), true, a);
});

test("DNS rebinding: the request goes to the address that was validated, never to a second lookup's answer", async () => {
  // A local server stands in for "the attacker's internal target".
  const hits = [];
  const srv = http.createServer((req, res) => {
    hits.push(req.headers.host);
    res.writeHead(200, { "content-type": "text/calendar" });
    res.end("BEGIN:VCALENDAR\r\nEND:VCALENDAR");
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const port = srv.address().port;
  try {
    // Pinned to a public (unroutable here) address: the socket must try THAT
    // address and fail — not quietly reach the loopback server.
    const pinned = [{ address: "192.0.2.10", family: 4 }];
    await assert.rejects(_requestOnce(`http://rebind.example.org:${port}/c.ics`, { headers: {}, deadline: Date.now() + 800, addrs: pinned }), (e) => ["CONNECTION_FAILED", "TIMEOUT"].includes(e.code));
    assert.strictEqual(hits.length, 0, "the loopback target was never reached");
    // …and pinned to the loopback address it does reach it (control)
    const ok = await _requestOnce(`http://rebind.example.org:${port}/c.ics`, { headers: {}, deadline: Date.now() + 2000, addrs: [{ address: "127.0.0.1", family: 4 }] });
    assert.strictEqual(ok.status, 200);
    assert.strictEqual(hits.length, 1);
  } finally {
    srv.close();
  }
});

test("redirect chains: ≤ 3 hops, each re-validated; a public → private hop is refused", async () => {
  let n = 0;
  const srv = http.createServer((req, res) => {
    n += 1;
    const step = Number(new URL(req.url, "http://x").searchParams.get("s") || 0);
    if (req.url.startsWith("/loop")) {
      res.writeHead(302, { location: `/loop?s=${step + 1}` });
      return res.end();
    }
    if (req.url.startsWith("/private")) {
      res.writeHead(302, { location: "http://10.0.0.7/c.ics" });
      return res.end();
    }
    res.writeHead(200, { "content-type": "text/calendar" });
    res.end("BEGIN:VCALENDAR\r\nEND:VCALENDAR");
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    await assert.rejects(safeFetch(`${base}/loop`, { timeoutMs: 3000 }), (e) => e.code === "TOO_MANY_REDIRECTS");
    assert.strictEqual(n, 4, "the original request + 3 redirects, never a 5th");
    await assert.rejects(safeFetch(`${base}/private`, { timeoutMs: 3000 }), (e) => e.code === "PRIVATE_ADDRESS");
  } finally {
    srv.close();
  }
});

function measure(fn) {
  global.gc && global.gc();
  const h0 = process.memoryUsage().heapUsed;
  const t0 = process.hrtime.bigint();
  let out;
  try {
    out = fn();
  } catch (e) {
    out = { error: e.code || e.message };
  }
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  const heapMb = (process.memoryUsage().heapUsed - h0) / 1048576;
  return { ms, heapMb, out };
}
const wrap = (lines) => ["BEGIN:VCALENDAR", "VERSION:2.0", ...lines, "END:VCALENDAR"].join("\r\n");
const NOW = new Date("2026-10-03T06:00:00Z");

test("hostile payloads stay bounded in CPU and memory, and never yield an empty success", () => {
  const big = (n) => "x".repeat(n);
  const payloads = {
    "one 1.9 MB line": wrap(["BEGIN:VEVENT", "UID:a", "DTSTART;VALUE=DATE:20261010", "DTEND;VALUE=DATE:20261011", `SUMMARY:${big(1.9 * 1024 * 1024)}`, "END:VEVENT"]),
    "1.9 MB DESCRIPTION folded in 74-char lines": wrap(["BEGIN:VEVENT", "UID:b", "DTSTART;VALUE=DATE:20261010", "DTEND;VALUE=DATE:20261011", "DESCRIPTION:x", ...Array.from({ length: 25_000 }, () => ` ${big(73)}`), "END:VEVENT"]),
    "5 001 VEVENTs": wrap(Array.from({ length: 5001 }, (_, i) => ["BEGIN:VEVENT", `UID:e${i}`, "DTSTART;VALUE=DATE:20300101", "END:VEVENT"]).flat()),
    "900 future events": wrap(Array.from({ length: 900 }, (_, i) => ["BEGIN:VEVENT", `UID:f${i}`, `DTSTART;VALUE=DATE:${20270101 + (i % 28)}`, "END:VEVENT"]).flat()),
    "50 001 lines": wrap(Array.from({ length: 50_001 }, () => "X-PAD:1")),
    "nested components 9 deep": wrap([...Array.from({ length: 9 }, (_, i) => `BEGIN:X${i}`), ...Array.from({ length: 9 }, (_, i) => `END:X${8 - i}`)]),
    "hostile unicode / control chars": wrap(["BEGIN:VEVENT", "UID:‮‍\u0000evil", "DTSTART;VALUE=DATE:20261010", "DTEND;VALUE=DATE:20261011", "SUMMARY:𐏿‮<script>alert(1)</script>", "END:VEVENT"]),
    "UID of 1 MB": wrap(["BEGIN:VEVENT", `UID:${big(1024 * 1024)}`, "DTSTART;VALUE=DATE:20261010", "DTEND;VALUE=DATE:20261011", "END:VEVENT"]),
  };
  const results = {};
  for (const [name, text] of Object.entries(payloads)) {
    const r = measure(() => ics.parseIcs(text, { now: NOW }));
    results[name] = { ms: Math.round(r.ms), heapMb: Math.round(r.heapMb * 10) / 10, result: r.out.error || `${r.out.events.length} events` };
    assert.ok(r.ms < 1500, `${name}: ${r.ms} ms`);
    assert.ok(r.heapMb < 120, `${name}: +${r.heapMb} MB heap`);
    if (!r.out.error) assert.ok(r.out.events.length > 0 || r.out.unreadableUids.length > 0, `${name}: an empty success would release bookings`);
  }
  assert.match(results["5 001 VEVENTs"].result, /TOO_MANY_EVENTS/);
  assert.match(results["900 future events"].result, /TOO_MANY_EVENTS/);
  assert.match(results["50 001 lines"].result, /TOO_LARGE|TOO_MANY/);
  assert.match(results["nested components 9 deep"].result, /MALFORMED/);
  // a giant UID is reduced to a fixed-size hash key (never stored raw)
  const giant = ics.parseIcs(payloads["UID of 1 MB"], { now: NOW });
  assert.ok(giant.events[0].key.length < 64, giant.events[0].key.slice(0, 80));
  record("payloads", results);
});

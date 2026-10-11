// SyncGuard: SSRF hardening of the calendar fetcher
// (services/calendarSync/safeFetch.js). Local servers only.
const { test, before, after } = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const zlib = require("node:zlib");
// Built once: compressing 40 MB per request could hit the fetch deadline on a loaded machine.
const GZIP_BOMB = zlib.gzipSync(Buffer.alloc(40 * 1024 * 1024, 0));

// Loopback test servers are reachable only with these flags (refused on Vercel).
process.env.SYNC_ALLOW_HTTP = "1";
process.env.SYNC_TEST_ALLOW_LOOPBACK = "1";
const { safeFetch, normaliseUrl, isPublicAddress, resolvePublic, FetchError } = require("../../services/calendarSync/safeFetch");

const ICS = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR\r\n";
let server;
let base;
const hits = [];
before(async () => {
  server = http.createServer((req, res) => {
    hits.push(req.url);
    const u = new URL(req.url, "http://x");
    switch (u.pathname) {
      case "/ok.ics":
        res.writeHead(200, { "content-type": "text/calendar", etag: '"v1"' });
        return res.end(ICS);
      case "/etag.ics":
        if (req.headers["if-none-match"] === '"v1"') {
          res.writeHead(304);
          return res.end();
        }
        res.writeHead(200, { etag: '"v1"' });
        return res.end(ICS);
      case "/to-metadata":
        res.writeHead(302, { location: "http://169.254.169.254/latest/meta-data/" });
        return res.end();
      case "/to-private":
        res.writeHead(301, { location: "https://10.0.0.5/cal.ics" });
        return res.end();
      case "/to-localhost":
        res.writeHead(302, { location: `http://localhost:${server.address().port}/ok.ics` });
        return res.end();
      case "/to-file":
        res.writeHead(302, { location: "file:///etc/passwd" });
        return res.end();
      case "/loop":
        res.writeHead(302, { location: "/loop" });
        return res.end();
      case "/hop":
        res.writeHead(307, { location: "/ok.ics" });
        return res.end();
      case "/big": {
        res.writeHead(200);
        const chunk = Buffer.alloc(64 * 1024, 65);
        let sent = 0;
        const pump = () => {
          while (sent < 3 * 1024 * 1024) {
            sent += chunk.length;
            if (!res.write(chunk)) return res.once("drain", pump);
          }
          res.end();
        };
        return pump();
      }
      case "/declared-big":
        res.writeHead(200, { "content-length": String(50 * 1024 * 1024) });
        return res.end("x");
      case "/gzip-bomb": {
        const bomb = GZIP_BOMB; // built once (top of file)
        res.writeHead(200, { "content-encoding": "gzip" });
        return res.end(bomb);
      }
      case "/gzip-ok":
        res.writeHead(200, { "content-encoding": "gzip" });
        return res.end(zlib.gzipSync(Buffer.from(ICS)));
      case "/slow":
        return; // never answers
      case "/drip":
        res.writeHead(200);
        res.write("BEGIN:VCALENDAR\r\n");
        return; // body never ends
      case "/404":
        res.writeHead(404);
        return res.end();
      case "/403":
        res.writeHead(403);
        return res.end();
      case "/429":
        res.writeHead(429, { "retry-after": "120" });
        return res.end();
      case "/500":
        res.writeHead(500);
        return res.end();
      case "/weird-encoding":
        res.writeHead(200, { "content-encoding": "compress" });
        return res.end("x");
      default:
        res.writeHead(404);
        res.end();
    }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const codeOf = async (p) => {
  try {
    await p;
  } catch (err) {
    return err instanceof FetchError ? err.code : `other:${err.message}`;
  }
  return "no-error";
};
const strict = { allowHttp: false, allowLoopback: false };
const normCode = (u) => {
  try {
    normaliseUrl(u, strict);
  } catch (err) {
    return err.code;
  }
  return "ok";
};

test("URL validation: schemes, credentials, IP literals in every encoding, internal names, ports", () => {
  const cases = {
    "https://www.airbnb.co.in/calendar/ical/123.ics?s=abc": "ok",
    "webcal://calendar.google.com/calendar/ical/x/basic.ics": "ok",
    "http://www.airbnb.co.in/x.ics": "HTTPS_REQUIRED",
    "file:///etc/passwd": "INVALID_URL",
    "ftp://example.com/x.ics": "INVALID_URL",
    "gopher://example.com:70/_x": "INVALID_URL",
    "javascript:alert(1)": "INVALID_URL",
    "data:text/calendar,BEGIN:VCALENDAR": "INVALID_URL",
    "https://user:pass@example.com/x.ics": "INVALID_URL",
    "https://127.0.0.1/x.ics": "PRIVATE_ADDRESS",
    "https://2130706433/x.ics": "PRIVATE_ADDRESS", // decimal 127.0.0.1
    "https://0x7f.0.0.1/x.ics": "PRIVATE_ADDRESS", // hex
    "https://0177.0.0.1/x.ics": "PRIVATE_ADDRESS", // octal
    "https://127.1/x.ics": "PRIVATE_ADDRESS", // short form
    "https://0.0.0.0/x.ics": "PRIVATE_ADDRESS",
    "https://169.254.169.254/latest/meta-data/": "PRIVATE_ADDRESS",
    "https://[::1]/x.ics": "PRIVATE_ADDRESS",
    "https://[::ffff:127.0.0.1]/x.ics": "PRIVATE_ADDRESS",
    "https://[fd00:ec2::254]/x.ics": "PRIVATE_ADDRESS",
    "https://8.8.8.8/x.ics": "PRIVATE_ADDRESS", // even public IP literals: hostnames only
    "https://localhost/x.ics": "PRIVATE_ADDRESS",
    "https://intranet/x.ics": "PRIVATE_ADDRESS",
    "https://metadata.google.internal/x": "PRIVATE_ADDRESS",
    "https://service.railway.internal/x": "PRIVATE_ADDRESS",
    "https://printer.local/x": "PRIVATE_ADDRESS",
    "https://example.com:8443/x.ics": "INVALID_URL",
    "https://example.com:443/x.ics": "ok",
    "https://exa mple.com/x.ics": "INVALID_URL",
    "https://example.com/\u0000x.ics": "INVALID_URL",
    [`https://example.com/${"a".repeat(3000)}`]: "INVALID_URL",
    "": "INVALID_URL",
  };
  for (const [u, want] of Object.entries(cases)) assert.strictEqual(normCode(u), want, u);
  assert.strictEqual(normaliseUrl("webcal://calendar.google.com/x.ics#frag", strict), "https://calendar.google.com/x.ics");
});

test("address classification covers private, reserved, metadata and tunnelled ranges", () => {
  const blocked = ["10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "127.0.0.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1", "255.255.255.255", "198.18.0.1", "192.0.2.1",
    "::1", "::", "::ffff:8.8.8.8", "::ffff:10.0.0.1", "64:ff9b::a00:1", "2002:a00:1::1", "2001:0:4136:e378::1", "fd12:3456::1", "fc00::1", "fe80::1", "ff02::1", "2001:db8::1", "100::1", "::127.0.0.1"];
  const allowed = ["8.8.8.8", "54.230.1.2", "172.15.0.1", "172.32.0.1", "2606:4700:4700::1111", "2a00:1450:4001::1"];
  for (const ip of blocked) assert.strictEqual(isPublicAddress(ip), false, ip);
  for (const ip of allowed) assert.strictEqual(isPublicAddress(ip), true, ip);
});

test("DNS: a name resolving to any private address is refused (incl. mixed answers)", async () => {
  const fake = (map) => async (h) => map[h];
  const resolve = fake({
    "evil.example.com": [{ address: "10.0.0.7", family: 4 }],
    "mixed.example.com": [{ address: "93.184.215.14", family: 4 }, { address: "127.0.0.1", family: 4 }],
    "v6.example.com": [{ address: "fd00::1", family: 6 }],
    "good.example.com": [{ address: "93.184.215.14", family: 4 }],
  });
  assert.strictEqual(await codeOf(resolvePublic("evil.example.com", { resolve })), "PRIVATE_ADDRESS");
  assert.strictEqual(await codeOf(resolvePublic("mixed.example.com", { resolve })), "PRIVATE_ADDRESS");
  assert.strictEqual(await codeOf(resolvePublic("v6.example.com", { resolve })), "PRIVATE_ADDRESS");
  assert.deepStrictEqual(await resolvePublic("good.example.com", { resolve }), [{ address: "93.184.215.14", family: 4 }]);
  assert.strictEqual(await codeOf(resolvePublic("nx.example.com", { resolve: async () => { const e = new Error("x"); e.code = "ENOTFOUND"; throw e; } })), "DNS_FAILED");
});

test("the socket connects to the validated (pinned) address, not a second lookup", async () => {
  // "pinned-check.example.com" does not resolve on the internet. The request
  // is given the validated address list; landing on our local server (with
  // the original Host header) proves Node never performed its own lookup —
  // there is no window for a DNS-rebinding answer between check and connect.
  const { _requestOnce } = require("../../services/calendarSync/safeFetch");
  const port = server.address().port;
  let hostHeader = null;
  server.once("request", (req) => {
    hostHeader = req.headers.host;
  });
  const res = await _requestOnce(`http://pinned-check.example.com:${port}/ok.ics`, {
    headers: { "user-agent": "t" },
    deadline: Date.now() + 2000,
    addrs: [{ address: "127.0.0.1", family: 4 }],
  });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body, ICS);
  assert.strictEqual(hostHeader, `pinned-check.example.com:${port}`);
  // and through the public API a non-default port on a hostname is refused even in test mode
  const viaApi = await safeFetch(`http://calendar.example.com:${port}/ok.ics`, { resolve: async () => [{ address: "127.0.0.1", family: 4 }] }).catch((e) => e);
  assert.strictEqual(viaApi.code, "INVALID_URL");
  const ok = await safeFetch(`${base}/ok.ics`, { resolve: async () => { throw new Error("must not resolve an IP literal"); } });
  assert.strictEqual(ok.status, 200);
  assert.strictEqual(ok.body, ICS);
  assert.strictEqual(ok.headers.etag, '"v1"');
});

test("redirects are re-validated on every hop", async () => {
  assert.strictEqual(await codeOf(safeFetch(`${base}/to-metadata`)), "PRIVATE_ADDRESS");
  assert.strictEqual(await codeOf(safeFetch(`${base}/to-private`)), "PRIVATE_ADDRESS");
  assert.strictEqual(await codeOf(safeFetch(`${base}/to-localhost`)), "PRIVATE_ADDRESS");
  assert.strictEqual(await codeOf(safeFetch(`${base}/to-file`)), "INVALID_URL");
  assert.strictEqual(await codeOf(safeFetch(`${base}/loop`)), "TOO_MANY_REDIRECTS");
  const hop = await safeFetch(`${base}/hop`);
  assert.strictEqual(hop.status, 200);
  assert.match(hop.finalUrl, /\/ok\.ics$/);
});

test("size limits hold on the wire and after decompression", async () => {
  assert.strictEqual(await codeOf(safeFetch(`${base}/big`)), "BODY_TOO_LARGE");
  assert.strictEqual(await codeOf(safeFetch(`${base}/declared-big`)), "BODY_TOO_LARGE");
  const before = process.memoryUsage().rss;
  assert.strictEqual(await codeOf(safeFetch(`${base}/gzip-bomb`)), "BODY_TOO_LARGE");
  assert.ok(process.memoryUsage().rss - before < 64 * 1024 * 1024, "gzip bomb not inflated into memory");
  const gz = await safeFetch(`${base}/gzip-ok`);
  assert.strictEqual(gz.body, ICS);
  assert.strictEqual(await codeOf(safeFetch(`${base}/weird-encoding`)), "UNSUPPORTED_ENCODING");
});

test("one deadline covers connect, headers and body (slow loris)", async () => {
  const t0 = Date.now();
  assert.strictEqual(await codeOf(safeFetch(`${base}/slow`, { timeoutMs: 400 })), "TIMEOUT");
  assert.strictEqual(await codeOf(safeFetch(`${base}/drip`, { timeoutMs: 400 })), "TIMEOUT");
  assert.ok(Date.now() - t0 < 2000);
});

test("HTTP status mapping and conditional requests", async () => {
  assert.strictEqual(await codeOf(safeFetch(`${base}/404`)), "NOT_FOUND");
  assert.strictEqual(await codeOf(safeFetch(`${base}/403`)), "AUTH_REFUSED");
  const rl = await safeFetch(`${base}/429`).catch((e) => e);
  assert.strictEqual(rl.code, "RATE_LIMITED");
  assert.strictEqual(rl.retryAfter, "120");
  assert.strictEqual(await codeOf(safeFetch(`${base}/500`)), "UPSTREAM_ERROR");
  const nm = await safeFetch(`${base}/etag.ics`, { etag: '"v1"' });
  assert.strictEqual(nm.status, 304);
  const fresh = await safeFetch(`${base}/etag.ics`);
  assert.strictEqual(fresh.status, 200);
});

test("connection refused / DNS failure are transient errors with plain messages (no URL echoed)", async () => {
  const dead = http.createServer();
  await new Promise((r) => dead.listen(0, "127.0.0.1", r));
  const port = dead.address().port;
  await new Promise((r) => dead.close(r));
  const err = await safeFetch(`http://127.0.0.1:${port}/x.ics?secret=TOPSECRET`).catch((e) => e);
  assert.strictEqual(err.code, "CONNECTION_FAILED");
  assert.ok(!String(err.message).includes("TOPSECRET"));
});

test("test-mode overrides are refused on a deployment", () => {
  process.env.VERCEL = "1";
  try {
    assert.strictEqual(normCode("http://127.0.0.1/x.ics"), "HTTPS_REQUIRED");
    assert.throws(() => normaliseUrl("http://127.0.0.1:9/x.ics"), (e) => e.code === "HTTPS_REQUIRED");
    assert.throws(() => normaliseUrl("https://127.0.0.1/x.ics"), (e) => e.code === "PRIVATE_ADDRESS");
  } finally {
    delete process.env.VERCEL;
  }
});

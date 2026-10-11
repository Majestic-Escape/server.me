// SSRF-hardened GET for host-supplied calendar URLs (docs/syncguard.md §8).
//
// Hosts paste arbitrary URLs and the server fetches them, so this is the
// most dangerous code path of SyncGuard. Rules:
//   * https only (`webcal(s)://` is normalised to https://). `http://` only
//     when SYNC_ALLOW_HTTP=1 (local tests; refused on Vercel).
//   * No credentials in the URL, no IP-literal hosts (any encoding — the
//     WHATWG parser normalises 0x7f.1, 2130706433, … to dotted quads first),
//     no single-label or internal-suffix hostnames, default ports only.
//   * DNS is resolved here and EVERY answer must be a public unicast
//     address; the socket then connects to the validated address (Node's
//     `lookup` hook), so a rebinding answer between "check" and "connect"
//     cannot happen. TLS still verifies the certificate for the hostname.
//   * Redirects are followed manually (≤ 3) and every hop is re-validated.
//   * No proxy environment variables, no cookies, no keep-alive.
//   * Body ≤ 2 MB on the wire and after decompression; one deadline for the
//     whole exchange (connect, redirects, body).
const dns = require("node:dns");
const net = require("node:net");
const http = require("node:http");
const https = require("node:https");
const zlib = require("node:zlib");

const MAX_BYTES = 2 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const MAX_URL_LENGTH = 2048;
const DEFAULT_TIMEOUT_MS = 10_000;
const USER_AGENT = "MajesticEscape-CalendarSync/1.0 (+https://majesticescape.in)";
const BLOCKED_SUFFIXES = [".local", ".localhost", ".internal", ".lan", ".home", ".corp", ".intranet", ".localdomain", ".arpa", ".invalid", ".test", ".example", ".onion"];

class FetchError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.code = code;
    Object.assign(this, extra);
  }
}

function testOverrides() {
  // Loopback test servers are reachable only in explicit test runs, never on
  // a deployment.
  const onPlatform = !!(process.env.VERCEL || process.env.VERCEL_ENV);
  return {
    allowHttp: process.env.SYNC_ALLOW_HTTP === "1" && !onPlatform,
    allowLoopback: process.env.SYNC_TEST_ALLOW_LOOPBACK === "1" && !onPlatform && process.env.NODE_ENV !== "production",
  };
}

// --- address classification ----------------------------------------------

function ipv4ToInt(ip) {
  const p = ip.split(".").map(Number);
  return ((p[0] << 24) >>> 0) + (p[1] << 16) + (p[2] << 8) + p[3];
}
const V4_BLOCKS = [
  ["0.0.0.0", 8], // "this" network
  ["10.0.0.0", 8], // RFC 1918
  ["100.64.0.0", 10], // CGNAT
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local, cloud metadata (169.254.169.254)
  ["172.16.0.0", 12], // RFC 1918
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.0.2.0", 24], // TEST-NET-1
  ["192.88.99.0", 24], // 6to4 relay anycast
  ["192.168.0.0", 16], // RFC 1918
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24], // TEST-NET-2
  ["203.0.113.0", 24], // TEST-NET-3
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved + broadcast
].map(([base, bits]) => ({ base: ipv4ToInt(base), mask: bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0 }));

function isPublicIPv4(ip) {
  const n = ipv4ToInt(ip);
  return !V4_BLOCKS.some((b) => ((n & b.mask) >>> 0) === ((b.base & b.mask) >>> 0));
}

// Expands an IPv6 literal (with optional embedded IPv4) to 8 16-bit words.
function ipv6Words(ip) {
  let s = ip.toLowerCase();
  const zone = s.indexOf("%");
  if (zone >= 0) s = s.slice(0, zone);
  let tail = [];
  const lastColon = s.lastIndexOf(":");
  if (s.includes(".")) {
    const v4 = s.slice(lastColon + 1);
    if (net.isIPv4(v4)) {
      const n = ipv4ToInt(v4);
      tail = [(n >>> 16) & 0xffff, n & 0xffff];
      s = s.slice(0, lastColon + 1) + "0:0";
    }
  }
  const [head, rest] = s.split("::");
  const h = head ? head.split(":").filter((x) => x !== "") : [];
  const r = rest !== undefined && rest !== "" ? rest.split(":").filter((x) => x !== "") : [];
  const fill = s.includes("::") ? 8 - h.length - r.length : 0;
  const words = [...h, ...Array(Math.max(0, fill)).fill("0"), ...r].map((x) => parseInt(x, 16));
  if (tail.length) {
    words[6] = tail[0];
    words[7] = tail[1];
  }
  return words.length === 8 && words.every((w) => Number.isInteger(w) && w >= 0 && w <= 0xffff) ? words : null;
}
function isPublicIPv6(ip) {
  const w = ipv6Words(ip);
  if (!w) return false;
  const allZero = (from, to) => w.slice(from, to).every((x) => x === 0);
  if (allZero(0, 8)) return false; // ::
  if (allZero(0, 7) && w[7] === 1) return false; // ::1
  if (allZero(0, 5) && w[5] === 0xffff) return false; // IPv4-mapped (::ffff:a.b.c.d): never connect via v6
  if (allZero(0, 6)) return false; // IPv4-compatible (deprecated)
  if (w[0] === 0x64 && w[1] === 0xff9b) return false; // NAT64 64:ff9b::/96 and 64:ff9b:1::/48
  if (w[0] === 0x2002) return false; // 6to4 (embeds an arbitrary IPv4)
  if (w[0] === 0x2001 && w[1] === 0x0000) return false; // Teredo
  if (w[0] === 0x2001 && w[1] === 0x0db8) return false; // documentation
  if (w[0] === 0x0100 && allZero(1, 4)) return false; // discard 100::/64
  if ((w[0] & 0xfe00) === 0xfc00) return false; // unique local fc00::/7 (Railway/AWS internal)
  if ((w[0] & 0xffc0) === 0xfe80) return false; // link-local
  if ((w[0] & 0xffc0) === 0xfec0) return false; // site-local (deprecated)
  if ((w[0] & 0xff00) === 0xff00) return false; // multicast
  return (w[0] & 0xe000) === 0x2000; // only global unicast 2000::/3
}

function isPublicAddress(ip) {
  if (net.isIPv4(ip)) return isPublicIPv4(ip);
  if (net.isIPv6(ip)) return isPublicIPv6(ip);
  return false;
}
function isLoopback(ip) {
  return (net.isIPv4(ip) && ip.startsWith("127.")) || ip === "::1";
}

// --- URL validation --------------------------------------------------------

// Returns a normalised URL string or throws FetchError. Never echo the URL
// back in messages: it is a credential (the OTA's secret calendar link).
function normaliseUrl(raw, { allowHttp = testOverrides().allowHttp, allowLoopback = testOverrides().allowLoopback } = {}) {
  if (typeof raw !== "string") throw new FetchError("INVALID_URL", "Enter the calendar link");
  let s = raw.trim();
  if (!s) throw new FetchError("INVALID_URL", "Enter the calendar link");
  if (s.length > MAX_URL_LENGTH) throw new FetchError("INVALID_URL", "That link is too long");
  // Control characters / whitespace inside a URL are never legitimate.
  if (/[\u0000- \u007f]/.test(s)) throw new FetchError("INVALID_URL", "That doesn't look like a calendar link");
  s = s.replace(/^webcals?:\/\//i, "https://");
  let url;
  try {
    url = new URL(s);
  } catch {
    throw new FetchError("INVALID_URL", "That doesn't look like a calendar link");
  }
  if (url.protocol === "http:" && !allowHttp) throw new FetchError("HTTPS_REQUIRED", "Use the secure (https://) calendar link");
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new FetchError("INVALID_URL", "Only https:// calendar links are supported");
  if (url.username || url.password) throw new FetchError("INVALID_URL", "Calendar links with a user name or password are not supported");
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (!host) throw new FetchError("INVALID_URL", "That doesn't look like a calendar link");
  const bracketless = host.replace(/^\[|\]$/g, "");
  if (net.isIP(bracketless)) {
    if (!(allowLoopback && isLoopback(bracketless))) throw new FetchError("PRIVATE_ADDRESS", "Calendar links must use a public web address");
  } else {
    if (host === "localhost" || !host.includes(".") || BLOCKED_SUFFIXES.some((sfx) => host.endsWith(sfx))) {
      throw new FetchError("PRIVATE_ADDRESS", "Calendar links must use a public web address");
    }
  }
  const defaultPort = url.protocol === "https:" ? "443" : "80";
  if (url.port && url.port !== defaultPort && !(allowLoopback && net.isIP(bracketless) && isLoopback(bracketless))) {
    throw new FetchError("INVALID_URL", "Calendar links must use the standard web port");
  }
  url.hash = "";
  return url.toString();
}

// --- DNS ------------------------------------------------------------------

function defaultResolve(hostname) {
  return new Promise((resolve, reject) => {
    dns.lookup(hostname, { all: true, verbatim: true }, (err, addrs) => (err ? reject(err) : resolve(addrs)));
  });
}

// dns.lookup cannot be cancelled (it runs on libuv's small thread pool), but
// a slow resolver must not hold the caller past the request's deadline —
// a booking-time re-verification has 8 s in total.
function beforeDeadline(promise, end) {
  const timeout = () => Object.assign(new Error("DNS lookup timed out"), { code: "ETIMEOUT" });
  const ms = end - Date.now();
  if (!(ms > 0)) {
    promise.catch(() => {});
    return Promise.reject(timeout());
  }
  let timer;
  const expiry = new Promise((_, reject) => {
    timer = setTimeout(() => reject(timeout()), ms);
    if (timer.unref) timer.unref();
  });
  return Promise.race([promise, expiry]).finally(() => clearTimeout(timer));
}

// Resolves and validates. Every answer must be public — a name that
// resolves to any private address is refused outright (mixed answers are a
// classic rebinding trick).
async function resolvePublic(hostname, { resolve = defaultResolve, allowLoopback = false } = {}) {
  const bare = hostname.replace(/^\[|\]$/g, "");
  if (net.isIP(bare)) {
    if (allowLoopback && isLoopback(bare)) return [{ address: bare, family: net.isIPv6(bare) ? 6 : 4 }];
    throw new FetchError("PRIVATE_ADDRESS", "Calendar links must use a public web address");
  }
  let addrs;
  try {
    addrs = await resolve(bare);
  } catch (err) {
    throw new FetchError("DNS_FAILED", "We couldn't find that calendar's website", { cause: err && err.code });
  }
  if (!Array.isArray(addrs) || !addrs.length) throw new FetchError("DNS_FAILED", "We couldn't find that calendar's website");
  for (const a of addrs) {
    if (!isPublicAddress(a.address) && !(allowLoopback && isLoopback(a.address))) {
      throw new FetchError("PRIVATE_ADDRESS", "Calendar links must use a public web address");
    }
  }
  return addrs.map((a) => ({ address: a.address, family: a.family || (net.isIPv6(a.address) ? 6 : 4) }));
}

// --- request --------------------------------------------------------------

function classifyStatus(status) {
  if (status === 401 || status === 403) return "AUTH_REFUSED";
  if (status === 404 || status === 410) return "NOT_FOUND";
  if (status === 429) return "RATE_LIMITED";
  if (status >= 500) return "UPSTREAM_ERROR";
  return "HTTP_ERROR";
}

function requestOnce(urlString, { headers, deadline, addrs, signal }) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlString);
    const mod = url.protocol === "https:" ? https : http;
    const pinned = addrs;
    const remaining = deadline - Date.now();
    if (remaining <= 0) return reject(new FetchError("TIMEOUT", "The calendar took too long to respond"));
    let settled = false;
    const done = (fn, v) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(v);
    };
    const req = mod.request(
      {
        protocol: url.protocol,
        hostname: url.hostname.replace(/^\[|\]$/g, ""),
        port: url.port || (url.protocol === "https:" ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        method: "GET",
        headers,
        agent: false, // no pooling, no proxy
        servername: net.isIP(url.hostname.replace(/^\[|\]$/g, "")) ? undefined : url.hostname,
        // Connect only to the address we validated (DNS pinning).
        lookup: (_hostname, options, cb) => {
          if (options && options.all) return cb(null, pinned);
          return cb(null, pinned[0].address, pinned[0].family);
        },
      },
      (res) => {
        const status = res.statusCode || 0;
        const out = {
          status,
          location: res.headers.location,
          headers: {
            etag: typeof res.headers.etag === "string" ? res.headers.etag.slice(0, 200) : null,
            lastModified: typeof res.headers["last-modified"] === "string" ? res.headers["last-modified"].slice(0, 100) : null,
            contentType: typeof res.headers["content-type"] === "string" ? res.headers["content-type"].slice(0, 100) : null,
            retryAfter: typeof res.headers["retry-after"] === "string" ? res.headers["retry-after"].slice(0, 40) : null,
          },
        };
        if (status !== 200) {
          // Nothing of a non-200 body is needed (redirect target and status
          // are in the headers): close the socket instead of draining it —
          // a hostile server could otherwise stream forever after we gave up.
          res.destroy();
          return done(resolve, out);
        }
        const declared = Number(res.headers["content-length"]);
        if (Number.isFinite(declared) && declared > MAX_BYTES) {
          res.destroy();
          return done(reject, new FetchError("BODY_TOO_LARGE", "That calendar is too large to import"));
        }
        let wire = 0;
        let decoded = 0;
        const chunks = [];
        const enc = String(res.headers["content-encoding"] || "").toLowerCase().trim();
        let stream = res;
        if (enc === "gzip" || enc === "x-gzip") stream = res.pipe(zlib.createGunzip());
        else if (enc === "deflate") stream = res.pipe(zlib.createInflate());
        else if (enc === "br") stream = res.pipe(zlib.createBrotliDecompress());
        else if (enc && enc !== "identity") {
          res.destroy();
          return done(reject, new FetchError("UNSUPPORTED_ENCODING", "That calendar uses an unsupported encoding"));
        }
        res.on("data", (c) => {
          wire += c.length;
          if (wire > MAX_BYTES) {
            res.destroy();
            done(reject, new FetchError("BODY_TOO_LARGE", "That calendar is too large to import"));
          }
        });
        stream.on("data", (c) => {
          decoded += c.length;
          if (decoded > MAX_BYTES) {
            res.destroy();
            if (stream !== res) stream.destroy();
            return done(reject, new FetchError("BODY_TOO_LARGE", "That calendar is too large to import"));
          }
          chunks.push(c);
        });
        stream.on("end", () => {
          let body = Buffer.concat(chunks).toString("utf8");
          if (body.charCodeAt(0) === 0xfeff) body = body.slice(1);
          out.body = body;
          out.bytes = decoded;
          done(resolve, out);
        });
        stream.on("error", () => done(reject, new FetchError("BAD_RESPONSE", "The calendar response could not be read")));
        res.on("error", () => done(reject, new FetchError("CONNECTION_FAILED", "The connection to the calendar was interrupted")));
      },
    );
    const timer = setTimeout(() => {
      req.destroy();
      done(reject, new FetchError("TIMEOUT", "The calendar took too long to respond"));
    }, remaining);
    if (signal) {
      if (signal.aborted) {
        req.destroy();
        return done(reject, new FetchError("ABORTED", "Cancelled"));
      }
      signal.addEventListener("abort", () => {
        req.destroy();
        done(reject, new FetchError("ABORTED", "Cancelled"));
      }, { once: true });
    }
    req.on("error", (err) => {
      const tls = err && /CERT|SSL|TLS|self.signed|unable to verify/i.test(`${err.code} ${err.message}`);
      done(reject, new FetchError(tls ? "TLS_ERROR" : "CONNECTION_FAILED", tls ? "The calendar's secure connection could not be verified" : "We couldn't connect to that calendar", { cause: err && err.code }));
    });
    req.end();
  });
}

// GET a calendar. Returns { status: 200, body, headers, finalUrl, bytes } or
// { status: 304, headers, finalUrl }; throws FetchError otherwise.
async function safeFetch(rawUrl, { etag, lastModified, timeoutMs = DEFAULT_TIMEOUT_MS, deadline, resolve, signal } = {}) {
  const t = testOverrides();
  const end = Math.min(deadline || Infinity, Date.now() + timeoutMs);
  let current = normaliseUrl(rawUrl, t);
  const headers = {
    "user-agent": USER_AGENT,
    accept: "text/calendar, text/plain;q=0.9, */*;q=0.1",
    "accept-encoding": "gzip, deflate, br",
    connection: "close",
  };
  if (etag) headers["if-none-match"] = etag;
  if (lastModified) headers["if-modified-since"] = lastModified;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const host = new URL(current).hostname;
    const lookup = resolve || defaultResolve;
    const addrs = await resolvePublic(host, { resolve: (h) => beforeDeadline(lookup(h), end), allowLoopback: t.allowLoopback });
    const res = await requestOnce(current, { headers, deadline: end, addrs, signal });
    if ([301, 302, 303, 307, 308].includes(res.status)) {
      if (!res.location) throw new FetchError("BAD_REDIRECT", "The calendar link redirects nowhere");
      if (hop === MAX_REDIRECTS) throw new FetchError("TOO_MANY_REDIRECTS", "The calendar link redirects too many times");
      let next;
      try {
        next = new URL(res.location, current).toString();
      } catch {
        throw new FetchError("BAD_REDIRECT", "The calendar link redirects to an invalid address");
      }
      current = normaliseUrl(next, t); // every hop is re-validated
      continue;
    }
    if (res.status === 304) return { status: 304, headers: res.headers, finalUrl: current };
    if (res.status === 200) return { status: 200, body: res.body || "", headers: res.headers, finalUrl: current, bytes: res.bytes || 0 };
    throw new FetchError(classifyStatus(res.status), `The calendar website answered with an error (${res.status})`, { httpStatus: res.status, retryAfter: res.headers.retryAfter });
  }
  throw new FetchError("TOO_MANY_REDIRECTS", "The calendar link redirects too many times");
}

// Permanent errors need the host; transient ones are retried with backoff.
const PERMANENT = new Set(["INVALID_URL", "HTTPS_REQUIRED", "PRIVATE_ADDRESS", "NOT_FOUND", "AUTH_REFUSED", "NOT_ICALENDAR", "TOO_LARGE", "BODY_TOO_LARGE", "TOO_MANY_EVENTS", "TOO_MANY_OCCURRENCES", "UNSUPPORTED_ENCODING", "TOO_MANY_REDIRECTS", "BAD_REDIRECT"]);
function isPermanent(code) {
  return PERMANENT.has(code);
}

module.exports = {
  safeFetch,
  normaliseUrl,
  resolvePublic,
  isPublicAddress,
  isPublicIPv4,
  isPublicIPv6,
  isPermanent,
  FetchError,
  MAX_BYTES,
  MAX_REDIRECTS,
  USER_AGENT,
  // tests only: proves the socket connects to the pinned address
  _requestOnce: requestOnce,
};

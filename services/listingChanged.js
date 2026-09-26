// Batch P — tells the caches that the public catalogue changed.
//
// Two caches hold catalogue data: Vercel's edge (the `listings` tag on the
// public list responses, see utils/httpCache.js) and the customer site's
// ISR pages / Data Cache (Next.js tags, refreshed through the site's
// POST /api/revalidate). Both are purged by tag; a purge marks entries
// stale, so the request after the next one is guaranteed fresh — that is
// the documented trade-off for a public list, and the 5-minute TTL is the
// bound when a notification is lost.
//
// Callers are the write paths that change something a card or a stay page
// shows (docs/batch-p-catalogue.md classifies every ListingProperty write).
// This never throws and never blocks a response for more than the deadline.
const TAG_ALL = "listings";
const SITE_BATCH = 20; // the site route accepts at most 20 tags per call
const CDN_BATCH = 16; // Vercel's bulk purge limit per call
const REQUEST_TIMEOUT_MS = 1500;
const TOTAL_DEADLINE_MS = 4000;

let mock = null; // set by tests (LISTING_CHANGE_MOCK=1)

function tagFor(id) {
  return `listing:${String(id)}`;
}

function tagsFor(ids) {
  const seen = new Set();
  const out = [TAG_ALL];
  for (const id of ids || []) {
    if (!id) continue;
    const t = tagFor(id);
    if (!seen.has(t)) {
      seen.add(t);
      out.push(t);
    }
  }
  return out;
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function log(level, msg, extra) {
  const line = `[catalogue] ${msg}`;
  if (level === "error") console.error(line, extra || "");
  else console.log(line, extra || "");
}

async function invalidateCdn(tags, deadline) {
  let invalidateByTag;
  try {
    ({ invalidateByTag } = require("@vercel/functions"));
  } catch {
    return { skipped: "no-@vercel/functions", status: "skipped" };
  }
  let done = 0;
  for (const batch of chunk(tags, CDN_BATCH)) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return { done, skipped: "deadline", status: "timeout" };
    // A batch counts only when the purge answered: when the timeout wins the
    // race the purge was merely attempted (it used to be counted as done).
    let timer;
    const outcome = await Promise.race([
      Promise.resolve(invalidateByTag(batch)).then(() => "ok"), // resolves immediately outside Vercel
      new Promise((resolve) => {
        timer = setTimeout(() => resolve("timeout"), Math.min(REQUEST_TIMEOUT_MS, remaining));
      }),
    ]).finally(() => clearTimeout(timer));
    if (outcome === "timeout") return { done, status: "timeout" };
    done += batch.length;
  }
  return { done, status: "ok" };
}

async function notifySite(tags, deadline) {
  const url = process.env.SITE_REVALIDATE_URL;
  const secret = process.env.REVALIDATE_SECRET;
  if (!url || !secret) return { skipped: "unconfigured", status: "skipped" };
  let done = 0;
  for (const batch of chunk(tags, SITE_BATCH)) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return { done, skipped: "deadline", status: "timeout" };
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", "x-revalidate-secret": secret },
      body: JSON.stringify({ tags: batch }),
      signal: AbortSignal.timeout(Math.min(REQUEST_TIMEOUT_MS, remaining)),
    });
    if (!res.ok) return { done, failed: res.status, status: "error" };
    done += batch.length;
  }
  return { done, status: "ok" };
}

// A rejected channel: an abort / timeout of the site call is "timeout",
// anything else "error".
function rejected(reason) {
  const name = (reason && reason.name) || "failed";
  return { error: name, status: name === "TimeoutError" || name === "AbortError" ? "timeout" : "error" };
}

// Both caches, one deadline. Every channel reports a confirmed status —
// ok | timeout | error | skipped — so a caller can tell a refresh that
// happened from one that was only attempted.
async function send(tags, reason) {
  const deadline = Date.now() + TOTAL_DEADLINE_MS;
  const [cdn, site] = await Promise.allSettled([invalidateCdn(tags, deadline), notifySite(tags, deadline)]);
  const summary = {
    reason,
    tags: tags.length,
    cdn: cdn.status === "fulfilled" ? cdn.value : rejected(cdn.reason),
    site: site.status === "fulfilled" ? site.value : rejected(site.reason),
  };
  if (summary.cdn.error || summary.site.error || summary.site.failed || summary.cdn.status === "timeout" || summary.site.status === "timeout") log("error", "notify incomplete", JSON.stringify(summary));
  return summary;
}

// ids: listing ObjectIds (any number). reason: short code for the log.
async function notifyListingChanged(ids, reason = "change") {
  const tags = tagsFor(Array.isArray(ids) ? ids : [ids]);
  if (mock) {
    mock.calls.push({ tags, reason, batches: chunk(tags, SITE_BATCH).length });
    return { mocked: true };
  }
  return send(tags, reason);
}

// Any other cached public content (the homepage hero: "site-hero"). The site
// route allow-lists the tags it accepts.
async function notifyTags(tags, reason = "change") {
  const list = [...new Set((Array.isArray(tags) ? tags : [tags]).filter((t) => typeof t === "string" && t))];
  if (mock) {
    mock.calls.push({ tags: list, reason, batches: chunk(list, SITE_BATCH).length });
    return { mocked: true, reason, tags: list.length, cdn: { status: "mocked" }, site: { status: "mocked" } };
  }
  return send(list, reason);
}

function __setMock(m) {
  mock = m;
}

module.exports = { notifyListingChanged, notifyTags, tagsFor, tagFor, chunk, TAG_ALL, SITE_BATCH, CDN_BATCH, __setMock };

if (process.env.LISTING_CHANGE_MOCK === "1") __setMock({ calls: [] });

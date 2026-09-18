// Batch P — edge caching for the public catalogue reads (home lists, search,
// city counts) and nothing else.
//
// index.js stamps `no-store` on every response first; the three catalogue
// controllers opt in here, and only for a 200. Browsers keep revalidating
// (max-age=0 + Express ETags → 304), Vercel's edge keeps a copy for 5 minutes
// and serves it stale for 2 more while it refreshes. CDN-Cache-Control (not
// Vercel-CDN-Cache-Control) is used on purpose: it is forwarded downstream,
// so the customer site's edge — which proxies /api/v1/* through an external
// rewrite — caches the same response too. The `listings` tag is what the
// change notifications purge (services/listingChanged.js); a purge marks
// entries stale, it does not delete them: the next request may still see
// the old copy while the edge refreshes, the one after is fresh.
//
// `?fresh=1` is the site server's way to bypass the cache when it
// regenerates a page after a purge. It needs the shared secret; without it
// the answer is 400 (a status the edge never stores), so the parameter can
// neither prime a stale entry the site would then hit nor hand anyone a free
// cache bypass.
const crypto = require("crypto");

const CDN_DIRECTIVE = "public, s-maxage=300, stale-while-revalidate=120";
const BROWSER_DIRECTIVE = "public, max-age=0, must-revalidate";
const TAG = "listings";

function sha(s) {
  return crypto.createHash("sha256").update(String(s)).digest();
}

function freshSecretOk(req) {
  const secret = process.env.CATALOGUE_FRESH_SECRET;
  const given = req.get("x-catalogue-fresh");
  if (!secret || !given) return false;
  return crypto.timingSafeEqual(sha(given), sha(secret));
}

function disabled() {
  return process.env.CATALOGUE_CACHE_DISABLED === "1";
}

// Call at the top of a catalogue handler. Returns false when the request
// has already been answered (invalid `fresh`), true otherwise. With
// `cacheable: false` (date-filtered search) the global no-store stands.
function catalogueCache(req, res, { cacheable = true } = {}) {
  if (Object.prototype.hasOwnProperty.call(req.query, "fresh")) {
    if (!freshSecretOk(req)) {
      res.status(400).json({
        success: false,
        code: "FRESH_NOT_ALLOWED",
        message: "fresh is reserved for the site server",
        statusCode: 400,
      });
      return false;
    }
    res.set("Cache-Control", "no-store");
    res.set("Vary", "Origin");
    return true;
  }
  if (!cacheable || disabled()) return true;
  const json = res.json.bind(res);
  res.json = (body) => {
    if (res.statusCode === 200) {
      res.set({
        "Cache-Control": BROWSER_DIRECTIVE,
        "CDN-Cache-Control": CDN_DIRECTIVE,
        "Vercel-Cache-Tag": TAG,
        Vary: "Origin",
      });
      res.removeHeader("Pragma");
      res.removeHeader("Expires");
      res.removeHeader("Surrogate-Control");
    }
    return json(body);
  };
  return true;
}

module.exports = { catalogueCache, CDN_DIRECTIVE, BROWSER_DIRECTIVE, TAG };

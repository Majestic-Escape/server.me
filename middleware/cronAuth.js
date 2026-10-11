// Vercel Cron sends `Authorization: Bearer <CRON_SECRET>` when the CRON_SECRET
// environment variable is set on the project. The payout cron moves money,
// so it is refused unless that secret is configured *and* presented.
const crypto = require("crypto");

// Digests have a fixed length, so neither the comparison nor an exception
// (a multi-byte header) says anything about the secret's length.
const digest = (v) => crypto.createHash("sha256").update(String(v), "utf8").digest();
function presentedSecret(req) {
  const header = req.headers["authorization"] || "";
  return header.startsWith("Bearer ") ? header.slice(7) : "";
}
function matches(presented, secret) {
  return !!secret && !!presented && crypto.timingSafeEqual(digest(presented), digest(secret));
}
function unauthorized(res) {
  return res.status(401).json({ success: false, code: "CRON_UNAUTHORIZED", message: "Unauthorized", statusCode: 401 });
}

module.exports = function cronAuth(req, res, next) {
  if (!matches(presentedSecret(req), process.env.CRON_SECRET)) return unauthorized(res);
  next();
};

// Accepts any of the named secrets (each checked in constant time). Used by
// the calendar sweep: Vercel cron sends CRON_SECRET, an external clock gets
// a *scoped* CALENDAR_SYNC_CRON_SECRET that cannot trigger payouts.
module.exports.anyOf = (...envNames) =>
  function cronAuthAnyOf(req, res, next) {
    const presented = presentedSecret(req);
    const ok = envNames.map((n) => matches(presented, process.env[n])).some(Boolean);
    if (!ok) return unauthorized(res);
    next();
  };

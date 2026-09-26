// Vercel Cron sends `Authorization: Bearer <CRON_SECRET>` when the CRON_SECRET
// environment variable is set on the project. The payout cron moves money,
// so it is refused unless that secret is configured *and* presented.
const crypto = require("crypto");

module.exports = function cronAuth(req, res, next) {
  const secret = process.env.CRON_SECRET;
  const header = req.headers["authorization"] || "";
  const presented = header.startsWith("Bearer ") ? header.slice(7) : "";
  // Digests have a fixed length, so neither the comparison nor an exception
  // (a multi-byte header) says anything about the secret's length.
  const digest = (v) => crypto.createHash("sha256").update(String(v), "utf8").digest();
  const ok = !!secret && !!presented && crypto.timingSafeEqual(digest(presented), digest(secret));
  if (!ok) {
    return res.status(401).json({ success: false, code: "CRON_UNAUTHORIZED", message: "Unauthorized", statusCode: 401 });
  }
  next();
};

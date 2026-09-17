// DB-backed abuse/cost guard for paid KYC provider calls (no Redis). The
// host's KYC form is the guard record: per kind ("ocr" | "gst") it keeps
// { windowStart, count, lastAt, inFlightUntil } and a request must claim a
// slot with ONE atomic findOneAndUpdate before the provider is called —
// one attempt in flight at a time, a cooldown between attempts and a daily
// ceiling. Cheap request validation runs before claim() so garbage never
// consumes quota; after a real provider attempt count/lastAt stay (the call
// may have cost credits) and only the in-flight lease is released.
const KycHostData = require("../models/KycHostForm");

const DAY_MS = 24 * 60 * 60 * 1000;
function int(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}
function config() {
  return {
    maxPerDay: int(process.env.KYC_MAX_ATTEMPTS_PER_DAY, 5),
    cooldownSeconds: int(process.env.KYC_ATTEMPT_COOLDOWN_SECONDS, 30),
    leaseSeconds: int(process.env.KYC_INFLIGHT_LEASE_SECONDS, 120),
  };
}

async function claim(hostId, kind, now = new Date()) {
  const { maxPerDay, cooldownSeconds, leaseSeconds } = config();
  const p = `verification.${kind}`;
  // Legacy forms have no guard state yet.
  await KycHostData.updateOne(
    { hostId, [p]: { $exists: false } },
    { $set: { [p]: { windowStart: now, count: 0, lastAt: null, inFlightUntil: null } } },
  );
  // A window older than 24 h starts over.
  await KycHostData.updateOne(
    { hostId, [`${p}.windowStart`]: { $lt: new Date(now.getTime() - DAY_MS) } },
    { $set: { [`${p}.windowStart`]: now, [`${p}.count`]: 0 } },
  );
  const cooldownCutoff = new Date(now.getTime() - cooldownSeconds * 1000);
  const claimed = await KycHostData.findOneAndUpdate(
    {
      hostId,
      [`${p}.inFlightUntil`]: { $not: { $gt: now } },
      [`${p}.count`]: { $lt: maxPerDay },
      [`${p}.lastAt`]: { $not: { $gt: cooldownCutoff } },
    },
    { $set: { [`${p}.inFlightUntil`]: new Date(now.getTime() + leaseSeconds * 1000), [`${p}.lastAt`]: now }, $inc: { [`${p}.count`]: 1 } },
    { new: true },
  ).lean();
  if (claimed) return { ok: true, form: claimed };

  const form = await KycHostData.findOne({ hostId }).select("verification").lean();
  if (!form) return { ok: false, reason: "no_form", retryAfterSeconds: 0 };
  const g = (form.verification && form.verification[kind]) || {};
  const secondsUntil = (date) => Math.max(1, Math.ceil((new Date(date).getTime() - now.getTime()) / 1000));
  if (g.inFlightUntil && new Date(g.inFlightUntil) > now) return { ok: false, reason: "in_flight", retryAfterSeconds: secondsUntil(g.inFlightUntil) };
  if (g.count >= maxPerDay) return { ok: false, reason: "daily_limit", retryAfterSeconds: secondsUntil(new Date(new Date(g.windowStart || now).getTime() + DAY_MS)) };
  if (g.lastAt && new Date(g.lastAt) > cooldownCutoff) return { ok: false, reason: "cooldown", retryAfterSeconds: secondsUntil(new Date(new Date(g.lastAt).getTime() + cooldownSeconds * 1000)) };
  return { ok: false, reason: "cooldown", retryAfterSeconds: cooldownSeconds || 1 };
}

async function release(hostId, kind) {
  try {
    await KycHostData.updateOne({ hostId }, { $set: { [`verification.${kind}.inFlightUntil`]: null } });
  } catch (err) {
    console.error("kycGuard release failed", err && err.message);
  }
}

function rateLimited(res, result) {
  const messages = {
    in_flight: "A verification is already in progress. Please wait a moment and try again.",
    cooldown: `Too many verification attempts. Please try again in ${result.retryAfterSeconds} seconds.`,
    daily_limit: "You have reached today's verification limit. Please try again tomorrow or contact support.",
  };
  res.set("Retry-After", String(result.retryAfterSeconds || 1));
  return res.status(429).json({
    success: false,
    code: "KYC_RATE_LIMITED",
    reason: result.reason,
    retryAfterSeconds: result.retryAfterSeconds,
    message: messages[result.reason] || messages.cooldown,
    statusCode: 429,
  });
}

module.exports = { claim, release, rateLimited, config };

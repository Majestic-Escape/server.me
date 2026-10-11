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

// Gives back the attempt a failure on OUR side consumed (the provider refused
// our credentials/plan — the request was never processed), so a
// misconfiguration never locks hosts out for the day. The cooldown stays.
async function refund(hostId, kind) {
  const p = `verification.${kind}.count`;
  try {
    return await KycHostData.findOneAndUpdate({ hostId, [p]: { $gt: 0 } }, { $inc: { [p]: -1 } }, { new: true }).select("verification").lean();
  } catch (err) {
    console.error("kycGuard refund failed", err && err.message);
    return null;
  }
}

async function release(hostId, kind) {
  try {
    await KycHostData.updateOne({ hostId }, { $set: { [`verification.${kind}.inFlightUntil`]: null } });
  } catch (err) {
    console.error("kycGuard release failed", err && err.message);
  }
}

// What a host may do next after a claimed attempt failed: seconds until the
// cooldown admits another attempt and attempts left in the current window.
// Sent with every post-claim failure so the client can count down instead of
// letting the host tap straight into a 429.
function attemptInfo(form, kind, now = new Date()) {
  const { maxPerDay, cooldownSeconds } = config();
  const g = (form && form.verification && form.verification[kind]) || {};
  const lastAt = g.lastAt ? new Date(g.lastAt).getTime() : 0;
  const retryAfterSeconds = lastAt ? Math.max(0, Math.ceil((lastAt + cooldownSeconds * 1000 - now.getTime()) / 1000)) : 0;
  return { retryAfterSeconds, attemptsLeft: Math.max(0, maxPerDay - (Number(g.count) || 0)) };
}

function rateLimited(res, result) {
  const messages = {
    in_flight: "A verification is already in progress. Please wait a moment and try again.",
    // one attempt is enough to start the cooldown: never call it "too many"
    cooldown: `Please wait ${result.retryAfterSeconds} seconds before trying again.`,
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

module.exports = { claim, release, refund, rateLimited, attemptInfo, config };

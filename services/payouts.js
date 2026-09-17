// Host payout cycle (Batch S.1 rewrite of the schedule-cron handler).
//
// Business rules are the existing ones, unchanged:
//   * a booking is paid out on its check-in day (the daily cron selects
//     check-ins from two days ago up to the end of today, so a missed run
//     is retried on the next two days);
//   * the payout amount is the booking's subTotal minus MAJESTIC_COMMISSION %
//     unless the host has hostOffer and a KYC verified within 90 days;
//   * the money goes by IMPS from ADMIN_ACCOUNT to the host's fund account
//     (BankDetail.fundId); no bank details → recorded as failed;
//   * a payout the gateway refused ("failed") or reversed is retried by a
//     later cycle inside the same window.
//
// What changed is the integrity around them — the pre-S.1 handler could
// pay a host twice (two overlapping runs each created a HostPayout row and
// each called the gateway; a 5xx/timeout marked the row failed and the next
// day created a second payout with a fresh random idempotency key) and paid
// hosts for bookings whose guest had been refunded (it selected on status
// only). Now:
//   * only confirmed, paid, local guest bookings qualify;
//   * one HostPayout row per booking (unique index) and an atomic claim
//     (lockedAt) so concurrent cycles cannot both process a booking;
//   * every gateway call carries reference_id = bookingId and a
//     deterministic idempotency key; before any retry the gateway is asked
//     for payouts with that reference and a live one is adopted, never
//     duplicated; an ambiguous outcome (timeout/5xx) is never marked
//     failed — it stays pending with lastError until the lookup settles it;
//   * the gateway id is written back with one retry and a CRITICAL log.
const Booking = require("../models/Booking");
const HostPayout = require("../models/HostPayout");
const BankDetail = require("../models/BankDetail");
const User = require("../models/User");
const { getPayoutGateway } = require("./payoutGateway");

const LOCK_STALE_MS = 10 * 60_000;
const LIVE_GATEWAY_STATUSES = new Set(["queued", "pending", "processing", "processed"]);

function windowFor(now = new Date()) {
  const todayStart = new Date(now);
  todayStart.setHours(0, 0, 0, 0);
  const todayEnd = new Date(now);
  todayEnd.setHours(23, 59, 59, 999);
  const twoDaysAgo = new Date(todayStart);
  twoDaysAgo.setDate(todayStart.getDate() - 2);
  return { from: twoDaysAgo, to: todayEnd };
}

function commissionPercent() {
  const c = Number(process.env.MAJESTIC_COMMISSION);
  return Number.isFinite(c) && c >= 0 && c <= 100 ? c : null;
}

// Unchanged amount rule (including the hostOffer / KYC-age branch exactly as
// written before; note User.kyc is a Boolean in the schema, so verifiedAt is
// never set and the commission branch is the one that runs in practice).
function payoutAmountFor(booking, host) {
  const amount = Number(booking.subTotal);
  if (!Number.isFinite(amount) || amount <= 0) return { error: "Amount too small" };
  const kycDate = new Date(host && host.kyc && host.kyc.verifiedAt);
  const diffDays = Math.floor(Math.abs(kycDate.getTime() - Date.now()) / 86_400_000);
  if (host && host.hostOffer === true && host.kyc && diffDays <= 90) return { amount };
  const commission = commissionPercent();
  if (commission === null) return { error: "MAJESTIC_COMMISSION is not configured" };
  return { amount: amount - (commission / 100) * amount };
}

async function qualifyingBookings(now) {
  const { from, to } = windowFor(now);
  return Booking.find({
    status: "confirmed",
    paymentStatus: "paid",
    action: "user",
    source: "local",
    checkIn: { $gte: from, $lte: to },
  }).lean();
}

// Creates the HostPayout row once (unique bookingId) with the computed amount.
async function ensurePayoutRow(booking) {
  const host = await User.findById(booking.hostId).lean();
  if (!host) return { error: "Host data could not be found" };
  const computed = payoutAmountFor(booking, host);
  if (computed.error) return computed;
  const insert = {
    bookingId: booking._id,
    propertyId: booking.propertyId,
    amount: computed.amount,
    status: "pending",
    reference: String(booking._id),
    attempts: 0,
  };
  try {
    const row = await HostPayout.findOneAndUpdate({ bookingId: booking._id }, { $setOnInsert: insert }, { upsert: true, new: true });
    return { row };
  } catch (err) {
    if (err.code !== 11000) throw err;
    // Two cycles upserted at once; the unique index kept one row.
    return { row: await HostPayout.findOne({ bookingId: booking._id }) };
  }
}

// Atomically claims a row that still needs a gateway payout. Returns the
// claimed row or null (already sent / being processed / not retryable).
async function claim(bookingId, now) {
  return HostPayout.findOneAndUpdate(
    {
      bookingId,
      $and: [
        {
          $or: [
            { status: "pending", paymentId: null },
            { status: { $in: ["failed", "reversed"] } },
          ],
        },
        { $or: [{ lockedAt: null }, { lockedAt: { $lt: new Date(now.getTime() - LOCK_STALE_MS) } }] },
      ],
    },
    { $set: { lockedAt: now, lastAttemptAt: now }, $inc: { attempts: 1 } },
    { new: true },
  );
}

async function recordGatewayId(row, payoutId) {
  const write = () =>
    HostPayout.updateOne({ _id: row._id }, { $set: { paymentId: payoutId, status: "pending", lastError: null, lockedAt: null } });
  try {
    await write();
  } catch (err) {
    console.error("[payouts] CRITICAL payout created at gateway but id not recorded; retrying", {
      bookingId: String(row.bookingId),
      payoutId,
      error: err.message,
    });
    await write();
  }
}

async function release(row, patch) {
  await HostPayout.updateOne({ _id: row._id }, { $set: { lockedAt: null, ...patch } });
}

// Sends (or adopts) the gateway payout for one claimed row.
async function sendPayout(booking, row) {
  const gateway = getPayoutGateway();
  const reference = row.reference || String(booking._id);

  // Anything the gateway already holds for this booking wins over a new
  // call: a reversed/rejected payout is final (retry allowed), a live one is
  // adopted.
  let existing = [];
  try {
    existing = await gateway.findByReference(process.env.ADMIN_ACCOUNT, reference);
  } catch (err) {
    await release(row, { lastError: `lookup failed: ${err.message}` });
    return { success: false, error: `Could not verify existing payouts: ${err.message}`, bookingId: booking._id };
  }
  const live = existing.find((p) => LIVE_GATEWAY_STATUSES.has(p.status));
  if (live) {
    await recordGatewayId(row, live.id);
    return { success: true, adopted: true, data: live, bookingId: booking._id };
  }

  const bank = await BankDetail.findOne({ hostId: booking.hostId }).lean();
  if (!bank || !bank.fundId) {
    await release(row, { status: "failed", lastError: "Bank details not found" });
    return { success: false, error: "Bank details not found", bookingId: booking._id };
  }
  const amountPaise = Math.round(row.amount * 100);
  if (!Number.isInteger(amountPaise) || amountPaise <= 0) {
    await release(row, { status: "failed", lastError: "Amount too small" });
    return { success: false, error: "Amount too small", bookingId: booking._id };
  }

  const idempotencyKey = `bk_${reference}_${row.attempts}`;
  try {
    const payout = await gateway.createPayout(
      {
        account_number: process.env.ADMIN_ACCOUNT,
        fund_account_id: bank.fundId,
        amount: amountPaise,
        currency: "INR",
        mode: "IMPS",
        purpose: "payout",
        queue_if_low_balance: true,
        reference_id: reference,
        notes: {
          booking_id: String(booking._id),
          user_id: String(booking.userId),
          host_id: String(booking.hostId),
          property_id: String(booking.propertyId),
        },
      },
      idempotencyKey,
    );
    if (!payout || !payout.id) throw Object.assign(new Error("empty payout response"), { kind: "ambiguous" });
    await recordGatewayId(row, payout.id);
    return { success: true, data: payout, bookingId: booking._id };
  } catch (err) {
    if (err.kind === "rejected") {
      await release(row, { status: "failed", lastError: err.message });
      return { success: false, error: err.message, bookingId: booking._id };
    }
    // Ambiguous: the payout may exist. Stay pending (not failed) so the next
    // cycle's reference lookup either adopts it or retries safely.
    await release(row, { lastError: `ambiguous: ${err.message}` });
    console.error("[payouts] ambiguous gateway outcome; will reconcile by reference on next cycle", {
      bookingId: String(booking._id),
      reference,
      error: err.message,
    });
    return { success: false, ambiguous: true, error: err.message, bookingId: booking._id };
  }
}

// One cycle. Safe to invoke concurrently or repeatedly: every booking is
// processed by at most one runner at a time and paid out at most once.
async function runPayoutCycle({ now = new Date() } = {}) {
  const bookings = await qualifyingBookings(now);
  const results = [];
  let skipped = 0;
  for (const booking of bookings) {
    const ensured = await ensurePayoutRow(booking);
    if (ensured.error) {
      results.push({ success: false, error: ensured.error, bookingId: booking._id });
      continue;
    }
    const row = await claim(booking._id, now);
    if (!row) {
      skipped += 1;
      continue;
    }
    try {
      results.push(await sendPayout(booking, row));
    } catch (err) {
      await release(row, { lastError: err.message });
      results.push({ success: false, error: err.message, bookingId: booking._id });
    }
  }
  const successful = results.filter((r) => r.success).length;
  const failed = results.length - successful;
  return { successful, failed, skipped, total: results.length, results };
}

module.exports = { runPayoutCycle, payoutAmountFor, windowFor, qualifyingBookings };

// Operational attention queue (Batch S.1).
//
// A booking lands here when money has been captured but the booking cannot
// be honoured as-is:
//   inventory_conflict — the unpaid hold was lost before the payment
//                        completed and the nights are now someone else's;
//   amount_mismatch    — the gateway captured an amount that is not the
//                        server quote for the stay (only possible for
//                        orders opened by the pre-S backend).
// Flagging is exactly-once (conditional claim on notifications.attentionAt),
// so callback + webhook + retries produce one alert. The alert reuses the
// existing Brevo notification template and goes to OPS_ALERT_EMAIL (falls
// back to ADMIN_EMAIL). Nothing here refunds, cancels or rebooks: an admin
// resolves the item (see resolve()).
const Booking = require("../models/Booking");
const emailer = require("../utils/sendEmail");
const inventory = require("./inventory");

const REASONS = new Set(["inventory_conflict", "amount_mismatch"]);

const alertEmails = () =>
  String(process.env.OPS_ALERT_EMAIL || process.env.ADMIN_EMAIL || "")
    .split(",")
    .map((e) => e.trim())
    .filter(Boolean);

function describe(bookingId, reason, details) {
  const base = `Booking ${bookingId} needs attention (${reason}).`;
  if (reason === "inventory_conflict") {
    return `${base} The guest has paid but the requested nights were taken by another booking before the payment completed. Decide: refund via admin cancel, or free the other booking and resolve with "keep". Order ${details.orderId || "-"}, payment ${details.paymentId || "-"}.`;
  }
  if (reason === "amount_mismatch") {
    return `${base} The gateway captured ${details.capturedPaise} paise but the server quote is ${details.expectedPaise} paise (order ${details.orderId || "-"}, payment ${details.paymentId || "-"}). The booking is NOT confirmed. Decide: refund via admin cancel, or resolve with "keep" to accept the captured amount.`;
  }
  return base;
}

// Flags the booking once and sends the alert once. Returns
// { flagged: true|false, alerted: true|false }.
async function flag(bookingId, reason, details = {}) {
  if (!REASONS.has(reason)) throw new Error(`unknown attention reason ${reason}`);
  const now = new Date();
  const claimed = await Booking.findOneAndUpdate(
    { _id: bookingId, "notifications.attentionAt": null },
    {
      $set: {
        needsAttention: reason,
        attentionDetails: { ...details, reason, at: now },
        attentionResolvedAt: null,
        attentionResolution: null,
        "notifications.attentionAt": now,
      },
    },
    { new: true },
  );
  if (!claimed) return { flagged: false, alerted: false };
  console.error("[attention] booking flagged", { bookingId: String(bookingId), reason, ...details });
  const message = describe(String(bookingId), reason, details);
  try {
    await Promise.all(alertEmails().map((email) => emailer.sendHostNotification(email, "Admin", message)));
    return { flagged: true, alerted: alertEmails().length > 0 };
  } catch (err) {
    // The queue entry stays (needsAttention is set); release the claim so a
    // later duplicate event (webhook redelivery) retries the e-mail.
    console.error("[attention] alert e-mail failed; will retry on next event", err.message);
    await Booking.updateOne({ _id: bookingId }, { $set: { "notifications.attentionAt": null } });
    return { flagged: true, alerted: false };
  }
}

// A queued booking whose alert could not be sent (claim released) gets the
// alert re-sent on the next delivery of the same payment event.
async function retryAlert(booking) {
  if (!booking || !booking.needsAttention) return { flagged: false, alerted: false };
  if (booking.notifications && booking.notifications.attentionAt) return { flagged: false, alerted: false };
  const details = booking.attentionDetails && typeof booking.attentionDetails === "object" ? { ...booking.attentionDetails } : {};
  delete details.reason;
  delete details.at;
  return flag(booking._id, booking.needsAttention, details);
}

// Open queue, oldest first.
function list() {
  return Booking.find({ needsAttention: { $type: "string" } })
    .sort({ "notifications.attentionAt": 1 })
    .populate("userId hostId propertyId payment")
    .lean();
}

// Admin resolution. "keep": the booking stands — re-secure the nights
// permanently (fails with DATES_UNAVAILABLE if they are still taken) and
// restore the post-payment status; "dismiss": the admin handled it another
// way (e.g. refunded through admin cancel) and only the flag is cleared.
async function resolve({ booking, resolution, manualListing, actorId }) {
  if (!booking.needsAttention) return { ok: true, alreadyClear: true };
  if (resolution === "keep") {
    const nights = inventory.nightsBetween(booking.checkIn, booking.checkOut);
    const owned = await inventory.finalizeNights({ bookingId: booking._id, nights });
    if (owned < nights.length) {
      const reserved = await inventory.reserveNights({ propertyId: booking.propertyId, nights, bookingId: booking._id });
      if (!reserved.ok) return { ok: false, code: "DATES_UNAVAILABLE", conflicts: reserved.conflicts };
      await inventory.finalizeNights({ bookingId: booking._id, nights });
    }
    await Booking.updateOne(
      { _id: booking._id },
      {
        $set: {
          paymentStatus: "paid",
          status: manualListing ? "pending" : "confirmed",
          holdExpiresAt: null,
          needsAttention: null,
          attentionResolvedAt: new Date(),
          attentionResolution: `keep by ${actorId}`,
          updatedAt: new Date(),
        },
      },
    );
    return { ok: true, resolution: "keep" };
  }
  if (resolution === "dismiss") {
    await Booking.updateOne(
      { _id: booking._id },
      { $set: { needsAttention: null, attentionResolvedAt: new Date(), attentionResolution: `dismiss by ${actorId}`, updatedAt: new Date() } },
    );
    return { ok: true, resolution: "dismiss" };
  }
  return { ok: false, code: "VALIDATION" };
}

module.exports = { flag, retryAlert, list, resolve, alertEmails, REASONS };

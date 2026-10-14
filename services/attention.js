// Operational attention queue (Batch S.1).
//
// A booking lands here when money has been captured but the booking cannot
// be honoured as-is:
//   inventory_conflict — the unpaid hold was lost before the payment
//                        completed and the nights are now someone else's;
//   amount_mismatch    — the gateway captured an amount that is not the
//                        server quote for the stay (only possible for
//                        orders opened by the pre-S backend);
//   ota_conflict       — SyncGuard imported an OTA booking for nights this
//                        paid Majestic booking already holds (the OTA sold
//                        them before it had our feed): a real double booking
//                        that only a human can resolve (docs/syncguard.md §3).
// Flagging is exactly-once (conditional claim on notifications.attentionAt),
// so callback + webhook + retries produce one alert. The alert reuses the
// existing Brevo notification template and goes to OPS_ALERT_EMAIL (falls
// back to ADMIN_EMAIL). Nothing here refunds, cancels or rebooks: an admin
// resolves the item (see resolve()).
const Booking = require("../models/Booking");
const emailer = require("../utils/sendEmail");
const inventory = require("./inventory");

const REASONS = new Set(["inventory_conflict", "amount_mismatch", "ota_conflict"]);

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
  if (reason === "ota_conflict") {
    return `${base} An external calendar (${details.channel || "OTA"}) now reports a booking on nights this paid Majestic booking already holds (${(details.nights || []).join(", ") || "-"}). The guest of one platform has to be moved: contact the host. Resolve with "keep" once the Majestic booking stands, or cancel it from its row to refund.`;
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
  // Resolving re-arms the queue (notifications.attentionAt back to null):
  // a NEW problem with this booking later — another OTA selling its nights,
  // say — must reach the admin again. The exactly-once claim still holds per
  // problem (callback + webhook + retries of one payment, one conflict).
  if (resolution === "keep" && booking.needsAttention === "ota_conflict") {
    // The Majestic booking already holds its nights and its status is
    // whatever the normal flow made it — keeping it only clears the flag.
    await Booking.updateOne(
      { _id: booking._id },
      { $set: { needsAttention: null, attentionResolvedAt: new Date(), attentionResolution: `keep by ${actorId}`, "notifications.attentionAt": null, updatedAt: new Date() } },
    );
    return { ok: true, resolution: "keep", flagOnly: true };
  }
  if (resolution === "keep") {
    const nights = inventory.nightsBetween(booking.checkIn, booking.checkOut);
    // SyncGuard: an OTA booking now covering any of these nights means "keep"
    // would confirm a double booking — refuse; cancel (refund) instead.
    const listingId = booking.propertyId && booking.propertyId._id ? booking.propertyId._id : booking.propertyId; // may be populated
    const imported = await inventory.importedOverlap(listingId, nights, booking._id);
    if (imported) return { ok: false, code: "DATES_UNAVAILABLE", conflicts: [{ bookingId: imported._id, kind: "ical" }] };
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
          "notifications.attentionAt": null,
          updatedAt: new Date(),
        },
      },
    );
    return { ok: true, resolution: "keep" };
  }
  if (resolution === "dismiss") {
    await Booking.updateOne(
      { _id: booking._id },
      { $set: { needsAttention: null, attentionResolvedAt: new Date(), attentionResolution: `dismiss by ${actorId}`, "notifications.attentionAt": null, updatedAt: new Date() } },
    );
    return { ok: true, resolution: "dismiss" };
  }
  return { ok: false, code: "VALIDATION" };
}

// A cancellation that should refund failed at the gateway (e.g. "Your account
// does not have enough balance to carry out the refund operation"). The
// booking is left exactly as it was (payment still "paid", booking still
// active) so the cancel can simply be retried — but it must never be silent:
// the guest was told it failed and nobody else knew. Logs and alerts ops on
// every failed attempt; never throws (the caller's 502 is what matters).
async function refundFailed({ bookingId, paymentId, amountPaise, reason, gateway }) {
  const description = (gateway && (gateway.description || gateway.message)) || String(gateway || "unknown error");
  console.error("[refund] FAILED at the gateway", { bookingId: String(bookingId), paymentId, amountPaise, reason, gateway: description });
  const message =
    `Refund failed for booking ${bookingId} (payment ${paymentId || "-"}, ₹${(Number(amountPaise) || 0) / 100}). ` +
    `Razorpay said: "${description}". Nothing was refunded and the booking is unchanged (still paid and active); ` +
    `the guest's cancellation did not go through. Fix the cause (for an insufficient balance: add funds in the Razorpay dashboard ` +
    `or ask Razorpay to allow refunds against future settlements), then cancel it again from the admin bookings page to refund.`;
  try {
    await Promise.all(alertEmails().map((email) => emailer.sendHostNotification(email, "Admin", message)));
  } catch (err) {
    console.error("[refund] alert e-mail failed", err.message);
  }
}

module.exports = { flag, retryAlert, list, resolve, alertEmails, refundFailed, REASONS };

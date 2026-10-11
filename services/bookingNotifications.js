// Email / invoice side effects of the booking lifecycle, extracted from the
// old controller bodies so the template ids and attachments stay exactly as
// they were. Recipients always come from the booking's populated user/host
// documents — never from the request body.
const fs = require("fs");
const path = require("path");
const jwt = require("jsonwebtoken");
const { sendEmail } = require("../utils/sendEmail");
const { changeToUpperCase } = require("../utils/convertToUpperCase");
const { paramsToObject } = require("../utils/paramsObject");
const generateInvoiceHTML = require("../utils/generateInvoiceHTML");
const generateInvoicePDF = (html) => require("../utils/generateInvoicePDF")(html); // Batch P: lazy (puppeteer + chromium)
const { generateBookingGuestListHTML } = require("../utils/generateBookingGuestList");
const { calTax } = require("../utils/tax");
const Booking = require("../models/Booking");
const Payment = require("../models/Payment");

const adminEmails = () =>
  String(process.env.ADMIN_EMAIL || "")
    .split(",")
    .map((e) => e.trim())
    .filter(Boolean);
const baseUrl = () => process.env.NEXTAUTH_URL;

const REVEAL_NONE = { contact: false, street: false };
const REVEAL_VOUCHER = { contact: true, street: true };

// Contact lock-down: each recipient gets their own full name, the
// counterpart's FIRST name, and - for the confirmation emails of a confirmed,
// paid booking and for every admin email - the voucher data (counterpart
// contact, exact street). Pending / rejected / cancelled emails carry no
// contact details and no street.
function fullName(u) {
  return `${u?.firstName || ""} ${u?.lastName || ""}`.trim();
}
function firstName(u, fallback) {
  return (u?.firstName || "").trim() || fallback;
}
function paramsFor(booking, recipient, reveal = REVEAL_NONE) {
  const guest = booking.userId;
  const host = booking.hostId;
  let userName;
  let hostName;
  if (recipient === "guest") {
    userName = fullName(guest);
    hostName = firstName(host, "your host");
  } else if (recipient === "host") {
    userName = firstName(guest, "your guest");
    hostName = fullName(host);
  } else {
    userName = fullName(guest);
    hostName = fullName(host);
  }
  return paramsToObject(userName, hostName, booking, recipient === "admin" ? REVEAL_VOUCHER : reveal);
}
function names(booking, reveal = REVEAL_NONE) {
  return {
    userName: changeToUpperCase(fullName(booking.userId)),
    hostName: changeToUpperCase(fullName(booking.hostId)),
    guest: paramsFor(booking, "guest", reveal),
    host: paramsFor(booking, "host", reveal),
    admin: paramsFor(booking, "admin"),
  };
}

// One notification step = several independent mails (guest, host, each
// admin). Every mail is attempted whatever happens to the others, and each
// delivered mail is recorded on the booking (notifications.sent), so a failed
// step can be retried without mailing anyone twice. Throws, after trying all
// of them, if any mail is still undelivered.
const adminItems = (templateId, params) => adminEmails().map((email) => ({ key: `admin:${email}`, to: email, templateId, params }));
async function deliver(booking, flow, items) {
  const sent = new Set((booking.notifications && booking.notifications.sent) || []);
  const failed = [];
  await Promise.all(
    items.map(async (it) => {
      const key = `${flow}:${it.key}`;
      if (sent.has(key)) return;
      try {
        await sendEmail(it.to, it.templateId, it.params, it.attachments || []);
      } catch (err) {
        failed.push(`${it.templateId}->${it.key}: ${err.message}`);
        return;
      }
      try {
        await Booking.updateOne({ _id: booking._id }, { $addToSet: { "notifications.sent": key } });
      } catch (err) {
        console.error("[notify] sent but not recorded", key, err.message); // worst case: one duplicate on a retry
      }
    }),
  );
  if (failed.length) throw new Error(`${flow}: mail not delivered (${failed.join("; ")})`);
}
const anyPending = (booking, flow, keys) => {
  const sent = (booking.notifications && booking.notifications.sent) || [];
  return keys.some((k) => !sent.includes(`${flow}:${k}`));
};
const adminKeys = () => adminEmails().map((e) => `admin:${e}`);

// Builds the invoice + guest-list PDFs (unchanged pipeline) and returns the
// attachment arrays plus a cleanup function.
async function buildAttachments(booking, payment) {
  const tax = calTax(booking).toLocaleString();
  const invoiceHtml = generateInvoiceHTML(booking, payment, tax);
  const guestListHtml = generateBookingGuestListHTML(booking);
  const pdfBuffer = await generateInvoicePDF(invoiceHtml);
  const guestListPdfBuffer = await generateInvoicePDF(guestListHtml);
  const invoicesDir = process.env.NEXT_PUBLIC_ENV === "dev" ? path.join(__dirname, "/..") : "/tmp";
  if (!fs.existsSync(invoicesDir)) fs.mkdirSync(invoicesDir, { recursive: true });
  const filePath = path.join(invoicesDir, `invoice-${booking._id}.pdf`);
  const guestListFilePath = path.join(invoicesDir, `guestlist-${booking._id}.pdf`);
  fs.writeFileSync(filePath, pdfBuffer);
  fs.writeFileSync(guestListFilePath, guestListPdfBuffer);
  const invoiceAttachment = [
    { name: `invoice-${booking._id}.pdf`, content: fs.readFileSync(filePath).toString("base64"), type: "application/pdf" },
  ];
  const guestListOnlyAttachment = [
    { name: `guest-list-${booking._id}.pdf`, content: fs.readFileSync(guestListFilePath).toString("base64"), type: "application/pdf" },
  ];
  const cleanup = async () => {
    for (const f of [filePath, guestListFilePath]) {
      try {
        await fs.promises.unlink(f);
      } catch (err) {
        console.error("Failed to delete PDF file:", err.message);
      }
    }
  };
  return { invoiceAttachment, guestListOnlyAttachment, cleanup };
}

// After a successful payment (old /booking/updateStatus body).
//   manual (host approval needed): host 8, admins 9, user 42
//   instant:                       host 34 (+guest list), user 35 (+invoice), admins 36
async function notifyPaid(booking, payment, { manual }) {
  if (manual) {
    // pending host approval: no contact details, no street
    const p = names(booking);
    await deliver(booking, "paid", [
      { key: "host", to: booking.hostId.email, templateId: 8, params: p.host },
      ...adminItems(9, p.admin),
      { key: "guest", to: booking.userId.email, templateId: 42, params: p.guest },
    ]);
    return;
  }
  // instant booking confirmed by the payment: the voucher emails
  const p = names(booking, REVEAL_VOUCHER);
  if (!anyPending(booking, "paid", ["host", "guest", ...adminKeys()])) return; // nothing left to send: no PDFs either
  const { invoiceAttachment, guestListOnlyAttachment, cleanup } = await buildAttachments(booking, payment);
  try {
    await deliver(booking, "paid", [
      { key: "host", to: booking.hostId.email, templateId: 34, params: p.host, attachments: guestListOnlyAttachment },
      { key: "guest", to: booking.userId.email, templateId: 35, params: p.guest, attachments: invoiceAttachment },
      ...adminItems(36, p.admin),
    ]);
  } finally {
    await cleanup();
  }
}

function reviewParams(booking, bookingId) {
  const token = jwt.sign({ bookingId }, process.env.JWT_SECRET, { expiresIn: "14d" });
  return {
    userName: firstName(booking.userId, "Guest"),
    hostName: firstName(booking.hostId, "Host"),
    propertyTitle: `${booking.propertyId?.title || ""}`,
    userUrl: `${baseUrl()}/rating?token=${token}&booking=${bookingId}`,
    hostUrl: `${baseUrl()}/rating?token=${token}&booking=${bookingId}`,
  };
}

async function scheduleReviewEmails(booking) {
  // Agenda is lazily required: it opens its own DB connection on import.
  const agenda = require("../utils/agenda");
  const params = reviewParams(booking, String(booking._id));
  const delayMs = new Date(booking.checkOut).getTime() + 5 * 60 * 60 * 1000 - Date.now();
  const delaySeconds = process.env.ENV === "dev" ? 40 : Math.max(0, Math.round(delayMs / 1000));
  await agenda.schedule(`${delaySeconds} seconds`, "sendReviewEmail", {
    userEmail: booking.userId.email,
    hostEmail: booking.hostId.email,
    params,
    bookingStatus: booking.status,
    bookingId: String(booking._id), // the job re-checks the live status (utils/agenda.js)
  });
}

// Host confirmed a (paid, manual) booking: user 10 (+invoice), host 19
// (+guest list), admins 18, then the post-checkout review reminder.
async function notifyHostConfirmed(booking, payment) {
  // host approved a paid booking: the voucher emails
  const p = names(booking, REVEAL_VOUCHER);
  if (anyPending(booking, "confirmed", ["guest", "host", ...adminKeys()])) {
    const { invoiceAttachment, guestListOnlyAttachment, cleanup } = await buildAttachments(booking, payment);
    try {
      await deliver(booking, "confirmed", [
        { key: "guest", to: booking.userId.email, templateId: 10, params: p.guest, attachments: invoiceAttachment },
        { key: "host", to: booking.hostId.email, templateId: 19, params: p.host, attachments: guestListOnlyAttachment },
        ...adminItems(18, p.admin),
      ]);
    } finally {
      await cleanup();
    }
  }
  await scheduleReviewEmails(booking);
}

// Instant booking confirmed by payment: only the review reminder (as before).
async function notifyInstantConfirmed(booking) {
  await scheduleReviewEmails(booking);
}

// Cancellation flows (template ids unchanged).
async function notifyHostRejected(booking) {
  const p = names(booking);
  await deliver(booking, "rejected", [
    { key: "guest", to: booking.userId.email, templateId: 11, params: p.guest },
    ...adminItems(16, p.admin),
    { key: "host", to: booking.hostId.email, templateId: 17, params: p.host },
  ]);
}
async function notifyAdminCancelled(booking) {
  const p = names(booking);
  await deliver(booking, "admin-cancelled", [
    { key: "guest", to: booking.userId.email, templateId: 32, params: p.guest },
    ...adminItems(31, p.admin),
    { key: "host", to: booking.hostId.email, templateId: 33, params: p.host },
  ]);
}
async function notifyHostTerminated(booking) {
  const p = names(booking);
  await deliver(booking, "host-terminated", [
    { key: "guest", to: booking.userId.email, templateId: 13, params: p.guest },
    { key: "host", to: booking.hostId.email, templateId: 14, params: p.host },
    ...adminItems(15, p.admin),
  ]);
}
async function notifyUserTerminated(booking) {
  const p = names(booking);
  await deliver(booking, "user-terminated", [
    { key: "guest", to: booking.userId.email, templateId: 22, params: p.guest },
    { key: "host", to: booking.hostId.email, templateId: 20, params: p.host },
    ...adminItems(21, p.admin),
  ]);
}

// ---------------------------------------------------------------------------
// Exactly-once delivery used by every trigger: the browser's follow-up calls,
// the Razorpay webhook (the guest may have closed the tab) and the recovery
// sweep. The claim (notifications.paidAt / confirmedAt) is taken first and
// given back if a mail could not be delivered, so the next trigger resumes —
// notifications.sent keeps it from repeating the mails that did go out.
// ---------------------------------------------------------------------------
const POPULATE = "userId hostId propertyId payment";
const isManual = (booking) => !!(booking.propertyId && booking.propertyId.bookingType && booking.propertyId.bookingType.manual);

async function deliverPaid(booking) {
  const payment = booking.payment || (await Payment.findOne({ bookingId: booking._id, status: { $in: ["paid", "refund initiated", "refunded"] } }));
  if (!payment) return { error: "PAYMENT_NOT_FOUND" };
  const claimed = await Booking.findOneAndUpdate({ _id: booking._id, "notifications.paidAt": null }, { $set: { "notifications.paidAt": new Date() } });
  if (!claimed) return { alreadyNotified: true };
  try {
    await notifyPaid(booking, payment, { manual: isManual(booking) });
  } catch (err) {
    console.error("notifyPaid failed", err.message);
    await Booking.updateOne({ _id: booking._id }, { $set: { "notifications.paidAt": null } });
    return { error: "NOTIFY_FAILED" };
  }
  return { sent: true };
}

async function deliverInstantConfirmed(booking) {
  const claimed = await Booking.findOneAndUpdate({ _id: booking._id, "notifications.confirmedAt": null }, { $set: { "notifications.confirmedAt": new Date() } });
  if (!claimed) return { alreadyNotified: true };
  try {
    await notifyInstantConfirmed(booking);
  } catch (err) {
    console.error("notifyInstantConfirmed failed", err.message);
    await Booking.updateOne({ _id: booking._id }, { $set: { "notifications.confirmedAt": null } });
    return { error: "NOTIFY_FAILED" };
  }
  return { sent: true };
}

async function deliverHostConfirmed(booking, payment) {
  const claimed = await Booking.findOneAndUpdate({ _id: booking._id, "notifications.confirmedAt": null }, { $set: { "notifications.confirmedAt": new Date() } });
  if (!claimed) return { alreadyNotified: true };
  try {
    await notifyHostConfirmed(booking, payment);
  } catch (err) {
    console.error("notifyHostConfirmed failed", err.message);
    await Booking.updateOne({ _id: booking._id }, { $set: { "notifications.confirmedAt": null } });
    return { error: "NOTIFY_FAILED" };
  }
  return { sent: true };
}

// A payment landed without the guest's browser reporting back (webhook) or
// a mail step failed: run every outstanding step of the booking.
async function deliverOutstanding(bookingId) {
  const booking = await Booking.findById(bookingId).populate(POPULATE);
  if (!booking || booking.action !== "user" || booking.paymentStatus !== "paid" || booking.needsAttention) return { skipped: true };
  const out = {};
  if (!(booking.notifications && booking.notifications.paidAt)) out.paid = await deliverPaid(booking);
  if (booking.status === "confirmed" && !(booking.notifications && booking.notifications.confirmedAt)) {
    if (isManual(booking)) {
      const payment = booking.payment || (await Payment.findOne({ bookingId: booking._id, status: { $in: ["paid", "refund initiated", "refunded"] } }));
      if (payment) out.confirmed = await deliverHostConfirmed(booking, payment);
    } else {
      out.confirmed = await deliverInstantConfirmed(booking);
    }
  }
  return out;
}

// Recovery sweep (GET /booking/cron/notify-sweep): paid, still-live bookings
// of the last few days whose mails never (fully) went out — the guest closed
// the page after paying, or the mail provider was down. Bounded on purpose:
// never older bookings (they predate the claim flags), never past stays.
const SWEEP_WINDOW_MS = 3 * 24 * 60 * 60 * 1000;
async function sweepUnsent({ limit = 25, budgetMs = 45_000, graceMs = Number(process.env.NOTIFY_SWEEP_GRACE_MS ?? 10 * 60 * 1000), now = new Date() } = {}) {
  const rows = await Booking.find({
    action: "user",
    source: "local",
    paymentStatus: "paid",
    needsAttention: null,
    status: { $in: ["pending", "confirmed"] },
    checkOut: { $gt: now },
    updatedAt: { $gte: new Date(now.getTime() - SWEEP_WINDOW_MS), $lte: new Date(now.getTime() - graceMs) },
    $or: [{ "notifications.paidAt": null }, { status: "confirmed", "notifications.confirmedAt": null }],
  })
    .sort({ updatedAt: 1 })
    .limit(limit)
    .select("_id")
    .lean();
  const summary = { found: rows.length, completed: 0, failed: 0, deferred: 0 };
  const stopAt = Date.now() + budgetMs; // PDFs take seconds each; the rest waits for the next run
  for (const row of rows) {
    if (Date.now() > stopAt) {
      summary.deferred += 1;
      continue;
    }
    try {
      const r = await deliverOutstanding(row._id);
      const bad = Object.values(r).some((x) => x && x.error);
      summary[bad ? "failed" : "completed"] += 1;
    } catch (err) {
      summary.failed += 1;
      console.error("[notify-sweep] booking failed", String(row._id), err.message);
    }
  }
  return summary;
}

module.exports = {
  deliverPaid,
  deliverInstantConfirmed,
  deliverHostConfirmed,
  deliverOutstanding,
  sweepUnsent,
  notifyPaid,
  notifyHostConfirmed,
  notifyInstantConfirmed,
  notifyHostRejected,
  notifyAdminCancelled,
  notifyHostTerminated,
  notifyUserTerminated,
};

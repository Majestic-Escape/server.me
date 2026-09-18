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

const adminEmails = () =>
  String(process.env.ADMIN_EMAIL || "")
    .split(",")
    .map((e) => e.trim())
    .filter(Boolean);
const baseUrl = () => process.env.NEXTAUTH_URL;

function names(booking) {
  const userName = changeToUpperCase(`${booking.userId?.firstName || ""} ${booking.userId?.lastName || ""}`.trim());
  const hostName = changeToUpperCase(`${booking.hostId?.firstName || ""} ${booking.hostId?.lastName || ""}`.trim());
  return { userName, hostName, params: paramsToObject(userName, hostName, booking) };
}

async function sendToAdmins(templateId, params) {
  await Promise.all(adminEmails().map((email) => sendEmail(email, templateId, params)));
}

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
  const { params } = names(booking);
  if (manual) {
    await sendEmail(booking.hostId.email, 8, params);
    await sendToAdmins(9, params);
    await sendEmail(booking.userId.email, 42, params);
    return;
  }
  const { invoiceAttachment, guestListOnlyAttachment, cleanup } = await buildAttachments(booking, payment);
  try {
    await sendEmail(booking.hostId.email, 34, params, guestListOnlyAttachment);
    await sendEmail(booking.userId.email, 35, params, invoiceAttachment);
    await sendToAdmins(36, params);
  } finally {
    await cleanup();
  }
}

function reviewParams(booking, bookingId) {
  const token = jwt.sign({ bookingId }, process.env.JWT_SECRET, { expiresIn: "14d" });
  return {
    userName: `${booking.userId.firstName} ${booking.userId.lastName}`,
    hostName: `${booking.hostId.firstName} ${booking.hostId.lastName}`,
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
  });
}

// Host confirmed a (paid, manual) booking: user 10 (+invoice), host 19
// (+guest list), admins 18, then the post-checkout review reminder.
async function notifyHostConfirmed(booking, payment) {
  const { params } = names(booking);
  const { invoiceAttachment, guestListOnlyAttachment, cleanup } = await buildAttachments(booking, payment);
  try {
    await sendEmail(booking.userId.email, 10, params, invoiceAttachment);
    await sendEmail(booking.hostId.email, 19, params, guestListOnlyAttachment);
    await sendToAdmins(18, params);
  } finally {
    await cleanup();
  }
  await scheduleReviewEmails(booking);
}

// Instant booking confirmed by payment: only the review reminder (as before).
async function notifyInstantConfirmed(booking) {
  await scheduleReviewEmails(booking);
}

// Cancellation flows (template ids unchanged).
async function notifyHostRejected(booking) {
  const { params } = names(booking);
  await sendEmail(booking.userId.email, 11, params);
  await sendToAdmins(16, params);
  await sendEmail(booking.hostId.email, 17, params);
}
async function notifyAdminCancelled(booking) {
  const { params } = names(booking);
  await sendEmail(booking.userId.email, 32, params);
  await sendToAdmins(31, params);
  await sendEmail(booking.hostId.email, 33, params);
}
async function notifyHostTerminated(booking) {
  const { params } = names(booking);
  await sendEmail(booking.userId.email, 13, params);
  await sendEmail(booking.hostId.email, 14, params);
  await sendToAdmins(15, params);
}
async function notifyUserTerminated(booking) {
  const { params } = names(booking);
  await sendEmail(booking.userId.email, 22, params);
  await sendEmail(booking.hostId.email, 20, params);
  await sendToAdmins(21, params);
}

module.exports = {
  notifyPaid,
  notifyHostConfirmed,
  notifyInstantConfirmed,
  notifyHostRejected,
  notifyAdminCancelled,
  notifyHostTerminated,
  notifyUserTerminated,
};

const axios = require("axios");
require("dotenv").config();

// Configuration constants
const BREVO_API_URL = "https://api.brevo.com/v3/smtp/email";
const DEFAULT_SENDER = {
  name: process.env.EMAIL_SENDER_NAME || "Majestic Escape",
  email: process.env.EMAIL_SENDER_ADDRESS || "notify@majesticescape.in",
};

async function sendEmail(recipientEmail, templateId, params, attachments = []) {
  // Test seam (never set in a deployment): record instead of sending.
  if (process.env.EMAIL_DISABLED === "1") {
    sendEmail.sent = sendEmail.sent || [];
    sendEmail.sent.push({ recipientEmail, templateId: Number(templateId), attachments: attachments.length, params });
    return { skipped: true, recipientEmail, templateId };
  }
  // Prepare the request payload for Brevo API
  const requestPayload = {
    sender: DEFAULT_SENDER,
    to: [{ email: recipientEmail }],
    templateId: parseInt(templateId),
    params: params,
  };

  if (attachments.length > 0) {
    requestPayload.attachment = attachments;
  }

  try {
    // Make API request to Brevo
    const response = await axios.post(BREVO_API_URL, requestPayload, {
      headers: {
        accept: "application/json",
        "api-key": process.env.BREVO_API_KEY,
        "content-type": "application/json",
      },
      // A hung provider must fail the one mail (which is then retried), not hold the request until the platform kills it.
      timeout: Number(process.env.EMAIL_TIMEOUT_MS) || 15000,
    });

    console.log("Email sent successfully:", {
      messageId: response.data.messageId,
      recipient: recipientEmail,
    });

    return response.data;
  } catch (error) {
    // Enhanced error logging
    console.error("Error sending email:", {
      status: error.response?.status,
      message: error.response?.data?.message || error.message,
      recipient: recipientEmail,
    });

    throw new Error(
      `Failed to send email: ${error.response?.data?.message || error.message}`
    );
  }
}

// ---------------------------------------------------------------------------
// Plain notifications (ops alerts, SyncGuard host notices, admin → host
// messages). These used Brevo template HOST_NOTIFICATION_TEMPLATE_ID || 2,
// but template 2 is the guest WELCOME mail and never renders
// params.message: every alert arrived as "Welcome to Majestic Escape! Hi
// Admin" with the actual text missing (seen in production on a failed
// refund, 2026-10-15). The mail is now built here and sent as Brevo
// htmlContent + textContent: no template id to mis-point, versioned with the
// code, and the text is HTML-escaped (it carries gateway / calendar strings).
// ---------------------------------------------------------------------------
const escapeHtml = (value) =>
  String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
// One header line; Brevo rejects nothing here but a CR/LF must never reach a header.
const oneLine = (value, max = 150) => String(value ?? "").replace(/[\r\n\t]+/g, " ").replace(/\s{2,}/g, " ").trim().slice(0, max);

const SUPPORT_EMAIL = "info@majesticescape.in";

function notificationHtml({ firstName, message, tag, ctaUrl, ctaLabel }) {
  const paragraphs = String(message ?? "")
    .split(/\n{2,}/)
    .map((p) => `<p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#1E1E1E;">${escapeHtml(p).replace(/\n/g, "<br>")}</p>`)
    .join("");
  const badge = tag
    ? `<tr><td style="padding:0 32px 8px;"><span style="display:inline-block;padding:4px 10px;border-radius:999px;background:#FDECEC;color:#B42318;font-size:12px;font-weight:600;letter-spacing:.02em;">${escapeHtml(tag)}</span></td></tr>`
    : "";
  const cta =
    ctaUrl && /^https:\/\//.test(ctaUrl)
      ? `<tr><td style="padding:0 32px 24px;"><a href="${escapeHtml(ctaUrl)}" style="display:inline-block;padding:12px 22px;border-radius:999px;background:#36621F;color:#ffffff;font-size:14px;font-weight:600;text-decoration:none;">${escapeHtml(ctaLabel || "Open Majestic Escape")}</a></td></tr>`
      : "";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark"><meta name="supported-color-schemes" content="light dark">
<title>Majestic Escape</title></head>
<body style="margin:0;padding:0;background:#F3F4F1;font-family:Poppins,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F3F4F1;padding:24px 12px;">
<tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:16px;overflow:hidden;border:1px solid #E4E7E0;">
<tr><td style="background:#36621F;padding:20px 32px;"><span style="font-size:18px;font-weight:700;color:#ffffff;letter-spacing:.01em;">Majestic Escape</span></td></tr>
<tr><td style="height:24px;line-height:24px;">&nbsp;</td></tr>
${badge}
<tr><td style="padding:0 32px 8px;"><p style="margin:0 0 16px;font-size:16px;font-weight:600;color:#1E1E1E;">Hi ${escapeHtml(firstName || "there")},</p>${paragraphs}</td></tr>
${cta}
<tr><td style="padding:16px 32px 24px;border-top:1px solid #EEF0EC;"><p style="margin:0;font-size:12px;line-height:1.6;color:#5F6368;">This is an automated message from Majestic Escape. Questions? Write to <a href="mailto:${SUPPORT_EMAIL}" style="color:#36621F;">${SUPPORT_EMAIL}</a>.</p></td></tr>
</table>
</td></tr></table>
</body></html>`;
}

function notificationText({ firstName, message, ctaUrl, ctaLabel }) {
  return [
    `Hi ${firstName || "there"},`,
    "",
    String(message ?? ""),
    ...(ctaUrl ? ["", `${ctaLabel || "Open Majestic Escape"}: ${ctaUrl}`] : []),
    "",
    `This is an automated message from Majestic Escape. Questions? Write to ${SUPPORT_EMAIL}.`,
  ].join("\n");
}

/**
 * @param {string} recipientEmail
 * @param {string} firstName   greeting name ("Admin" for ops alerts)
 * @param {string} message     plain text; blank lines start a new paragraph
 * @param {{subject?: string, tag?: string, ctaUrl?: string, ctaLabel?: string}} [opts]
 *   tag: a short red label above the text (e.g. "Action needed");
 *   ctaUrl: an https link shown as a button.
 */
async function sendHostNotification(recipientEmail, firstName, message, opts = {}) {
  const subject = oneLine(opts.subject) || "A message from Majestic Escape";
  const ctaUrl = opts.ctaUrl && /^https:\/\//.test(opts.ctaUrl) ? opts.ctaUrl : null;
  const view = { firstName, message, tag: opts.tag ? oneLine(opts.tag, 40) : null, ctaUrl, ctaLabel: opts.ctaLabel ? oneLine(opts.ctaLabel, 40) : null };
  if (process.env.EMAIL_DISABLED === "1") {
    sendEmail.sent = sendEmail.sent || [];
    sendEmail.sent.push({ recipientEmail, templateId: null, kind: "notification", subject, params: { firstName, message }, html: notificationHtml(view) });
    return { skipped: true, recipientEmail, kind: "notification" };
  }
  try {
    const response = await axios.post(
      BREVO_API_URL,
      {
        sender: DEFAULT_SENDER,
        to: [{ email: recipientEmail }],
        subject,
        htmlContent: notificationHtml(view),
        textContent: notificationText(view),
        tags: ["notification"],
      },
      {
        headers: {
          accept: "application/json",
          "api-key": process.env.BREVO_API_KEY,
          "content-type": "application/json",
        },
        timeout: Number(process.env.EMAIL_TIMEOUT_MS) || 15000,
      },
    );
    console.log("Email sent successfully:", { messageId: response.data.messageId, recipient: recipientEmail, kind: "notification" });
    return response.data;
  } catch (error) {
    console.error("Error sending email:", {
      status: error.response?.status,
      message: error.response?.data?.message || error.message,
      recipient: recipientEmail,
      kind: "notification",
    });
    throw new Error(`Failed to send email: ${error.response?.data?.message || error.message}`);
  }
}

module.exports = {
  sendEmail,
  sendHostNotification,
  // exported for tests
  notificationHtml,
};

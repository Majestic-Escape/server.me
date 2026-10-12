// agenda.js
const Agenda = require("agenda");
const { sendEmail } = require("./sendEmail"); // your email function
require("dotenv").config();

const agenda = new Agenda({
  db: { address: process.env.DB_URI, collection: "agendaJobs" },
});

// The booking a review reminder is about: its stored id, or — for jobs
// scheduled before bookingId was stored — the id in the rating link.
function reminderBookingId({ bookingId, params } = {}) {
  return bookingId || (String((params && params.userUrl) || "").match(/[?&]booking=([a-f0-9]{24})/i) || [])[1] || null;
}

// The reminder is scheduled when a stay is confirmed, hours or days before it
// is due; the stay may have been cancelled since. Judge the booking as it is
// now (jobs scheduled before bookingId was stored carry it in the rating link).
async function stillConfirmed(data) {
  const id = reminderBookingId(data);
  if (!id) return data.bookingStatus === "confirmed";
  try {
    const b = await require("../models/Booking").findById(id).select("status").lean();
    return !!b && b.status === "confirmed";
  } catch (err) {
    console.error("review reminder: status lookup failed", err.message);
    return data.bookingStatus === "confirmed";
  }
}

// Host recipients of scheduled e-mails are resolved when the job RUNS, from
// the stored identity (listing / booking id) to the host's CURRENT account
// e-mail. They fail closed: no identity, no booking / listing, no host id, no
// account, no address or a failed lookup → null, and the host copy is
// skipped (logged without the address). A saved address is never used — an
// address alone does not identify the host (it can change and be reused).
async function accountEmail(userId) {
  if (!userId) return null;
  const u = await require("../models/User").findById(userId).select("email").lean();
  return u && u.email ? u.email : null;
}

// Listing reminders: the listing's current host.
async function reminderRecipient(data) {
  if (!data || !data.propertyId) return null;
  try {
    const l = await require("../models/ListingProperty").findById(data.propertyId).select("host").lean();
    return l && l.host ? await accountEmail(l.host) : null;
  } catch (err) {
    console.error("listing reminder: host recipient lookup failed — host copy skipped", err.message);
    return null;
  }
}

// Review reminders: the host of the reviewed booking.
async function reviewHostRecipient(data) {
  const id = reminderBookingId(data);
  if (!id) return null;
  try {
    const b = await require("../models/Booking").findById(id).select("hostId").lean();
    return b && b.hostId ? await accountEmail(b.hostId) : null;
  } catch (err) {
    console.error("review reminder: host recipient lookup failed — host copy skipped", err.message);
    return null;
  }
}

// Define the job once globally
agenda.define("sendReviewEmail", async (job, done) => {
  if (process.env.NEXT_PUBLIC_ENV === "dev") {
    console.log("Agenda Function");
  }
  const { userEmail, params } = job.attrs.data;

  try {
    if (await stillConfirmed(job.attrs.data)) {
      if (process.env.NEXT_PUBLIC_ENV === "dev") {
        console.log("Agenda Function Inside");
      }
      await sendEmail(userEmail, 12, params);
      const hostTo = await reviewHostRecipient(job.attrs.data);
      if (hostTo) await sendEmail(hostTo, 43, params);
      else console.warn("review reminder: no resolvable host account — host copy skipped");
      if (process.env.NEXT_PUBLIC_ENV === "dev") {
        console.log("Agenda Function complete");
      }
    }
  } catch (err) {
    console.error("Error in job:", err);
  } finally {
    done();
  }
});

agenda.define("sendPropertyReminderEmail", async (job, done) => {
  const { newStatus, host, propertyId } = job.attrs.data;
  const hostEmail = await reminderRecipient(job.attrs.data);
  if (!hostEmail) console.warn("listing reminder: no resolvable host account — skipped");
  const params = { hostName: host };
  try {
    if (newStatus == "incomplete" && hostEmail) {
      if (process.env.HOST_COMMISSION_OFFER == "true") {
        await sendEmail(hostEmail, 52, params);
      } else {
        await sendEmail(hostEmail, 53, params);
      }
      await agenda.schedule(`48 hours`, "sendPropertyReminderAgainEmail", {
        newStatus,
        host,
        propertyId,
      });
    }
  } catch (err) {
    console.error("Error in job:", err);
  } finally {
    done();
  }
});
agenda.define("sendPropertyReminderAgainEmail", async (job, done) => {
  const { newStatus, host } = job.attrs.data;
  const hostEmail = await reminderRecipient(job.attrs.data);
  if (!hostEmail) console.warn("listing reminder: no resolvable host account — skipped");
  const params = { hostName: host };
  try {
    if (newStatus == "incomplete" && hostEmail) {
      if (process.env.HOST_COMMISSION_OFFER == "true") {
        await sendEmail(hostEmail, 52, params);
      } else {
        await sendEmail(hostEmail, 53, params);
      }
    }
  } catch (err) {
    console.error("Error in job:", err);
  } finally {
    done();
  }
});
(async () => {
  await agenda.start();
  if (process.env.NEXT_PUBLIC_ENV === "dev") {
    console.log("✅ Agenda started globally");
  }
})();

// exposed for tests (recipient resolution only)
agenda.__recipients = { reminderRecipient, reviewHostRecipient };
module.exports = agenda;

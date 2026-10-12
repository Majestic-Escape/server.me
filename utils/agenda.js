// agenda.js
const Agenda = require("agenda");
const { sendEmail } = require("./sendEmail"); // your email function
require("dotenv").config();

const agenda = new Agenda({
  db: { address: process.env.DB_URI, collection: "agendaJobs" },
});

// The reminder is scheduled when a stay is confirmed, hours or days before it
// is due; the stay may have been cancelled since. Judge the booking as it is
// now (jobs scheduled before bookingId was stored carry it in the rating link).
async function stillConfirmed({ bookingId, params, bookingStatus }) {
  const id = bookingId || ((String((params && params.userUrl) || "").match(/[?&]booking=([a-f0-9]{24})/i) || [])[1]);
  if (!id) return bookingStatus === "confirmed";
  try {
    const b = await require("../models/Booking").findById(id).select("status").lean();
    return !!b && b.status === "confirmed";
  } catch (err) {
    console.error("review reminder: status lookup failed", err.message);
    return bookingStatus === "confirmed";
  }
}

// The listing reminder goes to the host's CURRENT account e-mail, looked up
// when it is sent (a day or more after it was scheduled — the account address
// may have changed, the listing may have moved to another host or been
// deleted). Jobs scheduled before propertyId was stored keep their address.
async function reminderRecipient(data) {
  if (!data || !data.propertyId) return data && data.hostEmail;
  try {
    const l = await require("../models/ListingProperty").findById(data.propertyId).select("host").lean();
    if (!l || !l.host) return null;
    return await require("../services/listingPublish").hostEmailOf(l.host);
  } catch (err) {
    console.error("listing reminder: recipient lookup failed", err.message);
    return null;
  }
}

// The review reminder's host copy goes to the booking host's CURRENT account
// e-mail (the address may have changed since the stay was confirmed).
async function reviewHostRecipient({ bookingId, hostEmail }) {
  if (!bookingId) return hostEmail;
  try {
    const b = await require("../models/Booking").findById(bookingId).select("hostId").lean();
    if (!b || !b.hostId) return hostEmail;
    const u = await require("../models/User").findById(b.hostId).select("email").lean();
    return u && u.email ? u.email : hostEmail;
  } catch (err) {
    console.error("review reminder: host recipient lookup failed", err.message);
    return hostEmail;
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
        hostEmail,
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

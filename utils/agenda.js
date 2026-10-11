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

// Define the job once globally
agenda.define("sendReviewEmail", async (job, done) => {
  if (process.env.NEXT_PUBLIC_ENV === "dev") {
    console.log("Agenda Function");
  }
  const { userEmail, hostEmail, params } = job.attrs.data;

  try {
    if (await stillConfirmed(job.attrs.data)) {
      if (process.env.NEXT_PUBLIC_ENV === "dev") {
        console.log("Agenda Function Inside");
      }
      await sendEmail(userEmail, 12, params);
      await sendEmail(hostEmail, 43, params);
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
  const { newStatus, hostEmail, host } = job.attrs.data;
  const params = { hostName: host };
  try {
    if (newStatus == "incomplete") {
      if (process.env.HOST_COMMISSION_OFFER == "true") {
        await sendEmail(hostEmail, 52, params);
      } else {
        await sendEmail(hostEmail, 53, params);
      }
      await agenda.schedule(`48 hours`, "sendPropertyReminderAgainEmail", {
        newStatus,
        hostEmail,
        host,
      });
    }
  } catch (err) {
    console.error("Error in job:", err);
  } finally {
    done();
  }
});
agenda.define("sendPropertyReminderAgainEmail", async (job, done) => {
  const { newStatus, hostEmail, host } = job.attrs.data;
  const params = { hostName: host };
  try {
    if (newStatus == "incomplete") {
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

module.exports = agenda;

// agenda.js
const Agenda = require("agenda");
const { sendEmail } = require("./sendEmail"); // your email function
require("dotenv").config();

const agenda = new Agenda({
  db: { address: process.env.DB_URI, collection: "agendaJobs" },
});

// Define the job once globally
agenda.define("sendReviewEmail", async (job, done) => {
  if (process.env.NEXT_PUBLIC_ENV === "dev") {
    console.log("Agenda Function");
  }
  const { userEmail, hostEmail, params, bookingStatus } = job.attrs.data;

  try {
    if (bookingStatus === "confirmed") {
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
  }
});
(async () => {
  await agenda.start();
  if (process.env.NEXT_PUBLIC_ENV === "dev") {
    console.log("✅ Agenda started globally");
  }
})();

module.exports = agenda;

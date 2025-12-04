// agenda.js
const Agenda = require("agenda");
const { sendEmail } = require("./sendEmail"); // your email function
require("dotenv").config();

const agenda = new Agenda({
  db: { address: process.env.DB_URI, collection: "agendaJobs" },
});

// Define the job once globally
agenda.define("sendReviewEmail", async (job, done) => {
  console.log("Agenda Function");
  const { userEmail, hostEmail, params, bookingStatus } = job.attrs.data;

  try {
    if (bookingStatus === "confirmed") {
      console.log("Agenda Function Inside");
      await sendEmail(userEmail, 12, params);
      await sendEmail(hostEmail, 43, params);
      console.log("Agenda Function complete");
    }
  } catch (err) {
    console.error("Error in job:", err);
  } finally {
    done();
  }
});

(async () => {
  await agenda.start();
  console.log("✅ Agenda started globally");
})();

module.exports = agenda;

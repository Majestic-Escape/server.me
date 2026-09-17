const ExternalCalendar = require("../models/ExternalCalendar");
const crypto = require("crypto");
const Booking = require("../models/Booking");
// const ical = require("ical-generator").default;
const ical = require("node-ical");
const axios = require("axios");
const cron = require("node-cron");
const ListingProperty = require("../models/ListingProperty");
const inventory = require("../services/inventory");
let isCalendarCronRunning = false;
// async function syncCalendars(hostId) {
//   const calendars = await ExternalCalendar.find({ kind: "import" });
//   for (const cal of calendars) {
//     try {
//       const headers = {};
//       if (cal.etag) headers["If-None-Match"] = cal.etag;
//       if (cal.lastModified)
//         headers["If-Modified-Since"] = cal.lastModified.toUTCString();

//       const resp = await axios.get(cal.url, {
//         headers,
//         responseType: "text",
//         validateStatus: (s) => s === 200 || s === 304,
//         timeout: 20000,
//       });

//       if (resp.status === 304) {
//         // nothing changed
//         process.env.ENV === 'dev' && if (process.env.NEXT_PUBLIC_ENV === "dev") {
//   console.log("Calendar not modified:", cal.url);
// }
//         continue;
//       }

//       // update etag/lastModified
//       if (resp.headers.etag) cal.etag = resp.headers.etag;
//       if (resp.headers["last-modified"])
//         cal.lastModified = new Date(resp.headers["last-modified"]);
//       cal.lastFetched = new Date();
//       await cal.save();

//       // parse ICS
//       const data = resp.data;
//       process.env.ENV === 'dev' && if (process.env.NEXT_PUBLIC_ENV === "dev") {
//   console.log("the old", data);
// }
//       const parsed = ical.sync.parseICS(data);
//       process.env.ENV === 'dev' && if (process.env.NEXT_PUBLIC_ENV === "dev") {
//   console.log("the new", parsed);
// }

//       // collect UIDs seen
//       const seenUIDs = [];

//       for (const key in parsed) {
//         const vevent = parsed[key];
//         if (vevent.type !== "VEVENT") continue;

//         const uid = vevent.uid || vevent.uid || vevent.uid;
//         if (!uid) continue;

//         seenUIDs.push(uid);

//         // Node-ical gives start/end as Date if it can parse them
//         let start = vevent.start;
//         let end = vevent.end;
//         process.env.ENV === 'dev' && if (process.env.NEXT_PUBLIC_ENV === "dev") {
//   console.log("the start", start, end);
// }
//         // Normalize: if either is string or date, ensure Date objects
//         start = new Date(start);
//         end = new Date(end);

//         // Convert to date-only if they are all-day events (optional)
//         // Upsert booking by sourceId & propertyId
//         const existing = await Booking.findOne({
//           source: "ical",
//           sourceId: uid,
//           propertyId: cal.propertyId,
//         });

//         if (existing) {
//           // Update if dates changed
//           existing.checkIn = start;
//           existing.checkOut = end;
//           existing.price = existing.price ?? 0;
//           existing.status = "confirmed";
//           await existing.save();
//         } else {
//           // Create new imported booking -> block the dates
//           const newB = new Booking({
//             userId: hostId, // imported bookings may not have a user
//             propertyId: cal.propertyId,
//             hostId: hostId,
//             checkIn: start,
//             checkOut: end,
//             price: 0,
//             currency: "INR",
//             status: "confirmed",
//             paymentStatus: "unpaid",
//             source: "ical",
//             sourceId: uid,
//             guests: 0,
//           });
//           await newB.save();
//         }
//       }

//       // Remove bookings that were imported from this calendar but no longer present
//       const importedBookings = await Booking.find({
//         propertyId: cal.propertyId,
//         source: "ical",
//       });

//       for (const b of importedBookings) {
//         if (!seenUIDs.includes(b.sourceId)) {
//           // either remove or mark as cancelled
//           // await Booking.deleteOne({ _id: b._id });
//           b.status = "cancelled";
//           await b.save();
//         }
//       }
//     } catch (err) {
//       console.error("Failed to sync", cal.url, err.message || err);
//     }
//   } // for
// }
// Helper functions - define these OUTSIDE the syncCalendars function
function correctICalDates(vevent) {
  if (process.env.NEXT_PUBLIC_ENV === "dev") {
    console.log(`\n=== Correcting dates for: ${vevent.summary} ===`);
  }

  let start, end;

  // Check if this is an all-day event (VALUE=DATE format)
  const isAllDayEvent =
    vevent.start &&
    vevent.start.value &&
    typeof vevent.start.value === "string" &&
    vevent.start.value.length === 8; // YYYYMMDD format

  if (process.env.NEXT_PUBLIC_ENV === "dev") {
    console.log("Is all-day event:", isAllDayEvent);
  }

  if (isAllDayEvent) {
    // Parse dates manually to avoid timezone issues
    start = parseAllDayDate(vevent.start.value);
    end = parseAllDayDate(vevent.end.value);

    if (process.env.NEXT_PUBLIC_ENV === "dev") {
      console.log("Manual parsing - Start:", start.toISOString());
    }

    if (process.env.NEXT_PUBLIC_ENV === "dev") {
      console.log("Manual parsing - End:", end.toISOString());
    }

    // For all-day events in iCal, the end date is EXCLUSIVE
    // So "20251022 to 20251026" means: Oct 22, 23, 24, 25 (check out Oct 26)
    // We need to keep the end date as is for blocking purposes
    // The end date should remain as the checkout day
  } else {
    // For date-time events, use the parsed dates but ensure UTC
    start = forceUTC(new Date(vevent.start));
    end = forceUTC(new Date(vevent.end));

    if (process.env.NEXT_PUBLIC_ENV === "dev") {
      console.log("Date-time event - Start:", start.toISOString());
    }

    if (process.env.NEXT_PUBLIC_ENV === "dev") {
      console.log("Date-time event - End:", end.toISOString());
    }
  }

  return { start, end, isAllDayEvent };
}

function parseAllDayDate(dateString) {
  if (!dateString || dateString.length !== 8) {
    throw new Error(`Invalid date format: ${dateString}`);
  }

  // Parse YYYYMMDD format manually
  const year = parseInt(dateString.substring(0, 4));
  const month = parseInt(dateString.substring(4, 6)) - 1; // Months are 0-indexed
  const day = parseInt(dateString.substring(6, 8));

  // Create date in UTC to avoid timezone shifts
  // Use noon UTC to minimize timezone conversion issues
  return new Date(Date.UTC(year, month, day, 12, 0, 0));
}

function forceUTC(date) {
  if (!(date instanceof Date) || isNaN(date.getTime())) {
    throw new Error("Invalid date provided to forceUTC");
  }

  // Convert any date to UTC equivalent
  return new Date(
    Date.UTC(
      date.getFullYear(),
      date.getMonth(),
      date.getDate(),
      date.getHours(),
      date.getMinutes(),
      date.getSeconds()
    )
  );
}

// Main function
async function syncCalendars(hostId) {
  const calendars = await ExternalCalendar.find({ kind: "import" });
  for (const cal of calendars) {
    try {
      const headers = {};
      if (cal.etag) headers["If-None-Match"] = cal.etag;
      if (cal.lastModified)
        headers["If-Modified-Since"] = cal.lastModified.toUTCString();

      const resp = await axios.get(cal.url, {
        headers,
        responseType: "text",
        validateStatus: (s) => s === 200 || s === 304,
        timeout: 20000,
      });

      if (resp.status === 304) {
        if (process.env.NEXT_PUBLIC_ENV === "dev") {
          console.log("Calendar not modified:", cal.url);
        }
        continue;
      }

      // update etag/lastModified
      if (resp.headers.etag) cal.etag = resp.headers.etag;
      if (resp.headers["last-modified"])
        cal.lastModified = new Date(resp.headers["last-modified"]);
      cal.lastFetched = new Date();
      await cal.save();

      // parse ICS
      const data = resp.data;
      if (process.env.NEXT_PUBLIC_ENV === "dev") {
        console.log("=== RAW ICS DATA ===");
      }
      // Extract just the date parts to see the original values
      const dateMatches = data.match(
        /DTSTART[^:]*:(\d{8})|DTEND[^:]*:(\d{8})/g
      );
      if (dateMatches) {
        if (process.env.NEXT_PUBLIC_ENV === "dev") {
          console.log("Original dates from ICS:", dateMatches);
        }
      }

      const parsed = ical.sync.parseICS(data);
      if (process.env.NEXT_PUBLIC_ENV === "dev") {
        console.log("=== PARSED DATA ===");
      }

      // collect UIDs seen
      const seenUIDs = [];

      for (const key in parsed) {
        const vevent = parsed[key];
        if (vevent.type !== "VEVENT") continue;

        const uid = vevent.uid;
        if (!uid) continue;

        seenUIDs.push(uid);

        try {
          // Use our correction function instead of direct Date conversion
          const { start, end, isAllDayEvent } = correctICalDates(vevent);
          const today = new Date();
          today.setHours(0, 0, 0, 0);

          if (end < today) {
            console.log(
              `⏭️ Skipping past booking UID ${uid} - start: ${start}`
            );
            continue;
          }
          if (process.env.NEXT_PUBLIC_ENV === "dev") {
            console.log("FINAL DATES FOR BOOKING:");
          }

          // console.log(
          //   "Start:",
          //   start.toISOString(),
          //   "->",
          //   start.toDateString()
          // );

          if (process.env.NEXT_PUBLIC_ENV === "dev") {
            console.log("End:", end.toISOString(), "->", end.toDateString());
          }

          if (process.env.NEXT_PUBLIC_ENV === "dev") {
            console.log("Nights:", (end - start) / (1000 * 60 * 60 * 24));
          }

          // Validate the dates make sense
          if (start >= end) {
            console.error("Invalid dates: start after end for UID:", uid);
            continue;
          }

          // Upsert booking by sourceId & propertyId
          const existing = await Booking.findOne({
            source: "ical",
            sourceId: uid,
            propertyId: cal.propertyId,
          });

          if (existing) {
            // Update if dates changed
            existing.checkIn = start;
            existing.checkOut = end;
            existing.price = existing.price ?? 0;
            existing.status = "confirmed";
            await existing.save();
            // Batch S: keep the night inventory in step with the import.
            await inventory.releaseNights(existing._id);
            await inventory.ensureNightsBestEffort({
              propertyId: cal.propertyId,
              nights: inventory.nightsBetween(start, end),
              bookingId: existing._id,
              kind: "ical",
            });

            if (process.env.NEXT_PUBLIC_ENV === "dev") {
              console.log("✅ Updated booking:", existing._id);
            }
          } else {
            // Create new imported booking -> block the dates
            const newB = new Booking({
              userId: hostId,
              propertyId: cal.propertyId,
              hostId: hostId,
              checkIn: start,
              checkOut: end,
              price: 0,
              subTotal: 0,
              currency: "INR",
              status: "confirmed",
              paymentStatus: "paid",
              source: "ical",
              sourceId: uid,
              guests: 0,
              notes: `Imported from calendar${
                isAllDayEvent ? " (all-day event)" : ""
              }`,
            });
            await newB.save();
            await inventory.ensureNightsBestEffort({
              propertyId: cal.propertyId,
              nights: inventory.nightsBetween(start, end),
              bookingId: newB._id,
              kind: "ical",
            });

            if (process.env.NEXT_PUBLIC_ENV === "dev") {
              console.log("✅ Created new booking:", newB._id);
            }
          }
          // return resp.status;
        } catch (dateError) {
          console.error(
            "Error processing dates for UID:",
            uid,
            dateError.message
          );
          continue;
        }
      }

      // Batch A2: the listing may have been deleted by an admin while this
      // import ran (an import can target a pending listing). Imports for a
      // listing that no longer exists are withdrawn here; the admin delete's
      // post-commit sweep covers the remaining interleavings.
      const listingStillThere = await ListingProperty.exists({ _id: cal.propertyId });
      if (!listingStillThere) {
        const orphans = await Booking.find({ propertyId: cal.propertyId, source: "ical" }).select("_id").lean();
        for (const b of orphans) {
          await Booking.deleteOne({ _id: b._id });
          await inventory.releaseNights(b._id);
        }
        console.log(`calendar sync: listing ${cal.propertyId} no longer exists; ${orphans.length} imported booking(s) withdrawn`);
        continue;
      }

      // Remove bookings that were imported from this calendar but no longer present
      const importedBookings = await Booking.find({
        propertyId: cal.propertyId,
        source: "ical",
      });

      for (const b of importedBookings) {
        if (!seenUIDs.includes(b.sourceId)) {
          b.status = "cancelled";
          await b.save();
          await inventory.releaseNights(b._id);

          if (process.env.NEXT_PUBLIC_ENV === "dev") {
            console.log("❌ Cancelled missing booking:", b._id);
          }
        }
      }

      console.log(
        `🎉 Successfully synced calendar for property: ${cal.propertyId}`
      );
    } catch (err) {
      console.error("Failed to sync", cal.url, err.message || err);
    }
  }
}

// exports.saveCalendarUrl = async (req, res) => {
//   try {
//     const { propertyId, url, kind } = req.body;

//     const userData = await ListingProperty.findById(propertyId);

//     let secret = null;
//     if (kind === "export") {
//       // generate a secret for public ICS endpoint
//       secret = crypto.randomBytes(16).toString("hex");
//       const filter = {};
//       if (propertyId) {
//         filter.propertyId = propertyId;
//         filter.kind = "export";
//       }
//       const data = await ExternalCalendar.find(filter);
//       if (!data.propertyId == propertyId) {
//         const cal = new ExternalCalendar({
//           propertyId,
//           url,
//           kind,
//           secret,
//         });
//         await cal.save();
//       }
//     }

//     if (kind == "import") {
//       const cal = new ExternalCalendar({
//         propertyId,
//         url,
//         kind,
//         secret,
//       });
//       await cal.save();
//       await syncCalendars(userData.host);
//       if (!isCalendarCronRunning) {
//         cron.schedule("*/5 * * * *", async () => {
//           process.env.ENV === 'dev' && if (process.env.NEXT_PUBLIC_ENV === "dev") {
//   console.log("Running calendar sync...");
// }
//           await syncCalendars(userData.host);
//         });
//         isCalendarCronRunning = true;
//         process.env.ENV === 'dev' && if (process.env.NEXT_PUBLIC_ENV === "dev") {
//   console.log("✅ Calendar sync cron job started");
// }
//       }
//       res.json({ success: true, message: "Calendar imported", calendar: cal });
//     } else {
//       const host = process.env.PUBLIC_HOSTNAME;
//       const url = `https://${host}/calendarSync/ics/${secret}.ics`;

//       res.json({ success: true, url, secret });
//     }
//   } catch (err) {
//     console.error(err);
//     res.status(500).json({ success: false, message: err.message });
//   }
// };

exports.saveCalendarUrl = async (req, res) => {
  try {
    const { propertyId, url, kind } = req.body;
    const userData = await ListingProperty.findById(propertyId);

    let secret = null;

    if (kind === "export") {
      // check if export calendar already exists for this property
      const existing = await ExternalCalendar.findOne({
        propertyId,
        kind: "export",
      });
      if (process.env.NEXT_PUBLIC_ENV === "dev") {
        console.log("new fil", existing);
      }
      if (existing) {
        // ✅ Don't create a new one, just return the existing URL
        const host = process.env.PUBLIC_HOSTNAME;
        const url = `${host}/calendarSync/ics/${existing.secret}.ics`;

        return res.json({
          success: true,
          message: "Export calendar already exists",
          url,
          secret: existing.secret,
        });
      }

      // otherwise create a new export entry
      secret = crypto.randomBytes(16).toString("hex");
      const cal = new ExternalCalendar({ propertyId, kind, secret });
      await cal.save();

      const host = process.env.PUBLIC_HOSTNAME;
      const url = `${host}/calendarSync/ics/${secret}.ics`;

      return res.json({ success: true, url, secret });
    }

    // if (kind === "import") {
    //   const cal = new ExternalCalendar({ propertyId, url, kind });
    //   await cal.save();

    //   await syncCalendars(userData.host);

    //   if (!isCalendarCronRunning) {
    //     cron.schedule("*/5 * * * *", async () => {
    //       process.env.ENV === 'dev' && if (process.env.NEXT_PUBLIC_ENV === "dev") {
    //   console.log("Running calendar sync...");
    // }
    //       await syncCalendars(userData.host);
    //     });
    //     isCalendarCronRunning = true;
    //     process.env.ENV === 'dev' && if (process.env.NEXT_PUBLIC_ENV === "dev") {
    //   console.log("✅ Calendar sync cron job started");
    // }
    //   }
    //   return res.json({
    //     success: true,
    //     calendar: cal,
    //     message: firstTimeSync
    //       ? "Calendar sync has started. Please wait a few minutes and refresh the page."
    //       : "Calendar already synced. We will keep checking for updates.",
    //   });
    //   // return res.json({
    //   //   success: true,
    //   //   message: "Calendar imported",
    //   //   calendar: cal,
    //   // });
    // }

    if (kind === "import") {
      const existingImport = await ExternalCalendar.findOne({
        propertyId,
        kind: "import",
      });

      let firstTimeSync = false;

      if (!existingImport) {
        // FIRST TIME IMPORT → SAVE URL
        const cal = new ExternalCalendar({ propertyId, url, kind });
        await cal.save();
        firstTimeSync = true;
      }

      // START SYNC IMMEDIATELY
      await syncCalendars(userData.host);

      // START CRON ONLY ON FIRST SUBMISSION
      if (!isCalendarCronRunning) {
        cron.schedule("*/5 * * * *", async () => {
          if (process.env.NEXT_PUBLIC_ENV === "dev") {
            console.log("⏳ Running periodic calendar sync...");
          }
          await syncCalendars(userData.host);
        });

        isCalendarCronRunning = true;

        if (process.env.NEXT_PUBLIC_ENV === "dev") {
          console.log("🚀 Calendar sync cron job started");
        }
      }

      return res.json({
        success: true,
        message: firstTimeSync
          ? "Calendar sync has started. Please wait a few minutes and refresh the page."
          : "Calendar already synced. We will keep checking for updates.",
      });
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: err.message });
  }
};

// exports.exportCalendar = async (req, res) => {
//   try {
//     const { secret } = req.params;
//     const calEntry = await ExternalCalendar.findOne({ secret, kind: "export" });
//     if (!calEntry) return res.status(404).send("Not found");

//     // fetch bookings for property
//     const bookings = await Booking.find({
//       propertyId: calEntry.propertyId,
//       // include local and maybe imported bookings if desired
//       // decide what bookings you want to export (e.g. all confirmed/unavailable)
//     });

//     const domain = process.env.PUBLIC_HOSTNAME; // used for UID
//     const calendar = ical({ domain, name: "My App Calendar" });

//     bookings.forEach((b) => {
//       // choose UID pattern that distinguishes exported events from imported ones
//       const uid = `${b._id}@${domain}`;

//       calendar.createEvent({
//         start: b.checkIn,
//         end: b.checkOut,
//         summary: b.title || `Blocked`,
//         uid,
//         description: b._id.toString(),
//         allDay: true, // set to true if your checkIn/checkOut are whole-day events
//       });
//     });

//     res.setHeader("Content-Type", "text/calendar; charset=utf-8");
//     calendar.serve(res); // ical-generator will pipe calendar text to response
//   } catch (err) {
//     console.error(err);
//     res.status(500).send("Server error");
//   }
// };
function toUTCMidnight(dateLike) {
  const d = new Date(dateLike);
  // use UTC midnight to produce DATE-only values in ICS
  return new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
  );
}

exports.exportCalendar = async (req, res) => {
  try {
    const { secret } = req.params;
    const calEntry = await ExternalCalendar.findOne({
      secret,
      kind: "export",
    }).lean();
    if (!calEntry) return res.status(404).send("Not found");

    const bookings = await Booking.find({
      propertyId: calEntry.propertyId,
      status: { $nin: ["rejected", "cancelled"] },
    }).lean();

    const domain = process.env.PUBLIC_HOSTNAME || "yourdomain.com";
    const calendar = ical({
      domain,
      name: `Property ${calEntry.propertyId} calendar`,
    });

    bookings.forEach((b) => {
      const start = new Date(b.checkIn);
      const end = new Date(b.checkOut);
      const uid = `${b._id}@${domain}`;

      calendar.createEvent({
        uid,
        start,
        end,
        summary: b.title || "Blocked",
        description: `Booking ${b._id}`,
        allDay: true,
      });
    });

    // Set headers for iCal file download
    res.setHeader("Content-Type", "text/calendar; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="calendar-${calEntry.secret}.ics"`
    );

    // ✅ Send calendar as text
    res.send(calendar.toString());
  } catch (err) {
    console.error("export ICS error:", err);
    res.status(500).send("Server error");
  }
};

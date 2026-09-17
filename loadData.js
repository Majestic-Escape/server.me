const mongoose = require("mongoose");
const PropertyRegistrationNo = require("./models/PropertyRegistrationNo");
const data = require("./output.json"); // Ensure data.json is in the same folder

// Replace with your MongoDB connection string and database name
const dbURI =
  process.env.DB_URI /* no credentials in source; set DB_URI */;

mongoose
  .connect(dbURI, { useNewUrlParser: true, useUnifiedTopology: true })
  .then(async () => {
    if (process.env.NEXT_PUBLIC_ENV === "dev") {
      console.log("MongoDB connected");
    }
    try {
      // Insert many property records. The { ordered: false } option allows
      // the insert to continue even if some records fail (e.g., due to duplicates).
      const result = await PropertyRegistrationNo.insertMany(data, {
        ordered: false,
      });

      if (process.env.NEXT_PUBLIC_ENV === "dev") {
        console.log("Data inserted successfully:", result);
      }
    } catch (error) {
      console.error("Error inserting data:", error);
    } finally {
      mongoose.connection.close();
    }
  })
  .catch((err) => console.error("MongoDB connection error:", err));

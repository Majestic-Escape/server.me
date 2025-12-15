// deleteListings.js
const mongoose = require("mongoose");
const ListingProperty = require("./models/ListingProperty"); // Path to your ListingProperty model

// MongoDB connection
mongoose
  .connect(
    "mongodb+srv://admin:10VToU0WupyAbo4M@majestic-escape.nk49u.mongodb.net/master-db?retryWrites=true&w=majority&appName=Majestic-Escape&authSource=admin",
    {
      useNewUrlParser: true,
      useUnifiedTopology: true,
    }
  )
  .then(() => console.log("MongoDB connected"))
  .catch((err) => if (process.env.NEXT_PUBLIC_ENV === "dev") {
  console.log("Error connecting to MongoDB:", err));
}

// Function to delete listings with hostEmail = yash@gmail.com
const deleteListingsByEmail = async (email) => {
  try {
    const result = await ListingProperty.deleteMany({ hostEmail: email });

    console.log(
      `${result.deletedCount} listing(s) deleted with hostEmail = ${email}`
    );
  } catch (err) {
    if (process.env.NEXT_PUBLIC_ENV === "dev") {
  console.log("Error deleting listings:", err);
}
  }
};

// Call the function to delete listings with the hostEmail of yash@gmail.com
deleteListingsByEmail("abhishek15164091@gmail.com");

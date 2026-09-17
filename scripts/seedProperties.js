// scripts/seedProperties.js
require("dotenv").config();
const mongoose = require("mongoose");
const MajesticStay = require("../models/Property");

const properties = [
  {
    id: 1,
    type: "Villas",
    images: [
      "/images/properties/luxe-villa/luxe1.jpeg",
      "/images/properties/luxe-villa/luxe2.webp",
      "/images/properties/luxe-villa/luxe3.jpeg",
      "/images/properties/luxe-villa/luxe4.webp",
      "/images/properties/luxe-villa/luxe5.webp",
      "/images/properties/luxe-villa/luxe1.jpeg",
    ],
    title: "Luxe Villa",
    location: "Arpora, India",
    price: 4907,
    badge: "Guest's fav",
    dateRange: "10 - 15 Nov",
  },
  {
    id: 2,
    type: "Villas",
    images: [
      "/images/properties/casa-caisua/casa1.webp",
      "/images/properties/casa-caisua/casa2.webp",
      "/images/properties/casa-caisua/casa3.webp",
      "/images/properties/casa-caisua/casa4.webp",
      "/images/properties/casa-caisua/casa5.webp",
      "/images/properties/casa-caisua/casa1.webp",
    ],
    title: "Casa Caisua- Luxury Goan Loft Style Villa",
    location: "Vagator, Anjuna, India",
    price: 4907,
    badge: "Guest's fav",
    dateRange: "10 - 15 Nov",
  },
  {
    id: 3,
    type: "Farm House",
    images: [
      "/images/properties/fig/fig1.jpg",
      "/images/properties/fig/fig2.jpg",
      "/images/properties/fig/fig3.jpg",
      "/images/properties/fig/fig4.jpg",
      "/images/properties/fig/fig5.jpg",
    ],
    title: "The Figueiredo House - Lotoulim",
    location: "Goa, Goa",
    price: 4907,
    badge: "Guest's fav",
    dateRange: "10 - 15 Nov",
  },
  {
    id: 4,
    type: "Villas",
    images: [
      "/images/properties/villa-de-festa/villa-de-festa1.webp",
      "/images/properties/villa-de-festa/villa-de-festa2.webp",
      "/images/properties/villa-de-festa/villa-de-festa3.webp",
      "/images/properties/villa-de-festa/villa-de-festa4.webp",
      "/images/properties/villa-de-festa/villa-de-festa5.webp",
    ],
    title: "Villa De Festa",
    location: "Anjuna, India",
    price: 4907,
    badge: "Guest's fav",
    dateRange: "10 - 15 Nov",
  },
  {
    id: 5,
    type: "Pool",
    images: [
      "/images/properties/stellar/stellar1.webp",
      "/images/properties/stellar/stellar2.webp",
      "/images/properties/stellar/stellar3.webp",
      "/images/properties/stellar/stellar4.webp",
      "/images/properties/stellar/stellar5.webp",
    ],
    title: "Stellar Kamalaya Assagao",
    location: "Assagao, India",
    price: 4907,
    badge: "Guest's fav",
    dateRange: "10 - 15 Nov",
  },
  {
    id: 6,
    type: "Apartments",
    images: [
      "/images/properties/colva/colva2.webp",
      "/images/properties/colva/colva5.webp",
      "/images/properties/colva/colva3.jpeg",
      "/images/properties/colva/colva4.webp",
      "/images/properties/colva/colva1.webp",
    ],
    title: "A plush 2 Bedroom",
    location: "Colva, India",
    price: 4907,
    badge: "Guest's fav",
    dateRange: "10 - 15 Nov",
  },
  {
    id: 7,
    type: "Farm House",
    images: [
      "/images/properties/menons/menons1.webp",
      "/images/properties/menons/menons2.webp",
      "/images/properties/menons/menons3.webp",
      "/images/properties/menons/menons4.webp",
      "/images/properties/menons/menons5.webp",
    ],
    title: "Menons",
    location: "Benaulim, India",
    price: 4907,
    badge: "Guest's fav",
    dateRange: "10 - 15 Nov",
  },
  {
    id: 8,
    type: "Farm House",
    images: [
      "/images/properties/ov4/ov4_1.webp",
      "/images/properties/ov4/ov4_2.webp",
      "/images/properties/ov4/ov4_3.webp",
      "/images/properties/ov4/ov4_4.webp",
      "/images/properties/ov4/ov4_5.webp",
    ],
    title: "OV4 - 4BHK",
    location: "Calangute, India",
    price: 4907,
    badge: "Guest's fav",
    dateRange: "10 - 15 Nov",
  },
  {
    id: 9,
    type: "Villas",
    images: [
      "/images/properties/lotus/lotus1.webp",
      "/images/properties/lotus/lotus2.webp",
      "/images/properties/lotus/lotus3.webp",
      "/images/properties/lotus/lotus4.webp",
      "/images/properties/lotus/lotus5.webp",
    ],
    title: "Lotus Villa",
    location: "Mandrem, India",
    price: 5907,
    badge: "Guest's fav",
    dateRange: "10 - 15 Nov",
  },

  {
    id: 10,
    type: "Villas",
    images: [
      "/images/properties/q/q1.webp",
      "/images/properties/q/q2.webp",
      "/images/properties/q/q3.webp",
      "/images/properties/q/q4.webp",
      "/images/properties/q/q5.webp",
    ],
    title: "The Q Heritage Prvt Pool Villa",
    location: "Parra, India",
    price: 6299,
    badge: "Guest's fav",
    dateRange: "10 - 15 Nov",
  },
  {
    id: 11,
    type: "Farm House",
    images: [
      "/images/properties/island-house-goa/island-house-goa1.jpg",
      "/images/properties/island-house-goa/island-house-goa2.jpg",
      "/images/properties/island-house-goa/island-house-goa3.jpg",
      "/images/properties/island-house-goa/island-house-goa4.jpg",
      "/images/properties/island-house-goa/island-house-goa5.jpg",
    ],
    title: "Island House Goa",
    location: "Divar, India",
    price: 6299,
    badge: "Guest's fav",
    dateRange: "10 - 15 Nov",
  },

  {
    id: 12,
    type: "Villas",
    images: [
      "/images/properties/island-pool-villa/island-pool-villa1.webp",
      "/images/properties/island-pool-villa/island-pool-villa2.webp",
      "/images/properties/island-pool-villa/island-pool-villa3.webp",
      "/images/properties/island-pool-villa/island-pool-villa4.webp",
      "/images/properties/island-pool-villa/island-pool-villa5.webp",
      "/images/properties/island-pool-villa/island-pool-villa6.webp",
    ],
    title: "Island Pool Villa",
    location: "Tiswadi, India",
    price: 6299,
    badge: "Guest's fav",
    dateRange: "10 - 15 Nov",
  },
  {
    id: 13,
    type: "Beachfront",
    images: [
      "/images/properties/cabo-serai/cabo-serai1.jpg",
      "/images/properties/cabo-serai/cabo-serai2.jpg",
      "/images/properties/cabo-serai/cabo-serai3.jpg",
      "/images/properties/cabo-serai/cabo-serai4.jpg",
      "/images/properties/cabo-serai/cabo-serai5.jpg",
    ],
    title: "Cabo Serai",
    location: "Canacona, India",
    price: 6299,
    badge: "Guest's fav",
    dateRange: "10 - 15 Nov",
  },
  {
    id: 14,
    type: "Villas",
    images: [
      "/images/properties/3bhk-luxury-villa/3bhk-luxury-villa1.jpg",
      "/images/properties/3bhk-luxury-villa/3bhk-luxury-villa2.jpg",
      "/images/properties/3bhk-luxury-villa/3bhk-luxury-villa3.jpg",
      "/images/properties/3bhk-luxury-villa/3bhk-luxury-villa4.jpg",
      "/images/properties/3bhk-luxury-villa/3bhk-luxury-villa5.jpg",
    ],
    title: "3 BHK Luxury Villa",
    location: "Dabolim, India",
    price: 6299,
    badge: "Guest's fav",
    dateRange: "10 - 15 Nov",
  },
  {
    id: 15,
    type: "Villas",
    images: [
      "/images/properties/4bhk-heritage-villa/4bhk-heritage-villa1.webp",
      "/images/properties/4bhk-heritage-villa/4bhk-heritage-villa2.webp",
      "/images/properties/4bhk-heritage-villa/4bhk-heritage-villa3.webp",
      "/images/properties/4bhk-heritage-villa/4bhk-heritage-villa4.webp",
      "/images/properties/4bhk-heritage-villa/4bhk-heritage-villa5.webp",
    ],
    title: "4BHK Heritage Villa",
    location: "Candolim, India",
    price: 6299,
    badge: "Guest's fav",
    dateRange: "10 - 15 Nov",
  },
  {
    id: 16,
    type: "Villas",
    images: [
      "/images/properties/the-white-villa/the-white-villa1.webp",
      "/images/properties/the-white-villa/the-white-villa2.webp",
      "/images/properties/the-white-villa/the-white-villa3.webp",
      "/images/properties/the-white-villa/the-white-villa4.webp",
      "/images/properties/the-white-villa/the-white-villa5.webp",
    ],
    title: "The White Villa",
    location: "Colva, India",
    price: 6299,
    badge: "Guest's fav",
    dateRange: "10 - 15 Nov",
  },
];

// Transform the data to match our schema
const transformedProperties = properties.map((property) => ({
  type: mapPropertyType(property.type),
  category: getCategoryFromType(property.type),
  images: property?.images,
  title: property.title,
  location: property.location,
  city: property.location.split(",")[0].trim(),
  state: "Goa",
  country: "India",
  latitute: 15.2993,
  longitude: 74.124,
  price: {
    base: property.price,
    cleaning: Math.round(property.price * 0.05), // 5% of base price
    service: Math.round(property.price * 0.1), // 10% of base price
    tax: Math.round(property.price * 0.18), // 18% GST
  },
  capacity: {
    guests: getGuestsFromTitle(property.title),
    bedrooms: getBedroomsFromTitle(property.title),
    beds: getBedroomsFromTitle(property.title) + 1, // Assuming one extra bed
    bathrooms: getBedroomsFromTitle(property.title),
  },
  badge: property.badge,
  rating: {
    score: 4.5, // Default rating
    count: Math.floor(Math.random() * 50) + 10, // Random number of reviews between 10-60
  },
  amenities: getDefaultAmenities(property.type),
  description: {
    short: `Experience luxury living at ${property.title} in ${property.location}`,
    detailed: `Discover the perfect blend of comfort and elegance at ${
      property.title
    }, located in the beautiful ${
      property.location
    }. This ${property.type.toLowerCase()} offers a memorable stay with modern amenities and stunning views.`,
  },
  policies: {
    checkIn: "14:00",
    checkOut: "11:00",
    cancellation: "Flexible",
    houseRules: getDefaultHouseRules(),
  },
  host: {
    name: "Sam Doe",
    contact: {
      phone: "+91 9876543210",
      email: "sam.doe@example.com",
    },
    isSuperhost: true,
    profileImage: "/images/avatar-2.png",
    isVerified: true,
    reviews: generateRandomReviews("67675a4b74ad576ce38c2326", 5),
    stays: 500,
    rating: {
      average: 4.8,
      total: 120,
    },
    response: {
      rate: 99,
      time: "Within an hour",
    },
  },
  reviews: generateRandomReviews("67675a4b74ad576ce38c2326", 5),
  availability: {
    minStay: 2,
    maxStay: 30,
    instantBook: true,
    unavailableDates: [],
  },
}));

// Helper functions
function mapPropertyType(type) {
  const typeMapping = {
    Villas: "Luxury Villa",
    "Farm House": "Traditional Farm Stay",
    Pool: "Pool House",
    Apartments: "Luxury Apartment",
    Beachfront: "Beachfront Villa",
  };
  return typeMapping[type] || type;
}

function getCategoryFromType(type) {
  const categoryMapping = {
    Villas: "Luxury",
    "Farm House": "Heritage",
    Pool: "Luxury",
    Apartments: "Mid-Range",
    Beachfront: "Ultra Luxury",
  };
  return categoryMapping[type] || "Luxury";
}

function getGuestsFromTitle(title) {
  const bhkMatch = title.match(/(\d+)\s*BHK/i);
  return bhkMatch ? bhkMatch[1] * 2 : 6; // Assuming 2 guests per bedroom, default 6
}

function getBedroomsFromTitle(title) {
  const bhkMatch = title.match(/(\d+)\s*BHK/i);
  return bhkMatch ? parseInt(bhkMatch[1]) : 3; // Default 3 bedrooms
}

function getDefaultAmenities(type) {
  const baseAmenities = [
    "Wifi",
    "Air Conditioning",
    "Kitchen",
    "Parking",
    "Power Backup",
    "Security",
  ];

  const typeSpecificAmenities = {
    Villas: ["Private Pool", "Garden", "BBQ"],
    "Farm House": ["Garden", "BBQ", "Indoor Games"],
    Pool: ["Private Pool", "Garden"],
    Apartments: ["Gym", "Security"],
    Beachfront: ["Beach Access", "Sea View", "Private Pool"],
  };

  return [...baseAmenities, ...(typeSpecificAmenities[type] || [])];
}

function getDefaultHouseRules() {
  return [
    "No smoking inside the property",
    "No parties or events",
    "Pets allowed with prior approval",
    "Quiet hours from 10 PM to 8 AM",
    "Check-in time is 2 PM - 8 PM",
  ];
}
function generateRandomReviews(propertyId, count) {
  const reviews = [];
  const users = [
    "Alice Smith",
    "Bob Johnson",
    "Carol Williams",
    "David Brown",
    "Eva Davis",
  ];
  const contents = [
    "Wonderful stay! The host was very accommodating and the place was spotless.",
    "Great location and comfortable beds. Could use a bit more kitchen equipment.",
    "Absolutely loved our stay here. The host went above and beyond to make us feel welcome.",
    "Beautiful property with stunning views. We'll definitely be back!",
    "Clean, spacious, and well-equipped. Perfect for our family vacation.",
  ];

  for (let i = 0; i < count; i++) {
    reviews.push({
      property: propertyId,
      user: mongoose.Types.ObjectId(),
      rating: Math.floor(Math.random() * 5) + 1,
      createdAt: new Date(),
      date: new Date(),
      avatar: "/images/avatar-" + ((i % 5) + 1) + ".png",
      content: contents[Math.floor(Math.random() * contents.length)],
    });
  }

  return reviews;
}

// Database connection and seeding function
async function seedDatabase() {
  try {
    // Connect to MongoDB
    await mongoose.connect(
      process.env.DB_URI /* no credentials in source; set DB_URI */,
      {
        useNewUrlParser: true,
        useUnifiedTopology: true,
      }
    );
    if (process.env.NEXT_PUBLIC_ENV === "dev") {
      console.log("Connected to MongoDB");
    }

    // Clear existing properties
    await MajesticStay.deleteMany({});
    if (process.env.NEXT_PUBLIC_ENV === "dev") {
      console.log("Cleared existing properties");
    }

    // Insert new properties
    const result = await MajesticStay.insertMany(transformedProperties);

    if (process.env.NEXT_PUBLIC_ENV === "dev") {
      console.log(`Successfully seeded ${result.length} properties`);
    }

    // Disconnect from MongoDB
    await mongoose.disconnect();
    if (process.env.NEXT_PUBLIC_ENV === "dev") {
      console.log("Disconnected from MongoDB");
    }
  } catch (error) {
    console.error("Error seeding database:", error);
    process.exit(1);
  }
}

// Run the seeding function
seedDatabase();

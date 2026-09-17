const mongoose = require("mongoose");
const experienceSchema = new mongoose.Schema({
    title: { type: String, required: true },
    description: { type: String, required: true },
    hostId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    location: {
      type: { type: String, enum: ['Point'], default: 'Point' },
      coordinates: { type: [Number], index: '2dsphere' }
    },
    price: { type: Number, required: true },
    currency: { type: String, default: 'USD' },
    duration: { type: String, required: true }, // Example: '3 hours'
    groupSize: { type: Number, required: true }, // Max participants
    activities: [String], // List of activities included
    includes: [String], // Example: ['Lunch', 'Guide', 'Gear']
    language: { type: String, default: 'English' },
    images: { type: [String], required: true },
    ratings: {
      overall: { type: Number, min: 0, max: 5, default: 0 },
      experienceQuality: { type: Number, min: 0, max: 5, default: 0 },
      guideFriendliness: { type: Number, min: 0, max: 5, default: 0 },
      valueForMoney: { type: Number, min: 0, max: 5, default: 0 }
    },
    featured: { type: Boolean, default: false },
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now }
  });
  
  const Experience = mongoose.model('Experience', experienceSchema);
  
  module.exports = Experience;
  
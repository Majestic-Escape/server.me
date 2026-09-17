const mongoose = require("mongoose");
const chatSchema = new mongoose.Schema({
    participants: [
      { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
    ],
    messages: [
      {
        sender: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        message: { type: String },
        createdAt: { type: Date, default: Date.now }
      }
    ],
    bookingId: { type: mongoose.Schema.Types.ObjectId, ref: 'Booking' },
    automated: { type: Boolean, default: false }
  });
  
  const Chat = mongoose.model('Chat', chatSchema);
  
  module.exports = Chat;
  
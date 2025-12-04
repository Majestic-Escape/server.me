const mongoose = require("mongoose");

const HostBankAccountSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      // unique: true
    },
    accountNumber: {
      type: String,
      required: true,
      minlength: 9,
      maxlength: 18,
    },
    ifscCode: {
      type: String,
      required: true,
      match: /^[A-Z]{4}0[A-Z0-9]{6}$/,
    },
    accountHolderName: {
      type: String,
      required: true,
      minlength: 2,
    },
    bankName: {
      type: String,
      required: true,
      minlength: 2,
    },
  },
  { timestamps: true }
);

const HostBankAccount = mongoose.model(
  "HostBankAccount",
  HostBankAccountSchema
);

module.exports = HostBankAccount;

const HostBankAccount = require("../models/HostBankAccount");

// Get Bank Account Details
exports.getBankAccountDetails = async (req, res) => {
  try {
    const userId = req.user.id;
    const bankAccount = await HostBankAccount.findOne({ userId });

    if (!bankAccount) {
      return res.status(404).json({ message: "Bank account not found" });
    }

    res.status(200).json(bankAccount);
  } catch (error) {
    res.status(500).json({ message: "Server error", error: error.message });
  }
};

// Update Bank Account Details
exports.updateBankAccountDetails = async (req, res) => {
  try {
    const userId = req.user.id;
    const { accountNumber, ifscCode, accountHolderName, bankName } = req.body;

    if (!accountNumber || !ifscCode || !accountHolderName || !bankName) {
      return res.status(400).json({ message: "All fields are required" });
    }

    // let bankAccount = await HostBankAccount.findOne({ userId })
    let bankAccount = await HostBankAccount.findOne({ hostId: userId });
    if (bankAccount) {
      // bankAccount.accountNumber = accountNumber;
      // bankAccount.ifscCode = ifscCode;
      // bankAccount.accountHolderName = accountHolderName;
      // bankAccount.bankName = bankName;
      const bankAccount = await HostBankAccount.findOneAndUpdate(
        { hostId: userId },
        {
          accountNumber,
          ifscCode,
          accountHolderName,
          bankName,
        }
        // { new: true, upsert: true } // creates if not exists, returns updated doc
      );
    } else {
      bankAccount = new HostBankAccount({
        hostId: userId,
        accountNumber,
        ifscCode,
        accountHolderName,
        bankName,
      });
      await bankAccount.save();
    }

    res.status(200).json({
      message: "Bank account details updated successfully",
      bankAccount,
    });
  } catch (error) {
    res.status(500).json({ message: "Server error", error: error.message });
  }
};

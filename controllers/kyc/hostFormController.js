const axios = require("axios");
const KycLogs = require("../../models/KycLogs");
const kycHostForm = require("../../models/KycHostForm");
const User = require("../../models/User");
const mongoose = require("mongoose");
const { changeToUpperCase } = require("../../utils/convertToUpperCase");
const { sendEmail } = require("../../utils/sendEmail");
const ListingProperty = require("../../models/ListingProperty");
require("dotenv").config();

exports.createhostKycForm = async (req, res) => {
  try {
    if (process.env.NEXT_PUBLIC_ENV === "dev") {
      console.log("enterd create host");
    }
    const kyc = new kycHostForm(req.body);
    await kyc.save();
    res.status(200).json({ success: true, data: kyc });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
};

// exports.updatehostKycForm = async (req, res) => {
//   try {
//     const { id } = req.params;

//     const isCompleted = req.body.status === "completed";

//     if (process.env.NEXT_PUBLIC_ENV === "dev") {
//       console.log("time1");
//     }
//     const kycForm = await kycHostForm
//       .findOneAndUpdate(
//         { _id: id },
//         { $set: req.body },
//         { new: true, runValidators: true }
//       )
//       .populate("hostId");
//     if (process.env.NEXT_PUBLIC_ENV === "dev") {
//       console.log("time2");
//     }
//     if (!kycForm) {
//       return res
//         .status(404)
//         .json({ message: "Property not found or unauthorized to update" });
//     }
//     const adminEmail = process.env.ADMIN_EMAIL.split(",");

//     if (isCompleted) {
//       const data = await User.findByIdAndUpdate(
//         { _id: property.hostId._id },
//         {
//           kyc: true,
//         },
//         { new: true }
//       );
//       console.log("time5", req.body.status);
//       if (process.env.NEXT_PUBLIC_ENV === "dev") {
//         console.log("time3", id, property.hostId._id);
//       }

//       if (!data) {
//         return res.status(404).json({
//           success: false,
//           message: "Host not found or unauthorized to update kyc",
//         });
//       }
//       const updateListing = await ListingProperty.updateMany(
//         { host: property.hostId._id },
//         {
//           kycStatus: "completed",
//         },
//         { new: true }
//       );
//       if (!updateListing) {
//         return res.status(404).json({
//           sucess: false,
//           message: "Property not found or unauthorized to update kyc",
//         });
//       }

//       const params = {
//         hostName: changeToUpperCase(
//           data.firstName + " " + data.hostId.lastName
//         ),
//         hostEmail: data.email,
//         hostContact: data.email,
//         kycDate: new Date().toLocaleDateString(),
//       };

//       if (data.hostOffer && data.hostOffer == true) {
//         await sendEmail(property.hostId.email, 47, params);
//       }
//       // await Promise.all(
//       //   adminEmail.map((email) => sendEmail(email.trim(), 4, params))
//       // );

//       await sendEmail(property.hostId.email, 45, params);
//       // res.status(200).json(property);
//     }
//     res.status(200).json(property);
//   } catch (error) {
//     res.status(400).json({ message: error.message });
//   }
// };
exports.updatehostKycForm = async (req, res) => {
  try {
    const { id } = req.params;
    const isCompleted = req.body.status === "completed";

    const kycForm = await kycHostForm
      .findOneAndUpdate(
        { _id: id },
        { $set: req.body },
        { new: true, runValidators: true }
      )
      .populate("hostId");

    if (!kycForm) {
      return res.status(404).json({ message: "KYC form not found" });
    }

    if (isCompleted) {
      const host = await User.findByIdAndUpdate(
        kycForm.hostId._id,
        { kyc: true },
        { new: true }
      );

      await ListingProperty.updateMany(
        { host: host._id },
        { $set: { kycStatus: "completed" } }
      );

      const adminEmail = process.env.ADMIN_EMAIL.split(",");

      const params = {
        hostName: changeToUpperCase(`${host.firstName} ${host.lastName}`),
        hostEmail: host.email,
        hostContact: host.phone || host.email,
        kycDate: new Date().toLocaleDateString(),
      };

      if (host.hostOffer === true) {
        await sendEmail(host.email, 47, params);
      } else {
        await sendEmail(host.email, 45, params);
      }

      await Promise.all(
        adminEmail.map((email) => sendEmail(email.trim(), 4, params))
      );
    }

    return res.status(200).json(kycForm);
  } catch (error) {
    return res.status(400).json({ message: error.message });
  }
};

exports.updatehostKycFormStatus = async (req, res) => {
  try {
    const { userId, isVerified, documentType } = req.body;
    if (process.env.NEXT_PUBLIC_ENV === "dev") {
      console.log("robin");
    }
    const response = await kycHostForm.findOneAndUpdate(
      { hostId: new mongoose.Types.ObjectId(userId) },
      {
        $set: {
          "documentInfo.isVerified": isVerified,
          "documentInfo.documentType": documentType,
        },
      }
    );
    if (process.env.NEXT_PUBLIC_ENV === "dev") {
      console.log("nightwin", response);
    }
    res.status(200).json(response);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
};
exports.updatehostKycFormGstStatus = async (req, res) => {
  try {
    const { userId, panNumber, gstNumber, isVerified } = req.body;

    const response = await kycHostForm.findOneAndUpdate(
      { hostId: new mongoose.Types.ObjectId(userId) },
      {
        $set: {
          "gstInfo.panNumber": panNumber,
          "gstInfo.gstNumber": gstNumber,
          "gstInfo.isVerified": isVerified,
        },
      }
    );
    if (process.env.NEXT_PUBLIC_ENV === "dev") {
      console.log("nightwin", response);
    }
    res.status(200).json(response);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
};
exports.fetchhostKycForm = async (req, res) => {
  try {
    const { id } = req.params;
    const data = await kycHostForm.findOne({
      hostId: new mongoose.Types.ObjectId(id),
    });

    if (!data) {
      return res
        .status(404)
        .json({ message: "Property not found or unauthorized to update" });
    }

    res.status(200).json({ success: true, data: data });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
};

exports.fetchhostKycFormById = async (req, res) => {
  try {
    const { id } = req.params;
    const data = await kycHostForm.findById(id);

    if (!data) {
      return res
        .status(404)
        .json({ message: "Property not found or unauthorized to update" });
    }

    res.status(200).json({ success: true, data: data });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
};

exports.fetchhostKycFormByUserId = async (req, res) => {
  try {
    const { id } = req.params;
    const data = await kycHostForm.findOne({
      hostId: new mongoose.Types.ObjectId(id),
    });

    if (!data) {
      return res
        .status(404)
        .json({ message: "Property not found or unauthorized to update" });
    }

    res.status(200).json({ success: true, data: data });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
};

// services/externalAPIService.js
const axios = require("axios");
const FormData = require("form-data");
require("dotenv").config();
// const OCR_API = "https://api.digitap.ai/ocr/v1";
// const STATUS_API = "https://svc.digitap.ai/validation/kyc/v1";
// const AUTH_HEADER =
//   "Basic MTUyMjI5MjI6UU94Z3pSZEFtS3lnZUNDUnJPUUtJem1HcVd0OTBlc2Y=";

const OCR_API = process.env.OCR_API;
const STATUS_API = process.env.STATUS_API;
const AUTH_HEADER = process.env.AUTH_HEADER;
const CLIENT_ID = process.env.DIGITAP_CLIENT_ID;
const CLIENT_SECRET = process.env.DIGITAP_CLIENT_SECRET;
const getAuthHeader = () => {
  const credentials = `${CLIENT_ID}:${CLIENT_SECRET}`;

  if (process.env.NEXT_PUBLIC_ENV === "dev") {
    console.log("Header", Buffer.from(credentials).toString("base64"));
  }

  return `Basic ${Buffer.from(credentials).toString("base64")}`;
};
// exports.performOCR = async (imageBase64, clientRefId) => {
//   const form = new FormData();
//   form.append("imageUrl", imageBase64);
//   form.append("clientRefId", clientRefId);
//   //Basic MzEzNzA5Nzg6T2xTWXg2REV0ekNtSDBNeXFRM2NGS0ZaZ05wbXV0QWM=
//   try {
//     const a = getAuthHeader();
//     process.env.ENV === 'dev' && if (process.env.NEXT_PUBLIC_ENV === "dev") {
//   console.log("Header data", a);
// }
//     const response = await axios.post(`${OCR_API}/pan`, form, {
//       headers: {
//         ...form.getHeaders(),
//         Authorization: getAuthHeader(),
//       },
//     });
//     process.env.ENV === 'dev' && if (process.env.NEXT_PUBLIC_ENV === "dev") {
//   console.log("pan resp", response);
// }
//     return response.data;
//   } catch (error) {
//     process.env.ENV === 'dev' && if (process.env.NEXT_PUBLIC_ENV === "dev") {
//   console.log("API FAILED");
// }

//     const errorMessage = error.response?.data
//       ? JSON.stringify(error.response.data.error, null, 2)
//       : error.message;

//     process.env.ENV === 'dev' && if (process.env.NEXT_PUBLIC_ENV === "dev") {
//   console.log(error);
// }
//     throw new Error(` ${errorMessage}`);
//   }
// };

const {
  rawBase64FromPossibleDataUri,
  isValidBase64,
  detectMimeFromBuffer,
} = require("../utils/ocrHelpers");

// Every Digitap call has a deadline (shorter than the KYC in-flight lease in
// services/kycGuard.js) and every failure propagates with its axios
// `response` intact, so panKycController can tell the host what actually
// happened. These used to swallow errors: any provider rejection (unreadable
// image, auth, credits, outage) reached the host as "the document number
// could not be read" and KycLogs recorded it as a success.
const { providerTimeoutMs } = require("./kycProvider");
const OCR_PATHS = { pan: "pan", voterId: "voter", passport: "passport" };
const STATUS_PATHS = { pan: "pan_basic", voterId: "voter", passport: "passport" };

exports.performOCR = async (imageInput, clientRefId, doc) => {
  const rawBase64 = rawBase64FromPossibleDataUri(imageInput);
  if (!rawBase64 || !isValidBase64(rawBase64)) {
    throw new Error("Invalid base64 or unsupported input");
  }
  const buffer = Buffer.from(rawBase64.replace(/\s+/g, ""), "base64");
  if (!buffer.length) throw new Error("Decoded buffer empty");

  // Digitap takes an image under "imageUrl" and a PDF under "pdf".
  const mime = detectMimeFromBuffer(buffer);
  const form = new FormData();
  if (mime === "application/pdf") {
    form.append("pdf", buffer, { filename: "doc.pdf", contentType: mime });
  } else {
    const ext = mime === "image/png" ? "png" : mime === "image/jpeg" ? "jpg" : "bin";
    form.append("imageUrl", buffer, { filename: `image.${ext}`, contentType: mime });
  }
  form.append("clientRefId", clientRefId);

  const response = await axios.post(
    `${process.env.OCR_API}/${OCR_PATHS[doc] || OCR_PATHS.passport}`,
    form,
    {
      headers: { ...form.getHeaders(), Authorization: getAuthHeader() },
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
      timeout: providerTimeoutMs(),
    }
  );
  return response.data;
};
exports.performStatusCheck = async (requestData, doc) => {
  const response = await axios.post(
    `${STATUS_API}/${STATUS_PATHS[doc] || STATUS_PATHS.passport}`,
    requestData,
    {
      headers: {
        "Content-Type": "application/json",
        Authorization: getAuthHeader(),
      },
      timeout: providerTimeoutMs(),
    }
  );
  return response.data;
};

// exports.performVoterOCR = async (imageBase64, clientRefId) => {
//   const form = new FormData();
//   form.append("imageUrl", imageBase64);
//   form.append("clientRefId", clientRefId);

//   try {
//     const response = await axios.post(`${OCR_API}/voter`, form, {
//       headers: {
//         ...form.getHeaders(),
//         Authorization: AUTH_HEADER,
//       },
//     });
//     return response.data;
//   } catch (error) {
//     const errorMessage = error.response?.data
//       ? JSON.stringify(error.response.data.error, null, 2)
//       : error.message;

//     throw new Error(` ${errorMessage}`);
//   }
// };
// exports.performVoterStatusCheck = async (requestData) => {
//   try {
//     const response = await axios.post(`${STATUS_API}/voter`, requestData, {
//       headers: {
//         "Content-Type": "application/json",
//         Authorization: AUTH_HEADER,
//       },
//     });
//     return response.data;
//   } catch (error) {
//     throw new Error(
//       `Status API Error: ${error.response?.data || error.message}`
//     );
//   }
// };
// exports.performPassportOCR = async (imageBase64, clientRefId) => {
//   const form = new FormData();
//   form.append("imageUrl", imageBase64);
//   form.append("clientRefId", clientRefId);

//   try {
//     const response = await axios.post(`${OCR_API}/passport`, form, {
//       headers: {
//         ...form.getHeaders(),
//         Authorization: AUTH_HEADER,
//       },
//     });
//     return response.data;
//   } catch (error) {
//     const errorMessage = error.response?.data
//       ? JSON.stringify(error.response.data.error, null, 2)
//       : error.message;

//     throw new Error(` ${errorMessage}`);
//   }
// };
// exports.performPassportStatusCheck = async (requestData) => {
//   try {
//     const response = await axios.post(`${STATUS_API}/passport`, requestData, {
//       headers: {
//         "Content-Type": "application/json",
//         Authorization: AUTH_HEADER,
//       },
//     });
//     return response.data;
//   } catch (error) {
//     throw new Error(
//       `Status API Error: ${error.response?.data || error.message}`
//     );
//   }
// };

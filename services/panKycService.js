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
const fs = require("fs");
exports.performOCR = async (imageInput, clientRefId, doc) => {
  try {
    let buffer;
    if (typeof imageInput === "string" && fs.existsSync(imageInput)) {
      buffer = fs.readFileSync(imageInput);
    } else {
      // assume base64 / dataURI
      const rawBase64 = rawBase64FromPossibleDataUri(imageInput);
      if (!rawBase64 || !isValidBase64(rawBase64)) {
        throw new Error("Invalid base64 or unsupported input");
      }
      buffer = Buffer.from(rawBase64.replace(/\s+/g, ""), "base64");
    }

    if (!buffer || buffer.length === 0) {
      throw new Error("Decoded buffer empty");
    }

    // detect mime to give filename & contentType
    const mime = detectMimeFromBuffer(buffer);
    const ext =
      mime === "image/png"
        ? "png"
        : mime === "image/jpeg"
        ? "jpg"
        : mime === "application/pdf"
        ? "pdf"
        : "bin";

    const form = new FormData();
    // The doc says the key for image content is "imageUrl" OR "pdf" for pdfs.
    // For images, append under "imageUrl"
    if (mime === "application/pdf") {
      form.append("pdf", buffer, { filename: `doc.${ext}`, contentType: mime });
    } else {
      form.append("imageUrl", buffer, {
        filename: `image.${ext}`,
        contentType: mime,
      });
    }
    form.append("clientRefId", clientRefId);

    const headers = { ...form.getHeaders(), Authorization: getAuthHeader() };
    if (doc == "pan") {
      const response = await axios.post(`${process.env.OCR_API}/pan`, form, {
        headers,
        maxBodyLength: Infinity,
        maxContentLength: Infinity,
        // timeout: 30000 // optional
      });

      if (process.env.NEXT_PUBLIC_ENV === "dev") {
        console.log("passport ocr", response?.data?.result[0]?.details);
      }

      return response.data;
    } else if (doc == "voterId") {
      const response = await axios.post(`${process.env.OCR_API}/voter`, form, {
        headers,
        maxBodyLength: Infinity,
        maxContentLength: Infinity,
        // timeout: 30000 // optional
      });

      if (process.env.NEXT_PUBLIC_ENV === "dev") {
        console.log("voter ocr", response?.data?.result[0]?.details);
      }

      return response.data;
    } else {
      const response = await axios.post(
        `${process.env.OCR_API}/passport`,
        form,
        {
          headers,
          maxBodyLength: Infinity,
          maxContentLength: Infinity,
          // timeout: 30000 // optional
        }
      );

      if (process.env.NEXT_PUBLIC_ENV === "dev") {
        console.log("pans ocr", response?.data?.result[0]?.details);
      }

      return response.data;
    }
  } catch (error) {
    const errorMessage = error.response?.data
      ? JSON.stringify(error.response.data.error, null, 2)
      : error.message;

    if (process.env.NEXT_PUBLIC_ENV === "dev") {
      console.log(errorMessage);
    }
  }
};
exports.performStatusCheck = async (requestData, doc) => {
  if (process.env.NEXT_PUBLIC_ENV === "dev") {
    console.log("entered the status check", doc);
  }
  try {
    if (doc == "pan") {
      if (process.env.NEXT_PUBLIC_ENV === "dev") {
        console.log("entered the status check2");
      }
      try {
        const response = await axios.post(
          `${STATUS_API}/pan_basic`,
          requestData,
          {
            headers: {
              "Content-Type": "application/json",
              Authorization: getAuthHeader(),
            },
          }
        );
        if (process.env.NEXT_PUBLIC_ENV === "dev") {
          console.log("Pan response", response);
        }

        return response.data;
      } catch (error) {
        if (process.env.NEXT_PUBLIC_ENV === "dev") {
          console.log("Pan error check", error);
        }
      }
    } else if (doc == "voterId") {
      if (process.env.NEXT_PUBLIC_ENV === "dev") {
        console.log("entered the status check voter", requestData);
      }
      const response = await axios.post(`${STATUS_API}/voter`, requestData, {
        headers: {
          "Content-Type": "application/json",
          Authorization: getAuthHeader(),
        },
      });
      return response.data;
    } else {
      const response = await axios.post(`${STATUS_API}/passport`, requestData, {
        headers: {
          "Content-Type": "application/json",
          Authorization: getAuthHeader(),
        },
      });
      return response.data;
    }
  } catch (error) {
    if (process.env.NEXT_PUBLIC_ENV === "dev") {
      console.log("status check valida", error);
    }
    // const errorMessage = error.response?.data
    //   ? JSON.stringify(error.response.data.error, null, 2)
    //   : error.message;
    const message =
      error.response?.data?.error ||
      error.response?.data?.message ||
      error.message ||
      "Status check failed";

    throw new Error(message);
    // process.env.ENV === 'dev' && if (process.env.NEXT_PUBLIC_ENV === "dev") {
    //   console.log(errorMessage);
    // }
  }
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

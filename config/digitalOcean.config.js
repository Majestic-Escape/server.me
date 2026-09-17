require("dotenv").config();

// Batch P: the aws-sdk v2 client is built on first use, not at boot — the
// SDK is the single heaviest module in the function's cold start and only
// the upload/delete paths need it. Callers keep the same object shape.
let client = null;
function getS3() {
  if (!client) {
    const AWS = require("aws-sdk");
    const spacesEndpoint = new AWS.Endpoint(`${process.env.REGION}.digitaloceanspaces.com`);
    client = new AWS.S3({
      endpoint: spacesEndpoint,
      accessKeyId: process.env.DO_SPACES_KEY,
      secretAccessKey: process.env.DO_SPACES_SECRET,
      region: process.env.REGION,
      signatureVersion: "v4",
    });
  }
  return client;
}

// Lazy proxy: `s3.getSignedUrl(...)`, `s3.upload(...)` etc. keep working
// unchanged; the real client appears on the first property access.
module.exports = new Proxy(
  {},
  {
    get(_t, prop) {
      if (prop === "getS3") return getS3;
      if (typeof prop === "symbol" || prop === "then") return undefined;
      const s3 = getS3();
      const v = s3[prop];
      return typeof v === "function" ? v.bind(s3) : v;
    },
  },
);

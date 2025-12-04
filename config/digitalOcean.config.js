require('dotenv').config();
const AWS = require('aws-sdk');

const spacesEndpoint = new AWS.Endpoint(`${process.env.REGION}.digitaloceanspaces.com`);

const s3 = new AWS.S3({
  endpoint: spacesEndpoint,
  accessKeyId: process.env.DO_SPACES_KEY,
  secretAccessKey: process.env.DO_SPACES_SECRET,
  region:process.env.REGION,
  signatureVersion: "v4",
 
});

module.exports = s3;
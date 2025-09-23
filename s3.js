require("dotenv").config();
const { S3Client, PutObjectCommand, GetObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");

const s3 = new S3Client({ region: process.env.AWS_REGION });

async function uploadBufferToS3({ bucket, key, contentType, body }) {
  const cmd = new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType });
  await s3.send(cmd);
  return `s3://${bucket}/${key}`;
}

async function getPresignedGetUrl(bucket, key, expiresInSeconds = 900) {
  const cmd = new GetObjectCommand({ Bucket: bucket, Key: key });
  return getSignedUrl(s3, cmd, { expiresIn: expiresInSeconds });
}

module.exports = { uploadBufferToS3, getPresignedGetUrl };

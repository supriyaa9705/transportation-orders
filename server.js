require("dotenv").config();
const path = require("path");
const express = require("express");
const morgan = require("morgan");
const cors = require("cors");
const multer = require("multer");

const db = require("./db");
const { uploadBufferToS3, getPresignedGetUrl } = require("./s3");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(morgan("dev"));
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));

const upload = multer({ storage: multer.memoryStorage() });

// Health
app.get("/api/health", (_req, res) => {
  res.json({ status: "healthy", time: new Date().toISOString() });
});

// Orders: list
app.get("/api/orders", async (_req, res) => {
  try {
    const { rows } = await db.query(
      "SELECT order_id, customer_name, origin, destination, status, created_at, updated_at FROM orders ORDER BY created_at DESC LIMIT 100"
    );
    res.json(rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "DB_ERROR_LIST" });
  }
});

// Orders: create
app.post("/api/orders", async (req, res) => {
  const { customer_name, origin, destination, status = "Pending" } = req.body || {};
  try {
    const { rows } = await db.query(
      `INSERT INTO orders (customer_name, origin, destination, status)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [customer_name, origin, destination, status]
    );
    res.status(201).json(rows[0]);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "DB_ERROR_CREATE" });
  }
});

// Upload shipping doc → S3 input bucket
app.post("/api/orders/:id/upload", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "NO_FILE" });
    const key = `orders/${req.params.id}/docs/${Date.now()}-${req.file.originalname}`;
    const s3Uri = await uploadBufferToS3({
      bucket: process.env.S3_INPUT_BUCKET,
      key,
      contentType: req.file.mimetype,
      body: req.file.buffer
    });
    res.json({ uploaded: true, s3Uri, key });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "S3_UPLOAD_ERROR" });
  }
});

// Generate CSV report → S3 output bucket (returns presigned URL)
app.get("/api/orders/:id/report", async (req, res) => {
  try {
    const { rows } = await db.query("SELECT * FROM orders WHERE order_id = $1", [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: "NOT_FOUND" });

    const o = rows[0];
    const csv =
      "order_id,customer_name,origin,destination,status,created_at,updated_at\n" +
      `${o.order_id},"${o.customer_name}","${o.origin}","${o.destination}",${o.status},${o.created_at.toISOString()},${o.updated_at?.toISOString?.() || ""}\n`;

    const key = `orders/${req.params.id}/reports/${Date.now()}-summary.csv`;
    await uploadBufferToS3({
      bucket: process.env.S3_OUTPUT_BUCKET,
      key,
      contentType: "text/csv",
      body: Buffer.from(csv, "utf8")
    });

    const url = await getPresignedGetUrl(process.env.S3_OUTPUT_BUCKET, key, 900);
    res.json({ reportReady: true, downloadUrl: url, key });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "REPORT_ERROR" });
  }
});

app.listen(PORT, () => {
  console.log(`🚛 Transport Orders app running on port ${PORT}`);
});

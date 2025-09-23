// server.js — Incident Ticket Tracker (2-tier) — full version

// ===== Imports =====
const express = require('express');
const { Client } = require('pg');
const AWS = require('aws-sdk');
const multer = require('multer');
const multerS3 = require('multer-s3');
const moment = require('moment');
const path = require('path');

// ===== App setup =====
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

const PORT = process.env.PORT || 3000;

// ===== AWS SDK (uses EC2 instance profile with broad perms) =====
AWS.config.update({ region: 'ap-southeast-2' }); // <— change if your region differs
const s3 = new AWS.S3();

// ===== S3 buckets =====
const INPUT_BUCKET = 'orders-input-bucket-newcastle';   // <— change if needed
const OUTPUT_BUCKET = 'orders-output-bucket-newcastle'; // <— change if needed

// ===== Database config (Postgres on RDS) =====
// Replace host if your endpoint is different (keep quotes)
const dbConfig = {
  host: 'orders-prod-database.c36qu2wi67vk.ap-southeast-2.rds.amazonaws.com',
  port: 5432,
  database: 'postgres',
  user: 'ordersadmin',
  password: 'OrdersProd123!',
  ssl: {
    rejectUnauthorized: false // RDS TLS
  }
};

// ===== Multer for S3 uploads (attachments) =====
const upload = multer({
  storage: multerS3({
    s3: s3,
    bucket: INPUT_BUCKET,
    key: function (req, file, cb) {
      const ts = moment().format('YYYY-MM-DD-HH-mm-ss');
      const safe = file.originalname.replace(/\s+/g, '_');
      cb(null, `incidents/attachments/${ts}-${safe}`);
    }
  })
});

// ===== Helpers =====
async function withPg(fn) {
  const client = new Client(dbConfig);
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

// ===== Routes =====

// Home / dashboard (basic stats)
app.get('/', async (req, res) => {
  try {
    const client = new Client(dbConfig);
    await client.connect();

    const statsQuery = `
      SELECT 
        COUNT(*) AS total,
        COUNT(*) FILTER (WHERE status = 'New') AS new_count,
        COUNT(*) FILTER (WHERE status = 'In Progress') AS in_progress,
        COUNT(*) FILTER (WHERE severity = 'Critical') AS critical,
        COUNT(*) FILTER (WHERE severity IN ('High','Critical')) AS high_priority
      FROM incident_tickets
    `;
    const stats = (await client.query(statsQuery)).rows[0];
    await client.end();

    res.send(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>IT Incident Ticket Tracker</title>
  <link rel="stylesheet" href="/styles.css">
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>⚡ IT Incident Ticket Tracker</h1>
      <span class="badge">Production Baseline · BROAD permissions</span>
    </div>

    <div class="card">
      <h2>Dashboard</h2>
      <div class="kpis">
        <div class="kpi"><div class="n">${stats.total}</div><div class="l">Total Incidents</div></div>
        <div class="kpi"><div class="n">${stats.new_count}</div><div class="l">New</div></div>
        <div class="kpi"><div class="n">${stats.in_progress}</div><div class="l">In Progress</div></div>
        <div class="kpi crit"><div class="n">${stats.critical}</div><div class="l">Critical</div></div>
        <div class="kpi warn"><div class="n">${stats.high_priority}</div><div class="l">High+ Priority</div></div>
      </div>
    </div>

    <div class="grid">
      <div class="card">
        <h2>Actions</h2>
        <div class="list">
          <a href="/incidents">📋 View All Incidents</a><br/>
          <a href="/incidents/critical">🚨 Critical Incidents</a><br/>
          <a href="/health">❤️ Health Check</a><br/>
          <a href="/reports">📊 Generate Report (S3)</a>
        </div>
      </div>

      <div class="card">
        <h2>About</h2>
        <p>
          Purpose: <strong>Least Privilege Research</strong><br/>
          IAM Role: <code>OrdersProdEC2Role</code> (intentionally broad)<br/>
          Region: ap-southeast-2
        </p>
        <p class="footer">
          Running with intentionally BROAD permissions for baseline research.
        </p>
      </div>
    </div>
  </div>
</body>
</html>`);
  } catch (err) {
    res.status(500).send(`Error loading dashboard: ${err.message}`);
  }
});

// Health check: DB + quick S3 list
app.get('/health', async (req, res) => {
  try {
    const dbInfo = await withPg(async (client) => {
      const r = await client.query(
        'SELECT NOW() as current_time, COUNT(*)::int as incident_count FROM incident_tickets'
      );
      return r.rows[0];
    });

    // Light S3 check (list few objects)
    const s3List = await s3
      .listObjects({ Bucket: INPUT_BUCKET, Prefix: 'incidents/', MaxKeys: 3 })
      .promise();

    res.json({
      status: 'HEALTHY',
      db_connection: 'OK',
      timestamp: dbInfo.current_time,
      incident_count: dbInfo.incident_count,
      s3_connectivity: 'OK',
      s3_objects_listed: s3List?.Contents?.length ?? 0
    });
  } catch (err) {
    res.status(500).json({ status: 'ERROR', error: err.message });
  }
});

// Get all incidents (JSON)
app.get('/incidents', async (req, res) => {
  try {
    const rows = await withPg(async (client) => {
      const q = `
        SELECT incident_id, title, description, severity, status, incident_type,
               reporter, assigned_to, priority, created_date, updated_date, resolved_date, s3_attachments_path
        FROM incident_tickets
        ORDER BY 
          CASE severity 
            WHEN 'Critical' THEN 1 WHEN 'High' THEN 2 WHEN 'Medium' THEN 3 WHEN 'Low' THEN 4
          END, created_date DESC
      `;
      const r = await client.query(q);
      return r.rows;
    });
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Single-incident API for the detail panel
app.get('/incidents/:incident_id', async (req, res) => {
  const id = req.params.incident_id;
  try {
    const client = new Client(dbConfig);
    await client.connect();
    const result = await client.query(
      `SELECT * FROM incident_tickets WHERE incident_id = $1 LIMIT 1`,
      [id]
    );
    await client.end();

    if (!result.rows.length) {
      return res.status(404).json({ error: 'Incident not found' });
    }
    res.json(result.rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Only critical incidents
app.get('/incidents/critical', async (req, res) => {
  try {
    const rows = await withPg(async (client) => {
      const r = await client.query(
        "SELECT * FROM incident_tickets WHERE severity = 'Critical' ORDER BY created_date DESC"
      );
      return r.rows;
    });

    if (!rows.length) {
      res
        .status(404)
        .send('<pre>Cannot GET /incidents/critical — no critical incidents</pre>');
      return;
    }

    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Create new incident (supports single file attach to S3 input bucket)
app.post('/incidents', upload.single('attachment'), async (req, res) => {
  try {
    const {
      title,
      description,
      severity,
      incident_type,
      reporter,
      assigned_to,
      priority
    } = req.body;

    // Generate simple ID per day: INC-YYYYMMDD-###
    const ymd = moment().format('YYYYMMDD');
    const newId = await withPg(async (client) => {
      const c = await client.query(
        "SELECT COUNT(*)::int AS c FROM incident_tickets WHERE incident_id LIKE $1",
        [`INC-${ymd}-%`]
      );
      const next = String(c.rows[0].c + 1).padStart(3, '0');
      return `INC-${ymd}-${next}`;
    });

    const s3Path = req.file ? `s3://${req.file.bucket}/${req.file.key}` : null;

    const row = await withPg(async (client) => {
      const q = `
        INSERT INTO incident_tickets
          (incident_id, title, description, severity, incident_type, reporter, assigned_to, priority, s3_attachments_path)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
        RETURNING *
      `;
      const r = await client.query(q, [
        newId,
        title,
        description,
        severity,
        incident_type,
        reporter,
        assigned_to || null,
        parseInt(priority || '3', 10),
        s3Path
      ]);
      return r.rows[0];
    });

    res.json({
      success: true,
      incident: row,
      s3_attachment: s3Path
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Generate and save a JSON report to S3 output bucket
app.get('/reports', async (req, res) => {
  try {
    const data = await withPg(async (client) => {
      const q = `
        SELECT 
          incident_type,
          severity,
          COUNT(*)::int AS count,
          AVG(EXTRACT(EPOCH FROM (COALESCE(resolved_date, CURRENT_TIMESTAMP) - created_date))/3600) AS avg_hours
        FROM incident_tickets
        GROUP BY incident_type, severity
        ORDER BY incident_type,
          CASE severity WHEN 'Critical' THEN 1
                        WHEN 'High'     THEN 2
                        WHEN 'Medium'   THEN 3
                        WHEN 'Low'      THEN 4 END
      `;
      const r = await client.query(q);
      return r.rows;
    });

    const now = new Date();
    const report = {
      report_id: `RPT-${now.toISOString().replace(/[:.]/g, '-')}`,
      generated_date: now.toISOString(),
      incident_summary: data,
      permissions_note: 'Generated using broad S3/RDS permissions (baseline).'
    };

    const key = `reports/incident-summary-${now
      .toISOString()
      .replace(/[:.]/g, '-')}.json`;

    await s3
      .putObject({
        Bucket: OUTPUT_BUCKET,
        Key: key,
        Body: JSON.stringify(report, null, 2),
        ContentType: 'application/json'
      })
      .promise();

    res.json({
      status: 'OK',
      message: 'Report generated and saved to S3',
      rows_summarized: data.length,
      s3_location: `s3://${OUTPUT_BUCKET}/${key}`
    });
  } catch (err) {
    console.error('REPORT ERROR:', err);
    res.status(500).json({ status: 'ERROR', message: err.message });
  }
});

// ===== Start server =====
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🎫 Incident Tracker running on port ${PORT}`);
  console.log('🔓 BROAD permissions baseline (S3FullAccess, RDSFullAccess, etc.)');
  console.log('📍 Try: /health  /incidents  /incidents/critical  /reports');
});

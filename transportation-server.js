const express = require('express');
const { Client } = require('pg');
const AWS = require('aws-sdk');
const multer = require('multer');
const multerS3 = require('multer-s3');
const moment = require('moment');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// ---------- AWS ----------
AWS.config.update({ region: 'ap-southeast-2' });
const s3 = new AWS.S3();

// ---------- DB CONFIG (Update host to your real RDS endpoint) ----------
const dbConfig = {
  host: 'sandbox-orders-prod-database.c36qu2wi67vk.ap-southeast-2.rds.amazonaws.com',
  port: 5432,
  database: 'postgres',
  user: 'ordersadmin',
  password: 'OrdersProd123!',
  ssl: { require: true, rejectUnauthorized: false }   // <-- add this
};

// ---------- Uploads to S3 (shipping docs) ----------
const upload = multer({
  storage: multerS3({
    s3,
    bucket: 'orders-input-bucket-newcastle', // adjust if your bucket name differs
    key: (req, file, cb) => {
      const orderNo = req.body.order_no || req.params.orderNo || 'unknown';
      const ts = moment().format('YYYY-MM-DD-HH-mm-ss');
      cb(null, `shipments/${orderNo}/${ts}-${file.originalname}`);
    }
  })
});

// ---------- Helpers ----------
async function withDb(fn) {
  const client = new Client(dbConfig);
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

// ---------- ROUTES ----------

// Home: quick stats
app.get('/', async (_req, res) => {
  try {
    const stats = await withDb(async (client) => {
      const q = `
        SELECT 
          COUNT(*) as total_orders,
          COUNT(*) FILTER (WHERE status='New')         as new_orders,
          COUNT(*) FILTER (WHERE status='Planned')     as planned_orders,
          COUNT(*) FILTER (WHERE status='Dispatched')  as dispatched_orders,
          COUNT(*) FILTER (WHERE status='In Transit')  as in_transit,
          COUNT(*) FILTER (WHERE status='Delivered')   as delivered,
          COUNT(*) FILTER (WHERE status='Cancelled')   as cancelled,
          COUNT(*) FILTER (WHERE priority <= 2)        as high_priority
        FROM orders
      `;
      const r = await client.query(q);
      return r.rows[0];
    });

    res.send(`
      <h1>🚛 Transportation Orders Management</h1>
      <p><strong>Status:</strong> Production Baseline (BROAD Permissions)</p>
      <p><strong>Purpose:</strong> Least Privilege Research Project</p>

      <h2>📊 Dashboard</h2>
      <ul>
        <li><strong>Total Orders:</strong> ${stats.total_orders || 0}</li>
        <li><strong>New:</strong> ${stats.new_orders || 0}</li>
        <li><strong>Planned:</strong> ${stats.planned_orders || 0}</li>
        <li><strong>Dispatched:</strong> ${stats.dispatched_orders || 0}</li>
        <li><strong>In Transit:</strong> ${stats.in_transit || 0}</li>
        <li><strong>Delivered:</strong> ${stats.delivered || 0}</li>
        <li><strong>High Priority:</strong> ${stats.high_priority || 0}</li>
      </ul>

      <h2>🔧 Actions</h2>
      <ul>
        <li><a href="/orders">📋 View All Orders (JSON)</a></li>
        <li><a href="/orders/reports/summary">📊 Generate Summary Report</a></li>
        <li><a href="/health">❤️ Health Check</a></li>
      </ul>

      <hr>
      <p><em>Static frontend is served from <code>/public</code>. Open <strong>http://SERVER:3000/</strong> in your browser to use the UI.</em></p>
    `);
  } catch (err) {
    res.status(500).send(`Error loading dashboard: ${err.message}`);
  }
});

// Health
app.get('/health', async (_req, res) => {
  try {
    const dbInfo = await withDb(async (client) => {
      const r = await client.query('SELECT NOW() AS now, COUNT(*) AS order_count FROM orders');
      return r.rows[0];
    });

    const s3List = await s3
      .listObjectsV2({
        Bucket: 'orders-input-bucket-newcastle',
        Prefix: 'shipments/',
        MaxKeys: 5
      })
      .promise();

    res.json({
      status: 'HEALTHY',
      service: 'Transportation Orders Management',
      database: 'Connected',
      order_count: Number(dbInfo.order_count || 0),
      timestamp: dbInfo.now,
      s3_connectivity: 'Connected',
      s3_objects_preview: (s3List.Contents || []).map(o => o.Key),
      iam_role_note: 'EC2 instance profile with intentionally broad permissions'
    });
  } catch (err) {
    res.status(500).json({ status: 'ERROR', error: err.message });
  }
});

// List orders (joined with customers & shipments)
app.get('/orders', async (_req, res) => {
  try {
    const data = await withDb(async (client) => {
      const q = `
        SELECT 
          o.order_no, o.commodity, o.origin_city, o.destination_city,
          o.weight_kg, o.volume_m3, o.status, o.priority, o.service_type,
          o.pickup_date, o.delivery_date, o.created_at,
          c.company_name, c.contact_person,
          s.carrier, s.tracking_no, s.driver_name
        FROM orders o
        LEFT JOIN customers c ON o.customer_id = c.customer_id
        LEFT JOIN shipments s ON o.id = s.order_id
        ORDER BY 
          CASE o.status 
            WHEN 'New' THEN 1 
            WHEN 'Planned' THEN 2 
            WHEN 'Dispatched' THEN 3 
            WHEN 'In Transit' THEN 4 
            WHEN 'Delivered' THEN 5 
            WHEN 'Cancelled' THEN 6 
          END, 
          o.priority ASC, 
          o.created_at DESC
      `;
      const r = await client.query(q);
      return r.rows;
    });

    res.json({ count: data.length, orders: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get one order
app.get('/orders/:orderNo', async (req, res) => {
  try {
    const order = await withDb(async (client) => {
      const q = `
        SELECT 
          o.*, 
          c.company_name, c.contact_person, c.email, c.phone,
          s.carrier, s.driver_name, s.driver_phone, s.tracking_no,
          s.vehicle_registration, s.vehicle_type,
          s.pickup_datetime, s.delivery_datetime,
          s.actual_pickup_datetime, s.actual_delivery_datetime,
          s.cost_aud, s.fuel_surcharge, s.tolls_aud,
          s.s3_documents_path, s.shipment_notes
        FROM orders o
        LEFT JOIN customers c ON o.customer_id = c.customer_id
        LEFT JOIN shipments s ON o.id = s.order_id
        WHERE o.order_no = $1
      `;
      const r = await client.query(q, [req.params.orderNo]);
      return r.rows[0];
    });

    if (!order) return res.status(404).json({ error: 'Order not found' });
    res.json({ order });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Create order (optional docs upload)
app.post('/orders', upload.array('documents', 5), async (req, res) => {
  try {
    const {
      customer_id,
      commodity,
      commodity_type,
      origin_city,
      destination_city,
      weight_kg,
      volume_m3,
      service_type,
      priority,
      special_instructions,
      pickup_date,
      delivery_date,
      customer_reference
    } = req.body;

    const orderDate = moment().format('YYYYMMDD');

    const created = await withDb(async (client) => {
      const countR = await client.query(
        "SELECT COUNT(*)::int AS c FROM orders WHERE order_no LIKE $1",
        [`ORD-${orderDate}-%`]
      );
      const nextNum = String((countR.rows[0].c || 0) + 1).padStart(3, '0');
      const order_no = `ORD-${orderDate}-${nextNum}`;

      const insert = `
        INSERT INTO orders
          (order_no, customer_id, commodity, commodity_type, origin_city, destination_city,
           weight_kg, volume_m3, service_type, priority, special_instructions,
           pickup_date, delivery_date, customer_reference)
        VALUES
          ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
        RETURNING *
      `;
      const r = await client.query(insert, [
        order_no,
        customer_id ? Number(customer_id) : null,
        commodity,
        commodity_type || 'General',
        origin_city,
        destination_city,
        weight_kg ? Number(weight_kg) : 0,
        volume_m3 ? Number(volume_m3) : 0,
        service_type || 'Standard',
        priority ? Number(priority) : 3,
        special_instructions || null,
        pickup_date || null,
        delivery_date || null,
        customer_reference || null
      ]);

      return r.rows[0];
    });

    const s3_paths = (req.files || []).map(f => `s3://${f.bucket}/${f.key}`);

    res.json({
      success: true,
      order: created,
      uploaded_documents: s3_paths
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update order status
app.patch('/orders/:orderNo/status', async (req, res) => {
  try {
    const { status } = req.body;
    const allowed = ['New', 'Planned', 'Dispatched', 'In Transit', 'Delivered', 'Cancelled'];
    if (!allowed.includes(status)) {
      return res.status(400).json({ error: 'Invalid status' });
    }

    const updated = await withDb(async (client) => {
      const q = `
        UPDATE orders
        SET status = $1, updated_at = CURRENT_TIMESTAMP
        WHERE order_no = $2
        RETURNING *
      `;
      const r = await client.query(q, [status, req.params.orderNo]);
      return r.rows[0];
    });

    if (!updated) return res.status(404).json({ error: 'Order not found' });
    res.json({ success: true, order: updated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Generate summary report (and save JSON to S3)
app.get('/orders/reports/summary', async (_req, res) => {
  try {
    const { summary, customers } = await withDb(async (client) => {
      const q1 = `
        SELECT 
          o.status,
          o.service_type,
          o.commodity_type,
          COUNT(*)::int            AS count,
          AVG(o.weight_kg)         AS avg_weight,
          AVG(s.cost_aud)          AS avg_cost,
          AVG(
            EXTRACT(EPOCH FROM (
              COALESCE(s.actual_delivery_datetime, s.delivery_datetime)
              - COALESCE(s.actual_pickup_datetime, s.pickup_datetime)
            ))/3600
          ) AS avg_transit_hours
        FROM orders o
        LEFT JOIN shipments s ON o.id = s.order_id
        WHERE o.created_at >= CURRENT_DATE - INTERVAL '30 days'
        GROUP BY o.status, o.service_type, o.commodity_type
        ORDER BY o.status, o.service_type
      `;
      const q2 = `
        SELECT 
          c.company_name,
          COUNT(o.id)::int AS total_orders,
          SUM(s.cost_aud)  AS total_revenue
        FROM customers c
        LEFT JOIN orders o   ON c.customer_id = o.customer_id
        LEFT JOIN shipments s ON o.id = s.order_id
        WHERE o.created_at >= CURRENT_DATE - INTERVAL '30 days'
        GROUP BY c.customer_id, c.company_name
        ORDER BY total_revenue DESC NULLS LAST
        LIMIT 10
      `;

      const r1 = await client.query(q1);
      const r2 = await client.query(q2);
      return { summary: r1.rows, customers: r2.rows };
    });

    const report = {
      report_id: `TRANS-RPT-${moment().format('YYYY-MM-DD-HH-mm-ss')}`,
      generated_at: new Date().toISOString(),
      period: 'Last 30 days',
      order_summary: summary,
      top_customers: customers
    };

    const key = `reports/transportation-summary-${moment().format('YYYY-MM-DD-HH-mm-ss')}.json`;
    await s3
      .putObject({
        Bucket: 'orders-output-bucket-newcastle', // adjust if needed
        Key: key,
        Body: JSON.stringify(report, null, 2),
        ContentType: 'application/json'
      })
      .promise();

    res.json({
      message: 'Report generated and saved to S3',
      s3_location: `s3://orders-output-bucket-newcastle/${key}`,
      report
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Customers
app.get('/customers', async (_req, res) => {
  try {
    const rows = await withDb(async (client) => {
      const r = await client.query(
        'SELECT * FROM customers WHERE is_active = true ORDER BY company_name'
      );
      return r.rows;
    });
    res.json({ count: rows.length, customers: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------- SERVER ----------
const PORT = process.env.PORT || 3000;
app.listen(3000, '0.0.0.0', () => {
  console.log("🚛 Transportation Orders Management running on port 3000");
  console.log('🔓 Using BROAD permissions for production baseline research');
  console.log('📍 Access via: http://3.27.181.24:3000');
});


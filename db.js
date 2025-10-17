require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.RDS_HOST,
  port: Number(process.env.RDS_PORT),
  user: process.env.RDS_USER,
  password: process.env.RDS_PASSWORD,
  database: process.env.RDS_DB,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000
});

module.exports = {
  query: (text, params) => pool.query(text, params),
  pool
};

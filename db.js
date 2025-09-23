require("dotenv").config();
const { Pool } = require("pg");

const pool = new Pool({
  host: process.env.RDS_HOST,
  port: process.env.RDS_PORT || 5432,
  database: process.env.RDS_DB,
  user: process.env.RDS_USER,
  password: process.env.RDS_PASSWORD,
  ssl: { rejectUnauthorized: false }
});

module.exports = {
  query: (text, params) => pool.query(text, params),
  pool
};

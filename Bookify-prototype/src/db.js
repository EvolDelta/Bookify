// MySQL connection pool, configured from environment variables.
// Locally they come from .env (copy .env.example); on a cloud host you set
// the same names in the host's dashboard instead.
const fs = require('fs');
const mysql = require('mysql2/promise');

try { process.loadEnvFile(); } catch { /* no .env file — fine on a cloud host */ }

// All times are compared inside MySQL with NOW(), so the session time zone is
// the one place that decides what "now" means. Default: Thailand (UTC+7).
const TIME_ZONE = process.env.DB_TIMEZONE || '+07:00';

// Cloud MySQL providers require TLS. DB_SSL_CA may hold the CA certificate
// itself (paste it into the dashboard) or a path to the .pem file.
function sslOptions() {
  if (process.env.DB_SSL !== 'true') return undefined;
  const ca = process.env.DB_SSL_CA;
  if (!ca) return { rejectUnauthorized: true };
  return { ca: ca.includes('BEGIN CERTIFICATE') ? ca.replace(/\\n/g, '\n') : fs.readFileSync(ca, 'utf8') };
}

function connectionOptions(extra = {}) {
  return {
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'bookify',
    ssl: sslOptions(),
    timezone: TIME_ZONE,
    decimalNumbers: true, // DECIMAL columns come back as numbers, not strings
    ...extra
  };
}

const pool = mysql.createPool(connectionOptions({ connectionLimit: Number(process.env.DB_POOL_SIZE) || 10 }));
pool.pool.on('connection', conn => conn.query(`SET time_zone = '${TIME_ZONE}'`));

// Run fn(conn) inside a transaction: commit if it returns, roll back if it throws.
async function transaction(fn) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const result = await fn(conn);
    await conn.commit();
    return result;
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

module.exports = { pool, transaction, connectionOptions, TIME_ZONE };

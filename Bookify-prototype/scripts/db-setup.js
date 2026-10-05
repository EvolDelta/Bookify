// Builds the Bookify database from the files in db/:
//   npm run db:setup   → schema + triggers + sample data   (drops existing tables!)
//   npm run db:schema  → schema + triggers only, no sample data
// Works against a local MySQL or a cloud one — it uses the same .env settings
// as the server.
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
const { connectionOptions, TIME_ZONE } = require('../src/db');

// Split a .sql file into statements the way the mysql client / Workbench does,
// honouring DELIMITER lines so trigger bodies can contain semicolons.
function splitSql(text) {
  const statements = [];
  let delimiter = ';';
  let buf = [];
  for (const line of text.split(/\r?\n/)) {
    const d = line.match(/^\s*DELIMITER\s+(\S+)\s*$/i);
    if (d) { delimiter = d[1]; continue; }
    if (!buf.length && (/^\s*--/.test(line) || !line.trim())) continue;
    buf.push(line);
    if (line.trimEnd().endsWith(delimiter)) {
      const stmt = buf.join('\n').trimEnd();
      statements.push(stmt.slice(0, stmt.length - delimiter.length));
      buf = [];
    }
  }
  if (buf.join('').trim()) statements.push(buf.join('\n'));
  return statements;
}

async function runFile(conn, file) {
  const statements = splitSql(fs.readFileSync(path.join(__dirname, '..', 'db', file), 'utf8'));
  for (const sql of statements) {
    try {
      await conn.query(sql);
    } catch (err) {
      err.message = `${file}: ${err.message}\n--- in statement ---\n${sql.slice(0, 400)}`;
      throw err;
    }
  }
  console.log(`  ✓ ${file} (${statements.length} statements)`);
}

async function main() {
  const withSeed = !process.argv.includes('--no-seed');
  const opts = connectionOptions();
  const dbName = opts.database;

  // Connect without a database first so we can create it if it is missing.
  const conn = await mysql.createConnection({ ...opts, database: undefined });
  try {
    console.log(`Connected to ${opts.host}:${opts.port} as ${opts.user}`);
    await conn.query(`CREATE DATABASE IF NOT EXISTS \`${dbName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`);
    await conn.query(`USE \`${dbName}\``);
    await conn.query(`SET time_zone = '${TIME_ZONE}'`);
    console.log(`Building database "${dbName}"`);
    await runFile(conn, 'schema.sql');
    await runFile(conn, 'triggers.sql');
    if (withSeed) await runFile(conn, 'seed.sql');
    console.log('Done.');
  } finally {
    await conn.end();
  }
}

main().catch(err => {
  console.error('\nDatabase setup failed:\n' + err.message);
  if (/SUPER privilege|log_bin_trust_function_creators/i.test(err.message)) {
    console.error('\nHint: your cloud MySQL blocks triggers by default. Turn on the\n' +
      '"log_bin_trust_function_creators" setting in the provider dashboard and run this again.');
  }
  process.exit(1);
});

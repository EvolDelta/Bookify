// Give every account that has no password one, so you can log in as it.
// (The sample accounts in db/seed.sql already have one: see the top of that file.)
//   npm run sample-passwords                  (password: password123)
//   npm run sample-passwords -- another-pass
// Only accounts with no password yet are changed, so real registered accounts
// keep theirs. For local testing only — never run this against a live database.
const { pool } = require('../src/db');
const auth = require('../src/auth');

async function main() {
  const password = process.argv[2] || 'password123';
  if (password.length < 8) {
    console.log('The password must be at least 8 characters.');
    process.exitCode = 1;
    return;
  }
  const [users] = await pool.query('SELECT user_id, full_name, email FROM users WHERE password_hash IS NULL ORDER BY user_id');
  if (!users.length) {
    console.log('Every account already has a password — nothing to do.');
    return;
  }
  for (const u of users) {
    // Hash each one separately so every account gets its own salt.
    await pool.query('UPDATE users SET password_hash = ? WHERE user_id = ?', [await auth.hashPassword(password), u.user_id]);
    console.log(`  ${u.email.padEnd(32)} ${u.full_name}`);
  }
  console.log(`\n${users.length} account(s) can now log in with the password: ${password}`);
}

main()
  .catch(err => { console.error(err.message); process.exitCode = 1; })
  .finally(() => pool.end());

// Turn a registered account into an Admin (or back into a Customer, or an
// Organizer if the account runs an organizer).
//   npm run make-admin -- someone@example.com
//   npm run make-admin -- someone@example.com --remove
// The person registers on the website first (so they choose their own password,
// and it never appears in a script or SQL file); this only changes their role.
const { pool } = require('../src/db');

async function main() {
  const email = (process.argv.slice(2).find(a => !a.startsWith('--')) || '').trim().toLowerCase();
  if (!email) {
    console.log('Usage: npm run make-admin -- someone@example.com [--remove]');
    process.exitCode = 1;
    return;
  }
  const [[u]] = await pool.query(
    `SELECT u.full_name, u.password_hash IS NOT NULL AS can_log_in, o.organizer_id
     FROM users u LEFT JOIN organizers o ON o.user_id = u.user_id WHERE u.email = ?`, [email]);
  if (!u) {
    console.log(`No account with email ${email}. Register it on the website first, then run this again.`);
    process.exitCode = 1;
    return;
  }
  const role = !process.argv.includes('--remove') ? 'Admin' : u.organizer_id ? 'Organizer' : 'Customer';
  await pool.query('UPDATE users SET role = ? WHERE email = ?', [role, email]);
  console.log(`${u.full_name} <${email}> is now ${role === 'Admin' ? 'an Admin' : 'a ' + role}.`);
  if (!u.can_log_in) console.log('Note: this account has no password yet (sample data), so it cannot log in.');
}

main()
  .catch(err => { console.error(err.message); process.exitCode = 1; })
  .finally(() => pool.end());

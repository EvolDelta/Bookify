// Register, log in, log out, and "who am I".
const express = require('express');
const v = require('../validate');
const { HttpError } = require('../errors');
const { pool, transaction } = require('../db');
const auth = require('../auth');

const router = express.Router();
const MIN_PASSWORD = 8;

const publicUser = u => ({ user_id: u.user_id, full_name: u.full_name, email: u.email, phone_number: u.phone_number,
  role: u.role, organizer_id: u.organizer_id || null });

function password(value) {
  const s = typeof value === 'string' ? value : '';
  if (s.length < MIN_PASSWORD) throw new HttpError(400, `Password must be at least ${MIN_PASSWORD} characters.`);
  if (s.length > 200) throw new HttpError(400, 'Password is too long.');
  return s;
}

async function newUser(body) {
  return {
    full_name: v.text(body.full_name, 'full_name', { max: 100 }),
    email: v.email(body.email, 'email'),
    phone_number: v.text(body.phone_number, 'phone_number', { max: 20, optional: true }),
    password_hash: await auth.hashPassword(password(body.password))
  };
}

const duplicateEmail = err => {
  if (err.code === 'ER_DUP_ENTRY') return new HttpError(409, 'An account with that email already exists. Log in instead.');
  return err;
};

// POST /api/auth/register  { "full_name", "email", "password", "phone_number"? }
// Everyone who registers here is a Customer. Admins are promoted with `npm run make-admin`.
router.post('/register', async (req, res) => {
  const u = await newUser(req.body);
  let r;
  try {
    [r] = await pool.query('INSERT INTO users SET ?', [u]);
  } catch (err) {
    throw duplicateEmail(err);
  }
  await auth.startSession(res, r.insertId);
  res.status(201).json(publicUser({ ...u, user_id: r.insertId, role: 'Customer' }));
});

// POST /api/auth/register-organizer  { "full_name", "email", "password", "phone_number"?, "organizer_name" }
// Creates an Organizer account and the organizer it runs, in one go. The
// organizer starts Pending: an admin must verify it before it creates events (BR13).
router.post('/register-organizer', async (req, res) => {
  const u = { ...await newUser(req.body), role: 'Organizer' };
  const organizerName = v.text(req.body.organizer_name, 'organizer_name', { max: 100 });
  const [[taken]] = await pool.query('SELECT 1 FROM organizers WHERE contact_email = ?', [u.email]);
  if (taken) {
    throw new HttpError(409, 'An organizer already uses this email. Create a normal account with it, then ask an admin to link it to that organizer.');
  }
  const ids = await transaction(async conn => {
    let r;
    try {
      [r] = await conn.query('INSERT INTO users SET ?', [u]);
    } catch (err) {
      throw duplicateEmail(err);
    }
    const [o] = await conn.query('INSERT INTO organizers SET ?',
      [{ organizer_name: organizerName, contact_email: u.email, user_id: r.insertId }]);
    return { user_id: r.insertId, organizer_id: o.insertId };
  });
  await auth.startSession(res, ids.user_id);
  res.status(201).json(publicUser({ ...u, ...ids }));
});

// POST /api/auth/login  { "email", "password" }
router.post('/login', async (req, res) => {
  const email = v.email(req.body.email, 'email');
  const pw = typeof req.body.password === 'string' ? req.body.password : '';
  const [[user]] = await pool.query(
    'SELECT u.*, o.organizer_id FROM users u LEFT JOIN organizers o ON o.user_id = u.user_id WHERE u.email = ?', [email]);

  // Same message for "no such email" and "wrong password", so the form does not
  // tell an attacker which emails have accounts.
  const ok = user && user.password_hash ? await auth.verifyPassword(pw, user.password_hash) : (await auth.burnTime(pw), false);
  if (!ok) throw new HttpError(401, 'Wrong email or password.');

  await auth.startSession(res, user.user_id);
  res.json(publicUser(user));
});

// POST /api/auth/logout
router.post('/logout', async (req, res) => {
  await auth.endSession(req, res);
  res.status(204).end();
});

// GET /api/auth/me — the logged-in user, or null for a guest
router.get('/me', (req, res) => res.json(req.user));

module.exports = router;

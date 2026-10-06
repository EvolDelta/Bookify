// Register, log in, log out, and "who am I".
const express = require('express');
const v = require('../validate');
const { HttpError } = require('../errors');
const { pool } = require('../db');
const auth = require('../auth');

const router = express.Router();
const MIN_PASSWORD = 8;

const publicUser = u => ({ user_id: u.user_id, full_name: u.full_name, email: u.email, phone_number: u.phone_number, role: u.role });

function password(value) {
  const s = typeof value === 'string' ? value : '';
  if (s.length < MIN_PASSWORD) throw new HttpError(400, `Password must be at least ${MIN_PASSWORD} characters.`);
  if (s.length > 200) throw new HttpError(400, 'Password is too long.');
  return s;
}

// POST /api/auth/register  { "full_name", "email", "password", "phone_number"? }
// Everyone who registers is a Customer. Admins are promoted with `npm run make-admin`.
router.post('/register', async (req, res) => {
  const u = {
    full_name: v.text(req.body.full_name, 'full_name', { max: 100 }),
    email: v.email(req.body.email, 'email'),
    phone_number: v.text(req.body.phone_number, 'phone_number', { max: 20, optional: true }),
    password_hash: await auth.hashPassword(password(req.body.password))
  };
  let r;
  try {
    [r] = await pool.query('INSERT INTO users SET ?', [u]);
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') throw new HttpError(409, 'An account with that email already exists. Log in instead.');
    throw err;
  }
  await auth.startSession(res, r.insertId);
  res.status(201).json(publicUser({ ...u, user_id: r.insertId, role: 'Customer' }));
});

// POST /api/auth/login  { "email", "password" }
router.post('/login', async (req, res) => {
  const email = v.email(req.body.email, 'email');
  const pw = typeof req.body.password === 'string' ? req.body.password : '';
  const [[user]] = await pool.query('SELECT * FROM users WHERE email = ?', [email]);

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

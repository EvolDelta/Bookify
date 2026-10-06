// Authentication: password hashing, login sessions, and the middleware that
// decides who may call which API route.
//
// How a login works:
//   1. POST /api/auth/login checks the password against users.password_hash.
//   2. The server makes a random token, stores its SHA-256 hash in `sessions`,
//      and sends the token to the browser in an HttpOnly cookie (page
//      JavaScript cannot read it, so a script injected into the page cannot steal it).
//   3. On every later request loadUser() hashes the cookie's token, finds the
//      session and attaches the user to req.user.
const crypto = require('crypto');
const { promisify } = require('util');
const { pool } = require('./db');
const { HttpError } = require('./errors');

const scrypt = promisify(crypto.scrypt);
const COOKIE = 'bookify_session';
const SESSION_DAYS = 7;
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

// ───────────── passwords ─────────────
// Stored as "scrypt$N$r$p$salt$hash". The random salt means two people with the
// same password still get different hashes; scrypt is deliberately slow, so
// guessing passwords from a stolen table takes far too long to be practical.

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(password, salt, SCRYPT.keylen, SCRYPT);
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64'), hash.toString('base64')].join('$');
}

async function verifyPassword(password, stored) {
  const [alg, N, r, p, salt, hash] = String(stored || '').split('$');
  if (alg !== 'scrypt') return false;
  const expected = Buffer.from(hash, 'base64');
  const actual = await scrypt(password, Buffer.from(salt, 'base64'), expected.length, { N: +N, r: +r, p: +p });
  return crypto.timingSafeEqual(actual, expected);
}

// Used when the email does not exist, so a wrong email takes as long as a wrong
// password and the response time does not reveal which emails are registered.
let dummyHash;
async function burnTime(password) {
  dummyHash = dummyHash || await hashPassword('not-a-real-password');
  await verifyPassword(password, dummyHash);
}

// ───────────── sessions ─────────────

const sha256 = s => crypto.createHash('sha256').update(s).digest('hex');

function readCookie(req) {
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === COOKIE) return decodeURIComponent(v.join('='));
  }
  return null;
}

function cookie(value, maxAgeSeconds) {
  return [
    `${COOKIE}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAgeSeconds}`,
    // Secure = only sent over https. Local http://localhost would drop it, so only in production.
    ...(process.env.NODE_ENV === 'production' ? ['Secure'] : [])
  ].join('; ');
}

async function startSession(res, userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  await pool.query('DELETE FROM sessions WHERE expires_at < NOW()'); // tidy up old ones
  await pool.query(
    `INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, NOW() + INTERVAL ${SESSION_DAYS} DAY)`,
    [sha256(token), userId]);
  res.setHeader('Set-Cookie', cookie(token, SESSION_DAYS * 86400));
}

async function endSession(req, res) {
  const token = readCookie(req);
  if (token) await pool.query('DELETE FROM sessions WHERE token_hash = ?', [sha256(token)]);
  res.setHeader('Set-Cookie', cookie('', 0));
}

// ───────────── middleware ─────────────

// Runs on every API request: attaches req.user (or null). Never blocks.
async function loadUser(req, res, next) {
  req.user = null;
  const token = readCookie(req);
  if (token) {
    const [[user]] = await pool.query(
      `SELECT u.user_id, u.full_name, u.email, u.phone_number, u.role
       FROM sessions s JOIN users u ON u.user_id = s.user_id
       WHERE s.token_hash = ? AND s.expires_at > NOW()`, [sha256(token)]);
    req.user = user || null;
  }
  next();
}

function requireUser(req, res, next) {
  if (!req.user) throw new HttpError(401, 'Please log in first.');
  next();
}

function requireAdmin(req, res, next) {
  if (!req.user) throw new HttpError(401, 'Please log in first.');
  if (req.user.role !== 'Admin') throw new HttpError(403, 'Only admins can do this.');
  next();
}

// For "my own data, or any data if you are an admin".
function assertSelfOrAdmin(req, userId) {
  if (!req.user) throw new HttpError(401, 'Please log in first.');
  if (req.user.role !== 'Admin' && req.user.user_id !== userId) {
    throw new HttpError(403, 'You can only see your own account.');
  }
}

module.exports = {
  hashPassword, verifyPassword, burnTime, startSession, endSession,
  loadUser, requireUser, requireAdmin, assertSelfOrAdmin
};

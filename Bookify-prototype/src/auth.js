// Admin login. One administrator account, configured with ADMIN_EMAIL and
// ADMIN_PASSWORD in .env (never in the code: the repository is public).
// Logging in returns a signed token that the browser sends back as
//   Authorization: Bearer <token>
// The token carries its own expiry and an HMAC signature, so the server keeps
// no session store — which also works on serverless hosts such as Vercel.
const crypto = require('crypto');
const express = require('express');
const { HttpError } = require('./errors');

const SESSION_HOURS = 8;
const MAX_FAILURES = 5;            // wrong passwords allowed per address…
const LOCK_MINUTES = 15;           // …before it has to wait this long

const sha256 = s => crypto.createHash('sha256').update(String(s)).digest();

function adminConfig() {
  const email = (process.env.ADMIN_EMAIL || '').trim();
  const password = process.env.ADMIN_PASSWORD || '';
  return email && password ? { email, password } : null;
}

const secretFor = cfg => process.env.SESSION_SECRET || sha256(`bookify-session\0${cfg.email}\0${cfg.password}`);

function sign(payload, cfg) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const mac = crypto.createHmac('sha256', secretFor(cfg)).update(body).digest('base64url');
  return `${body}.${mac}`;
}

// Returns the session payload, or null if the token is missing, forged or expired.
function verify(token) {
  const cfg = adminConfig();
  if (!cfg || typeof token !== 'string' || !token.includes('.')) return null;
  const [body, mac] = token.split('.');
  const expected = crypto.createHmac('sha256', secretFor(cfg)).update(body).digest('base64url');
  if (mac.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return null;
  let payload;
  try { payload = JSON.parse(Buffer.from(body, 'base64url').toString()); } catch { return null; }
  return payload.exp > Date.now() ? payload : null;
}

// Express middleware for the Manage and Admin routes.
function requireAdmin(req, res, next) {
  const m = /^Bearer (.+)$/.exec(req.get('authorization') || '');
  if (!m || !verify(m[1])) throw new HttpError(401, 'Admin login required.');
  next();
}

// Failed logins per address, kept in memory (a restart clears it).
const failures = new Map();

const router = express.Router();

// POST /api/auth/login  { "email", "password" } → { token, email, expires_at }
router.post('/login', (req, res) => {
  const cfg = adminConfig();
  if (!cfg) throw new HttpError(503, 'Admin login is not set up: add ADMIN_EMAIL and ADMIN_PASSWORD to .env.');
  const key = req.ip;
  const f = failures.get(key);
  if (f && f.lockedUntil > Date.now()) {
    const minutes = Math.ceil((f.lockedUntil - Date.now()) / 60000);
    throw new HttpError(429, `Too many wrong passwords. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`);
  }
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  // Compare fixed-length digests so the time taken says nothing about the password.
  const ok = crypto.timingSafeEqual(sha256(email), sha256(cfg.email.toLowerCase()))
           & crypto.timingSafeEqual(sha256(password), sha256(cfg.password));
  if (!ok) {
    const prev = f && !(f.lockedUntil && f.lockedUntil <= Date.now()) ? f.count : 0;  // an ended lock starts over
    const count = prev + 1;
    failures.set(key, { count, lockedUntil: count >= MAX_FAILURES ? Date.now() + LOCK_MINUTES * 60000 : 0 });
    throw new HttpError(401, 'Wrong email or password.');
  }
  failures.delete(key);
  const exp = Date.now() + SESSION_HOURS * 3600000;
  res.json({ token: sign({ sub: cfg.email, exp }, cfg), email: cfg.email, expires_at: new Date(exp).toISOString() });
});

// GET /api/auth/me — is this token still a valid admin session?
router.get('/me', requireAdmin, (req, res) => {
  const payload = verify(req.get('authorization').slice(7));
  res.json({ email: payload.sub, expires_at: new Date(payload.exp).toISOString() });
});

module.exports = { router, requireAdmin };

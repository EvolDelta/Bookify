// Tiny input checks for request bodies. Each returns the cleaned value or
// throws a 400 HttpError naming the field.
const { HttpError } = require('./errors');

function id(value, field) {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, `${field} must be a positive whole number.`);
  return n;
}

function text(value, field, { max = 255, optional = false } = {}) {
  if (value === undefined || value === null || String(value).trim() === '') {
    if (optional) return null;
    throw new HttpError(400, `${field} is required.`);
  }
  const s = String(value).trim();
  if (s.length > max) throw new HttpError(400, `${field} must be at most ${max} characters.`);
  return s;
}

function money(value, field, { optional = false } = {}) {
  if (optional && (value === undefined || value === null)) return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) throw new HttpError(400, `${field} must be a number above zero.`);
  return Math.round(n * 100) / 100;
}

function oneOf(value, field, allowed, fallback) {
  if ((value === undefined || value === null) && fallback !== undefined) return fallback;
  if (!allowed.includes(value)) throw new HttpError(400, `${field} must be one of: ${allowed.join(', ')}.`);
  return value;
}

// Accepts "2026-11-20 19:00" or "2026-11-20T19:00" and returns MySQL DATETIME text.
function dateTime(value, field) {
  const m = String(value || '').match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})(:\d{2})?$/);
  if (!m) throw new HttpError(400, `${field} must look like 2026-11-20 19:00.`);
  return `${m[1]} ${m[2]}${m[3] || ':00'}`;
}

function date(value, field) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) throw new HttpError(400, `${field} must look like 2026-11-20.`);
  return value;
}

const email = (value, field) => {
  const s = text(value, field);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s)) throw new HttpError(400, `${field} is not a valid email.`);
  return s.toLowerCase();
};

module.exports = { id, text, money, oneOf, dateTime, date, email };

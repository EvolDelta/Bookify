// Users and organizers. People create their own account with
// POST /api/auth/register; the routes here are for admins and for "my account".
const express = require('express');
const v = require('../validate');
const { HttpError } = require('../errors');
const { pool } = require('../db');
const { expireStaleBookings } = require('../services/bookings');
const { requireAdmin, assertSelfOrAdmin } = require('../auth');

const users = express.Router();
const organizers = express.Router();

// POST /api/users  { "full_name", "email", "phone_number" } — admin adds a user without a login
users.post('/', requireAdmin, async (req, res) => {
  const u = {
    full_name: v.text(req.body.full_name, 'full_name', { max: 100 }),
    email: v.email(req.body.email, 'email'),
    phone_number: v.text(req.body.phone_number, 'phone_number', { max: 20, optional: true })
  };
  const [r] = await pool.query('INSERT INTO users SET ?', [u]);
  res.status(201).json({ user_id: r.insertId, ...u });
});

// GET /api/users/:id — yourself, or anyone if you are an admin
users.get('/:id', async (req, res) => {
  const id = v.id(req.params.id, 'id');
  assertSelfOrAdmin(req, id);
  const [[u]] = await pool.query('SELECT user_id, full_name, email, phone_number, role, created_at FROM users WHERE user_id = ?', [id]);
  if (!u) throw new HttpError(404, 'User not found.');
  res.json(u);
});

// PATCH /api/users/:id — administrator corrects a user's details
users.patch('/:id', requireAdmin, async (req, res) => {
  const id = v.id(req.params.id, 'id');
  const changes = {};
  if (req.body.full_name !== undefined) changes.full_name = v.text(req.body.full_name, 'full_name', { max: 100 });
  if (req.body.email !== undefined) changes.email = v.email(req.body.email, 'email');
  if (req.body.phone_number !== undefined) changes.phone_number = v.text(req.body.phone_number, 'phone_number', { max: 20, optional: true });
  if (!Object.keys(changes).length) throw new HttpError(400, 'Send at least one of full_name, email, phone_number.');
  const [r] = await pool.query('UPDATE users SET ? WHERE user_id = ?', [changes, id]);
  if (!r.affectedRows) throw new HttpError(404, 'User not found.');
  res.json({ user_id: id, ...changes });
});

// GET /api/users/:id/bookings — "my reservations"
users.get('/:id/bookings', async (req, res) => {
  assertSelfOrAdmin(req, v.id(req.params.id, 'id'));
  await expireStaleBookings();
  const [rows] = await pool.query(
    `SELECT b.booking_id, b.booking_status, b.created_at, b.lock_expires_at, b.total_amount,
            e.event_id, e.event_name, e.event_date, e.venue_name,
            GROUP_CONCAT(COALESCE(CONCAT(u.row_label, u.seat_number), CONCAT('#', u.unit_id))
                         ORDER BY u.unit_id SEPARATOR ', ') AS units
     FROM bookings b
     JOIN booking_items bi       ON bi.booking_id = b.booking_id
     JOIN admission_units u      ON u.unit_id = bi.unit_id
     JOIN event_ticket_types ett ON ett.event_ticket_type_id = u.event_ticket_type_id
     JOIN events e               ON e.event_id = ett.event_id
     WHERE b.user_id = ?
     GROUP BY b.booking_id, e.event_id
     ORDER BY b.created_at DESC`, [v.id(req.params.id, 'id')]);
  res.json(rows);
});

// GET /api/organizers
organizers.get('/', async (req, res) => {
  const [rows] = await pool.query('SELECT * FROM organizers ORDER BY organizer_name');
  res.json(rows);
});

// POST /api/organizers  { "organizer_name", "contact_email" } — starts as Pending
organizers.post('/', async (req, res) => {
  const o = {
    organizer_name: v.text(req.body.organizer_name, 'organizer_name', { max: 100 }),
    contact_email: v.email(req.body.contact_email, 'contact_email')
  };
  const [r] = await pool.query('INSERT INTO organizers SET ?', [o]);
  res.status(201).json({ organizer_id: r.insertId, ...o, verification_status: 'Pending' });
});

// PATCH /api/organizers/:id/verification  { "verification_status": "Verified" | "Rejected" | "Pending" }
// Administrator task. Needed before the organizer can create events (BR13).
organizers.patch('/:id/verification', async (req, res) => {
  const id = v.id(req.params.id, 'id');
  const status = v.oneOf(req.body.verification_status, 'verification_status', ['Pending', 'Verified', 'Rejected']);
  const [r] = await pool.query(
    `UPDATE organizers SET verification_status = ?, verified_at = IF(? = 'Verified', NOW(), NULL)
     WHERE organizer_id = ?`, [status, status, id]);
  if (!r.affectedRows) throw new HttpError(404, 'Organizer not found.');
  const [[o]] = await pool.query('SELECT * FROM organizers WHERE organizer_id = ?', [id]);
  res.json(o);
});

module.exports = { users, organizers };

// Everything under /api. Express 5 forwards errors thrown in async handlers
// to errorHandler, so routes do not need try/catch.
const express = require('express');
const { pool } = require('./db');
const { errorHandler } = require('./errors');
const { users, organizers } = require('./routes/people');

const api = express.Router();
api.use(express.json());

// GET /api/health — quick check that the server can reach the database
api.get('/health', async (req, res) => {
  const [[row]] = await pool.query('SELECT VERSION() AS mysql_version, NOW() AS db_time');
  res.json({ ok: true, ...row });
});

api.use('/events', require('./routes/events'));
api.use('/bookings', require('./routes/bookings'));
api.use('/promotions', require('./routes/promotions'));
api.use('/reports', require('./routes/reports'));
api.use('/users', users);
api.use('/organizers', organizers);

api.use((req, res) => res.status(404).json({ error: `No API route for ${req.method} ${req.originalUrl}` }));
api.use(errorHandler);

module.exports = api;

// Events: browse (customer), create / open / close (organizer), remove (admin).
const express = require('express');
const v = require('../validate');
const { HttpError } = require('../errors');
const { pool, transaction } = require('../db');
const { expireStaleBookings } = require('../services/bookings');

const router = express.Router();

const AVAILABILITY = `
  SELECT e.event_id, e.event_name, e.event_date, e.venue_name, e.event_kind, e.total_capacity, e.event_status,
         o.organizer_name,
         MIN(ett.price) AS price_from,
         COUNT(u.unit_id) AS units,
         COALESCE(SUM(u.unit_status = 'Available'), 0) AS available,
         COALESCE(SUM(u.unit_status = 'Locked'), 0)    AS locked,
         COALESCE(SUM(u.unit_status = 'Sold'), 0)      AS sold
  FROM events e
  JOIN organizers o ON o.organizer_id = e.organizer_id
  LEFT JOIN event_ticket_types ett ON ett.event_id = e.event_id
  LEFT JOIN admission_units u      ON u.event_ticket_type_id = ett.event_ticket_type_id`;
const AVAILABILITY_GROUP = ` GROUP BY e.event_id, o.organizer_name`;

// GET /api/events?status=On_sale     (default: events on sale, soonest first)
router.get('/', async (req, res) => {
  await expireStaleBookings();
  const status = v.oneOf(req.query.status, 'status', ['Draft', 'On_sale', 'Closed', 'Cancelled', 'all'], 'On_sale');
  const where = status === 'all' ? '' : ' WHERE e.event_status = ?';
  const [rows] = await pool.query(AVAILABILITY + where + AVAILABILITY_GROUP + ' ORDER BY e.event_date', [status]);
  res.json(rows.map(r => ({ ...r, is_full: r.units > 0 && r.sold === r.units })));
});

// GET /api/events/:id — event, its subtype details, ticket types and every unit's status
router.get('/:id', async (req, res) => {
  const id = v.id(req.params.id, 'id');
  await expireStaleBookings();
  const [[event]] = await pool.query(AVAILABILITY + ' WHERE e.event_id = ?' + AVAILABILITY_GROUP, [id]);
  if (!event) throw new HttpError(404, 'Event not found.');

  const [[sub]] = event.event_kind === 'Seated'
    ? await pool.query('SELECT seat_map_name, total_rows FROM seated_events WHERE event_id = ?', [id])
    : await pool.query('SELECT zone_name FROM non_seated_events WHERE event_id = ?', [id]);

  const [ticketTypes] = await pool.query(
    `SELECT ett.event_ticket_type_id, c.type_name, c.description, ett.price,
            COUNT(u.unit_id) AS units, COALESCE(SUM(u.unit_status = 'Available'), 0) AS available
     FROM event_ticket_types ett
     JOIN ticket_type_catalog c ON c.type_id = ett.type_id
     LEFT JOIN admission_units u ON u.event_ticket_type_id = ett.event_ticket_type_id
     WHERE ett.event_id = ?
     GROUP BY ett.event_ticket_type_id ORDER BY ett.price DESC`, [id]);

  const [units] = await pool.query(
    `SELECT u.unit_id, u.event_ticket_type_id, c.type_name, u.row_label, u.seat_number, u.unit_status
     FROM admission_units u
     JOIN event_ticket_types ett ON ett.event_ticket_type_id = u.event_ticket_type_id
     JOIN ticket_type_catalog c  ON c.type_id = ett.type_id
     WHERE ett.event_id = ?
     ORDER BY u.row_label, u.seat_number, u.unit_id`, [id]);

  res.json({ ...event, ...sub, ticket_types: ticketTypes, units });
});

// POST /api/events — an organizer creates a Draft event with its seats.
// Seated:     { ..., "event_kind": "Seated", "seat_map_name": "Hall", "ticket_types": [
//               { "type_name": "VIP", "price": 1200, "rows": ["A"], "seats_per_row": 10 }, ... ] }
// Non_Seated: { ..., "event_kind": "Non_Seated", "zone_name": "Field", "ticket_types": [
//               { "type_name": "Normal", "price": 150, "quantity": 80 }, ... ] }
router.post('/', async (req, res) => {
  const b = req.body;
  const e = {
    organizer_id: v.id(b.organizer_id, 'organizer_id'),
    event_name: v.text(b.event_name, 'event_name', { max: 150 }),
    event_date: v.dateTime(b.event_date, 'event_date'),
    venue_name: v.text(b.venue_name, 'venue_name', { max: 150 }),
    event_kind: v.oneOf(b.event_kind, 'event_kind', ['Seated', 'Non_Seated']),
    total_capacity: v.id(b.total_capacity, 'total_capacity')
  };
  const seated = e.event_kind === 'Seated';
  const types = Array.isArray(b.ticket_types) ? b.ticket_types : [];
  if (!types.length) throw new HttpError(400, 'BR11: ticket_types needs at least one entry.');

  // Turn each ticket type into the list of units it should create.
  const plan = types.map((t, i) => {
    const typeName = v.oneOf(t.type_name, `ticket_types[${i}].type_name`, ['Normal', 'Priority', 'VIP']);
    const price = v.money(t.price, `ticket_types[${i}].price`);
    let units;
    if (seated) {
      const rows = Array.isArray(t.rows) ? t.rows.map(r => v.text(r, `ticket_types[${i}].rows`, { max: 5 }).toUpperCase()) : [];
      const perRow = v.id(t.seats_per_row, `ticket_types[${i}].seats_per_row`);
      if (!rows.length) throw new HttpError(400, `ticket_types[${i}].rows must list row labels, e.g. ["A","B"].`);
      units = rows.flatMap(r => Array.from({ length: perRow }, (_, s) => [r, s + 1]));
    } else {
      units = Array.from({ length: v.id(t.quantity, `ticket_types[${i}].quantity`) }, () => [null, null]);
    }
    return { typeName, price, units };
  });
  const totalUnits = plan.reduce((t, p) => t + p.units.length, 0);
  if (totalUnits > e.total_capacity) {
    throw new HttpError(400, `BR22: ${totalUnits} units requested but total_capacity is ${e.total_capacity}.`);
  }

  const eventId = await transaction(async conn => {
    const [ins] = await conn.query('INSERT INTO events SET ?', [e]);    // trg_events_bi checks BR13
    const id = ins.insertId;
    if (seated) {
      const rowCount = new Set(plan.flatMap(p => p.units.map(u => u[0]))).size;
      await conn.query('INSERT INTO seated_events (event_id, seat_map_name, total_rows) VALUES (?, ?, ?)',
        [id, v.text(b.seat_map_name, 'seat_map_name', { max: 100 }), rowCount]);
    } else {
      await conn.query('INSERT INTO non_seated_events (event_id, zone_name) VALUES (?, ?)',
        [id, v.text(b.zone_name, 'zone_name', { max: 100 })]);
    }
    for (const p of plan) {
      const [ett] = await conn.query(
        `INSERT INTO event_ticket_types (event_id, type_id, price)
         SELECT ?, type_id, ? FROM ticket_type_catalog WHERE type_name = ?`, [id, p.price, p.typeName]);
      await conn.query('INSERT INTO admission_units (event_ticket_type_id, row_label, seat_number) VALUES ?',
        [p.units.map(([row, seat]) => [ett.insertId, row, seat])]);
    }
    return id;
  });
  res.status(201).json({ event_id: eventId, event_status: 'Draft', units_created: totalUnits,
    next: `PATCH /api/events/${eventId}/status {"event_status":"On_sale"} to open it for booking` });
});

// PATCH /api/events/:id/status  { "event_status": "On_sale" | "Closed" | "Cancelled" }
// Opening for sale runs the BR10/BR11 checks in trg_events_bu.
router.patch('/:id/status', async (req, res) => {
  const id = v.id(req.params.id, 'id');
  const status = v.oneOf(req.body.event_status, 'event_status', ['Draft', 'On_sale', 'Closed', 'Cancelled']);
  const [r] = await pool.query('UPDATE events SET event_status = ? WHERE event_id = ?', [status, id]);
  if (!r.affectedRows) throw new HttpError(404, 'Event not found.');
  res.json({ event_id: id, event_status: status });
});

// DELETE /api/events/:id — administrator removes a cancelled event that nobody booked.
// Events with bookings are kept so sales history still adds up.
router.delete('/:id', async (req, res) => {
  const id = v.id(req.params.id, 'id');
  await transaction(async conn => {
    const [[ev]] = await conn.query('SELECT event_status FROM events WHERE event_id = ? FOR UPDATE', [id]);
    if (!ev) throw new HttpError(404, 'Event not found.');
    if (ev.event_status !== 'Cancelled') throw new HttpError(409, 'Only Cancelled events can be removed. Cancel it first.');
    const [[{ n }]] = await conn.query(
      `SELECT COUNT(*) AS n FROM booking_items bi
       JOIN admission_units u ON u.unit_id = bi.unit_id
       JOIN event_ticket_types ett ON ett.event_ticket_type_id = u.event_ticket_type_id
       WHERE ett.event_id = ?`, [id]);
    if (n) throw new HttpError(409, 'This event has booking history, so it is kept (status Cancelled) rather than deleted.');
    await conn.query(
      `DELETE u FROM admission_units u JOIN event_ticket_types ett ON ett.event_ticket_type_id = u.event_ticket_type_id
       WHERE ett.event_id = ?`, [id]);
    await conn.query('DELETE FROM event_ticket_types WHERE event_id = ?', [id]);
    await conn.query('DELETE FROM seated_events WHERE event_id = ?', [id]);
    await conn.query('DELETE FROM non_seated_events WHERE event_id = ?', [id]);
    await conn.query('DELETE FROM events WHERE event_id = ?', [id]);
  });
  res.status(204).end();
});

module.exports = router;

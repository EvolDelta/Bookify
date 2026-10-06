// Events: browse (customer), create / open / close (organizer), remove (admin).
const express = require('express');
const v = require('../validate');
const { HttpError } = require('../errors');
const { pool, transaction } = require('../db');
const { expireStaleBookings } = require('../services/bookings');

const router = express.Router();

const AVAILABILITY = `
  SELECT e.event_id, e.event_name, e.event_date, e.venue_name, e.total_capacity, e.event_status,
         e.organizer_id, o.organizer_name,
         MIN(ett.price) AS price_from,
         COUNT(u.unit_id) AS units,
         COALESCE(SUM(u.unit_kind = 'Seated'), 0)   AS seated_units,
         COALESCE(SUM(u.unit_kind = 'Standing'), 0) AS standing_units,
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

// GET /api/events/:id — event, its ticket types and every unit's status.
// Each unit reports its kind plus the fields of its subtype: row_label and
// seat_number for a Seated unit, zone_name for a Standing one (BR16).
router.get('/:id', async (req, res) => {
  const id = v.id(req.params.id, 'id');
  await expireStaleBookings();
  const [[event]] = await pool.query(AVAILABILITY + ' WHERE e.event_id = ?' + AVAILABILITY_GROUP, [id]);
  if (!event) throw new HttpError(404, 'Event not found.');

  const [ticketTypes] = await pool.query(
    `SELECT ett.event_ticket_type_id, c.type_name, c.description, ett.price,
            COUNT(u.unit_id) AS units, COALESCE(SUM(u.unit_status = 'Available'), 0) AS available
     FROM event_ticket_types ett
     JOIN ticket_type_catalog c ON c.type_id = ett.type_id
     LEFT JOIN admission_units u ON u.event_ticket_type_id = ett.event_ticket_type_id
     WHERE ett.event_id = ?
     GROUP BY ett.event_ticket_type_id ORDER BY ett.price DESC`, [id]);

  const [units] = await pool.query(
    `SELECT u.unit_id, u.event_ticket_type_id, c.type_name, u.unit_kind,
            s.row_label, s.seat_number, st.zone_name, u.unit_status
     FROM admission_units u
     JOIN event_ticket_types ett ON ett.event_ticket_type_id = u.event_ticket_type_id
     JOIN ticket_type_catalog c  ON c.type_id = ett.type_id
     LEFT JOIN seated_units s    ON s.unit_id = u.unit_id
     LEFT JOIN standing_units st ON st.unit_id = u.unit_id
     WHERE ett.event_id = ?
     ORDER BY u.unit_kind, s.row_label, s.seat_number, st.zone_name, u.unit_id`, [id]);

  res.json({ ...event, ticket_types: ticketTypes, units });
});

// POST /api/events — an organizer creates a Draft event with its admission units.
// Each ticket type describes numbered seats, standing places, or both:
//   { ..., "ticket_types": [
//     { "type_name": "VIP",    "price": 1200, "rows": ["A"], "seats_per_row": 10 },
//     { "type_name": "Normal", "price": 300,  "rows": ["B", "C"], "seats_per_row": 10,
//       "zone_name": "Back Lawn", "quantity": 80 },
//     { "type_name": "Priority", "price": 500, "zone_name": "Front Pit", "quantity": 40 } ] }
// Seats become Seated_Units, standing places become Standing_Units (BR25), so an
// event may be all seated, all standing, or a mix.
router.post('/', async (req, res) => {
  const b = req.body;
  const e = {
    organizer_id: v.id(b.organizer_id, 'organizer_id'),
    event_name: v.text(b.event_name, 'event_name', { max: 150 }),
    event_date: v.dateTime(b.event_date, 'event_date'),
    venue_name: v.text(b.venue_name, 'venue_name', { max: 150 }),
    total_capacity: v.id(b.total_capacity, 'total_capacity')
  };
  const types = Array.isArray(b.ticket_types) ? b.ticket_types : [];
  if (!types.length) throw new HttpError(400, 'BR11: ticket_types needs at least one entry.');
  const typeNames = new Set();
  const seatLabels = new Set();

  // Turn each ticket type into the seats and standing places it should create.
  const plan = types.map((t, i) => {
    const typeName = v.oneOf(t.type_name, `ticket_types[${i}].type_name`, ['Normal', 'Priority', 'VIP']);
    if (typeNames.has(typeName)) throw new HttpError(400, `ticket_types contains duplicate type_name "${typeName}".`);
    typeNames.add(typeName);
    const price = v.money(t.price, `ticket_types[${i}].price`);
    const hasSeats = t.rows !== undefined || t.seats_per_row !== undefined;
    const hasStanding = t.zone_name !== undefined || t.quantity !== undefined;
    if (!hasSeats && !hasStanding) {
      throw new HttpError(400, `ticket_types[${i}] must describe seats (rows, seats_per_row), standing places (zone_name, quantity), or both.`);
    }

    const seats = [];
    if (hasSeats) {
      const rows = Array.isArray(t.rows) ? t.rows.map(r => v.text(r, `ticket_types[${i}].rows`, { max: 5 }).toUpperCase()) : [];
      const perRow = v.id(t.seats_per_row, `ticket_types[${i}].seats_per_row`);
      if (!rows.length) throw new HttpError(400, `ticket_types[${i}].rows must list row labels, e.g. ["A","B"].`);
      for (const r of rows) {
        if (seatLabels.has(r)) throw new HttpError(400, `BR16: row ${r} is listed more than once.`);
        seatLabels.add(r);
        for (let s = 1; s <= perRow; s++) seats.push([r, s]);
      }
    }
    const standing = hasStanding
      ? { zoneName: v.text(t.zone_name, `ticket_types[${i}].zone_name`, { max: 100 }),
          quantity: v.id(t.quantity, `ticket_types[${i}].quantity`) }
      : null;
    return { typeName, price, seats, standing };
  });
  const totalUnits = plan.reduce((t, p) => t + p.seats.length + (p.standing ? p.standing.quantity : 0), 0);
  if (totalUnits > e.total_capacity) {
    throw new HttpError(400, `BR22: ${totalUnits} units requested but total_capacity is ${e.total_capacity}.`);
  }

  const eventId = await transaction(async conn => {
    const [ins] = await conn.query('INSERT INTO events SET ?', [e]);    // trg_events_bi checks BR13
    const id = ins.insertId;
    for (const p of plan) {
      const [ett] = await conn.query(
        `INSERT INTO event_ticket_types (event_id, type_id, price)
         SELECT ?, type_id, ? FROM ticket_type_catalog WHERE type_name = ?`, [id, p.price, p.typeName]);
      const ettId = ett.insertId;

      // Supertype rows first, then one subtype row each (BR25). The ticket type
      // was created a moment ago in this transaction, so its units of a given
      // kind are exactly the ones just inserted, in unit_id order.
      if (p.seats.length) {
        await conn.query('INSERT INTO admission_units (event_ticket_type_id, unit_kind) VALUES ?',
          [p.seats.map(() => [ettId, 'Seated'])]);
        const [ids] = await conn.query(
          `SELECT unit_id FROM admission_units WHERE event_ticket_type_id = ? AND unit_kind = 'Seated' ORDER BY unit_id`, [ettId]);
        await conn.query('INSERT INTO seated_units (unit_id, row_label, seat_number) VALUES ?',
          [ids.map((r, k) => [r.unit_id, ...p.seats[k]])]);
      }
      if (p.standing) {
        await conn.query('INSERT INTO admission_units (event_ticket_type_id, unit_kind) VALUES ?',
          [Array.from({ length: p.standing.quantity }, () => [ettId, 'Standing'])]);
        await conn.query(
          `INSERT INTO standing_units (unit_id, zone_name)
           SELECT unit_id, ? FROM admission_units WHERE event_ticket_type_id = ? AND unit_kind = 'Standing'`,
          [p.standing.zoneName, ettId]);
      }
    }
    return id;
  });
  res.status(201).json({ event_id: eventId, event_status: 'Draft', units_created: totalUnits,
    next: `PATCH /api/events/${eventId}/status {"event_status":"On_sale"} to open it for booking` });
});

// PATCH /api/events/:id/status  { "event_status": "On_sale" | "Closed" | "Cancelled" }
// Opening for sale runs the BR11/BR25 checks in trg_events_bu.
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
    // Subtype rows before their admission units, which go before the ticket types.
    for (const subtype of ['seated_units', 'standing_units']) {
      await conn.query(
        `DELETE x FROM ${subtype} x
         JOIN admission_units u      ON u.unit_id = x.unit_id
         JOIN event_ticket_types ett ON ett.event_ticket_type_id = u.event_ticket_type_id
         WHERE ett.event_id = ?`, [id]);
    }
    await conn.query(
      `DELETE u FROM admission_units u JOIN event_ticket_types ett ON ett.event_ticket_type_id = u.event_ticket_type_id
       WHERE ett.event_id = ?`, [id]);
    await conn.query('DELETE FROM event_ticket_types WHERE event_id = ?', [id]);
    await conn.query('DELETE FROM events WHERE event_id = ?', [id]);
  });
  res.status(204).end();
});

module.exports = router;

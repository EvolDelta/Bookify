// Manager reports — the questions from the proposal's objectives and business
// problem. The same SQL, with comments, is in db/queries.sql.
const express = require('express');
const v = require('../validate');
const { pool } = require('../db');
const { expireStaleBookings } = require('../services/bookings');

const router = express.Router();

// O1: seats sold in the last 30 days, per day, plus every sale
router.get('/sales-last-30-days', async (req, res) => {
  const [daily] = await pool.query(
    `SELECT DATE_FORMAT(sold_at, '%Y-%m-%d') AS day, COUNT(*) AS tickets_sold, SUM(price_paid) AS gross
     FROM booking_items WHERE sold_at >= NOW() - INTERVAL 30 DAY
     GROUP BY day ORDER BY day`);
  const [sales] = await pool.query(
    `SELECT bi.sold_at, e.event_name, c.type_name, u.row_label, u.seat_number, bi.price_paid, us.full_name AS buyer
     FROM booking_items bi
     JOIN bookings b             ON b.booking_id = bi.booking_id
     JOIN users us               ON us.user_id = b.user_id
     JOIN admission_units u      ON u.unit_id = bi.unit_id
     JOIN event_ticket_types ett ON ett.event_ticket_type_id = u.event_ticket_type_id
     JOIN ticket_type_catalog c  ON c.type_id = ett.type_id
     JOIN events e               ON e.event_id = ett.event_id
     WHERE bi.sold_at >= NOW() - INTERVAL 30 DAY
     ORDER BY bi.sold_at DESC`);
  res.json({ daily, sales });
});

// O2: seat status per event and which events are full
router.get('/seat-status', async (req, res) => {
  await expireStaleBookings();
  const [rows] = await pool.query(
    `SELECT e.event_id, e.event_name, e.event_status, e.total_capacity,
            SUM(u.unit_status = 'Available') AS available,
            SUM(u.unit_status = 'Locked')    AS locked,
            SUM(u.unit_status = 'Sold')      AS sold,
            SUM(u.unit_status = 'Sold') = COUNT(*) AS is_full
     FROM events e
     JOIN event_ticket_types ett ON ett.event_id = e.event_id
     JOIN admission_units u      ON u.event_ticket_type_id = ett.event_ticket_type_id
     GROUP BY e.event_id ORDER BY e.event_date`);
  res.json(rows.map(r => ({ ...r, is_full: Boolean(r.is_full) })));
});

// O4: how many times each promotion was used
router.get('/promotion-usage', async (req, res) => {
  const [rows] = await pool.query(
    `SELECT p.coupon_code, p.discount_type, p.start_date, p.end_date,
            COUNT(b.booking_id) AS times_used,
            COALESCE(SUM(b.discount_amount_applied), 0) AS total_discount_given
     FROM promotions p
     LEFT JOIN bookings b ON b.promo_id = p.promo_id AND b.booking_status = 'Paid'
     GROUP BY p.promo_id ORDER BY times_used DESC`);
  res.json(rows);
});

// Business problem: unpaid reservations and how long they have been waiting
router.get('/pending-bookings', async (req, res) => {
  await expireStaleBookings();
  const [rows] = await pool.query(
    `SELECT b.booking_id, us.full_name, b.created_at, b.total_amount,
            TIMESTAMPDIFF(SECOND, b.created_at, NOW()) AS seconds_waiting,
            GREATEST(TIMESTAMPDIFF(SECOND, NOW(), b.lock_expires_at), 0) AS seconds_left
     FROM bookings b JOIN users us ON us.user_id = b.user_id
     WHERE b.booking_status = 'Pending' ORDER BY b.created_at`);
  res.json(rows);
});

// Business problem: how much an event has taken so far, split by payment method
router.get('/events/:id/revenue', async (req, res) => {
  const [rows] = await pool.query(
    `SELECT pay.payment_method, COUNT(DISTINCT pay.booking_id) AS bookings, SUM(pay.amount) AS collected
     FROM payments pay
     WHERE pay.payment_status = 'Successful'
       AND pay.booking_id IN (SELECT bi.booking_id
                              FROM booking_items bi
                              JOIN admission_units u      ON u.unit_id = bi.unit_id
                              JOIN event_ticket_types ett ON ett.event_ticket_type_id = u.event_ticket_type_id
                              WHERE ett.event_id = ?)
     GROUP BY pay.payment_method ORDER BY collected DESC`, [v.id(req.params.id, 'id')]);
  res.json({ by_method: rows, total: rows.reduce((t, r) => t + r.collected, 0) });
});

module.exports = router;

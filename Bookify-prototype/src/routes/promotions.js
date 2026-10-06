// Promotions: a supertype row plus exactly one subtype row (BR24).
const express = require('express');
const v = require('../validate');
const { HttpError } = require('../errors');
const { pool, transaction } = require('../db');
const { requireAdmin } = require('../auth');

const router = express.Router();

const LIST = `
  SELECT p.promo_id, p.coupon_code, p.discount_type, p.start_date, p.end_date,
         a.discount_amount, pc.discount_percent, pc.max_discount_cap,
         CURDATE() BETWEEN p.start_date AND p.end_date AS active_today,
         (SELECT COUNT(*) FROM bookings b WHERE b.promo_id = p.promo_id AND b.booking_status = 'Paid') AS times_used
  FROM promotions p
  LEFT JOIN amount_discounts a   ON a.promo_id = p.promo_id
  LEFT JOIN percent_discounts pc ON pc.promo_id = p.promo_id`;

// GET /api/promotions
router.get('/', async (req, res) => {
  const [rows] = await pool.query(LIST + ' ORDER BY p.start_date DESC');
  res.json(rows);
});

// POST /api/promotions
// Amount:  { "coupon_code": "EARLYBIRD", "discount_type": "Amount",  "discount_amount": 100,  "start_date": "...", "end_date": "..." }
// Percent: { "coupon_code": "SE20",      "discount_type": "Percent", "discount_percent": 20, "max_discount_cap": 300, ... }
router.post('/', requireAdmin, async (req, res) => {
  const b = req.body;
  const code = v.text(b.coupon_code, 'coupon_code', { max: 30 }).toUpperCase();
  if (!/^[A-Z0-9]+$/.test(code)) throw new HttpError(400, 'coupon_code may only contain letters and digits.');
  const type = v.oneOf(b.discount_type, 'discount_type', ['Amount', 'Percent']);
  const start = v.date(b.start_date, 'start_date');
  const end = v.date(b.end_date, 'end_date');

  const id = await transaction(async conn => {
    const [r] = await conn.query(
      'INSERT INTO promotions (coupon_code, discount_type, start_date, end_date) VALUES (?, ?, ?, ?)',
      [code, type, start, end]);
    if (type === 'Amount') {
      await conn.query('INSERT INTO amount_discounts (promo_id, discount_amount) VALUES (?, ?)',
        [r.insertId, v.money(b.discount_amount, 'discount_amount')]);
    } else {
      const pct = v.money(b.discount_percent, 'discount_percent');
      if (pct > 100) throw new HttpError(400, 'discount_percent cannot be above 100.');
      await conn.query('INSERT INTO percent_discounts (promo_id, discount_percent, max_discount_cap) VALUES (?, ?, ?)',
        [r.insertId, pct, v.money(b.max_discount_cap, 'max_discount_cap', { optional: true })]);
    }
    return r.insertId;
  });
  const [[row]] = await pool.query(LIST + ' WHERE p.promo_id = ?', [id]);
  res.status(201).json(row);
});

module.exports = router;

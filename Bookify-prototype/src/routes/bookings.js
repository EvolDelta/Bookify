// Customer booking flow: lock seats → pay → tickets, or cancel.
const express = require('express');
const v = require('../validate');
const { HttpError } = require('../errors');
const bookings = require('../services/bookings');

const router = express.Router();

// POST /api/bookings
// { "user_id": 1, "units": [{ "unit_id": 12 }, ...], "promo_code": "SE20" }
// Seats 3+ need { "attendee_name", "attendee_id_number" } (BR26).
router.post('/', async (req, res) => {
  const userId = v.id(req.body.user_id, 'user_id');
  const raw = Array.isArray(req.body.units) ? req.body.units : [];
  if (!raw.length) throw new HttpError(400, 'BR9: a booking needs at least one unit in "units".');
  const units = raw.map((u, i) => ({
    unit_id: v.id(u && u.unit_id, `units[${i}].unit_id`),
    attendee_name: v.text(u.attendee_name, `units[${i}].attendee_name`, { max: 100, optional: true }),
    attendee_id_number: v.text(u.attendee_id_number, `units[${i}].attendee_id_number`, { max: 20, optional: true })
  }));
  if (new Set(units.map(u => u.unit_id)).size !== units.length) throw new HttpError(400, 'The same unit_id is listed twice.');
  const identified = units.filter(u => u.attendee_name && u.attendee_id_number).length;
  if (units.length - identified > bookings.FREE_SEATS_WITHOUT_ID) {
    throw new HttpError(400, `BR26: for more than ${bookings.FREE_SEATS_WITHOUT_ID} tickets, every extra ticket needs attendee_name and attendee_id_number.`);
  }
  const promoCode = v.text(req.body.promo_code, 'promo_code', { max: 30, optional: true });

  const booking = await bookings.createBooking({ userId, units, promoCode: promoCode && promoCode.toUpperCase() });
  res.status(201).json(booking);
});

// GET /api/bookings/:id
router.get('/:id', async (req, res) => {
  await bookings.expireStaleBookings();
  res.json(await bookings.getBooking(v.id(req.params.id, 'id')));
});

// POST /api/bookings/:id/payments
// { "payment_method": "PromptPay", "amount": 2100, "payment_status": "Successful" }
// Sample data only — nothing is charged (no payment gateway, per the scope).
router.post('/:id/payments', async (req, res) => {
  const booking = await bookings.payBooking(v.id(req.params.id, 'id'), {
    paymentMethod: v.oneOf(req.body.payment_method, 'payment_method', ['Bank transfer', 'PromptPay', 'Cash']),
    amount: v.money(req.body.amount, 'amount'),
    paymentStatus: v.oneOf(req.body.payment_status, 'payment_status', ['Pending', 'Successful', 'Failed'], 'Successful')
  });
  res.status(201).json(booking);
});

// POST /api/bookings/:id/cancel   { "user_id": 1 }
router.post('/:id/cancel', async (req, res) => {
  res.json(await bookings.cancelBooking(v.id(req.params.id, 'id'), v.id(req.body.user_id, 'user_id')));
});

module.exports = router;

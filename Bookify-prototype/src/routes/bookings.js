// Customer booking flow: lock seats → pay → tickets, or cancel.
const express = require('express');
const v = require('../validate');
const { HttpError } = require('../errors');
const bookings = require('../services/bookings');
const { requireUser, assertSelfOrAdmin } = require('../auth');

const router = express.Router();
router.use(requireUser); // every booking route needs a logged-in user

// POST /api/bookings — books for the logged-in user
// { "units": [{ "unit_id": 12 }, ...], "promo_code": "SE20" }
// Seats 3+ need { "attendee_name", "identity_number" } (BR24).
router.post('/', async (req, res) => {
  const raw = Array.isArray(req.body.units) ? req.body.units : [];
  if (!raw.length) throw new HttpError(400, 'BR9: a booking needs at least one unit in "units".');
  const units = raw.map((u, i) => ({
    unit_id: v.id(u && u.unit_id, `units[${i}].unit_id`),
    attendee_name: v.text(u.attendee_name, `units[${i}].attendee_name`, { max: 100, optional: true }),
    identity_number: v.text(u.identity_number, `units[${i}].identity_number`, { max: 20, optional: true })
  }));
  if (new Set(units.map(u => u.unit_id)).size !== units.length) throw new HttpError(400, 'The same unit_id is listed twice.');
  const identified = units.filter(u => u.attendee_name && u.identity_number).length;
  if (units.length - identified > bookings.FREE_SEATS_WITHOUT_ID) {
    throw new HttpError(400, `BR24: for more than ${bookings.FREE_SEATS_WITHOUT_ID} tickets, every extra ticket needs attendee_name and identity_number.`);
  }
  const promoCode = v.text(req.body.promo_code, 'promo_code', { max: 30, optional: true });

  const booking = await bookings.createBooking({ userId: req.user.user_id, units, promoCode: promoCode && promoCode.toUpperCase() });
  res.status(201).json(booking);
});

// GET /api/bookings/:id — your own booking (admins can see any)
router.get('/:id', async (req, res) => {
  await bookings.expireStaleBookings();
  const booking = await bookings.getBooking(v.id(req.params.id, 'id'));
  assertSelfOrAdmin(req, booking.user_id);
  res.json(booking);
});

// POST /api/bookings/:id/payments
// { "payment_method": "PromptPay", "amount": 2100, "payment_status": "Successful" }
// Sample data only — nothing is charged (no payment gateway, per the scope).
router.post('/:id/payments', async (req, res) => {
  const id = v.id(req.params.id, 'id');
  assertSelfOrAdmin(req, (await bookings.getBooking(id)).user_id);
  const booking = await bookings.payBooking(id, {
    paymentMethod: v.oneOf(req.body.payment_method, 'payment_method', ['Bank transfer', 'PromptPay', 'Cash']),
    amount: v.money(req.body.amount, 'amount'),
    paymentStatus: v.oneOf(req.body.payment_status, 'payment_status', ['Pending', 'Successful', 'Failed'], 'Successful')
  });
  res.status(201).json(booking);
});

// POST /api/bookings/:id/cancel — cancel your own unpaid booking
router.post('/:id/cancel', async (req, res) => {
  res.json(await bookings.cancelBooking(v.id(req.params.id, 'id'), req.user.user_id));
});

module.exports = router;

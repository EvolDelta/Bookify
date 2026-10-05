// Booking lifecycle: lock seats → pay → sold + tickets, or expire / cancel.
// These are the rules that span several tables in one go (BR9, BR17–BR19), so
// each runs inside a single transaction: either every step happens or none does.
const crypto = require('crypto');
const { pool, transaction } = require('../db');
const { HttpError } = require('../errors');

const HOLD_MINUTES = 5;        // BR17 — schema.sql's ck_bookings_lock uses the same 5
const FREE_SEATS_WITHOUT_ID = 2; // BR26

// BR18: unpaid bookings past lock_expires_at become Expired and give their
// seats back. This runs at the start of every request that reads or changes
// seat status, instead of on a timer — a serverless host such as Vercel runs
// no code between requests, so a timer would never fire there.
async function expireStaleBookings() {
  await transaction(async conn => {
    // Lock bookings before units, the same order payBooking uses, so the two
    // cannot deadlock each other.
    const [rows] = await conn.query(
      `SELECT booking_id FROM bookings
       WHERE booking_status = 'Pending' AND lock_expires_at <= NOW() FOR UPDATE`);
    if (rows.length) await expire(conn, rows.map(r => r.booking_id));
  });
}

async function expire(conn, bookingIds) {
  await conn.query(
    `UPDATE admission_units u JOIN booking_items bi ON bi.unit_id = u.unit_id
     SET u.unit_status = 'Available'
     WHERE bi.booking_id IN (?) AND u.unit_status = 'Locked'`, [bookingIds]);
  await conn.query(`UPDATE bookings SET booking_status = 'Expired' WHERE booking_id IN (?)`, [bookingIds]);
}

// Price of a promotion for a given subtotal (BR24 subtypes).
function discountFor(promo, subtotal) {
  if (!promo) return 0;
  const raw = promo.discount_type === 'Amount'
    ? promo.discount_amount
    : subtotal * promo.discount_percent / 100;
  const capped = promo.max_discount_cap != null ? Math.min(raw, promo.max_discount_cap) : raw;
  return Math.round(Math.min(capped, subtotal) * 100) / 100;
}

/**
 * Lock seats for a user for HOLD_MINUTES (BR17).
 * units: [{ unit_id, attendee_name?, attendee_id_number? }]
 */
async function createBooking({ userId, units, promoCode }) {
  await expireStaleBookings();

  return transaction(async conn => {
    const unitIds = units.map(u => u.unit_id);

    // FOR UPDATE OF u locks only the seat rows. A second buyer asking for the
    // same seat waits here until this transaction ends, then sees it Locked —
    // that wait is what makes double booking impossible.
    const [rows] = await conn.query(
      `SELECT u.unit_id, u.unit_status, u.row_label, u.seat_number, ett.price,
              e.event_id, e.event_status, e.event_date > NOW() AS upcoming
       FROM admission_units u
       JOIN event_ticket_types ett ON ett.event_ticket_type_id = u.event_ticket_type_id
       JOIN events e ON e.event_id = ett.event_id
       WHERE u.unit_id IN (?)
       ORDER BY u.unit_id
       FOR UPDATE OF u`, [unitIds]);

    if (rows.length !== unitIds.length) throw new HttpError(404, 'One or more unit_id values do not exist.');
    if (new Set(rows.map(r => r.event_id)).size > 1) throw new HttpError(400, 'All seats in one booking must be for the same event.');
    const ev = rows[0];
    if (ev.event_status !== 'On_sale') throw new HttpError(409, `This event is not on sale (status: ${ev.event_status}).`);
    if (!ev.upcoming) throw new HttpError(409, 'BR25: this event has already taken place.');
    const taken = rows.filter(r => r.unit_status !== 'Available');
    if (taken.length) {
      throw new HttpError(409, `Already taken: ${taken.map(r => r.row_label ? r.row_label + r.seat_number : '#' + r.unit_id).join(', ')}.`);
    }

    let promo = null;
    if (promoCode) {
      const [promos] = await conn.query(
        `SELECT p.promo_id, p.discount_type, a.discount_amount, pc.discount_percent, pc.max_discount_cap
         FROM promotions p
         LEFT JOIN amount_discounts a   ON a.promo_id = p.promo_id
         LEFT JOIN percent_discounts pc ON pc.promo_id = p.promo_id
         WHERE p.coupon_code = ? AND CURDATE() BETWEEN p.start_date AND p.end_date`, [promoCode]);
      if (!promos.length) throw new HttpError(400, `Promotion ${promoCode} does not exist or is not valid today.`);
      promo = promos[0];
    }

    const priceOf = new Map(rows.map(r => [r.unit_id, r.price]));
    const subtotal = rows.reduce((t, r) => t + r.price, 0);
    const discount = discountFor(promo, subtotal);
    const total = Math.round((subtotal - discount) * 100) / 100;

    // NOW() is fixed for the whole statement, so both columns get the same base time.
    const [res] = await conn.query(
      `INSERT INTO bookings (user_id, promo_id, created_at, lock_expires_at, total_amount, discount_amount_applied)
       VALUES (?, ?, NOW(), NOW() + INTERVAL ${HOLD_MINUTES} MINUTE, ?, ?)`,
      [userId, promo ? promo.promo_id : null, total, discount]);
    const bookingId = res.insertId;

    // Units without attendee details first, so the ones that carry them are the
    // 3rd+ items that BR26 (trg_booking_items_bi) asks about.
    const ordered = [...units].sort((a, b) => Boolean(a.attendee_name) - Boolean(b.attendee_name));
    for (const u of ordered) {
      await conn.query(
        `INSERT INTO booking_items (booking_id, unit_id, price_paid, attendee_name, attendee_id_number)
         VALUES (?, ?, ?, ?, ?)`,
        [bookingId, u.unit_id, priceOf.get(u.unit_id), u.attendee_name || null, u.attendee_id_number || null]);
    }

    await conn.query(`UPDATE admission_units SET unit_status = 'Locked' WHERE unit_id IN (?)`, [unitIds]);
    return getBooking(bookingId, conn);
  });
}

/** Record a (sample) payment; once successful payments cover the total, the booking is Paid (BR19). */
async function payBooking(bookingId, { paymentMethod, amount, paymentStatus }) {
  return transaction(async conn => {
    const [[b]] = await conn.query(
      `SELECT booking_status, total_amount, lock_expires_at > NOW() AS still_locked
       FROM bookings WHERE booking_id = ? FOR UPDATE`, [bookingId]);
    if (!b) throw new HttpError(404, 'Booking not found.');
    if (b.booking_status !== 'Pending') throw new HttpError(409, `Booking is already ${b.booking_status}.`);
    if (!b.still_locked) {
      // Too late: expire it now and keep that change (no throw → commit).
      await expire(conn, [bookingId]);
      return { expired: true };
    }

    await conn.query(
      `INSERT INTO payments (booking_id, payment_method, amount, payment_status) VALUES (?, ?, ?, ?)`,
      [bookingId, paymentMethod, amount, paymentStatus]);

    const [[{ paid }]] = await conn.query(
      `SELECT COALESCE(SUM(amount), 0) AS paid FROM payments
       WHERE booking_id = ? AND payment_status = 'Successful'`, [bookingId]);

    if (paid >= b.total_amount) {
      await conn.query(`UPDATE bookings SET booking_status = 'Paid' WHERE booking_id = ?`, [bookingId]);
      // sold_at filled → uq_items_sold_once (BR20) guarantees no unit is ever sold twice.
      await conn.query(`UPDATE booking_items SET sold_at = NOW() WHERE booking_id = ?`, [bookingId]);
      await conn.query(
        `UPDATE admission_units u JOIN booking_items bi ON bi.unit_id = u.unit_id
         SET u.unit_status = 'Sold' WHERE bi.booking_id = ?`, [bookingId]);
      const [items] = await conn.query(`SELECT booking_item_id FROM booking_items WHERE booking_id = ?`, [bookingId]);
      for (const it of items) {
        const code = 'BKF-' + crypto.randomBytes(4).toString('hex').toUpperCase();
        await conn.query(`INSERT INTO tickets (booking_item_id, ticket_code) VALUES (?, ?)`, [it.booking_item_id, code]);
      }
    }
    return { expired: false, booking: await getBooking(bookingId, conn) };
  }).then(r => {
    if (r.expired) throw new HttpError(409, `The ${HOLD_MINUTES}-minute hold has expired; the seats were released.`);
    return r.booking;
  });
}

/** A customer cancels their own unpaid booking. Paid bookings would need a refund, which is out of scope. */
async function cancelBooking(bookingId, userId) {
  return transaction(async conn => {
    const [[b]] = await conn.query(`SELECT user_id, booking_status FROM bookings WHERE booking_id = ? FOR UPDATE`, [bookingId]);
    if (!b) throw new HttpError(404, 'Booking not found.');
    if (b.user_id !== userId) throw new HttpError(403, 'This booking belongs to another user.');
    if (b.booking_status === 'Paid') throw new HttpError(409, 'Paid bookings cannot be cancelled here (refunds are out of scope).');
    if (b.booking_status !== 'Pending') throw new HttpError(409, `Booking is already ${b.booking_status}.`);
    await conn.query(
      `UPDATE admission_units u JOIN booking_items bi ON bi.unit_id = u.unit_id
       SET u.unit_status = 'Available'
       WHERE bi.booking_id = ? AND u.unit_status = 'Locked'`, [bookingId]);
    await conn.query(`UPDATE bookings SET booking_status = 'Cancelled' WHERE booking_id = ?`, [bookingId]);
    return getBooking(bookingId, conn);
  });
}

async function getBooking(bookingId, conn = pool) {
  const [[booking]] = await conn.query(
    `SELECT b.booking_id, b.user_id, b.booking_status, b.created_at, b.lock_expires_at,
            GREATEST(TIMESTAMPDIFF(SECOND, NOW(), b.lock_expires_at), 0) AS seconds_left,
            b.total_amount, b.discount_amount_applied, p.coupon_code
     FROM bookings b LEFT JOIN promotions p ON p.promo_id = b.promo_id
     WHERE b.booking_id = ?`, [bookingId]);
  if (!booking) throw new HttpError(404, 'Booking not found.');
  if (booking.booking_status !== 'Pending') booking.seconds_left = 0;

  const [items] = await conn.query(
    `SELECT bi.booking_item_id, bi.unit_id, e.event_id, e.event_name, e.event_date, c.type_name,
            u.row_label, u.seat_number, bi.price_paid, bi.sold_at, bi.attendee_name, t.ticket_code
     FROM booking_items bi
     JOIN admission_units u      ON u.unit_id = bi.unit_id
     JOIN event_ticket_types ett ON ett.event_ticket_type_id = u.event_ticket_type_id
     JOIN ticket_type_catalog c  ON c.type_id = ett.type_id
     JOIN events e               ON e.event_id = ett.event_id
     LEFT JOIN tickets t         ON t.booking_item_id = bi.booking_item_id
     WHERE bi.booking_id = ? ORDER BY bi.booking_item_id`, [bookingId]);

  const [payments] = await conn.query(
    `SELECT payment_id, payment_method, amount, paid_at, payment_status
     FROM payments WHERE booking_id = ? ORDER BY payment_id`, [bookingId]);

  return { ...booking, items, payments };
}

module.exports = { HOLD_MINUTES, FREE_SEATS_WITHOUT_ID, expireStaleBookings, createBooking, payBooking, cancelBooking, getBooking };

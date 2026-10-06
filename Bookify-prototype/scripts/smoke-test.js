// End-to-end check of the API and the database rules.
//   npm run db:setup && npm run test:api
// Starts the app in-process on a spare port, runs real HTTP requests against
// it, and also pokes the database directly to prove the constraints and
// triggers refuse bad data even when the API is bypassed.
// Needs a freshly seeded database (it books seats and changes data).
const assert = require('assert/strict');
const app = require('../server');
const { pool } = require('../src/db');

let base;
let passed = 0;

// A pretend browser: remembers its own login cookie between requests.
function client() {
  let cookie = null;
  return {
    get cookie() { return cookie; },
    async call(method, path, body) {
      const headers = {};
      if (body) headers['content-type'] = 'application/json';
      if (cookie) headers.cookie = cookie;
      const res = await fetch(base + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
      const set = res.headers.get('set-cookie');
      if (set) cookie = /Max-Age=0/.test(set) ? null : set.split(';')[0];
      const text = await res.text();
      return { status: res.status, body: text ? JSON.parse(text) : null };
    }
  };
}
const guest = client(), alice = client(), bob = client(), cara = client(), admin = client();

async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    console.log(`  ✗ ${name}\n    ${err.message}`);
    process.exitCode = 1;
  }
}

// Expect a raw SQL statement to be rejected with a message matching `pattern`.
async function rejects(sql, params, pattern) {
  await assert.rejects(pool.query(sql, params), err => {
    assert.match(err.sqlMessage || err.message, pattern);
    return true;
  });
}

async function main() {
  const server = app.listen(0);
  base = `http://localhost:${server.address().port}/api`;
  console.log(`Testing ${base}\n`);

  console.log('Browsing');
  await check('health check reaches MySQL', async () => {
    const r = await guest.call('GET', '/health');
    assert.equal(r.status, 200);
  });
  await check('lists on-sale events with seat counts; Hamlet is full', async () => {
    const r = await guest.call('GET', '/events');
    assert.equal(r.body.length, 3);
    assert.equal(r.body.find(e => e.event_name === 'Hamlet Reloaded').is_full, true);
  });
  await check('event detail has subtype fields, ticket types and units', async () => {
    const r = await admin.call('GET', '/events/1');
    assert.equal(r.body.seat_map_name, 'Main Hall A–E');
    assert.equal(r.body.standing_zone, null);
    assert.equal(r.body.ticket_types.length, 3);
    assert.equal(r.body.units.length, 50);
  });

  console.log('\nAccounts and login');
  // Throwaway test accounts; the password is only used by this script.
  const PASSWORD = 'test-password-123';
  const people = [[alice, 'Alice Test'], [bob, 'Bob Test'], [cara, 'Cara Test'], [admin, 'Admin Test']];
  await check('registering logs you in as a Customer', async () => {
    for (const [c, name] of people) {
      const email = name.split(' ')[0].toLowerCase() + '@test.example.com';
      const r = await c.call('POST', '/auth/register', { full_name: name, email, password: PASSWORD });
      assert.equal(r.status, 201, JSON.stringify(r.body));
      assert.equal(r.body.role, 'Customer');
      c.id = r.body.user_id;
      c.email = email;
    }
    assert.equal((await alice.call('GET', '/auth/me')).body.email, 'alice@test.example.com');
  });
  await check('passwords shorter than 8 characters are refused', async () => {
    const r = await guest.call('POST', '/auth/register', { full_name: 'Short', email: 'short@test.example.com', password: 'abc' });
    assert.equal(r.status, 400);
  });
  await check('an email can only register once', async () => {
    const r = await guest.call('POST', '/auth/register', { full_name: 'Again', email: 'ALICE@test.example.com', password: PASSWORD });
    assert.equal(r.status, 409);
  });
  await check('the database stores a salted hash, never the password', async () => {
    const [[a]] = await pool.query('SELECT password_hash FROM users WHERE user_id = ?', [alice.id]);
    const [[b]] = await pool.query('SELECT password_hash FROM users WHERE user_id = ?', [bob.id]);
    assert.match(a.password_hash, /^scrypt\$/);
    assert.ok(!a.password_hash.includes(PASSWORD));
    assert.notEqual(a.password_hash, b.password_hash, 'same password must give different hashes');
  });
  await check('the sessions table stores a hash of the cookie token, not the token', async () => {
    const token = decodeURIComponent(alice.cookie.split('=')[1]);
    const [[{ n }]] = await pool.query('SELECT COUNT(*) AS n FROM sessions WHERE token_hash = ?', [token]);
    assert.equal(n, 0);
    const [[{ m }]] = await pool.query('SELECT COUNT(*) AS m FROM sessions WHERE user_id = ?', [alice.id]);
    assert.equal(m, 1);
  });
  await check('wrong password and unknown email get the same answer', async () => {
    const a = await guest.call('POST', '/auth/login', { email: 'alice@test.example.com', password: 'wrong-password' });
    const b = await guest.call('POST', '/auth/login', { email: 'nobody@test.example.com', password: PASSWORD });
    assert.equal(a.status, 401);
    assert.equal(b.status, 401);
    assert.equal(a.body.error, b.body.error);
  });
  await check('log out, then log back in with the right password', async () => {
    assert.equal((await cara.call('POST', '/auth/logout')).status, 204);
    assert.equal((await cara.call('GET', '/auth/me')).body, null);
    const r = await cara.call('POST', '/auth/login', { email: cara.email, password: PASSWORD });
    assert.equal(r.status, 200);
    assert.equal((await cara.call('GET', '/auth/me')).body.user_id, cara.id);
  });
  await check('a guest cannot book', async () => {
    assert.equal((await guest.call('POST', '/bookings', { units: [{ unit_id: 20 }] })).status, 401);
  });
  await check('a customer cannot host an event, create promotions or see reports', async () => {
    const ev = await alice.call('POST', '/events', { organizer_id: 1, event_name: 'Sneaky', event_date: '2030-01-01 20:00',
      venue_name: 'X', event_kind: 'Non_Seated', total_capacity: 5, zone_name: 'X', ticket_types: [{ type_name: 'Normal', price: 1, quantity: 5 }] });
    assert.equal(ev.status, 403);
    assert.equal((await alice.call('PATCH', '/events/4/status', { event_status: 'Cancelled' })).status, 403);
    assert.equal((await alice.call('POST', '/promotions', { coupon_code: 'FREE', discount_type: 'Percent', discount_percent: 100, start_date: '2026-01-01', end_date: '2030-01-01' })).status, 403);
    assert.equal((await alice.call('GET', '/reports/seat-status')).status, 403);
    assert.equal((await alice.call('GET', '/organizers')).status, 403);
    assert.equal((await guest.call('GET', '/reports/seat-status')).status, 401);
  });
  await check('npm run make-admin promotes an account to Admin', async () => {
    const { execFileSync } = require('child_process');
    const out = execFileSync(process.execPath, [require('path').join(__dirname, 'make-admin.js'), admin.email], { env: process.env }).toString();
    assert.match(out, /is now an Admin/);
    assert.equal((await admin.call('GET', '/auth/me')).body.role, 'Admin');
  });

  console.log('\nBooking');
  let bookingId;
  await check('two buyers race for the same seat: exactly one wins (no double booking)', async () => {
    const [a, b] = await Promise.all([
      alice.call('POST', '/bookings', { units: [{ unit_id: 3 }] }),
      bob.call('POST', '/bookings', { units: [{ unit_id: 3 }] })
    ]);
    assert.deepEqual([a.status, b.status].sort(), [201, 409]);
    bookingId = (a.status === 201 ? a : b).body.booking_id;
  });
  await check('a new booking is Pending with a 5-minute lock (BR17)', async () => {
    const r = await admin.call('GET', `/bookings/${bookingId}`);
    assert.equal(r.body.booking_status, 'Pending');
    assert.ok(r.body.seconds_left > 290 && r.body.seconds_left <= 300, `seconds_left = ${r.body.seconds_left}`);
  });
  await check('locked seat shows as Locked in the event', async () => {
    const r = await admin.call('GET', '/events/1');
    assert.equal(r.body.units.find(u => u.unit_id === 3).unit_status, 'Locked');
  });
  await check('a partial payment leaves the booking Pending (BR19)', async () => {
    assert.equal((await cara.call('GET', `/bookings/${bookingId}`)).status, 403);  // someone else's booking
    const r = await admin.call('POST', `/bookings/${bookingId}/payments`, { payment_method: 'PromptPay', amount: 200 });
    assert.equal(r.body.booking_status, 'Pending');
  });
  await check('a failed payment does not count (BR19)', async () => {
    const r = await admin.call('POST', `/bookings/${bookingId}/payments`, { payment_method: 'PromptPay', amount: 1000, payment_status: 'Failed' });
    assert.equal(r.body.booking_status, 'Pending');
  });
  await check('paying the rest makes it Paid, sells the seat and issues a ticket', async () => {
    const r = await admin.call('POST', `/bookings/${bookingId}/payments`, { payment_method: 'Cash', amount: 1000 });
    assert.equal(r.body.booking_status, 'Paid');
    assert.match(r.body.items[0].ticket_code, /^BKF-[0-9A-F]{8}$/);
    const ev = await admin.call('GET', '/events/1');
    assert.equal(ev.body.units.find(u => u.unit_id === 3).unit_status, 'Sold');
  });
  await check('cannot pay a booking twice', async () => {
    const r = await admin.call('POST', `/bookings/${bookingId}/payments`, { payment_method: 'Cash', amount: 10 });
    assert.equal(r.status, 409);
  });

  await check('percent promotion is capped (SE20: 20% of 2400 = 480 → cap 300)', async () => {
    const r = await cara.call('POST', '/bookings', { units: [{ unit_id: 4 }, { unit_id: 5 }], promo_code: 'se20' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.discount_amount_applied, 300);
    assert.equal(r.body.total_amount, 2100);
    assert.equal(r.body.coupon_code, 'SE20');
  });
  await check('expired promotion is refused (BR22)', async () => {
    const r = await cara.call('POST', '/bookings', { units: [{ unit_id: 6 }], promo_code: 'OLDPROMO' });
    assert.equal(r.status, 400);
  });
  await check('3 tickets without attendee details are refused (BR26)', async () => {
    const r = await bob.call('POST', '/bookings', { units: [{ unit_id: 60 }, { unit_id: 61 }, { unit_id: 62 }] });
    assert.equal(r.status, 400);
  });
  await check('3 tickets with attendee details for the 3rd are accepted (BR26)', async () => {
    const r = await bob.call('POST', '/bookings', { units: [
      { unit_id: 60 }, { unit_id: 61 }, { unit_id: 62, attendee_name: 'Nok', attendee_id_number: '1100700000099' }] });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.items.length, 3);
  });
  await check('seats from two different events cannot share a booking', async () => {
    const r = await alice.call('POST', '/bookings', { units: [{ unit_id: 7 }, { unit_id: 70 }] });
    assert.equal(r.status, 400);
  });
  await check('a sold-out event refuses bookings', async () => {
    const r = await alice.call('POST', '/bookings', { units: [{ unit_id: 151 }] });
    assert.equal(r.status, 409);
  });

  await check('an unpaid booking expires after 5 minutes and releases its seat (BR18)', async () => {
    const r = await bob.call('POST', '/bookings', { units: [{ unit_id: 8 }] });
    assert.equal(r.status, 201);
    // pretend 6 minutes have passed
    await pool.query(
      `UPDATE bookings SET created_at = created_at - INTERVAL 6 MINUTE, lock_expires_at = lock_expires_at - INTERVAL 6 MINUTE
       WHERE booking_id = ?`, [r.body.booking_id]);
    const pay = await admin.call('POST', `/bookings/${r.body.booking_id}/payments`, { payment_method: 'Cash', amount: 1200 });
    assert.equal(pay.status, 409);
    const b = await admin.call('GET', `/bookings/${r.body.booking_id}`);
    assert.equal(b.body.booking_status, 'Expired');
    const ev = await admin.call('GET', '/events/1');
    assert.equal(ev.body.units.find(u => u.unit_id === 8).unit_status, 'Available');
  });
  await check('a customer can cancel their own pending booking, not someone else\'s', async () => {
    const r = await bob.call('POST', '/bookings', { units: [{ unit_id: 9 }] });
    assert.equal((await alice.call('POST', `/bookings/${r.body.booking_id}/cancel`)).status, 403);
    const c = await bob.call('POST', `/bookings/${r.body.booking_id}/cancel`);
    assert.equal(c.body.booking_status, 'Cancelled');
  });

  console.log('\nOrganizers and events');
  await check('an unverified organizer cannot create an event (BR13)', async () => {
    const r = await admin.call('POST', '/events', {
      organizer_id: 3, event_name: 'Pop-up gig', event_date: '2030-01-10 20:00', venue_name: 'Yard',
      event_kind: 'Non_Seated', total_capacity: 50, zone_name: 'Yard', ticket_types: [{ type_name: 'Normal', price: 100, quantity: 50 }] });
    assert.equal(r.status, 409);
    assert.match(r.body.error, /BR13/);
  });
  let newEvent;
  await check('organizer can create a seated event with an optional standing zone, then open it', async () => {
    await admin.call('PATCH', '/organizers/3/verification', { verification_status: 'Verified' });
    const r = await admin.call('POST', '/events', {
      organizer_id: 3, event_name: 'Acoustic Night', event_date: '2030-01-10 20:00', venue_name: 'Hall 2',
      event_kind: 'Seated', total_capacity: 30, seat_map_name: 'Hall 2',
      ticket_types: [{ type_name: 'VIP', price: 800, rows: ['A'], seats_per_row: 5 },
                     { type_name: 'Normal', price: 300, rows: ['B', 'C'], seats_per_row: 10,
                       standing_zone: 'Lawn', quantity: 5 }] });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.units_created, 30);
    newEvent = r.body.event_id;
    const open = await call('PATCH', `/events/${newEvent}/status`, { event_status: 'On_sale' });
    assert.equal(open.status, 200);
  });
  await check('standing zones cannot be attached to units from another event', async () => {
    const [[{ standing_zone_id: zoneId }]] = await pool.query(
      'SELECT standing_zone_id FROM standing_zones WHERE event_id = ?', [newEvent]);
    await rejects(
      'INSERT INTO admission_units (event_ticket_type_id, standing_zone_id) VALUES (1, ?)',
      [zoneId], /BR16: standing zone must belong to the unit event/);
  });
  await check('more units than total_capacity is refused (BR22)', async () => {
    const r = await admin.call('POST', '/events', {
      organizer_id: 1, event_name: 'Too big', event_date: '2030-01-10 20:00', venue_name: 'X',
      event_kind: 'Non_Seated', total_capacity: 10, zone_name: 'X', ticket_types: [{ type_name: 'Normal', price: 100, quantity: 11 }] });
    assert.equal(r.status, 400);
  });
  await check('an event without ticket types cannot go on sale (BR11)', async () => {
    const r = await admin.call('PATCH', '/events/4/status', { event_status: 'On_sale' });
    assert.equal(r.status, 409);
    assert.match(r.body.error, /BR11/);
  });
  await check('admin removes a cancelled event with no bookings; keeps one with bookings', async () => {
    assert.equal((await admin.call('DELETE', `/events/${newEvent}`)).status, 409);  // not cancelled yet
    await admin.call('PATCH', `/events/${newEvent}/status`, { event_status: 'Cancelled' });
    assert.equal((await admin.call('DELETE', `/events/${newEvent}`)).status, 204);
    await admin.call('PATCH', '/events/3/status', { event_status: 'Cancelled' });
    assert.equal((await admin.call('DELETE', '/events/3')).status, 409);
    await admin.call('PATCH', '/events/3/status', { event_status: 'On_sale' });
  });
  await check('creates an Amount and a Percent promotion (BR24 subtypes)', async () => {
    const a = await admin.call('POST', '/promotions', { coupon_code: 'flat50', discount_type: 'Amount', discount_amount: 50, start_date: '2026-01-01', end_date: '2030-12-31' });
    const p = await admin.call('POST', '/promotions', { coupon_code: 'HALF', discount_type: 'Percent', discount_percent: 50, start_date: '2026-01-01', end_date: '2030-12-31' });
    assert.equal(a.status, 201);
    assert.equal(a.body.coupon_code, 'FLAT50');
    assert.equal(p.body.discount_percent, 50);
    assert.equal((await admin.call('POST', '/promotions', { coupon_code: 'HALF', discount_type: 'Amount', discount_amount: 5, start_date: '2026-01-01', end_date: '2030-12-31' })).status, 409);
  });
  await check('duplicate user email is refused (BR15)', async () => {
    const r = await admin.call('POST', '/users', { full_name: 'Copy', email: 'SOMCHAI@student.example.ac.th' });
    assert.equal(r.status, 409);
  });

  console.log('\nReports');
  await check('sales in the last 30 days (O1)', async () => {
    const r = await admin.call('GET', '/reports/sales-last-30-days');
    assert.ok(r.body.sales.length >= 12);
  });
  await check('seat status / full events (O2)', async () => {
    const r = await admin.call('GET', '/reports/seat-status');
    assert.equal(r.body.find(e => e.event_id === 3).is_full, true);
  });
  await check('promotion usage (O4)', async () => {
    const r = await admin.call('GET', '/reports/promotion-usage');
    assert.equal(r.body.find(p => p.coupon_code === 'EARLYBIRD').times_used, 1);
  });
  await check('revenue by payment method for an event', async () => {
    const r = await admin.call('GET', '/reports/events/3/revenue');
    assert.equal(r.body.total, 1400);
  });
  await check('user\'s reservation list (O3)', async () => {
    const r = await bob.call('GET', `/users/${bob.id}/bookings`);
    assert.ok(r.body.length >= 3);
    assert.equal((await bob.call('GET', '/users/1/bookings')).status, 403);  // not his
  });

  console.log('\nDatabase rules hold even when the API is bypassed');
  await check('BR20: a unit cannot be sold twice', () => rejects(
    `INSERT INTO booking_items (booking_id, unit_id, price_paid, sold_at) VALUES (6, 1, 1200, NOW())`, [], /Duplicate entry/));  // unit 1 was sold in booking 1
  await check('BR12: no ticket for an unpaid booking item', () => rejects(
    `INSERT INTO tickets (booking_item_id, ticket_code) VALUES (12, 'BKF-HACK')`, [], /BR12/));
  await check('BR23: a seated event cannot also get a non-seated row', () => rejects(
    `INSERT INTO non_seated_events (event_id, zone_name) VALUES (1, 'Lawn')`, [], /foreign key/i));
  await check('BR16: a seated unit needs a row and seat', () => rejects(
    `INSERT INTO admission_units (event_ticket_type_id) VALUES (1)`, [], /BR16/));
  await check('BR16: a seat number cannot repeat within an event', () => rejects(
    `INSERT INTO admission_units (event_ticket_type_id, row_label, seat_number) VALUES (1, 'A', 1)`, [], /BR16/));
  await check('BR14: status values outside the allowed set are refused', () => rejects(
    `UPDATE bookings SET booking_status = 'Refunded' WHERE booking_id = 1`, [], /Data truncated|incorrect/i));
  await check('BR17: lock_expires_at must be created_at + 5 minutes', () => rejects(
    `INSERT INTO bookings (user_id, created_at, lock_expires_at, total_amount) VALUES (1, NOW(), NOW() + INTERVAL 1 HOUR, 100)`, [], /ck_bookings_lock/));
  await check('BR21: ticket price must be above zero', () => rejects(
    `UPDATE event_ticket_types SET price = 0 WHERE event_ticket_type_id = 1`, [], /ck_ett_price/));
  await check('BR25: an event cannot be dated before it was created', () => rejects(
    `INSERT INTO events (organizer_id, event_name, event_date, venue_name, event_kind, total_capacity)
     VALUES (1, 'Past', NOW() - INTERVAL 1 DAY, 'X', 'Seated', 10)`, [], /ck_events_future/));

  server.close();
  await pool.end();
  console.log(`\n${passed} checks passed${process.exitCode ? ', some FAILED' : ''}.`);
}

main().catch(async err => {
  console.error(err);
  process.exit(1);
});

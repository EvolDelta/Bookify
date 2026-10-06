-- Bookify — sample data. Run after schema.sql and triggers.sql.
-- Dates are relative to NOW(), so the "last 30 days" reports always have data
-- no matter when you run this. Explicit ids keep the bookings below readable.
-- Every row has to pass the triggers, so this file also doubles as a test.

-- ───────────── people ─────────────
-- Every sample account can log in, so the whole team shares the same logins:
--   customers and organizers   password123
--   admin@bookify.test         admin12345
-- password_hash is the salted scrypt hash of that password (see src/auth.js),
-- never the password itself. 

INSERT INTO users (user_id, full_name, email, phone_number, role, password_hash) VALUES
  (1, 'Somchai Jaidee', 'somchai@student.example.ac.th', '0812345671', 'Customer',
   'scrypt$16384$8$1$JJMsGZzIH2vGJsUNXSFOdA==$wJHab04LVKcJoE3UYJ0QhmMCy1TPwhoKCnz5XfSDZTa2ut73LtCje5sNKXdfQ6vmHdK2JK5+odcejEDaXCgPFw=='),
  (2, 'Suda Rakdee', 'suda@student.example.ac.th', '0812345672', 'Customer',
   'scrypt$16384$8$1$JTLPD4bDWQID5VNcZhEvnA==$5tAiZeKEYio8MEhTXxyfhxNdB0v5Qncs6fC2i7APdaAr3+EFQdu0SyKraHSDL8VOoGZ8dUTqhOWrNNG9LoM30A=='),
  (3, 'Anan Meesuk', 'anan@student.example.ac.th', '0812345673', 'Customer',
   'scrypt$16384$8$1$GHTcj5JfxfvUTr5E+zW3Rg==$5ANf8vPgedBD8/Nk6id8A/YhyFL583C9ePVy3P9CfXTNKhOuucn7DXdbZdBkTk45XTCg/wx5Rfl6M/9OoS+mDg=='),
  (4, 'Ploy Chanthra', 'ploy@student.example.ac.th', '0812345674', 'Customer',
   'scrypt$16384$8$1$2t6/PB2c0WvLPgb/KwlAwQ==$YR4xcEI3xAhWyz7wM9jI40UCN3SB0fIlObA0lDwpnPr7XlGQ3p0PA5o/IAFi7g8Qim1LlOcZM2gob/DGAwHvYQ=='),
  (5, 'Krit Wongsa', 'krit@student.example.ac.th', '0812345675', 'Customer',
   'scrypt$16384$8$1$EN1iBQx9cq81Gb9URxZP/g==$FKHkpvTHRWzSZuZSJD/2IuO57PiQixCW2eCv5qytO7xp9jgltiaIQR+fVPg83R7tQ/toygscQpM9fwh9sUK4SQ=='),
  (6, 'Mali Srisuk', 'mali@student.example.ac.th', '0812345676', 'Customer',
   'scrypt$16384$8$1$Z2nsHeDnIrn5Yt7tlwSaVg==$N8h4RjLLPKo2P3efxtgyaklrH8gB47Zw5PPjxyDB1UCkuMWB859jSFulaXumH7Szat0/sIocBb3MYkZYI4joxw==');

-- The accounts that run each organizer (role Organizer).
INSERT INTO users (user_id, full_name, email, phone_number, role, password_hash) VALUES
  (7, 'SE Music Society', 'music@se.example.ac.th', '0812345677', 'Organizer',
   'scrypt$16384$8$1$oHB/N8R60Xtnym0Po2Bnfw==$HBPftM8K6xtnkLezXGa3/biwkOwNUgdZF1135ZDMCRSCKRCrYP0nmyNP6fLFbZY3HJZNUXVXAto54pnbDGxojw=='),
  (8, 'Drama Club', 'drama@club.example.ac.th', '0812345678', 'Organizer',
   'scrypt$16384$8$1$rCYjWCqo7pDLul6NeF3kJw==$SUWfymdDYiDwtb08L7UtP8AvRJEzunNpHzmu/Zra1TeJmBZmZWSBBkYP8n/84nO0/zFiE8oy3Pxdc5WXSisQZg=='),
  (9, 'Night Market Live', 'hello@nml.example.com', '0812345679', 'Organizer',
   'scrypt$16384$8$1$vkuiYruJiWnY97jT7XhYPA==$qOwOkxHuvWxMqjuIk9xpZ8ZPbLPWtcF2EEi5HeHcnCNjoHvY6k3JYhMhaNa4FmPL4JnGy2MX2d59SaPQr9ItsQ==');

-- The admin: can host for any organizer and run the admin/manager tasks.
INSERT INTO users (user_id, full_name, email, phone_number, role, password_hash) VALUES
  (10, 'Bookify Admin', 'admin@bookify.test', NULL, 'Admin',
   'scrypt$16384$8$1$I3JqWiQuxknqNRiKtMKArA==$9edQn52wgdMP4jVc4R8no0/1mmwC+fKH+6pTnvNyr4UKcYJJUUqGCso+S3FK+8Z3vpzTkbW2jrX8poPlGBREFA==');

INSERT INTO organizers (organizer_id, organizer_name, contact_email, verification_status, verified_at, user_id) VALUES
  (1, 'SE Music Society',   'music@se.example.ac.th',   'Verified', NOW() - INTERVAL 60 DAY, 7),
  (2, 'Drama Club',         'drama@club.example.ac.th', 'Verified', NOW() - INTERVAL 50 DAY, 8),
  (3, 'Night Market Live',  'hello@nml.example.com',    'Pending',  NULL,                    9);

INSERT INTO ticket_type_catalog (type_id, type_name, description) VALUES
  (1, 'Normal',   'Standard admission'),
  (2, 'Priority', 'Better view, early entry'),
  (3, 'VIP',      'Front rows and meet & greet');

-- ───────────── events ─────────────

INSERT INTO events (event_id, organizer_id, event_name, event_date, venue_name, total_capacity, created_at) VALUES
  (1, 1, 'SE Night Concert 2026',      TIMESTAMP(CURDATE() + INTERVAL 21 DAY, '19:00:00'), 'Main Hall, Building 30', 60,  NOW() - INTERVAL 40 DAY),
  (2, 1, 'Freshy Football Cup Final',  TIMESTAMP(CURDATE() + INTERVAL 14 DAY, '16:00:00'), 'University Stadium',     100, NOW() - INTERVAL 30 DAY),
  (3, 2, 'Hamlet Reloaded',            TIMESTAMP(CURDATE() + INTERVAL 7 DAY,  '18:30:00'), 'Black Box Theatre',      6,   NOW() - INTERVAL 20 DAY),
  (4, 2, 'Winter Showcase (draft)',    TIMESTAMP(CURDATE() + INTERVAL 60 DAY, '18:00:00'), 'Black Box Theatre',      40,  NOW());

INSERT INTO event_ticket_types (event_ticket_type_id, event_id, type_id, price) VALUES
  (1, 1, 1, 300.00),   -- concert Normal
  (2, 1, 2, 500.00),   -- concert Priority
  (3, 1, 3, 1200.00),  -- concert VIP
  (4, 2, 1, 150.00),   -- football Normal
  (5, 2, 3, 400.00),   -- football VIP
  (6, 3, 1, 250.00)    -- Hamlet Normal
;

-- Every unit gets an admission_units row (supertype) and then exactly one
-- seated_units or standing_units row (subtype, BR25).
-- (Explicit unit_ids: bulk inserts may skip AUTO_INCREMENT numbers.)

-- Concert seats: row A = VIP (unit 1–10), B–C = Priority (11–30), D–E = Normal (31–50).
INSERT INTO admission_units (unit_id, event_ticket_type_id, unit_kind)
WITH RECURSIVE seat (n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seat WHERE n < 50)
SELECT n, CASE WHEN n <= 10 THEN 3 WHEN n <= 30 THEN 2 ELSE 1 END, 'Seated' FROM seat ORDER BY n;
INSERT INTO seated_units (unit_id, row_label, seat_number)
WITH RECURSIVE seat (n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seat WHERE n < 50)
SELECT n, CHAR(ASCII('A') + (n - 1) DIV 10), (n - 1) MOD 10 + 1 FROM seat ORDER BY n;

-- Football standing places: 80 Normal in the East Stand (units 51–130),
-- 20 VIP on the VIP Terrace (131–150). No row or seat.
INSERT INTO admission_units (unit_id, event_ticket_type_id, unit_kind)
WITH RECURSIVE n (i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 100)
SELECT 50 + i, IF(i <= 80, 4, 5), 'Standing' FROM n ORDER BY i;
INSERT INTO standing_units (unit_id, zone_name)
WITH RECURSIVE n (i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 100)
SELECT 50 + i, IF(i <= 80, 'East Stand', 'VIP Terrace') FROM n ORDER BY i;

-- Hamlet: one row of 6 seats (units 151–156).
INSERT INTO admission_units (unit_id, event_ticket_type_id, unit_kind)
WITH RECURSIVE seat (n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seat WHERE n < 6)
SELECT 150 + n, 6, 'Seated' FROM seat ORDER BY n;
INSERT INTO seated_units (unit_id, row_label, seat_number)
WITH RECURSIVE seat (n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seat WHERE n < 6)
SELECT 150 + n, 'A', n FROM seat ORDER BY n;

-- The concert also has 10 Normal standing places on the Back Lawn (units 157–166),
-- so one event holds both seated and standing units.
INSERT INTO admission_units (unit_id, event_ticket_type_id, unit_kind)
WITH RECURSIVE n (i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 10)
SELECT 156 + i, 1, 'Standing' FROM n ORDER BY i;
INSERT INTO standing_units (unit_id, zone_name)
WITH RECURSIVE n (i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 10)
SELECT 156 + i, 'Back Lawn' FROM n ORDER BY i;

-- Open the three complete events for sale (trg_events_bu checks BR11/BR25).
-- Event 4 stays Draft: it has no ticket types yet, so it could not be opened.
UPDATE events SET event_status = 'On_sale' WHERE event_id IN (1, 2, 3);

-- ───────────── promotions ─────────────

INSERT INTO promotions (promo_id, coupon_code, discount_type, start_date, end_date) VALUES
  (1, 'EARLYBIRD', 'Amount',  CURDATE() - INTERVAL 30 DAY, CURDATE() + INTERVAL 10 DAY),
  (2, 'SE20',      'Percent', CURDATE() - INTERVAL 20 DAY, CURDATE() + INTERVAL 20 DAY),
  (3, 'OLDPROMO',  'Amount',  CURDATE() - INTERVAL 90 DAY, CURDATE() - INTERVAL 60 DAY);
INSERT INTO amount_discounts  (promo_id, discount_amount) VALUES (1, 100.00), (3, 50.00);
INSERT INTO percent_discounts (promo_id, discount_percent, max_discount_cap) VALUES (2, 20.00, 300.00);

-- ───────────── bookings ─────────────
-- B1: Somchai, 2 VIP concert seats, SE20 → 20% of 2400 = 480, capped at 300.
SET @t = NOW() - INTERVAL 10 DAY;
INSERT INTO bookings VALUES (1, 1, 2, 'Paid', @t, @t + INTERVAL 5 MINUTE, 2100.00, 300.00);
INSERT INTO booking_items (booking_item_id, booking_id, unit_id, price_paid, sold_at) VALUES
  (1, 1, 1, 1200.00, @t + INTERVAL 3 MINUTE), (2, 1, 2, 1200.00, @t + INTERVAL 3 MINUTE);
INSERT INTO payments (booking_id, payment_method, amount, paid_at, payment_status) VALUES
  (1, 'PromptPay', 2100.00, @t + INTERVAL 3 MINUTE, 'Successful');

-- B2–B4: Hamlet sells out (6 of 6) — shows up in the "events that are full" report.
SET @t = NOW() - INTERVAL 8 DAY;
INSERT INTO bookings VALUES (2, 2, NULL, 'Paid', @t, @t + INTERVAL 5 MINUTE, 500.00, 0);
INSERT INTO booking_items (booking_item_id, booking_id, unit_id, price_paid, sold_at) VALUES
  (3, 2, 151, 250.00, @t + INTERVAL 2 MINUTE), (4, 2, 152, 250.00, @t + INTERVAL 2 MINUTE);
INSERT INTO payments (booking_id, payment_method, amount, paid_at, payment_status) VALUES
  (2, 'Bank transfer', 500.00, @t + INTERVAL 2 MINUTE, 'Successful');

SET @t = NOW() - INTERVAL 5 DAY;
INSERT INTO bookings VALUES (3, 3, 1, 'Paid', @t, @t + INTERVAL 5 MINUTE, 400.00, 100.00);
INSERT INTO booking_items (booking_item_id, booking_id, unit_id, price_paid, sold_at) VALUES
  (5, 3, 153, 250.00, @t + INTERVAL 4 MINUTE), (6, 3, 154, 250.00, @t + INTERVAL 4 MINUTE);
INSERT INTO payments (booking_id, payment_method, amount, paid_at, payment_status) VALUES
  (3, 'Cash', 400.00, @t + INTERVAL 4 MINUTE, 'Successful');

SET @t = NOW() - INTERVAL 2 DAY;
INSERT INTO bookings VALUES (4, 4, NULL, 'Paid', @t, @t + INTERVAL 5 MINUTE, 500.00, 0);
INSERT INTO booking_items (booking_item_id, booking_id, unit_id, price_paid, sold_at) VALUES
  (7, 4, 155, 250.00, @t + INTERVAL 1 MINUTE), (8, 4, 156, 250.00, @t + INTERVAL 1 MINUTE);
INSERT INTO payments (booking_id, payment_method, amount, paid_at, payment_status) VALUES
  (4, 'PromptPay', 500.00, @t + INTERVAL 1 MINUTE, 'Successful');

-- B5: Krit, 3 standing football places. The 3rd needs attendee details (BR24).
-- First payment failed, second succeeded (BR19 only counts Successful ones).
SET @t = NOW() - INTERVAL 1 DAY;
INSERT INTO bookings VALUES (5, 5, NULL, 'Paid', @t, @t + INTERVAL 5 MINUTE, 450.00, 0);
INSERT INTO booking_items (booking_item_id, booking_id, unit_id, price_paid, sold_at, attendee_name, identity_number) VALUES
  (9,  5, 51, 150.00, @t + INTERVAL 4 MINUTE, NULL, NULL),
  (10, 5, 52, 150.00, @t + INTERVAL 4 MINUTE, NULL, NULL);
INSERT INTO booking_items (booking_item_id, booking_id, unit_id, price_paid, sold_at, attendee_name, identity_number) VALUES
  (11, 5, 53, 150.00, @t + INTERVAL 4 MINUTE, 'Nok Wongsa', '1100700000001');
INSERT INTO payments (booking_id, payment_method, amount, paid_at, payment_status) VALUES
  (5, 'PromptPay',     450.00, @t + INTERVAL 2 MINUTE, 'Failed'),
  (5, 'Bank transfer', 450.00, @t + INTERVAL 4 MINUTE, 'Successful');

-- B6: Mali held a Priority seat and never paid → Expired, seat back to Available.
SET @t = NOW() - INTERVAL 3 DAY;
INSERT INTO bookings VALUES (6, 6, NULL, 'Expired', @t, @t + INTERVAL 5 MINUTE, 500.00, 0);
INSERT INTO booking_items (booking_item_id, booking_id, unit_id, price_paid) VALUES (12, 6, 11, 500.00);

-- B7: Somchai booked a Normal seat and cancelled before paying.
SET @t = NOW() - INTERVAL 4 DAY;
INSERT INTO bookings VALUES (7, 1, NULL, 'Cancelled', @t, @t + INTERVAL 5 MINUTE, 300.00, 0);
INSERT INTO booking_items (booking_item_id, booking_id, unit_id, price_paid) VALUES (13, 7, 31, 300.00);

-- Sold units, then one ticket per sold item (trg_tickets_bi checks BR12).
UPDATE admission_units SET unit_status = 'Sold'
WHERE unit_id IN (SELECT unit_id FROM booking_items WHERE sold_at IS NOT NULL);

INSERT INTO tickets (booking_item_id, ticket_code, issued_at)
SELECT booking_item_id, CONCAT('BKF-', LPAD(booking_item_id, 6, '0')), sold_at
FROM booking_items WHERE sold_at IS NOT NULL;

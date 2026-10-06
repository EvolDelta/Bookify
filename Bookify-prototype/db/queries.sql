-- Bookify — report queries (milestone M5). Each answers a question from the
-- proposal's objectives (O1–O4) or business problem section. Run them one at a
-- time in MySQL Workbench after loading seed.sql. The API serves several of
-- them under /api/reports.

-- Q1 (O1) Every seat sold in the last 30 days, with sale time and price.
-- LEFT JOIN both subtypes: a seat has a row and number, a standing place a zone.
SELECT e.event_name, c.type_name, u.unit_kind, s.row_label, s.seat_number, st.zone_name,
       bi.price_paid, bi.sold_at, us.full_name AS buyer
FROM booking_items bi
JOIN bookings b              ON b.booking_id = bi.booking_id
JOIN users us                ON us.user_id = b.user_id
JOIN admission_units u       ON u.unit_id = bi.unit_id
LEFT JOIN seated_units s     ON s.unit_id = u.unit_id
LEFT JOIN standing_units st  ON st.unit_id = u.unit_id
JOIN event_ticket_types ett  ON ett.event_ticket_type_id = u.event_ticket_type_id
JOIN ticket_type_catalog c   ON c.type_id = ett.type_id
JOIN events e                ON e.event_id = ett.event_id
WHERE bi.sold_at >= NOW() - INTERVAL 30 DAY
ORDER BY bi.sold_at DESC;

-- Q2 (O1) Tickets sold per day over the last 30 days.
SELECT DATE(sold_at) AS sale_day, COUNT(*) AS tickets_sold, SUM(price_paid) AS gross_before_discount
FROM booking_items
WHERE sold_at >= NOW() - INTERVAL 30 DAY
GROUP BY DATE(sold_at)
ORDER BY sale_day;

-- Q3 (O2) Seat status per event: available / locked / sold, and whether it is full.
SELECT e.event_id, e.event_name, e.total_capacity,
       SUM(u.unit_status = 'Available') AS available,
       SUM(u.unit_status = 'Locked')    AS locked,
       SUM(u.unit_status = 'Sold')      AS sold,
       SUM(u.unit_status = 'Sold') = COUNT(*) AS is_full
FROM events e
JOIN event_ticket_types ett ON ett.event_id = e.event_id
JOIN admission_units u      ON u.event_ticket_type_id = ett.event_ticket_type_id
GROUP BY e.event_id, e.event_name, e.total_capacity
ORDER BY e.event_date;

-- Q4 (O2) Events that are completely sold out.
SELECT e.event_name, e.event_date, COUNT(*) AS seats
FROM events e
JOIN event_ticket_types ett ON ett.event_id = e.event_id
JOIN admission_units u      ON u.event_ticket_type_id = ett.event_ticket_type_id
GROUP BY e.event_id, e.event_name, e.event_date
HAVING SUM(u.unit_status <> 'Sold') = 0;

-- Q5 (business problem) Remaining seats per ticket type for one event right now
-- ("how many Priority seats are left at this moment?").
SELECT c.type_name, ett.price, COUNT(*) AS total, SUM(u.unit_status = 'Available') AS still_available
FROM event_ticket_types ett
JOIN ticket_type_catalog c ON c.type_id = ett.type_id
JOIN admission_units u     ON u.event_ticket_type_id = ett.event_ticket_type_id
WHERE ett.event_id = 1
GROUP BY c.type_name, ett.price;

-- Q6 (O3) Who reserved which seats at which event, and what happened to the booking.
SELECT us.full_name, e.event_name, b.booking_id, b.booking_status, b.created_at,
       GROUP_CONCAT(COALESCE(CONCAT(s.row_label, s.seat_number), st.zone_name)
                    ORDER BY u.unit_id SEPARATOR ', ') AS units
FROM bookings b
JOIN users us               ON us.user_id = b.user_id
JOIN booking_items bi       ON bi.booking_id = b.booking_id
JOIN admission_units u      ON u.unit_id = bi.unit_id
LEFT JOIN seated_units s    ON s.unit_id = u.unit_id
LEFT JOIN standing_units st ON st.unit_id = u.unit_id
JOIN event_ticket_types ett ON ett.event_ticket_type_id = u.event_ticket_type_id
JOIN events e               ON e.event_id = ett.event_id
GROUP BY us.full_name, e.event_name, b.booking_id, b.booking_status, b.created_at
ORDER BY b.created_at DESC;

-- Q7 (business problem) Unpaid reservations and how long they have been waiting.
SELECT b.booking_id, us.full_name, b.created_at,
       TIMESTAMPDIFF(SECOND, b.created_at, NOW()) AS seconds_waiting,
       GREATEST(TIMESTAMPDIFF(SECOND, NOW(), b.lock_expires_at), 0) AS seconds_left
FROM bookings b
JOIN users us ON us.user_id = b.user_id
WHERE b.booking_status = 'Pending'
ORDER BY b.created_at;

-- Q8 (O4) How many times each promotion was used, and the discount it gave.
-- LEFT JOIN so promotions that were never used still show with 0.
SELECT p.coupon_code, p.discount_type, p.start_date, p.end_date,
       COUNT(b.booking_id) AS times_used,
       COALESCE(SUM(b.discount_amount_applied), 0) AS total_discount_given
FROM promotions p
LEFT JOIN bookings b ON b.promo_id = p.promo_id AND b.booking_status = 'Paid'
GROUP BY p.promo_id, p.coupon_code, p.discount_type, p.start_date, p.end_date
ORDER BY times_used DESC;

-- Q9 (business problem) Revenue per event split by payment method.
SELECT e.event_name, pay.payment_method, SUM(pay.amount) AS collected
FROM payments pay
JOIN bookings b ON b.booking_id = pay.booking_id
JOIN events e   ON e.event_id = (SELECT ett.event_id
                                 FROM booking_items bi
                                 JOIN admission_units u      ON u.unit_id = bi.unit_id
                                 JOIN event_ticket_types ett ON ett.event_ticket_type_id = u.event_ticket_type_id
                                 WHERE bi.booking_id = b.booking_id LIMIT 1)
WHERE pay.payment_status = 'Successful'
GROUP BY e.event_name, pay.payment_method
ORDER BY e.event_name, collected DESC;

-- Q10 Best-selling ticket category across all events (only possible because the
-- catalog is shared — see Ticket_Type_Catalog in the proposal).
SELECT c.type_name, COUNT(*) AS tickets_sold, SUM(bi.price_paid) AS gross
FROM booking_items bi
JOIN admission_units u      ON u.unit_id = bi.unit_id
JOIN event_ticket_types ett ON ett.event_ticket_type_id = u.event_ticket_type_id
JOIN ticket_type_catalog c  ON c.type_id = ett.type_id
WHERE bi.sold_at IS NOT NULL
GROUP BY c.type_name
ORDER BY tickets_sold DESC;

-- Q11 Customers who have never completed a booking (candidates for a promo).
SELECT us.full_name, us.email
FROM users us
WHERE us.role = 'Customer'
  AND NOT EXISTS (SELECT 1 FROM bookings b WHERE b.user_id = us.user_id AND b.booking_status = 'Paid');

-- Q12 Organizers ranked by tickets sold (window function).
SELECT o.organizer_name, COUNT(bi.booking_item_id) AS tickets_sold,
       RANK() OVER (ORDER BY COUNT(bi.booking_item_id) DESC) AS sales_rank
FROM organizers o
LEFT JOIN events e              ON e.organizer_id = o.organizer_id
LEFT JOIN event_ticket_types ett ON ett.event_id = e.event_id
LEFT JOIN admission_units u     ON u.event_ticket_type_id = ett.event_ticket_type_id
LEFT JOIN booking_items bi      ON bi.unit_id = u.unit_id AND bi.sold_at IS NOT NULL
GROUP BY o.organizer_id, o.organizer_name;

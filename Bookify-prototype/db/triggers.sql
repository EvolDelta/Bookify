-- Bookify — triggers for the business rules a CHECK constraint cannot express
-- (a CHECK may only look at its own row; these rules need to look at other rows).
-- Each one raises SQLSTATE 45000 with the rule number in the message, so the
-- error tells you which business rule was broken.
--
-- Run after schema.sql. In MySQL Workbench run the whole file as-is; the
-- DELIMITER lines let a trigger body contain semicolons.
-- (Triggers are dropped together with their tables in schema.sql; the shared
-- procedure is not, so drop it here. check_admission_unit is from an older
-- version of this file.)

DROP PROCEDURE IF EXISTS check_admission_unit;
DROP PROCEDURE IF EXISTS check_seat_unique;

DELIMITER $$

-- BR13: only a verified organizer may create an event.
CREATE TRIGGER trg_events_bi BEFORE INSERT ON events
FOR EACH ROW
BEGIN
  IF NOT EXISTS (SELECT 1 FROM organizers
                 WHERE organizer_id = NEW.organizer_id AND verification_status = 'Verified') THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'BR13: organizer must be verified before creating an event';
  END IF;
END$$

-- BR11, and BR10/BR25 (totality): an event can only go on sale once it has at
-- least one ticket type with admission units, and every one of those units has
-- its Seated_Unit or Standing_Unit row.
CREATE TRIGGER trg_events_bu BEFORE UPDATE ON events
FOR EACH ROW
BEGIN
  IF NEW.event_status = 'On_sale' AND OLD.event_status <> 'On_sale' THEN
    IF NOT EXISTS (SELECT 1 FROM event_ticket_types ett
                   JOIN admission_units u ON u.event_ticket_type_id = ett.event_ticket_type_id
                   WHERE ett.event_id = NEW.event_id) THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'BR11: event needs a ticket type and admission units before going on sale';
    END IF;
    IF EXISTS (SELECT 1 FROM event_ticket_types ett
               JOIN admission_units u ON u.event_ticket_type_id = ett.event_ticket_type_id
               LEFT JOIN seated_units s    ON s.unit_id = u.unit_id
               LEFT JOIN standing_units st ON st.unit_id = u.unit_id
               WHERE ett.event_id = NEW.event_id AND s.unit_id IS NULL AND st.unit_id IS NULL) THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'BR25: every admission unit needs a Seated_Unit or Standing_Unit row';
    END IF;
  END IF;
END$$

-- BR22: never more units than the event's capacity.
CREATE TRIGGER trg_units_bi BEFORE INSERT ON admission_units
FOR EACH ROW
BEGIN
  IF (SELECT COUNT(*) FROM admission_units u
      JOIN event_ticket_types ett ON ett.event_ticket_type_id = u.event_ticket_type_id
      WHERE ett.event_id = (SELECT event_id FROM event_ticket_types
                            WHERE event_ticket_type_id = NEW.event_ticket_type_id))
     >= (SELECT e.total_capacity FROM event_ticket_types ett JOIN events e ON e.event_id = ett.event_id
         WHERE ett.event_ticket_type_id = NEW.event_ticket_type_id) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'BR22: event already has total_capacity admission units';
  END IF;
END$$

-- BR16: row + seat is unique within the whole event (across all ticket types).
-- Shared by the insert and update triggers on seated_units.
CREATE PROCEDURE check_seat_unique(IN p_unit_id INT, IN p_ett_id INT, IN p_row VARCHAR(5), IN p_seat INT)
BEGIN
  IF EXISTS (SELECT 1 FROM seated_units s
             JOIN admission_units u      ON u.unit_id = s.unit_id
             JOIN event_ticket_types ett ON ett.event_ticket_type_id = u.event_ticket_type_id
             WHERE ett.event_id = (SELECT event_id FROM event_ticket_types WHERE event_ticket_type_id = p_ett_id)
               AND s.row_label = p_row AND s.seat_number = p_seat AND s.unit_id <> p_unit_id) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'BR16: that row and seat already exist in this event';
  END IF;
END$$

CREATE TRIGGER trg_seated_units_bi BEFORE INSERT ON seated_units
FOR EACH ROW
BEGIN
  CALL check_seat_unique(NEW.unit_id,
    (SELECT event_ticket_type_id FROM admission_units WHERE unit_id = NEW.unit_id),
    NEW.row_label, NEW.seat_number);
END$$

CREATE TRIGGER trg_seated_units_bu BEFORE UPDATE ON seated_units
FOR EACH ROW
BEGIN
  IF NOT (NEW.row_label <=> OLD.row_label) OR NOT (NEW.seat_number <=> OLD.seat_number) THEN
    CALL check_seat_unique(NEW.unit_id,
      (SELECT event_ticket_type_id FROM admission_units WHERE unit_id = NEW.unit_id),
      NEW.row_label, NEW.seat_number);
  END IF;
END$$

CREATE TRIGGER trg_units_bu BEFORE UPDATE ON admission_units
FOR EACH ROW
BEGIN
  -- status changes happen thousands of times; only check when the unit moves.
  -- Staying inside its event keeps BR16 and BR22 true without re-checking them.
  IF NOT (NEW.event_ticket_type_id <=> OLD.event_ticket_type_id) THEN
    IF (SELECT event_id FROM event_ticket_types WHERE event_ticket_type_id = NEW.event_ticket_type_id)
       <> (SELECT event_id FROM event_ticket_types WHERE event_ticket_type_id = OLD.event_ticket_type_id) THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'BR3: a unit cannot move to a ticket type of another event';
    END IF;
  END IF;
END$$

-- BR22: a promotion only applies to a booking created inside its valid period.
CREATE TRIGGER trg_bookings_bi BEFORE INSERT ON bookings
FOR EACH ROW
BEGIN
  IF NEW.promo_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM promotions
       WHERE promo_id = NEW.promo_id AND DATE(NEW.created_at) BETWEEN start_date AND end_date) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'BR22: promotion is not valid on the booking date';
  END IF;
END$$

CREATE TRIGGER trg_booking_items_bi BEFORE INSERT ON booking_items
FOR EACH ROW
BEGIN
  -- BR23: cannot book an event that has already happened
  IF EXISTS (SELECT 1 FROM bookings b, admission_units u
             JOIN event_ticket_types ett ON ett.event_ticket_type_id = u.event_ticket_type_id
             JOIN events e ON e.event_id = ett.event_id
             WHERE b.booking_id = NEW.booking_id AND u.unit_id = NEW.unit_id
               AND b.created_at >= e.event_date) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'BR23: booking was created after the event date';
  END IF;

  -- BR24: past the 2-ticket ceiling every extra unit needs its own attendee details
  IF (SELECT COUNT(*) FROM booking_items WHERE booking_id = NEW.booking_id) >= 2
     AND (NULLIF(TRIM(NEW.attendee_name), '') IS NULL OR NULLIF(TRIM(NEW.identity_number), '') IS NULL) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'BR24: tickets beyond the 2nd need attendee_name and identity_number';
  END IF;
  -- BR24: one identity_number per event. Expired and cancelled bookings no
  -- longer hold a place, so they do not count.
  IF NEW.identity_number IS NOT NULL AND EXISTS (
       SELECT 1 FROM booking_items bi
       JOIN bookings b             ON b.booking_id = bi.booking_id
       JOIN admission_units u      ON u.unit_id = bi.unit_id
       JOIN event_ticket_types ett ON ett.event_ticket_type_id = u.event_ticket_type_id
       WHERE bi.identity_number = NEW.identity_number
         AND b.booking_status IN ('Pending','Paid')
         AND ett.event_id = (SELECT ett2.event_id FROM admission_units u2
                             JOIN event_ticket_types ett2 ON ett2.event_ticket_type_id = u2.event_ticket_type_id
                             WHERE u2.unit_id = NEW.unit_id)) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'BR24: that identity_number already holds a ticket for this event';
  END IF;
END$$

-- BR12: tickets are only issued for sold items of paid bookings.
CREATE TRIGGER trg_tickets_bi BEFORE INSERT ON tickets
FOR EACH ROW
BEGIN
  IF NOT EXISTS (SELECT 1 FROM booking_items bi JOIN bookings b ON b.booking_id = bi.booking_id
                 WHERE bi.booking_item_id = NEW.booking_item_id
                   AND b.booking_status = 'Paid' AND bi.sold_at IS NOT NULL) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'BR12: a ticket needs a sold item from a paid booking';
  END IF;
END$$

DELIMITER ;

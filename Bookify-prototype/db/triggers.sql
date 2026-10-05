-- Bookify — triggers for the business rules a CHECK constraint cannot express
-- (a CHECK may only look at its own row; these rules need to look at other rows).
-- Each one raises SQLSTATE 45000 with the rule number in the message, so the
-- error tells you which business rule was broken.
--
-- Run after schema.sql. In MySQL Workbench run the whole file as-is; the
-- DELIMITER lines let a trigger body contain semicolons.
-- (Triggers are dropped together with their tables in schema.sql; the shared
-- procedure is not, so drop it here.)

DROP PROCEDURE IF EXISTS check_admission_unit;

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

-- BR10/BR23 (totality) and BR11: an event can only go on sale once it has its
-- subtype row, at least one ticket type and at least one admission unit.
CREATE TRIGGER trg_events_bu BEFORE UPDATE ON events
FOR EACH ROW
BEGIN
  IF NEW.event_status = 'On_sale' AND OLD.event_status <> 'On_sale' THEN
    IF (NEW.event_kind = 'Seated'     AND NOT EXISTS (SELECT 1 FROM seated_events     WHERE event_id = NEW.event_id))
    OR (NEW.event_kind = 'Non_Seated' AND NOT EXISTS (SELECT 1 FROM non_seated_events WHERE event_id = NEW.event_id)) THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'BR10: event has no Seated_Event / Non_Seated_Event row';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM event_ticket_types ett
                   JOIN admission_units u ON u.event_ticket_type_id = ett.event_ticket_type_id
                   WHERE ett.event_id = NEW.event_id) THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'BR11: event needs a ticket type and admission units before going on sale';
    END IF;
  END IF;
END$$

-- BR16 and BR22, shared by the insert and update triggers below.
CREATE PROCEDURE check_admission_unit(
  IN p_unit_id INT, IN p_ett_id INT, IN p_row VARCHAR(5), IN p_seat INT, IN p_is_insert BOOLEAN)
BEGIN
  DECLARE v_event_id INT;
  DECLARE v_kind VARCHAR(20);
  DECLARE v_capacity INT;

  SELECT e.event_id, e.event_kind, e.total_capacity INTO v_event_id, v_kind, v_capacity
  FROM event_ticket_types ett JOIN events e ON e.event_id = ett.event_id
  WHERE ett.event_ticket_type_id = p_ett_id;

  -- BR16: seated units have a row and seat; standing units have neither
  IF v_kind = 'Seated' AND p_row IS NULL THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'BR16: a unit of a seated event needs row_label and seat_number';
  END IF;
  IF v_kind = 'Non_Seated' AND p_row IS NOT NULL THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'BR16: a unit of a non-seated event has no row_label or seat_number';
  END IF;

  -- BR16: row + seat is unique within the whole event (across all ticket types)
  IF p_row IS NOT NULL AND EXISTS (
       SELECT 1 FROM admission_units u
       JOIN event_ticket_types ett ON ett.event_ticket_type_id = u.event_ticket_type_id
       WHERE ett.event_id = v_event_id AND u.row_label = p_row AND u.seat_number = p_seat
         AND u.unit_id <> IFNULL(p_unit_id, 0)) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'BR16: that row and seat already exist in this event';
  END IF;

  -- BR22: never more units than the event's capacity
  IF p_is_insert AND (SELECT COUNT(*) FROM admission_units u
                      JOIN event_ticket_types ett ON ett.event_ticket_type_id = u.event_ticket_type_id
                      WHERE ett.event_id = v_event_id) >= v_capacity THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'BR22: event already has total_capacity admission units';
  END IF;
END$$

CREATE TRIGGER trg_units_bi BEFORE INSERT ON admission_units
FOR EACH ROW
BEGIN
  CALL check_admission_unit(NULL, NEW.event_ticket_type_id, NEW.row_label, NEW.seat_number, TRUE);
END$$

CREATE TRIGGER trg_units_bu BEFORE UPDATE ON admission_units
FOR EACH ROW
BEGIN
  -- status changes happen thousands of times; only re-check when the seat itself moves
  IF NOT (NEW.event_ticket_type_id <=> OLD.event_ticket_type_id)
     OR NOT (NEW.row_label <=> OLD.row_label) OR NOT (NEW.seat_number <=> OLD.seat_number) THEN
    CALL check_admission_unit(OLD.unit_id, NEW.event_ticket_type_id, NEW.row_label, NEW.seat_number, FALSE);
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
  -- BR25: cannot book an event that has already happened
  IF EXISTS (SELECT 1 FROM bookings b, admission_units u
             JOIN event_ticket_types ett ON ett.event_ticket_type_id = u.event_ticket_type_id
             JOIN events e ON e.event_id = ett.event_id
             WHERE b.booking_id = NEW.booking_id AND u.unit_id = NEW.unit_id
               AND b.created_at >= e.event_date) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'BR25: booking was created after the event date';
  END IF;

  -- BR26: past the 2-ticket ceiling every extra unit needs its own attendee details
  IF (SELECT COUNT(*) FROM booking_items WHERE booking_id = NEW.booking_id) >= 2
     AND (NULLIF(TRIM(NEW.attendee_name), '') IS NULL OR NULLIF(TRIM(NEW.attendee_id_number), '') IS NULL) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'BR26: tickets beyond the 2nd need attendee_name and attendee_id_number';
  END IF;
  IF NEW.attendee_id_number IS NOT NULL AND EXISTS (
       SELECT 1 FROM booking_items WHERE booking_id = NEW.booking_id AND attendee_id_number = NEW.attendee_id_number) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'BR26: each attendee in a booking must be a different person';
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

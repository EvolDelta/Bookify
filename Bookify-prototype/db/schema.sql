-- Bookify — relational schema (MySQL 8+)
-- Implements the entity list and business rules (BR1–BR26) from the Lab 7 proposal.
-- Rules that a column type, CHECK, UNIQUE or FOREIGN KEY can express live here;
-- rules that need to look at other rows live in triggers.sql; rules that span a
-- whole transaction (BR9, BR17–BR19) live in src/services/bookings.js.
--
-- WARNING: running this file DROPS every Bookify table first (clean rebuild).

SET FOREIGN_KEY_CHECKS = 0;
DROP TABLE IF EXISTS tickets, payments, booking_items, bookings,
  percent_discounts, amount_discounts, promotions,
  admission_units, event_ticket_types, ticket_type_catalog,
  seated_events, non_seated_events, events, organizers, users;
SET FOREIGN_KEY_CHECKS = 1;

-- ───────────── people ─────────────

-- The ticket buyer. Login/password is out of scope, so there is no password column.
CREATE TABLE users (
  user_id       INT AUTO_INCREMENT PRIMARY KEY,
  full_name     VARCHAR(100) NOT NULL,
  email         VARCHAR(255) NOT NULL,
  phone_number  VARCHAR(20),
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_users_email UNIQUE (email)                                      -- BR15
);

CREATE TABLE organizers (
  organizer_id         INT AUTO_INCREMENT PRIMARY KEY,
  organizer_name       VARCHAR(100) NOT NULL,
  contact_email        VARCHAR(255) NOT NULL,
  verification_status  ENUM('Pending','Verified','Rejected') NOT NULL DEFAULT 'Pending',
  verified_at          DATETIME NULL,
  CONSTRAINT uq_organizers_email UNIQUE (contact_email),
  -- a verified organizer must say when it was verified
  CONSTRAINT ck_organizers_verified CHECK (verification_status <> 'Verified' OR verified_at IS NOT NULL)
);

-- ───────────── events (supertype + disjoint, total specialisation) ─────────────

CREATE TABLE events (
  event_id        INT AUTO_INCREMENT PRIMARY KEY,
  organizer_id    INT NOT NULL,                                                 -- BR1
  event_name      VARCHAR(150) NOT NULL,
  event_date      DATETIME NOT NULL,
  venue_name      VARCHAR(150) NOT NULL,
  event_kind      ENUM('Seated','Non_Seated') NOT NULL,                         -- discriminator, BR23
  total_capacity  INT NOT NULL,
  event_status    ENUM('Draft','On_sale','Closed','Cancelled') NOT NULL DEFAULT 'Draft',  -- BR14
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_events_organizer FOREIGN KEY (organizer_id) REFERENCES organizers (organizer_id),
  CONSTRAINT ck_events_capacity CHECK (total_capacity > 0),
  CONSTRAINT ck_events_future CHECK (event_date > created_at),                  -- BR25
  -- lets each subtype table point at (event_id, event_kind), see below
  CONSTRAINT uq_events_id_kind UNIQUE (event_id, event_kind)
);

-- Disjointness (BR23): each subtype row carries a fixed event_kind and references
-- (event_id, event_kind) together, so a 'Seated' event can never get a
-- Non_Seated_Event row and vice versa. Totality is checked when the event is
-- opened for sale (trg_events_bu in triggers.sql).
CREATE TABLE seated_events (
  event_id       INT PRIMARY KEY,
  event_kind     ENUM('Seated','Non_Seated') NOT NULL DEFAULT 'Seated',
  seat_map_name  VARCHAR(100) NOT NULL,
  total_rows     INT NOT NULL,
  CONSTRAINT ck_seated_kind CHECK (event_kind = 'Seated'),
  CONSTRAINT ck_seated_rows CHECK (total_rows > 0),
  CONSTRAINT fk_seated_event FOREIGN KEY (event_id, event_kind) REFERENCES events (event_id, event_kind)
);

CREATE TABLE non_seated_events (
  event_id    INT PRIMARY KEY,
  event_kind  ENUM('Seated','Non_Seated') NOT NULL DEFAULT 'Non_Seated',
  zone_name   VARCHAR(100) NOT NULL,
  CONSTRAINT ck_non_seated_kind CHECK (event_kind = 'Non_Seated'),
  CONSTRAINT fk_non_seated_event FOREIGN KEY (event_id, event_kind) REFERENCES events (event_id, event_kind)
);

-- ───────────── ticket types and sellable places ─────────────

CREATE TABLE ticket_type_catalog (
  type_id      INT AUTO_INCREMENT PRIMARY KEY,
  type_name    ENUM('Normal','Priority','VIP') NOT NULL,                        -- BR14
  description  VARCHAR(255),
  CONSTRAINT uq_catalog_name UNIQUE (type_name)                                 -- BR15
);

-- Bridge for Events M:N Ticket_Type_Catalog (BR2).
CREATE TABLE event_ticket_types (
  event_ticket_type_id  INT AUTO_INCREMENT PRIMARY KEY,
  event_id              INT NOT NULL,
  type_id               INT NOT NULL,
  price                 DECIMAL(10,2) NOT NULL,
  CONSTRAINT fk_ett_event FOREIGN KEY (event_id) REFERENCES events (event_id),
  CONSTRAINT fk_ett_type  FOREIGN KEY (type_id)  REFERENCES ticket_type_catalog (type_id),
  CONSTRAINT uq_ett_event_type UNIQUE (event_id, type_id),                      -- BR15
  CONSTRAINT ck_ett_price CHECK (price > 0)                                     -- BR21
);

-- One row per sellable place (BR3). Seated/non-seated rules and per-event seat
-- uniqueness (BR16) and the capacity limit (BR22) are in triggers.sql.
CREATE TABLE admission_units (
  unit_id               INT AUTO_INCREMENT PRIMARY KEY,
  event_ticket_type_id  INT NOT NULL,
  row_label             VARCHAR(5) NULL,
  seat_number           INT NULL,
  unit_status           ENUM('Available','Locked','Sold') NOT NULL DEFAULT 'Available',  -- BR14
  CONSTRAINT fk_units_ett FOREIGN KEY (event_ticket_type_id) REFERENCES event_ticket_types (event_ticket_type_id),
  -- a seat has both a row and a number, or neither
  CONSTRAINT ck_units_row_seat CHECK ((row_label IS NULL) = (seat_number IS NULL)),
  CONSTRAINT ck_units_seat_positive CHECK (seat_number IS NULL OR seat_number > 0),
  INDEX ix_units_status (event_ticket_type_id, unit_status)
);

-- ───────────── promotions (supertype + disjoint, total specialisation) ─────────────

CREATE TABLE promotions (
  promo_id       INT AUTO_INCREMENT PRIMARY KEY,
  coupon_code    VARCHAR(30) NOT NULL,
  discount_type  ENUM('Amount','Percent') NOT NULL,                             -- discriminator, BR24
  start_date     DATE NOT NULL,
  end_date       DATE NOT NULL,
  CONSTRAINT uq_promotions_code UNIQUE (coupon_code),
  CONSTRAINT ck_promotions_period CHECK (end_date >= start_date),
  CONSTRAINT uq_promotions_id_type UNIQUE (promo_id, discount_type)
);

CREATE TABLE amount_discounts (
  promo_id         INT PRIMARY KEY,
  discount_type    ENUM('Amount','Percent') NOT NULL DEFAULT 'Amount',
  discount_amount  DECIMAL(10,2) NOT NULL,
  CONSTRAINT ck_amount_type CHECK (discount_type = 'Amount'),
  CONSTRAINT ck_amount_positive CHECK (discount_amount > 0),
  CONSTRAINT fk_amount_promo FOREIGN KEY (promo_id, discount_type) REFERENCES promotions (promo_id, discount_type)
);

CREATE TABLE percent_discounts (
  promo_id          INT PRIMARY KEY,
  discount_type     ENUM('Amount','Percent') NOT NULL DEFAULT 'Percent',
  discount_percent  DECIMAL(5,2) NOT NULL,
  max_discount_cap  DECIMAL(10,2) NULL,
  CONSTRAINT ck_percent_type CHECK (discount_type = 'Percent'),
  CONSTRAINT ck_percent_range CHECK (discount_percent > 0 AND discount_percent <= 100),
  CONSTRAINT ck_percent_cap CHECK (max_discount_cap IS NULL OR max_discount_cap > 0),
  CONSTRAINT fk_percent_promo FOREIGN KEY (promo_id, discount_type) REFERENCES promotions (promo_id, discount_type)
);

-- ───────────── bookings, payments, tickets ─────────────

CREATE TABLE bookings (
  booking_id               INT AUTO_INCREMENT PRIMARY KEY,
  user_id                  INT NOT NULL,                                        -- BR4
  promo_id                 INT NULL,                                            -- BR8: at most one coupon
  booking_status           ENUM('Pending','Paid','Expired','Cancelled') NOT NULL DEFAULT 'Pending',  -- BR14
  created_at               DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  lock_expires_at          DATETIME NOT NULL,
  total_amount             DECIMAL(10,2) NOT NULL,
  discount_amount_applied  DECIMAL(10,2) NOT NULL DEFAULT 0,                    -- BR21: frozen at sale
  CONSTRAINT fk_bookings_user  FOREIGN KEY (user_id)  REFERENCES users (user_id),
  CONSTRAINT fk_bookings_promo FOREIGN KEY (promo_id) REFERENCES promotions (promo_id),
  CONSTRAINT ck_bookings_lock CHECK (lock_expires_at = created_at + INTERVAL 5 MINUTE),  -- BR17
  CONSTRAINT ck_bookings_amounts CHECK (total_amount >= 0 AND discount_amount_applied >= 0),
  INDEX ix_bookings_status_expiry (booking_status, lock_expires_at)
);

-- Bridge for Bookings M:N Admission_Units (BR5).
CREATE TABLE booking_items (
  booking_item_id     INT AUTO_INCREMENT PRIMARY KEY,
  booking_id          INT NOT NULL,
  unit_id             INT NOT NULL,
  price_paid          DECIMAL(10,2) NOT NULL,                                   -- BR21: copied at sale
  sold_at             DATETIME NULL,
  -- BR26: attendee details, required for the 3rd and later item of a booking
  attendee_name       VARCHAR(100) NULL,
  attendee_id_number  VARCHAR(20) NULL,
  -- BR20: equals unit_id once sold, NULL before. UNIQUE ignores NULLs, so many
  -- unsold rows may point at a unit over time, but only one can ever be sold.
  sold_unit_id        INT AS (IF(sold_at IS NULL, NULL, unit_id)) STORED,
  CONSTRAINT fk_items_booking FOREIGN KEY (booking_id) REFERENCES bookings (booking_id),
  CONSTRAINT fk_items_unit    FOREIGN KEY (unit_id)    REFERENCES admission_units (unit_id),
  CONSTRAINT uq_items_booking_unit UNIQUE (booking_id, unit_id),
  CONSTRAINT uq_items_sold_once UNIQUE (sold_unit_id),                          -- BR20
  CONSTRAINT ck_items_price CHECK (price_paid > 0)
);

CREATE TABLE payments (
  payment_id      INT AUTO_INCREMENT PRIMARY KEY,
  booking_id      INT NOT NULL,                                                 -- BR6
  payment_method  ENUM('Bank transfer','PromptPay','Cash') NOT NULL,            -- BR14
  amount          DECIMAL(10,2) NOT NULL,
  paid_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  payment_status  ENUM('Pending','Successful','Failed') NOT NULL DEFAULT 'Pending',  -- BR14
  CONSTRAINT fk_payments_booking FOREIGN KEY (booking_id) REFERENCES bookings (booking_id),
  CONSTRAINT ck_payments_amount CHECK (amount > 0)                              -- BR19
);

CREATE TABLE tickets (
  ticket_id        INT AUTO_INCREMENT PRIMARY KEY,
  booking_item_id  INT NOT NULL,
  ticket_code      VARCHAR(20) NOT NULL,
  issued_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  printed_at       DATETIME NULL,
  CONSTRAINT fk_tickets_item FOREIGN KEY (booking_item_id) REFERENCES booking_items (booking_item_id),
  CONSTRAINT uq_tickets_item UNIQUE (booking_item_id),                          -- BR7: at most one per item
  CONSTRAINT uq_tickets_code UNIQUE (ticket_code)                               -- BR15
);

# Bookify backend: a guide to the database and the cloud

This guide is in three parts:

- **Part 1** gets the database and API running on your own PC.
- **Part 2** explains how the proposal's business rules became SQL. This is the part to study for the course.
- **Part 3** moves the database and the app to the cloud.

```
 Browser (public/ — HTML/CSS/JS)
      │  fetch('/api/...')            JSON
      ▼
 Express server (server.js, src/)     ← "application layer": checks input, runs transactions
      │  SQL over TCP (mysql2)
      ▼
 MySQL (db/schema.sql, triggers.sql)  ← "data layer": the rules that must NEVER be broken
```

What lives where:

| Folder / file | Purpose |
|---|---|
| `db/schema.sql` | Tables, keys, CHECK / UNIQUE / FOREIGN KEY constraints (milestone M4 DDL) |
| `db/triggers.sql` | Rules that need to look at other rows (BR3, BR10–BR13, BR16, BR22–BR25, BR27) |
| `db/seed.sql` | Sample data (milestone M4 sample data) |
| `db/queries.sql` | 12 report queries (milestone M5 needs ≥ 10) |
| `src/services/bookings.js` | Lock → pay → sell flow, run as transactions (BR9, BR17–BR21) |
| `src/routes/*.js` | The HTTP API, plus the input checks that give friendlier errors than the database |
| `src/errors.js` | Turns MySQL constraint and trigger errors into 4xx JSON replies |
| `public/` | The website (plain HTML/CSS/JS, no build step) |
| `scripts/db-setup.js` | Builds the database from the `db/` files |
| `src/auth.js`, `src/routes/auth.js` | Sign up, log in, sessions, and the "organizers / admins only" checks |
| `scripts/make-admin.js` | Turns a registered account into an Admin |
| `scripts/sample-passwords.js` | Gives any account with no password one, for local testing |
| `scripts/smoke-test.js` | Automatic checks of the API, the login rules and the database rules |

---

## Part 1: Run it locally

### 1. Prerequisites

- **Node.js 22 or newer.** Run `node -v` to check. Your proposal says Node 20, but Node 20 reached end of life in April 2026, so change the tech-stack row to **Node.js 22 LTS or 24 LTS**.
- **MySQL 8 or newer.** It's already installed on this PC as the Windows service `MySQL267`, together with MySQL Workbench.

### 2. Tell the app how to reach MySQL

```bash
cp .env.example .env
```

Open `.env` and set `DB_PASSWORD` to your local MySQL root password. `.env` is in `.gitignore`, so it never gets pushed to GitHub. Keep it that way: **passwords never go into Git.**

### 3. Build the database and test it

```bash
npm install
npm run db:setup      # creates database "bookify": tables, triggers and sample data
npm run test:api      # should end with all checks passed
npm run dev           # http://localhost:3000 serves the site, http://localhost:3000/api/... the API
```

`db:setup` **drops and rebuilds** all Bookify tables, so run it whenever you want a clean copy. `test:api` changes data, so run `db:setup` again before running the tests a second time.

### 4. Look at it in MySQL Workbench

1. Connect to `localhost:3306`. In the schema list, double-click `bookify`.
2. Open `db/queries.sql` and run the queries one at a time (Ctrl+Enter on a query). Screenshots of these results are your M5 deliverable.
3. Go to **Database → Reverse Engineer…** and pick `bookify`. Workbench draws the diagram from the real tables. Compare it with your Draw.io ERD: every entity should be there, with the same keys. This is the "free check on our diagram" your tech-stack table mentions.

### 5. Log in with the sample accounts

`db:setup` loads sample accounts that everyone on the team can log in with. Their passwords are stored in `db/seed.sql` as scrypt hashes, so every copy of the database gets the same logins:

| Account | Email | Password |
|---|---|---|
| Admin | `admin@bookify.test` | `admin12345` |
| Organizers | `music@se.example.ac.th`, `drama@club.example.ac.th`, `hello@nml.example.com` | `password123` |
| Customers | `somchai@`, `suda@`, `anan@`, `ploy@`, `krit@`, `mali@` … `student.example.ac.th` | `password123` |

These passwords are written in this guide, so anyone can read them. On a database the public can reach, change them, or use `npm run db:schema` (no sample data) and create your own accounts.

#### Making another account an admin

Everyone who signs up on the website is a **Customer**: they can browse and book, but they can't open the **Host** side. To make an admin:

1. Run `npm run dev`, open http://localhost:3000, click **Log in**, and create your account under *New here?* with your own password.
2. In the terminal, promote that account:
   ```bash
   npm run make-admin -- your-email@example.com
   ```
3. Reload the page. You'll see an **Admin** badge next to your initials, and the **Attend / Host / Manage / Admin** switch appears.

To turn an admin back into a customer, run `npm run make-admin -- your-email@example.com --remove`. If the account runs an organizer, it goes back to Organizer instead. Their password never goes into a script or SQL file: they type it on the website, and only a hash is stored.

#### Organizer accounts

An **Organizer** account runs one organizer (`organizers.user_id`). It gets **Attend / Host** only: it can create events for its own organizer and open, close or cancel them, and nothing else. Promotions, reports, verifying organizers and removing events stay with admins.

**Creating one:** click **Log in**, choose **To host events** under *New here?*, and fill in your name, email, password and the organizer's name. That creates the Organizer account and the organizer (status **Pending**) together, already linked, and opens Host. An admin then clicks **Verify** in **Admin → Organizers**; until then the organizer can't create events (BR13).

**Organizers an admin registered:** the account that runs an organizer is the one registered with the organizer's **contact email**.

- When an admin registers an organizer, an existing account with that email is linked straight away.
- If the person signs up later (with a normal account), the admin clicks **Link account** in the same table. **Unlink** turns the account back into a Customer.

The sample data already has one Organizer account per organizer (`music@se.example.ac.th`, `drama@club.example.ac.th`, `hello@nml.example.com`). Like the sample customers, their password is `password123`. SE Music Society and Drama Club are **Verified**; Night Market Live is still **Pending**, so log in as `hello@nml.example.com` to see BR13 stop an unverified organizer from creating events.

### 6. Try the API

Bookings need a logged-in user. With `curl`, `-c`/`-b cookies.txt` saves and sends the login cookie, like a browser does:

```bash
curl http://localhost:3000/api/events
curl -c cookies.txt -X POST http://localhost:3000/api/auth/register -H "content-type: application/json" -d "{\"full_name\":\"Test User\",\"email\":\"test@example.com\",\"password\":\"test-password-1\"}"
curl -b cookies.txt -X POST http://localhost:3000/api/bookings -H "content-type: application/json" -d "{\"units\":[{\"unit_id\":12}],\"promo_code\":\"EARLYBIRD\"}"
curl -b cookies.txt -X POST http://localhost:3000/api/bookings/8/payments -H "content-type: application/json" -d "{\"payment_method\":\"PromptPay\",\"amount\":400}"
```

(Use whatever `booking_id` the booking command returns.) Run the booking command twice and the second one fails with *"Already taken: B2"*. Without `-b cookies.txt` you get *"Please log in first."*

#### API reference

| Who | Method & path | What it does |
|---|---|---|
| Anyone | `POST /api/auth/register` | Create a Customer account and log in (`full_name`, `email`, `password` with at least 8 characters) |
| Anyone | `POST /api/auth/register-organizer` | Create an Organizer account plus a Pending organizer it runs, and log in (the fields above plus `organizer_name`) |
| Anyone | `POST /api/auth/login` · `POST /api/auth/logout` | Log in or out (sets or clears the `bookify_session` cookie) |
| Anyone | `GET /api/auth/me` | The logged-in user, or `null` |
| Anyone | `GET /api/events` · `GET /api/events/:id` | Events on sale, and one event with every seat's status |
| Anyone | `GET /api/promotions` | Promotion codes |
| Anyone | `GET /api/events/:id/image` · `GET /api/promotions/:id/image` | An uploaded image file |
| Logged in | `POST /api/bookings` | Lock seats for 5 minutes (`units`, optional `promo_code`) |
| Logged in | `POST /api/bookings/:id/payments` | Pay your booking (`payment_method`, `amount`, optional `payment_status`) |
| Logged in | `POST /api/bookings/:id/cancel` | Cancel your unpaid booking |
| Logged in | `GET /api/bookings/:id` · `GET /api/users/:id/bookings` | Your own booking or reservations (admins can see anyone's) |
| Organizer or Admin | `GET /api/events?status=all` | Events in any status (an Organizer sees only their own) |
| Organizer or Admin | `POST /api/events` | Host a Draft event with seated and/or standing units (see the comment in `src/routes/events.js`). An Organizer may only use their own `organizer_id` |
| Organizer or Admin | `PUT /api/events/:id/image` | Replace or remove the event image (`organizer_id` plus `image_url` or `image_data`; send neither to remove). The `organizer_id` must be the event's own organizer |
| Organizer or Admin | `PATCH /api/events/:id/status` | Open, close or cancel an event (an Organizer only their own) |
| Organizer or Admin | `GET /api/organizers` | Organizers (an Organizer sees only their own) |
| Admin | `DELETE /api/events/:id` | Remove a cancelled event that has no bookings |
| Admin | `POST /api/promotions` · `PUT /api/promotions/:id/image` | Create Amount / Percent promotions; replace or remove a promotion image |
| Admin | `GET /api/reports/...` | `sales-last-30-days` (O1), `seat-status` (O2), `promotion-usage` (O4), `pending-bookings`, `events/:id/revenue` |
| Admin | `POST /api/organizers` · `PATCH /api/organizers/:id/verification` | Register and verify organizers (BR13) |
| Admin | `POST /api/organizers/:id/account` · `DELETE /api/organizers/:id/account` | Link or unlink the account registered with the organizer's contact email |
| Admin | `GET /api/users` · `POST /api/users` · `PATCH /api/users/:id` | List users, add a user without a login, or correct a user's details |

A guest who calls a login-only route gets **401 Please log in first**. A customer who calls an admin route gets **403 Only admins can do this**, and an Organizer who touches another organizer's event gets **403 BR1: you can only manage your own organizer's events** (the website shows the same message without the `BR1:` prefix). The website hides nothing important: the real checks happen in the API (`requireAdmin`, `requireHost` and `assertHostOf` in `src/auth.js`), so even a hand-made request can't get past them.

#### How the login works

- **Passwords** are stored as a salted **scrypt** hash in `users.password_hash`, like `scrypt$16384$8$1$<salt>$<hash>`. The same password gives a different hash for every user, and the hash can't be turned back into the password.
- **Sessions:** after login, the browser gets a random token in an **HttpOnly** cookie, which page JavaScript can't read. The `sessions` table stores only the SHA-256 hash of that token, and a session lasts 7 days.
- A wrong password and an unknown email get the same message, *"Wrong email or password."*, so nobody can find out which emails have accounts.

#### The website

`npm run dev` and open http://localhost:3000. Everything on the page is read from and written to MySQL through the API above. **Log in** (top right) logs in or creates a Customer account. Organizer accounts get an **Attend / Host** switch at the top right; admin accounts (step 5) get a switch between all the user roles in the proposal:

| Role | Screens |
|---|---|
| Attend (customer) | Browse events and today's promotions → event page → seat map with standing zones → reserve (5-minute hold) → pay (split or failed payments allowed) → ticket codes. "Reservations" lists Pending / Paid / Expired / Cancelled bookings. Reserving needs a logged-in account. |
| Host (organizer, or admin acting for any organizer) | Dashboard for the organizer, create an event (seats and/or standing zones per ticket type), open / close / cancel sales. Admins also choose which organizer they act for and create Amount or Percent promotions |
| Manage (manager) | Sales in the last 30 days and takings by payment method (O1), seat status and full events (O2), promotion usage (O4), unpaid holds with live countdowns |
| Admin | Verify organizers (BR13), link organizer accounts, see users and their roles, correct user details, cancel and remove events |

When the API or the database refuses something, the page shows its message in plain words. The API's messages start with the business rule number (for example *"BR11: event needs a ticket type…"*), and `plainError()` in `public/app.js` strips that prefix before showing it. The page never shows rule numbers; where a screen explains a rule, a `// BRxx` comment in `public/app.js` marks which one.

An event has no "kind" of its own. Each ticket type describes numbered seats (`rows` + `seats_per_row`), standing places (`zone_name` + `quantity`), or both, so one event can be all seated, all standing, or a mix. Seats become `seated_units` rows and standing places become `standing_units` rows; all of them count against the same `total_capacity`.

Example ticket type that includes both seats and standing places at the same price:
```json
{ "type_name": "Normal", "price": 300, "rows": ["B"], "seats_per_row": 20, "zone_name": "Lawn", "quantity": 80 }
```
Events and promotions may have an image. `POST /api/events`, `POST /api/promotions` and the `PUT …/image` routes accept either `"image_url": "https://…"` (a link) or `"image_data": "data:image/jpeg;base64,…"` (an uploaded PNG, JPEG, WebP or GIF of at most 2 MB). Uploaded files are stored in MySQL (`image_data MEDIUMBLOB`) rather than on disk, because serverless hosts such as Vercel have no lasting disk. Every listing returns a ready-to-use `image_src`: the link, or `/api/events/:id/image?v=…` for an upload, where `v` changes whenever the image does so browsers never show a stale copy. The website shrinks large photos to 1600 px before uploading.

`GET /api/events/:id` reports `seated_units` / `standing_units` counts, and each unit carries `unit_kind` plus either `row_label` and `seat_number` (Seated) or `zone_name` (Standing); the other fields are `null`. Bookings with more than 2 units need `attendee_name` and `identity_number` on every unit beyond the second (BR24).

---

## Part 2: How the proposal became SQL

### Three layers, one rule of thumb

**Put a rule as low as it can go.** If the database itself refuses bad data, no bug in the API and no one typing into Workbench can break the rule. Each rule lives in the lowest layer that can express it:

| Layer | Files | What it can check |
|---|---|---|
| **Database: constraints** | `db/schema.sql` | One row at a time: `NOT NULL`, `CHECK`, `UNIQUE`, `ENUM`, `FOREIGN KEY` |
| **Database: triggers** | `db/triggers.sql` | Rules that need to look at *other* rows (counts, the event a unit belongs to, the booking's status). Each one raises `SQLSTATE 45000` with a message that starts with the rule number |
| **API: transactions** | `src/services/bookings.js` | Rules that span several statements: "at least one item", the 5-minute lock, expiry, "paid when payments cover the total" |
| **API: checks** | `src/routes/*.js`, `src/auth.js` | Who may do what (login, roles, "your own organizer"), plus early input checks that give a clearer error than the database would |

The website (`public/app.js`) repeats some checks so a form can explain a problem before it's sent, but it's never the thing that enforces a rule. The page doesn't show rule numbers; `// BRxx` comments in the source mark where each rule shows up.

### Business rules, one by one

The **Database** column is the guarantee. The **API** column is either a second line of defence (a friendlier error before the database sees the data) or, where the database column is empty, the only place the rule lives.

#### Relationships and cardinality

| Rule | Meaning | Database | API |
|---|---|---|---|
| **BR1** | Every event belongs to exactly one organizer, and only that organizer (or an admin) manages it | `events.organizer_id NOT NULL` + `fk_events_organizer` | `assertHostOf()` in `src/auth.js`: an Organizer account may only create, open, close, cancel or change the image of its own organizer's events. `GET /api/events?status=…` and `GET /api/organizers` show an Organizer only their own |
| **BR2** | Events and ticket types are many-to-many, with a price per event | Bridge table `event_ticket_types`; `UNIQUE (event_id, type_id)` | `POST /api/events` refuses the same `type_name` twice |
| **BR3** | Each admission unit belongs to one ticket type of one event | `admission_units.event_ticket_type_id NOT NULL` + FK; `trg_units_bu` refuses moving a unit to another event's ticket type | — |
| **BR4** | Every booking belongs to exactly one user | `bookings.user_id NOT NULL` + `fk_bookings_user` | Every `/api/bookings` route needs a login (`requireUser`). The booking is always made for the logged-in user, and only that user (or an admin) can see, pay or cancel it (`assertSelfOrAdmin`) |
| **BR5** | Bookings and admission units are many-to-many | Bridge table `booking_items`; `UNIQUE (booking_id, unit_id)` | `POST /api/bookings` refuses the same `unit_id` twice |
| **BR6** | Each payment belongs to one booking; a booking may have many payments | `payments.booking_id NOT NULL` + `fk_payments_booking` | — |
| **BR7** | A booking item has at most one ticket | `UNIQUE (booking_item_id)` on `tickets` | `payBooking()` issues exactly one ticket per item |
| **BR8** | A booking uses at most one promotion | A single nullable `bookings.promo_id`: one column can't hold two | `POST /api/bookings` takes one `promo_code` |
| **BR9** | A booking has at least one item | Can't be said in SQL ("at least one child row") | `POST /api/bookings` refuses an empty `units` list. `createBooking()` inserts the booking and its items in one transaction, so a booking with no items is never committed |

#### Events, organizers and admission units

| Rule | Meaning | Database | API |
|---|---|---|---|
| **BR10, BR25** | Admission units are specialised into Seated and Standing. Every unit is exactly one of them: never both (disjoint), never neither (total) | **Disjoint:** each subtype table has a fixed `unit_kind` (`CHECK (unit_kind = 'Seated')`) and a composite FK to `admission_units (unit_id, unit_kind)`. **Total:** `trg_events_bu` refuses to open an event for sale while any of its units has no subtype row | `POST /api/events` inserts each unit and its subtype row in one transaction. `createBooking()` refuses a unit with no seat or standing details |
| **BR11** | An event can go on sale only once it has at least one ticket type with units | `trg_events_bu` (when `event_status` changes to `On_sale`) | `POST /api/events` refuses an empty `ticket_types` list |
| **BR13** | Only a verified organizer can create events | `trg_events_bi`. `ck_organizers_verified`: a Verified organizer must have `verified_at` | New organizers start **Pending** (`POST /api/auth/register-organizer`, `POST /api/organizers`). Only an admin can change `verification_status` (`PATCH /api/organizers/:id/verification`) |
| **BR16** | A seated unit has a row and seat number, unique within the event. A standing unit has only a zone | `seated_units.row_label`, `seat_number NOT NULL`, `seat_number > 0`; `standing_units` has no row/seat columns at all, only `zone_name NOT NULL`. `trg_seated_units_bi` / `_bu` (via `check_seat_unique`) refuse a repeated row + seat anywhere in the same event | `POST /api/events` refuses a row label listed twice |
| **BR22** | An event never has more units than `total_capacity` | `trg_units_bi` | `POST /api/events` counts the units it is about to create first |
| **BR23** | An event is in the future, and nobody can book it once it has happened | `ck_events_future CHECK (event_date > created_at)`; `trg_booking_items_bi` refuses an item if the booking was made on or after the event date | `createBooking()` refuses events whose `event_date` has passed. Only `On_sale` events can be booked |

#### Bookings, payments and tickets

| Rule | Meaning | Database | API |
|---|---|---|---|
| **BR12** | A ticket is issued only for a sold item of a Paid booking | `trg_tickets_bi` | `payBooking()` marks the booking Paid and the items sold *before* inserting tickets, in one transaction |
| **BR17** | A new booking locks its units for 5 minutes | `ck_bookings_lock CHECK (lock_expires_at = created_at + INTERVAL 5 MINUTE)` | `createBooking()` locks the unit rows with `SELECT … FOR UPDATE`, refuses units that aren't Available, and sets them to Locked. `HOLD_MINUTES = 5` must match the CHECK |
| **BR18** | An unpaid booking whose lock has run out becomes Expired and its units go back on sale | — (no timer in the database; see idea 5 below) | `expireStaleBookings()` runs before every request that reads or changes seat status. `payBooking()` expires a booking that is paid too late |
| **BR19** | Payment amounts are above zero, and a booking becomes Paid once its **Successful** payments cover the total (it may be split over several payments; Failed and Pending ones don't count) | `ck_payments_amount CHECK (amount > 0)` | `payBooking()` sums the Successful payments and, when they reach `total_amount`, marks the booking Paid, the items sold and the units Sold, then issues tickets |
| **BR20** | A unit is sold once and only once | Generated column `sold_unit_id` + `UNIQUE (sold_unit_id)` (see idea 2) | — |
| **BR21** | Prices are above zero, and the price and discount a customer gets are frozen on the booking | `ck_ett_price`, `ck_items_price` (`> 0`); `booking_items.price_paid` and `bookings.discount_amount_applied` store copies | `createBooking()` copies each unit's current price into `price_paid` and works out the discount once, when the booking is made. Later price changes never touch existing bookings |
| **BR24** | Up to 2 tickets per booking need no ID. Every ticket after the 2nd needs `attendee_name` and `identity_number`, and one `identity_number` can hold only one ticket per event (counting Pending and Paid bookings) | `trg_booking_items_bi` | `POST /api/bookings` checks the attendee details first. `createBooking()` inserts the items without details first, so the ones with details are the 3rd and later rows the trigger checks. `FREE_SEATS_WITHOUT_ID = 2` |

#### Values, uniqueness and promotions

| Rule | Meaning | Database | API |
|---|---|---|---|
| **BR14** | Status and type columns only take their allowed values | `ENUM` columns: `event_status`, `unit_kind`, `unit_status`, `booking_status`, `payment_method`, `payment_status`, `type_name`, `discount_type`, plus `role` and `verification_status` | `v.oneOf()` in `src/validate.js` refuses other values with a clear message before the SQL runs |
| **BR15** | Things that identify something are unique | `UNIQUE` on `users.email`, `tickets.ticket_code`, `ticket_type_catalog.type_name` and `event_ticket_types (event_id, type_id)`. Also unique, though not tagged: `promotions.coupon_code`, `organizers.contact_email`, `organizers.user_id` | `POST /api/auth/register` turns a duplicate email into *"An account with that email already exists."* |
| **BR26** | Promotions are specialised into Amount and Percent discounts. Every promotion is exactly one of them | **Disjoint:** `amount_discounts` / `percent_discounts` use the same fixed-`discount_type` + composite-FK pattern as BR25. Their values are checked too (`discount_amount > 0`, `0 < discount_percent <= 100`, `max_discount_cap > 0`) | **Total:** `POST /api/promotions` inserts the promotion and its one subtype row in one transaction. `discountFor()` applies the amount, or the percent up to its cap |
| **BR27** | A promotion applies only to bookings made between its start and end dates | `trg_bookings_bi`; `ck_promotions_period CHECK (end_date >= start_date)` | `createBooking()` looks the code up only among promotions valid today |

### How a broken rule reaches the user

1. A trigger raises `SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'BR13: organizer must be verified…'`, or a constraint fails (`ER_CHECK_CONSTRAINT_VIOLATED`, `ER_DUP_ENTRY`, …). API checks throw `HttpError(400 / 403 / 409, 'BRxx: …')` the same way.
2. `errorHandler` in `src/errors.js` turns it into a JSON reply: `409` for a trigger, `409` for a duplicate, `400` for a CHECK or a bad foreign key. The body is `{ "error": "BR13: organizer must be verified…" }`.
3. The rule number stays in the API reply, so `curl`, Workbench and `npm run test:api` can tell which rule fired (the tests match on it, for example `/BR13/`).
4. The website's `plainError()` removes the `BRxx:` prefix and shows *"Organizer must be verified before creating an event"*.

### Five ideas worth understanding

**1. The subtype pattern (EER specialisation in SQL).**
`seated_units` stores a fixed `unit_kind = 'Seated'` and points at `admission_units(unit_id, unit_kind)`, a *composite* foreign key. If you try to add a `standing_units` row for a seated unit, the pair `(1, 'Standing')` doesn't exist in `admission_units`, so the database refuses it. That's how "disjoint" becomes a constraint and not just a sentence. "Total" (every unit has a subtype row) can't be a constraint, because the supertype row has to exist first, so `trg_events_bu` checks it at the moment it matters: before the event goes on sale. Promotions use the same pattern.

**2. "Sold once and only once" (BR20) with a generated column.**
```sql
sold_unit_id INT AS (IF(sold_at IS NULL, NULL, unit_id)) STORED,
UNIQUE (sold_unit_id)
```
A UNIQUE index ignores NULLs. While a unit is only *held*, `sold_unit_id` is NULL, so expired and cancelled bookings can reference the same unit. Once `sold_at` is filled, it becomes the unit id, and a second sale of that unit collides with the first one.

**3. Transactions: all or nothing.**
Paying a booking changes four tables (payments, bookings, booking_items, admission_units) and inserts tickets. If the server crashed halfway, you'd have a paid booking with unsold seats. `transaction()` in `src/db.js` wraps the steps in `BEGIN … COMMIT`, and any error does a `ROLLBACK`, so the database never sees half a payment.

**4. Row locks: why double booking is impossible.**
In `createBooking`:
```sql
SELECT ... FROM admission_units u ... WHERE u.unit_id IN (...) FOR UPDATE OF u
```
`FOR UPDATE` locks those unit rows until the transaction ends. If two students click seat A3 at the same moment, the second `SELECT` *waits*. When it continues, it sees `Locked` and gets a 409. The test "two buyers race for the same seat" proves this: it fires both requests at once, and exactly one wins. This is the main fix for pain point #1 in your proposal: the spreadsheet couldn't say no, but the database can.

**5. Expiring holds without a timer (BR18).**
Holds expire lazily. Before any request reads seat status, `expireStaleBookings()` frees every hold whose `lock_expires_at` has passed. Nothing has to run in the background, which matters in Part 3 because serverless hosts don't run code between requests. (MySQL also has `CREATE EVENT … ON SCHEDULE EVERY 1 MINUTE`, but many cloud providers turn the event scheduler off.) The website also asks the server to re-check a booking when its countdown reaches zero, so the screen updates straight away.

### Exercises (good practice before the exam)

Run `npm run db:setup` for fresh sample data, then try each of these in Workbench and read the error message. Each one should fail:
```sql
INSERT INTO standing_units (unit_id, zone_name) VALUES (1, 'Lawn');               -- BR25: unit 1 is seat A1
INSERT INTO events (organizer_id, event_name, event_date, venue_name, total_capacity)
  VALUES (3, 'Test', NOW() + INTERVAL 30 DAY, 'Hall', 10);                         -- BR13: Night Market Live is Pending
UPDATE events SET event_status = 'On_sale' WHERE event_id = 4;                     -- BR11: no ticket types yet
UPDATE seated_units SET row_label = 'A', seat_number = 2 WHERE unit_id = 1;       -- BR16: A2 already exists
INSERT INTO booking_items (booking_id, unit_id, price_paid) VALUES (5, 54, 150);  -- BR24: 4th ticket without ID
INSERT INTO booking_items (booking_id, unit_id, price_paid, sold_at)
  VALUES (6, 1, 1200, NOW());                                                      -- BR20: unit 1 is already sold
INSERT INTO tickets (booking_item_id, ticket_code) VALUES (12, 'X');              -- BR12: booking 6 expired
UPDATE bookings SET booking_status = 'Refunded' WHERE booking_id = 1;             -- BR14
```
Next, open two Workbench tabs and recreate the race by hand. In tab 1 run `START TRANSACTION; SELECT * FROM admission_units WHERE unit_id = 20 FOR UPDATE;`. In tab 2 run the same two lines and watch it hang. Then run `COMMIT;` in tab 1, and tab 2 continues.

---

## Part 3: Put it in the cloud

### The key idea

You need **two** things hosted:

1. **The database.** A MySQL server running 24/7 somewhere.
2. **The app.** Your Express server plus the `public/` files.

Your proposal says "Vercel if we deploy". That's fine for the **app**, but **Vercel doesn't host MySQL**, so you need a separate MySQL provider. The app connects to it using the same `.env` variables, but with the provider's values.

### Step 1: Choose a cloud MySQL

| Provider | Notes |
|---|---|
| **Aiven for MySQL** (recommended) | Real MySQL 8, free plan available, works with triggers |
| Railway | Easy, but uses trial credits, not free forever |
| Google Cloud SQL / AWS RDS / Azure | Industry standard, but setup takes more effort and needs a credit card. Student credits often cover it |
| TiDB Cloud Serverless | MySQL-*compatible* with a generous free tier, **but doesn't support triggers**, so `triggers.sql` would fail. Avoid it for this project |

Free tiers change often, so check the provider's current pricing page before you sign up.

### Step 2: Create the database (Aiven example)

1. Sign up at aiven.io, then go to **Create service → MySQL → Free plan**. Pick a region close to Thailand (for example Singapore).
2. When it's running, the **Overview** page shows Host, Port, User (`avnadmin`), and Password, plus a **CA certificate** to download. Save the certificate as `ca.pem` in the project folder. `*.pem` is git-ignored.
3. Go to **Advanced configuration** and turn on `log_bin_trust_function_creators`. Cloud MySQL blocks triggers without it, and `db:setup` prints this hint if you forget.
4. Put the values in `.env` (see the "Cloud MySQL" block in `.env.example`):
   ```
   DB_HOST=…aivencloud.com
   DB_PORT=…
   DB_USER=avnadmin
   DB_PASSWORD=…
   DB_NAME=bookify
   DB_SSL=true
   DB_SSL_CA=./ca.pem
   ```
5. Run `npm run db:setup` from your laptop. The same script now builds the database **in the cloud**. Run `npm run test:api` to confirm, then `npm run db:setup` again for clean data.
6. In Workbench, add a new connection with the same host, port and user. On the **SSL** tab, set *Use SSL* to *Require* and choose `ca.pem` as the CA file. Now you can run `queries.sql` against the cloud database.

TLS (`DB_SSL=true`) encrypts the connection. Cloud databases are reachable from the internet, so your password must never travel in plain text.

### Step 3: Deploy the app

**Option A: Vercel** (matches your proposal)
1. Push the project to GitHub. Check that `.env` and `ca.pem` are **not** in the commit.
2. On vercel.com, go to **Add New → Project** and import the repo. Vercel detects Express from `server.js` (it exports `app`). Check Vercel's current Express docs if the build complains.
3. Go to **Settings → Environment Variables** and add every `DB_*` variable. For `DB_SSL_CA`, paste the **contents** of `ca.pem`, because there's no file on Vercel. Also add `DB_POOL_SIZE=2`, since each serverless instance opens its own connections and free databases allow only a few.
4. Deploy, then open `https://<your-app>.vercel.app/api/health`. It should show `"ok": true` and the MySQL version.

**Option B: Render or Railway** (a "normal" always-running server)
Create a **Web Service** from the repo, with build command `npm install` and start command `npm start`. Add the same environment variables. This is closer to how `npm run dev` behaves locally. On a free plan the server sleeps when idle, so the first request after a while is slow.

### Step 4: Good habits to know (not required for the lab)

- **Least privilege:** create a separate MySQL user for the app with only `SELECT, INSERT, UPDATE, DELETE` on `bookify`. Use the admin user only for `db:setup`.
- **Backups:** paid plans take daily backups. On a free plan, use **Server → Data Export** in Workbench before big changes.
- **Never** commit `.env`. If a password ever reaches GitHub, change it immediately in the provider's dashboard.

---

## What isn't done yet

- **Proposal update:** login is now built, so move "User login security" from out of scope to in scope, and add `password_hash` and `role` (Customer / Organizer / Admin) to Users, `user_id` to Organizers (the account that runs it, 0..1 to 0..1), and the `sessions` table to your entity list and ERD.

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
| `db/triggers.sql` | Rules that need to look at other rows (BR10–BR13, BR16, BR22, BR25, BR26) |
| `db/seed.sql` | Sample data (milestone M4 sample data) |
| `db/queries.sql` | 12 report queries (milestone M5 needs ≥ 10) |
| `src/services/bookings.js` | Lock → pay → sell flow, run as transactions (BR9, BR17–BR19) |
| `src/routes/*.js` | The HTTP API |
| `scripts/db-setup.js` | Builds the database from the `db/` files |
| `src/auth.js`, `src/routes/auth.js` | Sign up, log in, sessions, and the "admins only" checks |
| `scripts/make-admin.js` | Turns a registered account into an Admin |
| `scripts/smoke-test.js` | 49 automatic checks of the API, the login rules and the database rules |

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
npm run test:api      # 49 checks; should end with "49 checks passed."
npm run dev           # http://localhost:3000 serves the site, http://localhost:3000/api/... the API
```

`db:setup` **drops and rebuilds** all Bookify tables, so run it whenever you want a clean copy. `test:api` changes data, so run `db:setup` again before running the tests a second time.

### 4. Look at it in MySQL Workbench

1. Connect to `localhost:3306`. In the schema list, double-click `bookify`.
2. Open `db/queries.sql` and run the queries one at a time (Ctrl+Enter on a query). Screenshots of these results are your M5 deliverable.
3. Go to **Database → Reverse Engineer…** and pick `bookify`. Workbench draws the diagram from the real tables. Compare it with your Draw.io ERD: every entity should be there, with the same keys. This is the "free check on our diagram" your tech-stack table mentions.

### 5. Create your admin account

Everyone who signs up on the website is a **Customer**: they can browse and book, but they can't open the **Host** side. To make an admin:

1. Run `npm run dev`, open http://localhost:3000, click **Sign up**, and create your account with your own password.
2. In the terminal, promote that account:
   ```bash
   npm run make-admin -- your-email@example.com
   ```
3. Reload the page. You'll see an **Admin** badge next to your initials, and **Host** now opens.

To turn an admin back into a customer, run `npm run make-admin -- your-email@example.com --remove`. The admin's password never goes into a script or SQL file: they type it on the website, and only a hash is stored.

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
| Anyone | `POST /api/auth/login` · `POST /api/auth/logout` | Log in or out (sets or clears the `bookify_session` cookie) |
| Anyone | `GET /api/auth/me` | The logged-in user, or `null` |
| Anyone | `GET /api/events` · `GET /api/events/:id` | Events on sale, and one event with every seat's status |
| Anyone | `GET /api/promotions` | Promotion codes |
| Logged in | `POST /api/bookings` | Lock seats for 5 minutes (`units`, optional `promo_code`) |
| Logged in | `POST /api/bookings/:id/payments` | Pay your booking (`payment_method`, `amount`, optional `payment_status`) |
| Logged in | `POST /api/bookings/:id/cancel` | Cancel your unpaid booking |
| Logged in | `GET /api/bookings/:id` · `GET /api/users/:id/bookings` | Your own booking or reservations (admins can see anyone's) |
| Admin | `POST /api/events` | Host a Draft event with its seats (see the comment in `src/routes/events.js`) |
| Admin | `PATCH /api/events/:id/status` · `DELETE /api/events/:id` | Open, close or cancel an event; remove a cancelled event that has no bookings |
| Admin | `POST /api/promotions` | Create Amount / Percent promotions |
| Admin | `GET /api/reports/...` | `sales-last-30-days` (O1), `seat-status` (O2), `promotion-usage` (O4), `pending-bookings`, `events/:id/revenue` |
| Admin | `/api/organizers...` | List, register and verify organizers (BR13) |
| Admin | `POST /api/users` · `PATCH /api/users/:id` | Add a user, or correct a user's details |

A guest who calls a login-only route gets **401 Please log in first**. A customer who calls an admin route gets **403 Only admins can do this**. The website hides nothing important: the real check happens in the API (`requireAdmin` in `src/auth.js`), so even a hand-made request can't get past it.

#### How the login works

- **Passwords** are stored as a salted **scrypt** hash in `users.password_hash`, like `scrypt$16384$8$1$<salt>$<hash>`. The same password gives a different hash for every user, and the hash can't be turned back into the password.
- **Sessions:** after login, the browser gets a random token in an **HttpOnly** cookie, which page JavaScript can't read. The `sessions` table stores only the SHA-256 hash of that token, and a session lasts 7 days.
- A wrong password and an unknown email get the same message, *"Wrong email or password."*, so nobody can find out which emails have accounts.

---

## Part 2: How the proposal became SQL

### Where each business rule is enforced

A good rule of thumb: **put a rule as low as it can go.** If the database itself refuses bad data, no bug in any app, and no one typing into Workbench, can break the rule.

| Rule | Enforced by | Where |
|---|---|---|
| BR1–BR8 cardinality | `FOREIGN KEY` (the "many" side holds the key). M:N becomes a bridge table | schema.sql |
| BR7 "at most one ticket per item" | `UNIQUE (booking_item_id)` on tickets | schema.sql |
| BR8 "at most one promotion" | A single `promo_id` column on bookings; one column can't hold two | schema.sql |
| BR9 "at least one item" | Transaction in `createBooking` (SQL can't say "at least one child row") | bookings.js |
| BR10 / BR23 / BR24 disjoint + total | Composite FK `(event_id, event_kind)` + `CHECK (event_kind='Seated')` makes it disjoint; `trg_events_bu` makes it total before going on sale | schema.sql, triggers.sql |
| BR11 | `trg_events_bu` | triggers.sql |
| BR12 | `trg_tickets_bi` | triggers.sql |
| BR13 | `trg_events_bi` | triggers.sql |
| BR14 allowed values | `ENUM(...)` columns | schema.sql |
| BR15 uniqueness | `UNIQUE` constraints | schema.sql |
| BR16 | `CHECK` (row and seat both or neither) + `trg_units_bi/bu` | both |
| BR17 5-minute lock | `CHECK (lock_expires_at = created_at + INTERVAL 5 MINUTE)` | schema.sql |
| BR18 expiry | `expireStaleBookings()` | bookings.js |
| BR19 paid when payments cover total | `payBooking()` | bookings.js |
| BR20 sold once only | Generated column + `UNIQUE` (explained below) | schema.sql |
| BR21 price > 0, frozen prices | `CHECK`; `price_paid` / `discount_amount_applied` copied at sale time | both |
| BR22 capacity, promotion period | `trg_units_bi`, `trg_bookings_bi` | triggers.sql |
| BR25 | `CHECK (event_date > created_at)` + `trg_booking_items_bi` | both |
| BR26 2-ticket ceiling | `trg_booking_items_bi` + attendee columns on booking_items | both |

### Five ideas worth understanding

**1. The subtype pattern (EER specialisation in SQL).**
`seated_events` stores a fixed `event_kind = 'Seated'` and points at `events(event_id, event_kind)`, a *composite* foreign key. If you try to add a `non_seated_events` row for a seated event, the pair `(1, 'Non_Seated')` doesn't exist in `events`, so the database refuses it. That's how "disjoint" becomes a constraint and not just a sentence. Promotions use the same pattern.

**2. "Sold once and only once" (BR20) with a generated column.**
```sql
sold_unit_id INT AS (IF(sold_at IS NULL, NULL, unit_id)) STORED,
UNIQUE (sold_unit_id)
```
A UNIQUE index ignores NULLs. While a seat is only *held*, `sold_unit_id` is NULL, so expired and cancelled bookings can reference the same seat. Once `sold_at` is filled, it becomes the unit id, and a second sale of that unit collides with the first one.

**3. Transactions: all or nothing.**
Paying a booking changes four tables: payments, bookings, booking_items, and admission_units, plus inserting tickets. If the server crashed halfway, you'd have a paid booking with unsold seats. `transaction()` in `src/db.js` wraps the steps in `BEGIN … COMMIT`, and any error does a `ROLLBACK`, so the database never sees half a payment.

**4. Row locks: why double booking is impossible.**
In `createBooking`:
```sql
SELECT ... FROM admission_units u ... WHERE u.unit_id IN (...) FOR UPDATE OF u
```
`FOR UPDATE` locks those seat rows until the transaction ends. If two students click seat A3 at the same moment, the second `SELECT` *waits*. When it continues, it sees `Locked` and gets a 409. The test "two buyers race for the same seat" proves this: it fires both requests at once, and exactly one wins. This is the main fix for pain point #1 in your proposal: the spreadsheet couldn't say no, but the database can.

**5. Expiring holds without a timer.**
Holds expire lazily. Before any request reads seat status, `expireStaleBookings()` runs one `UPDATE` that frees every hold whose `lock_expires_at` has passed. Nothing has to run in the background, which matters in Part 3 because serverless hosts don't run code between requests. (MySQL also has `CREATE EVENT … ON SCHEDULE EVERY 1 MINUTE`, but many cloud providers turn the event scheduler off.)

### Exercises (good practice before the exam)

Try each of these in Workbench and read the error message. Each one should fail:
```sql
INSERT INTO non_seated_events (event_id, zone_name) VALUES (1, 'Lawn');          -- BR23
INSERT INTO tickets (booking_item_id, ticket_code) VALUES (12, 'X');              -- BR12
UPDATE bookings SET booking_status = 'Refunded' WHERE booking_id = 1;             -- BR14
INSERT INTO admission_units (event_ticket_type_id, row_label, seat_number) VALUES (1, 'A', 1);  -- BR16
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

- **Only login is connected to the API.** Sign up, Log in, Sign out and the Host lock use the real accounts. Events, seats, bookings and the Host dashboard in `public/app.js` are still in-memory demo data (with euros, a 6-seat limit and card payment). Connecting them means replacing those arrays with `fetch('/api/…')` calls.
- **Proposal update:** login is now built, so move "User login security" from out of scope to in scope, and add `password_hash` and `role` to Users plus the `sessions` table to your entity list and ERD.

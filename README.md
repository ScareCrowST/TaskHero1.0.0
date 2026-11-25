# 🛡️ TaskHero

A gamified, ManageBac-style homework platform for IB MYP schools. Teachers post assignments and grade work against MYP criteria (A–D, 0–8); students hand in answers and files and earn XP, levels and streaks; school admins manage their own people. **Every school gets its own database file**, and the whole thing runs on a school's own computer at `http://localhost:3000` with **zero dependencies** (just Node.js).

> Built as an IB MYP Personal Project.

## What it does

| Role | Can do |
|---|---|
| **Student** | Join classes with a code · see assignments and deadlines · type an answer and/or upload files · see *submitted / late / graded* · read MYP criteria grades and feedback · monthly calendar · personal quests · level up a pixel hero (XP, streak multiplier, titles, avatar editor) · class discussions |
| **Teacher** | Create classes (join code) · post assignments with instructions, criteria, due date and attached worksheets · download submissions · grade criteria A–D (0–8) + written feedback · class gradebook · announcements · manage class roster |
| **School admin** | Create accounts one by one or by CSV import (temporary passwords) · approve teacher sign-ups · reset passwords · disable accounts · turn student self sign-up on/off · school overview |
| **Super admin** | Approve / reject / revoke / delete schools (deleting removes the school's database and files) |

## Quick start (localhost)

You need **Node.js 22.13 or newer** ([nodejs.org](https://nodejs.org)). There is nothing to install.

```bash
git clone https://github.com/ScareCrowST/TaskHero1.0.0.git
cd TaskHero1.0.0
npm start            # or: node server/index.js
```

Open **http://localhost:3000**.

On the very first start the terminal prints a one-time **super-admin password**. Save it. (Lost it? `npm run reset-admin`.)

### Try it with demo data

```bash
npm run seed         # creates an approved school "DEMO-SCHOOL"
npm start
```

Log in with School ID `DEMO-SCHOOL` and password `Demo12345`:

| Username | Role |
|---|---|
| `alex`, `sam`, `mira` | students (class join code `DEMO-MATH`) |
| `ms_rivera` | teacher |
| `demo_admin` | school admin |

### Setting up a real school

1. Go to `/register-school` and register the school (choose a School ID such as `ISP-2026`, create the admin account).
2. Open `/superadmin`, log in, and **approve** the school. This creates its own database file.
3. The school admin logs in with the School ID → *People* → add teachers/students (or import a CSV). Students can also sign up themselves with the School ID.
4. Teachers create classes and give students the join code.

### Using it on a school network

By default the server only listens on `127.0.0.1` (this computer). To let other computers in the school open it:

```bash
HOST=0.0.0.0 PORT=3000 npm start      # Windows PowerShell:  $env:HOST="0.0.0.0"; npm start
```

then browse to `http://<this-computer's-IP>:3000`. If you put it behind HTTPS, also set `TASKHERO_COOKIE_SECURE=1`.

### Configuration (environment variables)

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `3000` | Port to listen on |
| `HOST` | `127.0.0.1` | Interface to listen on (`0.0.0.0` = whole network) |
| `TASKHERO_DATA` | `./data` | Where databases and uploads live |
| `TASKHERO_MAX_UPLOAD_MB` | `10` | Maximum size of one uploaded file |
| `TASKHERO_ADMIN_PASSWORD` | random | Super-admin password used on first start |
| `TASKHERO_COOKIE_SECURE` | off | Set to `1` when served over HTTPS |

## Where the data lives

```
data/
  master.db                 schools registry, sessions, super-admin login
  schools/DEMO-SCHOOL.db    ONE database per school (users, classes, work, grades...)
  uploads/DEMO-SCHOOL/...   that school's uploaded files (random names)
```

A school's data can't be reached through another school's ID: each request opens only the database of the school in the logged-in session. Deleting a school in `/superadmin` deletes its `.db` file and uploads.

### Backups

```bash
npm run backup                      # writes ../backups/taskhero-<date>/
node server/cli.js backup D:\usb    # or to a folder of your choice
```

Safe to run while the server is running. To restore: stop TaskHero, copy `master.db`, `schools/` and `uploads/` from the backup into `data/`, start again.

Other commands: `node server/cli.js list-schools`, `npm run reset-admin`.

## Security notes

- Passwords are hashed with **scrypt** (salted) – never stored or sent back in plain text.
- Sessions are random tokens in an `HttpOnly`, `SameSite=Strict` cookie; only a hash of the token is stored.
- Repeated failed logins are rate-limited.
- Every state-changing request needs an `X-TaskHero` header and a same-origin check (CSRF protection).
- Strict Content-Security-Policy: no inline scripts, no external resources. All user text is HTML-escaped when shown.
- Uploads: allow-listed file types, size limit, random server-side names, always served as a download (`nosniff`) – never executed or rendered.
- XP, levels and streaks are calculated on the server; XP is paid once per assignment, personal quests give a small fixed amount (max 3 a day), so it can't be farmed or edited in the browser.
- Role checks happen on the server for every route; other classes/schools look like "not found".

TaskHero has no email, so password resets are done by the school admin, who hands over a one-time temporary password. This is meant for a trusted school network – if you expose it to the internet, put it behind HTTPS.

## Development

```bash
npm test                 # 32 API/unit tests (node:test)
npm run e2e              # real-browser test on localhost (needs Playwright installed globally)
```

```
server/   index.js (HTTP server, security headers, router) · routes/ · lib/ (db, auth, xp, uploads)
public/   index.html · register-school.html · superadmin.html · css/ · js/ (modules, no build step)
tests/    api.test.js · backup.test.js · e2e.js
docs/     project notes for the Personal Project report
```

### Fonts

The original design used the *Press Start 2P* and *Space Grotesk* web fonts from a CDN. TaskHero now loads **no external resources** so it works offline and keeps student data on the school's server, so system fonts are used. To bring the pixel fonts back, download the two `.woff2` files into `public/fonts/` and add `@font-face` rules for them to `public/css/app.css`.

## Licence

MIT

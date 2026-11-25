# TaskHero 2.0 – project notes (for the Personal Project report / process journal)

These notes record what changed from the first prototype (v1, browser-only) to v2 (server + per-school databases), **why**, and how it was tested. Use them as evidence for Criteria B (planning) and C (taking action).

## 1. Analysis of version 1

| Finding | Why it mattered | Fixed in v2 by |
|---|---|---|
| All data in each browser's `localStorage` | Teacher and student never shared data, so "submitting homework" could not work | Node server + SQLite |
| The logged-in user was a *copy* of the user in the users list; XP was saved to the copy | Progress was lost after logging out and in again (breaks the success criterion "data reloads correctly") | XP lives only in the database, tested after a fresh login |
| XP could be farmed (tick/untick a task, create 100-XP tasks) | Rewards meant nothing | XP paid once per assignment/quest, fixed quest value, 3 quests/day cap, all server-side |
| Super-admin password hard-coded in a public repo; plain-text passwords; approval was a flag in `localStorage` | Anyone could approve a school or read passwords | scrypt hashing, random first-run admin password, server-side approval |
| User text inserted into HTML unescaped, inline `onclick` with user text | Script injection (XSS) | Escaping template helper, strict CSP, no inline handlers |
| Discussions global, joining a class did not check school | No school separation | One database file per school |
| "Submit" was a checkbox; no files, grades or teacher view | Not ManageBac-like | Assignments, uploads, submissions, MYP criteria grading, gradebook |

## 2. Design decisions (and trade-offs)

* **One SQLite file per school** instead of one shared database with a `school_id` column. A coding slip cannot leak data between schools, a school can be backed up/moved/deleted as one file, and it matches the plan to "connect a database for every separate school". Trade-off: schema changes must be applied to every school file (done automatically when a school database is opened).
* **No dependencies** (Node's built-in HTTP server and `node:sqlite`). A school only needs Node – no `npm install`, no build step – which makes the final "run it on localhost" step reliable. Trade-off: a small hand-written router.
* **Accounts and a database instead of "no accounts"**. The original Safety plan said "no accounts, no passwords, zero database connections". A homework platform needs to know who submitted what, so this changed. The safety goal is now met differently: each school hosts its own server, passwords are hashed, no external services or fonts are loaded, and school data is separated. *Update the Safety criterion in the report to say this.*
* **Server-side XP** so students can't edit their own score.

## 3. Testing evidence

| Layer | What | Where |
|---|---|---|
| API / security (32 tests) | role permissions, school isolation, CSRF, rate limit, path traversal, upload rules, XP rules, grading flow, backup/restore | `npm test` |
| Real browser on localhost (19 checks) | landing → sign-in → submit work with file → teacher grades → student sees feedback → quests, calendar, avatar → admin creates account with forced password change → school registration + super-admin approval → mobile layout | `npm run e2e` (Chromium, screenshots saved) |

Bugs found *by* the tests while building (good material for the "evaluation / problems solved" parts of the journal):
1. Phone layout: the top bar and the sidebar overflowed/disappeared at 390 px wide – fixed with a horizontally scrolling tab menu.
2. Registration rate-limit was shared by all test schools registering from one IP – made configurable.
3. A test selector matched hidden landing-page text – tests now scope to the app view.

## 4. Things still open

* Real-user testing (a teacher and 3–5 students for 1–2 weeks) – needed for Criterion C/D evidence.
* Pixel fonts need to be self-hosted (see README → Fonts).
* No e-mail: password resets go through the school admin.
* Not yet built (ideas for "future development"): late-work policies, rubric comments per criterion, file preview, notification badges, CSV export of grades.

## 5. Inconsistencies in the report/journal worth fixing

* Hosting: report says GitHub, journal says Vercel – the final product runs on localhost.
* Audience: MYP 1–3 in one place, MYP 1–4 in another.
* Timeline contains "September 31"; journal stages after the first are still "Not completed".
* Safety criterion – see section 2.

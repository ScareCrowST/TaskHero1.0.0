'use strict';
/**
 * Browser end-to-end test (real Chromium against a real localhost server).
 *   node tests/e2e.js [screenshot-dir]
 * Needs Playwright (not a project dependency, so it is not part of `npm test`).
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const shots = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'th-shots-'));
fs.mkdirSync(shots, { recursive: true });
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'th-e2e-'));
process.env.TASKHERO_DATA = dir;
process.env.TASKHERO_ADMIN_PASSWORD = 'SuperSecret123';
execFileSync('node', [path.join(__dirname, '..', 'server', 'cli.js'), 'seed-demo'], { env: process.env, stdio: 'ignore' });

const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const { start, server } = require('../server/index.js');

const problems = [];
const consoleErrors = [];
let passed = 0;
const pages = [];
async function step(name, fn) {
  try { await fn(); passed++; console.log('  ✔', name); } catch (e) {
    problems.push(name + ': ' + e.message.split('\n')[0]); console.log('  ✖', name, '\n     ', e.message.split('\n').slice(0, 6).join('\n      '));
    if (process.env.E2E_DEBUG) {
      for (const [i, pg] of pages.entries()) {
        try { console.log(`     [page ${i}] ${pg.url()} :: ${(await pg.textContent('#view', { timeout: 1500 })).replace(/\s+/g, ' ').slice(0, 260)}`); } catch { /* page closed */ }
      }
      console.log('     [console errors]', consoleErrors.slice(-5));
      for (const [i, pg] of pages.entries()) { try { await pg.screenshot({ path: path.join(shots, `fail-${i}.png`) }); } catch { /* ignore */ } }
    }
  }
}

(async () => {
  const { port } = await start({ port: 0, quiet: true });
  const base = `http://127.0.0.1:${port}`;
  const browser = await chromium.launch();
  async function newPage(viewport = { width: 1280, height: 850 }) {
    const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1 });
    const page = await ctx.newPage();
    pages.push(page);
    page.setDefaultTimeout(10000);
    page.on('console', (m) => { if (m.type() === 'error' || /Content Security Policy/i.test(m.text())) consoleErrors.push(m.text()); });
    page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + e.message));
    page.on('dialog', (d) => d.accept(d.type() === 'prompt' ? 'DEMO-SCHOOL' : undefined));
    return page;
  }
  const shot = async (page, name) => { await page.waitForTimeout(900); await page.screenshot({ path: path.join(shots, name + '.png') }); }; // wait for fade-in / theme transitions
  async function login(page, school, user, pass) {
    await page.goto(base + '/');
    await page.click('#landing .nav-links [data-action=show-login]');
    await page.fill('#loginForm [name=school]', school);
    await page.fill('#loginForm [name=username]', user);
    await page.fill('#loginForm [name=password]', pass);
    await page.click('#loginForm button[type=submit]');
    await page.waitForSelector('#app.active');
  }

  console.log('Landing & auth');
  const student = await newPage();
  await step('landing page renders without CDN requests', async () => {
    const external = [];
    student.on('request', (r) => { if (!r.url().startsWith(base) && !r.url().startsWith('data:')) external.push(r.url()); });
    await student.goto(base + '/');
    await student.waitForSelector('.hero h1');
    await shot(student, '01-landing');
    assert.deepEqual(external, []);
  });
  await step('wrong password shows an error and stays on the form', async () => {
    await student.click('#landing .nav-links [data-action=show-login]');
    await student.fill('#loginForm [name=school]', 'DEMO-SCHOOL');
    await student.fill('#loginForm [name=username]', 'alex');
    await student.fill('#loginForm [name=password]', 'wrongpass1');
    await student.click('#loginForm button[type=submit]');
    await student.waitForSelector('#loginForm .form-error.show');
    assert.match(await student.textContent('#loginForm .form-error'), /Invalid/);
  });
  await step('student logs in and sees dashboard with assignments and XP card', async () => {
    await student.fill('#loginForm [name=password]', 'Demo12345');
    await student.click('#loginForm button[type=submit]');
    await student.waitForSelector('#app.active .stat-grid');
    await student.waitForSelector('text=Coming up');
    assert.match(await student.textContent('#view'), /Investigation: patterns in sequences/);
    assert.match(await student.textContent('#view'), /Good method/); // graded feedback from seed
    await shot(student, '02-student-dashboard');
  });
  await step('light theme toggle works and persists across reload', async () => {
    await student.click('.dash-nav .theme-toggle');
    assert.equal(await student.getAttribute('html', 'data-theme'), 'light');
    await shot(student, '03-student-dashboard-light');
    await student.reload();
    await student.waitForSelector('#app.active');
    assert.equal(await student.getAttribute('html', 'data-theme'), 'light');
    await student.click('.dash-nav .theme-toggle');
  });
  await step('session survives a page reload (no localStorage data loss)', async () => {
    await student.reload();
    await student.waitForSelector('#app.active .stat-grid');
    assert.match(await student.textContent('#userName'), /Alex/);
  });

  console.log('Student: submit work');
  await step('open class and assignment', async () => {
    await student.click('.side-btn:has-text("My classes")');
    await student.click('.class-card');
    await student.waitForSelector('text=Quadratic equations worksheet');
    await shot(student, '04-class-student');
    await student.click('a.row-item:has-text("Investigation")');
    await student.waitForSelector('textarea[name=text]');
    await shot(student, '05-assignment-student');
  });
  await step('attach a file, write an answer and submit; XP and badge update', async () => {
    const f = path.join(dir, 'report.txt');
    fs.writeFileSync(f, 'My investigation report');
    await student.fill('textarea[name=text]', 'Pattern: n^2 + 1 <b>bold?</b>');
    await student.setInputFiles('input[type=file]', f);
    await student.waitForSelector('#myFiles .file-item:has-text("report.txt")');
    assert.match(await student.inputValue('textarea[name=text]'), /Pattern: n\^2/); // typed text survived the upload re-render
    await student.click('button:has-text("Submit work")');
    await student.waitForSelector('.state-badge:has-text("Submitted")');
    await student.waitForSelector('#toast:not(.hidden)');
    assert.match(await student.textContent('#levelBadge'), /1|2/);
    await shot(student, '06-submitted');
    assert.equal(await student.locator('#view b', { hasText: 'bold?' }).count(), 0); // HTML in the answer is shown as text, not rendered
  });

  console.log('Teacher: grade');
  const teacher = await newPage();
  await step('teacher dashboard lists the submission', async () => {
    await login(teacher, 'DEMO-SCHOOL', 'ms_rivera', 'Demo12345');
    await teacher.waitForSelector('text=Waiting to be graded');
    assert.match(await teacher.textContent('#view'), /Alex Brave — Investigation/);
    await shot(teacher, '07-teacher-dashboard');
  });
  await step('teacher opens the submission, downloads the file and grades it', async () => {
    await teacher.click('a.row-item:has-text("Alex Brave")');
    await teacher.waitForSelector('#view >> text=Submissions');
    await shot(teacher, '08-teacher-assignment');
    await teacher.click('.row-item:has-text("Alex Brave")');
    await teacher.waitForSelector('#modalRoot .modal-card input[name=gB]');
    const [dl] = await Promise.all([teacher.waitForEvent('download'), teacher.click('#modalRoot .modal-card .file-item a')]);
    assert.equal(dl.suggestedFilename(), 'report.txt');
    assert.equal(fs.readFileSync(await dl.path(), 'utf8'), 'My investigation report');
    await shot(teacher, '09-grading-modal');
    await teacher.fill('input[name=gB]', '7'); await teacher.fill('input[name=gC]', '6'); await teacher.fill('input[name=gD]', '5');
    await teacher.fill('textarea[name=feedback]', 'Excellent pattern spotting!');
    await teacher.click('#modalRoot .modal-card button[type=submit]');
    await teacher.waitForSelector('.chip.crit-chip:has-text("B7")');
  });
  await step('gradebook shows the grades', async () => {
    await teacher.click('a:has-text("← MYP 4 Math")');
    await teacher.click('.tab:has-text("Gradebook")');
    await teacher.waitForSelector('.tbl .chip:has-text("B7")');
    await shot(teacher, '10-gradebook');
  });
  await step('teacher can create an assignment and post an announcement', async () => {
    await teacher.click('.tab:has-text("Assignments")');
    await teacher.click('button:has-text("New assignment")');
    await teacher.fill('#modalRoot .modal-card input[name=title]', 'Browser-made homework');
    await teacher.fill('#modalRoot .modal-card input[name=dueAt]', '2099-05-05T10:00');
    await teacher.check('#modalRoot .modal-card input[value=A]');
    await teacher.click('#modalRoot .modal-card button[type=submit]');
    await teacher.waitForSelector('h1:has-text("Browser-made homework")');
    await teacher.click('a:has-text("← MYP 4 Math")');
    await teacher.click('.tab:has-text("Announcements")');
    await teacher.click('button:has-text("Post announcement")');
    await teacher.fill('#modalRoot .modal-card input[name=title]', 'Bring calculators');
    await teacher.fill('#modalRoot .modal-card textarea[name=body]', 'Friday test.');
    await teacher.click('#modalRoot .modal-card button[type=submit]');
    await teacher.waitForSelector('.post:has-text("Bring calculators")');
  });

  console.log('Student sees result');
  await step('student sees grades, feedback and locked submission', async () => {
    await student.click('.side-btn:has-text("Dashboard")');
    await student.waitForSelector('text=Excellent pattern spotting!');
    await student.click('a.row-item:has-text("Investigation")');
    await student.waitForSelector('text=Your result');
    assert.equal(await student.locator('textarea[name=text]').count(), 0); // locked
    await shot(student, '11-student-graded');
  });
  await step('student calendar and quests', async () => {
    await student.click('.side-btn:has-text("Quests")');
    await student.click('button:has-text("New quest")');
    await student.fill('#modalRoot .modal-card input[name=title]', 'Revise chapter 5');
    await student.click('#modalRoot .modal-card button[type=submit]');
    await student.waitForSelector('.quest:has-text("Revise chapter 5")');
    await student.click('.quest:has-text("Revise chapter 5") .check');
    await student.waitForSelector('.quest.done:has-text("Revise chapter 5")');
    await shot(student, '12-quests');
    await student.click('.side-btn:has-text("Calendar")');
    await student.waitForSelector('.cal-grid');
    await shot(student, '13-calendar');
  });
  await step('hero profile: change colours and save', async () => {
    await student.click('.side-btn:has-text("My hero")');
    await student.click('.swatch[data-kind=outfit][data-color="#e74c3c"]');
    await student.click('.role-tab[data-weapon=staff]');
    await student.click('button:has-text("Save profile")');
    await student.waitForSelector('#toast:not(.hidden)');
    await student.reload(); await student.waitForSelector('#app.active');
    await student.click('.side-btn:has-text("My hero")');
    await student.waitForSelector('.swatch[data-kind=outfit].on');
    assert.equal(await student.getAttribute('.swatch[data-kind=outfit].on', 'data-color'), '#e74c3c');
    await shot(student, '14-profile');
  });

  console.log('School admin');
  const admin = await newPage();
  await step('admin sees overview and creates a student with a temporary password', async () => {
    await login(admin, 'DEMO-SCHOOL', 'demo_admin', 'Demo12345');
    await admin.waitForSelector('#view >> text=Students');
    await shot(admin, '15-admin-overview');
    await admin.click('.side-btn:has-text("People")');
    await admin.click('button:has-text("Add person")');
    await admin.fill('#modalRoot .modal-card input[name=displayName]', 'New Kid');
    await admin.fill('#modalRoot .modal-card input[name=username]', 'newkid');
    await admin.click('#modalRoot .modal-card button[type=submit]');
    await admin.waitForSelector('.temp-pass');
    const temp = (await admin.textContent('.temp-pass')).trim();
    assert.ok(temp.length >= 10);
    await shot(admin, '16-admin-credentials');
    await admin.click('#modalRoot .modal-card button:has-text("Done")');
    // the new account is forced to change the temporary password
    const kid = await newPage();
    await login(kid, 'DEMO-SCHOOL', 'newkid', temp);
    await kid.waitForSelector('#modalRoot .modal-card input[name=next]');
    assert.equal(await kid.locator('#modalRoot .modal-close').count(), 0);
    await kid.fill('#modalRoot .modal-card input[name=current]', temp);
    await kid.fill('#modalRoot .modal-card input[name=next]', 'MyOwnPass99');
    await kid.click('#modalRoot .modal-card button[type=submit]');
    await kid.waitForSelector('.stat-grid');
  });
  await step('admin people page lists everyone', async () => {
    await admin.click('.side-btn:has-text("People")');
    await admin.waitForSelector('.tbl');
    assert.ok((await admin.locator('.tbl tbody tr').count()) >= 6);
    await shot(admin, '17-admin-people');
  });

  console.log('Super admin & registration');
  await step('a school registers through the form and the super admin approves it', async () => {
    const reg = await newPage();
    await reg.goto(base + '/register-school');
    await reg.fill('[name=schoolName]', 'Browser Test Academy');
    await reg.fill('[name=schoolCode]', 'bta-2026');
    await reg.fill('[name=country]', 'Azerbaijan');
    await reg.fill('[name=adminName]', 'Bea Admin');
    await reg.fill('[name=adminUsername]', 'bea');
    await reg.fill('[name=adminEmail]', 'bea@bta.test');
    await reg.fill('[name=password]', 'Sup3rSecret');
    await reg.fill('[name=confirmPassword]', 'Sup3rSecret');
    await reg.selectOption('[name=studentCount]', '101-500');
    await reg.selectOption('[name=ibProgram]', 'MYP');
    await reg.fill('[name=reason]', 'Personal project testing');
    await reg.check('#terms');
    await shot(reg, '18-register');
    await reg.click('button[type=submit]');
    await reg.waitForSelector('#successModal:not(.hidden)');
    assert.equal((await reg.textContent('#displaySchoolCode')).trim(), 'BTA-2026');

    const sup = await newPage();
    await sup.goto(base + '/superadmin');
    await sup.waitForSelector('#loginPage', { state: 'visible' });
    await sup.fill('[name=username]', 'superadmin'); await sup.fill('[name=password]', 'SuperSecret123');
    await sup.click('button[type=submit]');
    await sup.waitForSelector('text=Browser Test Academy');
    await shot(sup, '19-superadmin');
    await sup.click('.panel:has-text("Browser Test Academy") button:has-text("Approve")');
    await sup.waitForSelector('.panel:has-text("Browser Test Academy") .st-graded');

    const bea = await newPage();
    await login(bea, 'BTA-2026', 'bea', 'Sup3rSecret');
    await bea.waitForSelector('text=Browser Test Academy');
  });

  console.log('Responsive');
  await step('mobile layout has no horizontal scroll', async () => {
    const m = await newPage({ width: 390, height: 800 });
    await login(m, 'DEMO-SCHOOL', 'alex', 'Demo12345');
    await m.waitForSelector('.stat-grid');
    const overflow = await m.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    await shot(m, '20-mobile');
    assert.ok(overflow <= 1, 'horizontal overflow: ' + overflow + 'px');
    await m.click('.side-btn:has-text("Calendar")');
    await m.waitForSelector('.cal-grid');
    assert.ok((await m.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)) <= 1, 'calendar overflows on mobile');
  });

  await step('no console errors or CSP violations in the whole run', async () => {
    assert.deepEqual(consoleErrors.filter((e) => !/401|403|404|409|429/.test(e)), []);
  });

  await browser.close();
  await new Promise((r) => server.close(r));
  require('../server/lib/db').closeAll();
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`\n${passed} passed, ${problems.length} failed. Screenshots: ${shots}`);
  if (problems.length) { console.log(problems.join('\n')); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(1); });

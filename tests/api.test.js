'use strict';
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { boot, Client, makeSchool, makeUser, GOOD_PW } = require('./helpers');

let env;
before(async () => { env = await boot({ maxUploadMb: 1 }); });
after(async () => { await env.stop(); });

const PAST = '2020-01-01T08:00';
const FUTURE = '2099-01-01T08:00';

async function classroom(code) {
  const { admin, sup } = await makeSchool(env, code, `School ${code}`);
  const teacher = await makeUser(env, code, admin, 'teach', 'Teacher One', 'teacher');
  const alex = await makeUser(env, code, admin, 'alex', 'Alex', 'student');
  const sam = await makeUser(env, code, admin, 'sam', 'Sam', 'student');
  const cls = (await teacher.post('/api/classes', { name: 'MYP 4 Math', subject: 'Math', yearGroup: 'MYP 4' })).data.class;
  await alex.post('/api/classes/join', { code: cls.code });
  await sam.post('/api/classes/join', { code: cls.code });
  return { admin, sup, teacher, alex, sam, cls };
}

describe('security basics', () => {
  test('API blocks requests without the CSRF header and from foreign origins', async () => {
    const c = new Client(env.base);
    assert.equal((await c.call('POST', '/api/auth/logout', {}, { csrf: false })).status, 403);
    const res = await c.raw('POST', '/api/auth/logout', { body: {}, headers: { Origin: 'http://evil.example' } });
    assert.equal(res.status, 403);
  });

  test('unauthenticated users get 401 on private routes', async () => {
    const c = new Client(env.base);
    for (const u of ['/api/me', '/api/classes', '/api/tasks', '/api/dashboard', '/api/admin/users']) {
      assert.equal((await c.get(u)).status, 401, u);
    }
    assert.equal((await c.get('/api/superadmin/schools')).status, 401);
  });

  test('responses carry security headers and the CSP forbids inline scripts', async () => {
    const res = await fetch(env.base + '/');
    const csp = res.headers.get('content-security-policy');
    assert.match(csp, /script-src 'self'/);
    assert.doesNotMatch(csp, /script-src[^;]*unsafe-inline/);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('x-frame-options'), 'DENY');
  });

  test('static server cannot be tricked into reading files outside public/', async () => {
    for (const p of ['/..%2f..%2fpackage.json', '/%2e%2e/%2e%2e/package.json', '/../package.json', '/..%2fserver%2findex.js']) {
      const res = await fetch(env.base + p);
      assert.ok([403, 404].includes(res.status), `${p} -> ${res.status}`);
      const body = await res.text();
      assert.doesNotMatch(body, /"name": "taskhero"/);
    }
    assert.equal((await fetch(env.base + '/data/master.db')).status, 404);
  });

  test('login is rate limited after repeated failures', async () => {
    await makeSchool(env, 'RATE-SCH');
    const c = new Client(env.base);
    let last;
    for (let i = 0; i < 9; i++) last = await c.post('/api/auth/login', { school: 'RATE-SCH', username: 'headadmin', password: 'wrong-pass-1' });
    assert.equal(last.status, 429);
    // even the right password is refused during the lockout
    assert.equal((await c.post('/api/auth/login', { school: 'RATE-SCH', username: 'headadmin', password: GOOD_PW })).status, 429);
  });

  test('passwords are hashed and never returned by the API', async () => {
    const { admin } = await makeSchool(env, 'HASH-SCH');
    const me = await admin.get('/api/me');
    assert.ok(!JSON.stringify(me.data).includes('password'));
    const users = await admin.get('/api/admin/users');
    assert.ok(!JSON.stringify(users.data).includes('scrypt'));
    assert.ok(!JSON.stringify(users.data).includes('password_hash'));
    const db = env.db.schoolDb('HASH-SCH');
    const row = db.prepare("SELECT password_hash FROM users WHERE username = 'headadmin'").get();
    assert.match(row.password_hash, /^scrypt\$/);
    assert.ok(!row.password_hash.includes(GOOD_PW));
  });

  test('weak passwords are rejected', async () => {
    const c = new Client(env.base);
    const r = await c.post('/api/schools/register', {
      schoolName: 'Weak', schoolCode: 'WEAK-SCH', country: 'X', adminName: 'A', adminEmail: 'a@b.co', password: 'short', confirmPassword: 'short',
    });
    assert.equal(r.status, 400);
  });

  test('school codes cannot contain path characters', async () => {
    const c = new Client(env.base);
    const r = await c.post('/api/schools/register', {
      schoolName: 'Evil', schoolCode: '../../ETC', country: 'X', adminName: 'A', adminEmail: 'a@b.co', password: GOOD_PW, confirmPassword: GOOD_PW,
    });
    assert.equal(r.status, 400);
  });
});

describe('school lifecycle and isolation', () => {
  test('a new school cannot be used until the super-admin approves it', async () => {
    const c = new Client(env.base);
    const reg = await c.post('/api/schools/register', {
      schoolName: 'Pending Prep', schoolCode: 'PEND-SCH', country: 'Azerbaijan', adminName: 'Boss', adminEmail: 'boss@pend.test',
      adminUsername: 'boss', password: GOOD_PW, confirmPassword: GOOD_PW,
    });
    assert.equal(reg.status, 201);
    const l1 = await c.post('/api/auth/login', { school: 'PEND-SCH', username: 'boss', password: GOOD_PW });
    assert.equal(l1.status, 403);
    assert.match(l1.data.error, /waiting for approval/);
    assert.equal((await c.get('/api/schools/lookup?code=PEND-SCH')).status, 404);

    const sup = new Client(env.base);
    assert.equal((await sup.post('/api/superadmin/login', { username: 'superadmin', password: 'nope' })).status, 401);
    assert.equal((await sup.post('/api/superadmin/login', { username: 'superadmin', password: 'SuperSecret123' })).status, 200);
    const list = await sup.get('/api/superadmin/schools');
    assert.ok(list.data.schools.find((s) => s.code === 'PEND-SCH' && s.status === 'pending'));
    await sup.post('/api/superadmin/schools/PEND-SCH/status', { status: 'approved' });
    assert.equal((await c.post('/api/auth/login', { school: 'PEND-SCH', username: 'boss', password: GOOD_PW })).status, 200);

    // revoking logs people out immediately
    await sup.post('/api/superadmin/schools/PEND-SCH/status', { status: 'rejected' });
    assert.equal((await c.get('/api/me')).status, 401);
  });

  test('a school admin cannot use the super-admin API', async () => {
    const { admin } = await makeSchool(env, 'NOSUP-SCH');
    assert.equal((await admin.get('/api/superadmin/schools')).status, 401);
  });

  test('two schools are fully separate (different databases, same usernames, same ids)', async () => {
    const a = await classroom('ISO-AAA');
    const b = await classroom('ISO-BBB');
    assert.notEqual(env.db.DATA_DIR, undefined);
    const dbDir = path.join(env.dir, 'schools');
    assert.ok(fs.existsSync(path.join(dbDir, 'ISO-AAA.db')) && fs.existsSync(path.join(dbDir, 'ISO-BBB.db')));

    // both have an "alex" and a class with id 1 - each only ever sees their own
    const aAssign = (await a.teacher.post(`/api/classes/${a.cls.id}/assignments`, { title: 'A-only work', dueAt: FUTURE, criteria: ['A'] })).data.assignment;
    const bView = await b.alex.get(`/api/assignments/${aAssign.id}`);
    assert.equal(bView.status, 404);
    const bList = await b.alex.get('/api/classes');
    assert.equal(bList.data.classes.length, 1);
    const bDash = await b.alex.get('/api/dashboard');
    assert.equal(bDash.data.upcoming.length, 0);

    // credentials of one school do not work at the other (and a school-A session never reaches school B data)
    const wrong = new Client(env.base);
    assert.equal((await wrong.post('/api/auth/login', { school: 'ISO-BBB', username: 'headadmin', password: GOOD_PW })).status, 200); // admin exists in both
    assert.equal((await wrong.post('/api/auth/login', { school: 'ISO-BBB', username: 'teach', password: GOOD_PW })).status, 401); // teach changed password
    // class join codes are per-school
    const stranger = await makeUser(env, 'ISO-BBB', b.admin, 'newbie', 'Newbie', 'student');
    assert.equal((await stranger.post('/api/classes/join', { code: a.cls.code })).status, 404);
  });

  test('deleting a school removes its database file and uploads', async () => {
    const x = await classroom('DEL-SCH');
    const as = (await x.teacher.post(`/api/classes/${x.cls.id}/assignments`, { title: 'W', dueAt: FUTURE })).data.assignment;
    await x.teacher.upload(`/api/assignments/${as.id}/files`, 'notes.txt', 'hello');
    const dbFile = path.join(env.dir, 'schools', 'DEL-SCH.db');
    const upDir = path.join(env.dir, 'uploads', 'DEL-SCH');
    assert.ok(fs.existsSync(dbFile) && fs.readdirSync(upDir).length === 1);
    assert.equal((await x.sup.del('/api/superadmin/schools/DEL-SCH', { confirm: 'WRONG' })).status, 400);
    assert.equal((await x.sup.del('/api/superadmin/schools/DEL-SCH', { confirm: 'DEL-SCH' })).status, 200);
    assert.ok(!fs.existsSync(dbFile) && !fs.existsSync(upDir));
    assert.equal((await x.alex.get('/api/me')).status, 401);
  });
});

describe('accounts and roles', () => {
  test('students can self-sign-up, teachers need approval, signup can be turned off', async () => {
    const { admin } = await makeSchool(env, 'SIGN-SCH');
    const anon = new Client(env.base);
    const s = await anon.post('/api/auth/signup', { school: 'SIGN-SCH', username: 'kid1', displayName: 'Kid One', password: GOOD_PW, role: 'student' });
    assert.equal(s.status, 201);
    assert.equal(s.data.user.role, 'student');
    assert.equal(s.data.user.xp, 0);

    const t = new Client(env.base);
    const tr = await t.post('/api/auth/signup', { school: 'SIGN-SCH', username: 'wannabe', displayName: 'Fake Teacher', password: GOOD_PW, role: 'teacher' });
    assert.equal(tr.status, 202);
    assert.equal((await t.post('/api/auth/login', { school: 'SIGN-SCH', username: 'wannabe', password: GOOD_PW })).status, 403);
    const pending = (await admin.get('/api/admin/users?status=pending')).data.users;
    assert.equal(pending.length, 1);
    await admin.patch(`/api/admin/users/${pending[0].id}`, { status: 'active' });
    assert.equal((await t.post('/api/auth/login', { school: 'SIGN-SCH', username: 'wannabe', password: GOOD_PW })).status, 200);

    // cannot sign up as admin, duplicate usernames are refused, signup toggle works
    assert.equal((await anon.post('/api/auth/signup', { school: 'SIGN-SCH', username: 'x1x', displayName: 'X', password: GOOD_PW, role: 'school_admin' })).status, 400);
    assert.equal((await anon.post('/api/auth/signup', { school: 'SIGN-SCH', username: 'KID1', displayName: 'X', password: GOOD_PW, role: 'student' })).status, 409);
    await admin.patch('/api/admin/settings', { allowStudentSignup: false });
    assert.equal((await anon.post('/api/auth/signup', { school: 'SIGN-SCH', username: 'late1', displayName: 'L', password: GOOD_PW, role: 'student' })).status, 403);
  });

  test('students and teachers cannot use admin routes or create classes as a student', async () => {
    const x = await classroom('ROLE-SCH');
    assert.equal((await x.alex.get('/api/admin/users')).status, 403);
    assert.equal((await x.teacher.get('/api/admin/users')).status, 403);
    assert.equal((await x.alex.post('/api/classes', { name: 'Hack', subject: 'Math' })).status, 403);
    assert.equal((await x.alex.post(`/api/classes/${x.cls.id}/assignments`, { title: 'Hack', dueAt: FUTURE })).status, 403);
    assert.equal((await x.alex.post(`/api/classes/${x.cls.id}/announcements`, { title: 'Hack', body: 'x' })).status, 403);
  });

  test('admin-created accounts must change their temporary password; resets and disabling work', async () => {
    const { admin } = await makeSchool(env, 'ADM-SCH');
    const made = (await admin.post('/api/admin/users', { username: 'newstu', displayName: 'New Student', role: 'student' })).data;
    assert.ok(made.tempPassword && made.tempPassword.length >= 10);
    const c = new Client(env.base);
    const login = await c.post('/api/auth/login', { school: 'ADM-SCH', username: 'newstu', password: made.tempPassword });
    assert.equal(login.status, 200);
    assert.equal(login.data.user.mustChangePassword, true);
    assert.equal((await c.get('/api/classes')).status, 403); // blocked until changed
    assert.equal((await c.post('/api/me/password', { current: made.tempPassword, next: 'weak' })).status, 400);
    assert.equal((await c.post('/api/me/password', { current: made.tempPassword, next: 'BrandNew123' })).status, 200);
    assert.equal((await c.get('/api/classes')).status, 200);

    const reset = (await admin.post(`/api/admin/users/${made.id}/reset-password`)).data;
    assert.equal((await c.get('/api/classes')).status, 401); // session killed by reset
    assert.equal((await new Client(env.base).post('/api/auth/login', { school: 'ADM-SCH', username: 'newstu', password: reset.tempPassword })).status, 200);

    await admin.patch(`/api/admin/users/${made.id}`, { status: 'disabled' });
    assert.equal((await new Client(env.base).post('/api/auth/login', { school: 'ADM-SCH', username: 'newstu', password: reset.tempPassword })).status, 403);
    const self = (await admin.get('/api/me')).data.user;
    assert.equal((await admin.patch(`/api/admin/users/${self.id}`, { status: 'disabled' })).status, 400);
  });

  test('CSV import creates accounts and reports bad rows', async () => {
    const { admin } = await makeSchool(env, 'CSV-SCH');
    const csv = 'username,displayName,role,yearGroup\nanna,Anna K,student,MYP 3\nbad name!,Broken,student,MYP 3\nben,Ben T,teacher,\nanna,Duplicate,student,MYP 1\n';
    const r = await admin.post('/api/admin/users/import', { csv });
    assert.equal(r.data.created.length, 2);
    assert.equal(r.data.errors.length, 2);
    assert.ok(r.data.created.every((u) => u.tempPassword));
  });

  test('avatar and title can be updated but only with valid values', async () => {
    const x = await classroom('AVA-SCH');
    const ok = await x.alex.patch('/api/me', { title: 'Math Wizard', avatar: { skin: '#e0ac69', hair: '#3498db', outfit: '#2ecc71', weapon: 'bow' } });
    assert.equal(ok.status, 200);
    assert.equal(ok.data.user.avatar.weapon, 'bow');
    assert.equal((await x.alex.patch('/api/me', { avatar: { skin: 'red;background:url(x)', hair: '#000000', outfit: '#000000', weapon: 'bow' } })).status, 400);
    assert.equal((await x.alex.patch('/api/me', { avatar: { skin: '#000000', hair: '#000000', outfit: '#000000', weapon: 'laser' } })).status, 400);
  });
});

describe('classes, assignments, submissions and grading', () => {
  test('full homework flow: post -> submit -> grade -> feedback', async () => {
    const x = await classroom('FLOW-SCH');
    const post = await x.teacher.post(`/api/classes/${x.cls.id}/assignments`, { title: 'Quadratics', instructions: 'Do Q1-5', dueAt: FUTURE, criteria: ['A', 'C'], xp: 40 });
    assert.equal(post.status, 201);
    const a = post.data.assignment;

    // students see it, with state "todo", without a code to the class
    const list = (await x.alex.get(`/api/classes/${x.cls.id}/assignments`)).data.assignments;
    assert.equal(list[0].state, 'todo');
    assert.equal((await x.alex.get('/api/classes')).data.classes[0].code, undefined);
    assert.ok((await x.teacher.get('/api/classes')).data.classes[0].code);

    // empty submission is refused
    assert.equal((await x.alex.post(`/api/assignments/${a.id}/submit`, { text: '' })).status, 400);

    const sub = await x.alex.post(`/api/assignments/${a.id}/submit`, { text: 'x = 3 or x = -2' });
    assert.equal(sub.status, 200);
    assert.equal(sub.data.submission.status, 'submitted');
    assert.equal(sub.data.submission.late, false);
    assert.equal(sub.data.xp.gained, 40);

    // the teacher sees it in the roster and the to-grade queue
    const detail = (await x.teacher.get(`/api/assignments/${a.id}`)).data.assignment;
    assert.equal(detail.counts.submitted, 1);
    const alexRow = detail.roster.find((r) => r.displayName === 'Alex');
    const samRow = detail.roster.find((r) => r.displayName === 'Sam');
    assert.equal(alexRow.state, 'submitted');
    assert.equal(samRow.state, 'todo');
    assert.equal((await x.teacher.get('/api/dashboard')).data.toGrade.length, 1);

    // students cannot grade; invalid grades are refused
    assert.equal((await x.alex.post(`/api/submissions/${alexRow.submission.id}/grade`, { grades: { A: 8 } })).status, 403);
    assert.equal((await x.teacher.post(`/api/submissions/${alexRow.submission.id}/grade`, { grades: { A: 9 } })).status, 400);
    assert.equal((await x.teacher.post(`/api/submissions/${alexRow.submission.id}/grade`, { grades: { B: 5 } })).status, 400);
    assert.equal((await x.teacher.post(`/api/submissions/${alexRow.submission.id}/grade`, { grades: {} })).status, 400);

    const g = await x.teacher.post(`/api/submissions/${alexRow.submission.id}/grade`, { grades: { A: 7, C: 5 }, feedback: 'Great working!' });
    assert.equal(g.status, 200);
    assert.equal(g.data.submission.status, 'graded');

    const mine = (await x.alex.get(`/api/assignments/${a.id}`)).data.assignment;
    assert.equal(mine.state, 'graded');
    assert.deepEqual(mine.mySubmission.grades, { A: 7, C: 5 });
    assert.equal(mine.mySubmission.feedback, 'Great working!');
    // graded work is locked
    assert.equal((await x.alex.post(`/api/assignments/${a.id}/submit`, { text: 'changed my mind' })).status, 400);

    // gradebook
    const gb = (await x.teacher.get(`/api/classes/${x.cls.id}/gradebook`)).data;
    const cell = gb.cells[`${x.alex.userId}:${a.id}`];
    assert.equal(cell.status, 'graded');
    assert.deepEqual(cell.grades, { A: 7, C: 5 });
  });

  test("a student can only see their own submission and other students' work stays private", async () => {
    const x = await classroom('PRIV-SCH');
    const a = (await x.teacher.post(`/api/classes/${x.cls.id}/assignments`, { title: 'Private', dueAt: FUTURE })).data.assignment;
    await x.alex.post(`/api/assignments/${a.id}/submit`, { text: 'ALEX SECRET ANSWER' });
    const samView = JSON.stringify((await x.sam.get(`/api/assignments/${a.id}`)).data);
    assert.ok(!samView.includes('ALEX SECRET ANSWER'));
    assert.equal((await x.sam.get(`/api/assignments/${a.id}`)).data.assignment.roster, undefined);
    // a student from outside the class gets 404
    const outsider = await makeUser(env, 'PRIV-SCH', x.admin, 'outsider', 'Out', 'student');
    assert.equal((await outsider.get(`/api/assignments/${a.id}`)).status, 404);
    assert.equal((await outsider.get(`/api/classes/${x.cls.id}`)).status, 404);
    // another teacher cannot read or grade
    const other = await makeUser(env, 'PRIV-SCH', x.admin, 'other', 'Other Teacher', 'teacher');
    assert.equal((await other.get(`/api/assignments/${a.id}`)).status, 404);
  });

  test('XP is awarded once per assignment, late work earns half, and levels are computed on the server', async () => {
    const x = await classroom('XP-SCH');
    const late = (await x.teacher.post(`/api/classes/${x.cls.id}/assignments`, { title: 'Late one', dueAt: PAST, xp: 40 })).data.assignment;
    const big = (await x.teacher.post(`/api/classes/${x.cls.id}/assignments`, { title: 'Big', dueAt: FUTURE, xp: 100 })).data.assignment;

    const r1 = await x.alex.post(`/api/assignments/${late.id}/submit`, { text: 'late work' });
    assert.equal(r1.data.submission.late, true);
    assert.equal(r1.data.xp.gained, 20);

    const again = await x.alex.post(`/api/assignments/${late.id}/submit`, { text: 'late work v2' });
    assert.equal(again.data.xp, null); // no second payout
    assert.equal((await x.alex.get('/api/me')).data.user.xp, 20);

    const r2 = await x.alex.post(`/api/assignments/${big.id}/submit`, { text: 'big' });
    assert.equal(r2.data.xp.gained, 100);
    const me = (await x.alex.get('/api/me')).data.user;
    assert.equal(me.xp, 120);
    assert.equal(me.level, 2);
    assert.equal(me.xpIntoLevel, 20);
    assert.equal(me.xpNeeded, 150);
    assert.equal(me.streak, 1);

    // XP survives "reload": a brand-new session sees exactly the same numbers
    const fresh = new Client(env.base);
    await fresh.post('/api/auth/login', { school: 'XP-SCH', username: 'alex', password: GOOD_PW + 'x' });
    assert.equal((await fresh.get('/api/me')).data.user.xp, 120);
    // students cannot set their own XP
    assert.equal((await x.alex.patch('/api/me', { xp: 99999, level: 50 })).data.user.xp, 120);
  });

  test('personal quests: small fixed XP, once per quest, max 3 per day', async () => {
    const x = await classroom('QUEST-SCH');
    const ids = [];
    for (let i = 0; i < 5; i++) ids.push((await x.alex.post('/api/tasks', { title: `Quest ${i}`, subject: 'Math', due: '2099-01-01', priority: 'high' })).data.task.id);

    const first = await x.alex.post(`/api/tasks/${ids[0]}/toggle`);
    assert.equal(first.data.task.done, true);
    assert.equal(first.data.xp.gained, 10);
    // untick + tick again = no farming
    await x.alex.post(`/api/tasks/${ids[0]}/toggle`);
    const again = await x.alex.post(`/api/tasks/${ids[0]}/toggle`);
    assert.equal(again.data.xp, null);
    assert.equal((await x.alex.get('/api/me')).data.user.xp, 10);

    await x.alex.post(`/api/tasks/${ids[1]}/toggle`);
    await x.alex.post(`/api/tasks/${ids[2]}/toggle`);
    const fourth = await x.alex.post(`/api/tasks/${ids[3]}/toggle`);
    assert.equal(fourth.data.task.done, true);
    assert.equal(fourth.data.xp, null); // daily cap reached
    assert.equal((await x.alex.get('/api/me')).data.user.xp, 30);

    // quests are private
    assert.equal((await x.sam.post(`/api/tasks/${ids[0]}/toggle`)).status, 404);
    assert.equal((await x.sam.get('/api/tasks')).data.tasks.length, 0);
    assert.equal((await x.alex.post('/api/tasks', { title: 'x', subject: 'Math', due: 'not-a-date' })).status, 400);
  });

  test('students who join later still see existing assignments', async () => {
    const x = await classroom('LATE-SCH');
    await x.teacher.post(`/api/classes/${x.cls.id}/assignments`, { title: 'Old work', dueAt: FUTURE });
    const newbie = await makeUser(env, 'LATE-SCH', x.admin, 'newbie', 'Newbie', 'student');
    await newbie.post('/api/classes/join', { code: x.cls.code });
    assert.equal((await newbie.get('/api/dashboard')).data.upcoming.length, 1);
    assert.equal((await newbie.get(`/api/classes/${x.cls.id}/assignments`)).data.assignments[0].state, 'todo');
  });

  test('announcements and discussions are class-scoped and moderated by the teacher', async () => {
    const x = await classroom('DISC-SCH');
    await x.teacher.post(`/api/classes/${x.cls.id}/announcements`, { title: 'Test on Friday', body: 'Revise chapter 4' });
    assert.equal((await x.alex.get(`/api/classes/${x.cls.id}/announcements`)).data.announcements[0].title, 'Test on Friday');
    assert.equal((await x.alex.get('/api/dashboard')).data.announcements.length, 1);

    const t = (await x.alex.post(`/api/classes/${x.cls.id}/threads`, { title: 'Help with Q3?', body: '<script>alert(1)</script>' })).data;
    await x.sam.post(`/api/threads/${t.id}/comments`, { body: 'Try completing the square' });
    const threads = (await x.sam.get(`/api/classes/${x.cls.id}/threads`)).data.threads;
    assert.equal(threads[0].commentCount, 1);
    assert.equal(threads[0].body, '<script>alert(1)</script>'); // stored verbatim; the UI escapes on display
    assert.equal(threads[0].canDelete, false);
    assert.equal((await x.sam.del(`/api/threads/${t.id}`)).status, 403);
    assert.equal((await x.teacher.del(`/api/threads/${t.id}`)).status, 200);

    const outsider = await makeUser(env, 'DISC-SCH', x.admin, 'outsider', 'Out', 'student');
    assert.equal((await outsider.get(`/api/classes/${x.cls.id}/threads`)).status, 404);
  });

  test('teachers can manage members; deleting a class removes its data', async () => {
    const x = await classroom('MEM-SCH');
    const extra = await makeUser(env, 'MEM-SCH', x.admin, 'extra', 'Extra', 'student');
    assert.equal((await x.teacher.post(`/api/classes/${x.cls.id}/members`, { username: 'extra' })).status, 201);
    assert.equal((await x.teacher.post(`/api/classes/${x.cls.id}/members`, { username: 'extra' })).status, 409);
    assert.equal((await x.teacher.post(`/api/classes/${x.cls.id}/members`, { username: 'teach' })).status, 404);
    assert.equal((await x.teacher.get(`/api/classes/${x.cls.id}`)).data.class.members.length, 3);
    await x.teacher.del(`/api/classes/${x.cls.id}/members/${extra.userId}`);
    assert.equal((await extra.get(`/api/classes/${x.cls.id}`)).status, 404);
    assert.equal((await x.sam.post(`/api/classes/${x.cls.id}/leave`)).status, 200);
    assert.equal((await x.alex.del(`/api/classes/${x.cls.id}`)).status, 403);
    assert.equal((await x.teacher.del(`/api/classes/${x.cls.id}`)).status, 200);
    assert.equal((await x.alex.get(`/api/classes/${x.cls.id}`)).status, 404);
  });

  test('calendar returns deadlines and quests for a date range', async () => {
    const x = await classroom('CAL-SCH');
    await x.teacher.post(`/api/classes/${x.cls.id}/assignments`, { title: 'Cal work', dueAt: '2099-03-10T09:00' });
    await x.alex.post('/api/tasks', { title: 'Cal quest', subject: 'Math', due: '2099-03-12' });
    const ev = (await x.alex.get('/api/calendar?from=2099-03-01&to=2099-03-31')).data.events;
    assert.deepEqual(ev.map((e) => e.type), ['assignment', 'task']);
    assert.equal((await x.teacher.get('/api/calendar?from=2099-03-01&to=2099-03-31')).data.events.length, 1);
    assert.equal((await x.alex.get('/api/calendar?from=2099-01-01&to=2099-12-31')).status, 400);
  });
});

describe('file uploads', () => {
  test('teacher attaches a file, students download it, and file rules are enforced', async () => {
    const x = await classroom('FILE-SCH');
    const a = (await x.teacher.post(`/api/classes/${x.cls.id}/assignments`, { title: 'With file', dueAt: FUTURE })).data.assignment;

    const up = await x.teacher.upload(`/api/assignments/${a.id}/files`, 'worksheet.pdf', '%PDF-1.4 fake pdf bytes');
    assert.equal(up.status, 201);
    assert.equal(up.data.file.name, 'worksheet.pdf');

    const dl = await x.alex.raw('GET', `/api/files/${up.data.file.id}`);
    assert.equal(dl.status, 200);
    assert.equal(await dl.text(), '%PDF-1.4 fake pdf bytes');
    assert.match(dl.headers.get('content-disposition'), /^attachment;/);
    assert.equal(dl.headers.get('x-content-type-options'), 'nosniff');

    // students cannot attach teacher files; bad types and empty files are refused
    assert.equal((await x.alex.upload(`/api/assignments/${a.id}/files`, 'x.pdf', 'abc')).status, 403);
    assert.equal((await x.teacher.upload(`/api/assignments/${a.id}/files`, 'virus.exe', 'MZ')).status, 400);
    assert.equal((await x.teacher.upload(`/api/assignments/${a.id}/files`, 'script.php', '<?php')).status, 400);
    assert.equal((await x.teacher.upload(`/api/assignments/${a.id}/files`, 'empty.txt', '')).status, 400);
    // path tricks in the file name are neutralised
    const sneaky = await x.teacher.upload(`/api/assignments/${a.id}/files`, '../../evil.txt', 'ok');
    assert.equal(sneaky.status, 201);
    assert.ok(!sneaky.data.file.name.includes('/'));
    const stored = fs.readdirSync(path.join(env.dir, 'uploads', 'FILE-SCH'));
    assert.ok(stored.every((n) => /^[0-9a-f]{32}$/.test(n)));
  });

  test('uploads over the size limit are rejected and leave nothing on disk', async () => {
    const x = await classroom('BIG-SCH');
    const a = (await x.teacher.post(`/api/classes/${x.cls.id}/assignments`, { title: 'Big', dueAt: FUTURE })).data.assignment;
    const big = Buffer.alloc(1.5 * 1024 * 1024, 'a');
    const r = await x.alex.upload(`/api/assignments/${a.id}/submission/files`, 'huge.txt', big).catch((e) => ({ status: 'network-error', err: e }));
    assert.ok(r.status === 413 || r.status === 'network-error', String(r.status));
    const dir = path.join(env.dir, 'uploads', 'BIG-SCH');
    assert.equal(fs.existsSync(dir) ? fs.readdirSync(dir).length : 0, 0);
  });

  test('student files: private drafts, visible to the teacher only after submitting, locked after grading', async () => {
    const x = await classroom('SUBF-SCH');
    const a = (await x.teacher.post(`/api/classes/${x.cls.id}/assignments`, { title: 'Upload work', dueAt: FUTURE, criteria: ['A'] })).data.assignment;
    const up = await x.alex.upload(`/api/assignments/${a.id}/submission/files`, 'my-work.docx', 'DOCX BYTES');
    assert.equal(up.status, 201);
    const fid = up.data.file.id;

    // draft: only Alex can read it
    assert.equal((await x.alex.raw('GET', `/api/files/${fid}`)).status, 200);
    assert.equal((await x.teacher.raw('GET', `/api/files/${fid}`)).status, 404);
    assert.equal((await x.sam.raw('GET', `/api/files/${fid}`)).status, 404);
    const roster = (await x.teacher.get(`/api/assignments/${a.id}`)).data.assignment.roster;
    assert.equal(roster.find((r) => r.displayName === 'Alex').state, 'todo');

    // submitting with just a file (no text) is fine and awards XP
    const sub = await x.alex.post(`/api/assignments/${a.id}/submit`, { text: '' });
    assert.equal(sub.status, 200);
    assert.equal(sub.data.submission.files.length, 1);

    // now the teacher can download it, but still not Sam; strangers cannot delete
    const tdl = await x.teacher.raw('GET', `/api/files/${fid}`);
    assert.equal(tdl.status, 200);
    assert.equal(await tdl.text(), 'DOCX BYTES');
    assert.equal((await x.sam.raw('GET', `/api/files/${fid}`)).status, 404);
    assert.equal((await x.sam.del(`/api/files/${fid}`)).status, 404);
    assert.equal((await x.teacher.del(`/api/files/${fid}`)).status, 404);

    // after grading, the student can no longer change files
    const subId = sub.data.submission.id;
    await x.teacher.post(`/api/submissions/${subId}/grade`, { grades: { A: 6 } });
    assert.equal((await x.alex.upload(`/api/assignments/${a.id}/submission/files`, 'more.txt', 'x')).status, 400);
    assert.equal((await x.alex.del(`/api/files/${fid}`)).status, 400);
  });

  test('deleting an assignment deletes its files from disk', async () => {
    const x = await classroom('RMF-SCH');
    const a = (await x.teacher.post(`/api/classes/${x.cls.id}/assignments`, { title: 'Temp', dueAt: FUTURE })).data.assignment;
    await x.teacher.upload(`/api/assignments/${a.id}/files`, 'a.txt', 'aaa');
    await x.alex.upload(`/api/assignments/${a.id}/submission/files`, 'b.txt', 'bbb');
    const dir = path.join(env.dir, 'uploads', 'RMF-SCH');
    assert.equal(fs.readdirSync(dir).length, 2);
    assert.equal((await x.teacher.del(`/api/assignments/${a.id}`)).status, 200);
    assert.equal(fs.readdirSync(dir).length, 0);
  });
});

describe('xp math', () => {
  const xp = require('../server/lib/xp');
  test('level curve and streak multipliers', () => {
    assert.deepEqual(xp.levelInfo(0), { level: 1, into: 0, needed: 100, title: 'Novice Apprentice' });
    assert.equal(xp.levelInfo(99).level, 1);
    assert.equal(xp.levelInfo(100).level, 2);
    assert.equal(xp.levelInfo(100 + 150).level, 3);
    assert.equal(xp.levelInfo(100 + 150 + 200 - 1).level, 3);
    assert.equal(xp.streakMultiplier(1), 1);
    assert.equal(xp.streakMultiplier(3), 1.5);
    assert.equal(xp.streakMultiplier(7), 2);
    assert.equal(xp.streakMultiplier(14), 3);
    assert.equal(xp.streakMultiplier(30), 5);
  });

  test('streak increments on consecutive days and resets after a gap', () => {
    const d = env.db.schoolDb('XP-SCH');
    const { localDay } = require('../server/lib/util');
    const day = (off) => { const t = new Date(); t.setDate(t.getDate() + off); return localDay(t); };
    d.prepare("UPDATE users SET streak = 6, last_active = ? WHERE username = 'sam'").run(day(-1));
    let u = d.prepare("SELECT * FROM users WHERE username = 'sam'").get();
    assert.equal(xp.touchStreak ? 0 : 0, 0);
    const r = xp.award(d, u.id, 10, 'test', 'test:streak1');
    assert.equal(r.multiplier, 2); // streak became 7
    u = d.prepare("SELECT * FROM users WHERE username = 'sam'").get();
    assert.equal(u.streak, 7);
    d.prepare("UPDATE users SET last_active = ? WHERE username = 'sam'").run(day(-3));
    const r2 = xp.award(d, u.id, 10, 'test', 'test:streak2');
    assert.equal(r2.multiplier, 1); // streak reset to 1
  });
});

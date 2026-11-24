'use strict';
const db = require('../lib/db');
const auth = require('../lib/auth');
const { HttpError, bad, str, oneOf } = require('../lib/util');
const { publicUser, DEFAULT_AVATAR } = require('../lib/serialize');
const { titleForLevel } = require('../lib/xp');

const USERNAME_RE = /^[a-zA-Z0-9._-]{3,30}$/;
const HEX_RE = /^#[0-9a-fA-F]{6}$/;
const WEAPONS = ['sword', 'staff', 'bow', 'book'];

function cleanUsername(v) {
  const u = str(v, 'Username', { min: 3, max: 30 });
  if (!USERNAME_RE.test(u)) throw bad('Username may only use letters, numbers, dots, dashes and underscores (3-30 characters).');
  return u;
}
function requireStrongPassword(pw) {
  const problem = auth.checkPasswordStrength(pw);
  if (problem) throw bad(problem);
}
function normCode(v) { return String(v || '').trim().toUpperCase(); }

/** Find an approved school by code, or null. */
function approvedSchool(code) {
  if (!db.CODE_RE.test(code)) return null;
  const s = db.master().prepare('SELECT * FROM schools WHERE code = ?').get(code);
  return s && s.status === 'approved' && db.schoolExists(code) ? s : null;
}

module.exports = function register(router) {
  // ------------------------------------------------ school registration (public)
  router.post('/api/schools/register', { auth: 'public' }, (ctx) => {
    const key = 'reg:' + ctx.ip;
    auth.limiterCheck(key, Number(process.env.TASKHERO_REG_LIMIT || 10));
    auth.limiterFail(key); // every attempt counts: stops automated bulk registration

    const b = ctx.body;
    const name = str(b.schoolName, 'School name', { max: 120 });
    const code = normCode(b.schoolCode);
    if (!db.CODE_RE.test(code)) throw bad('School code must be 3-24 characters: capital letters, numbers and dashes.');
    const country = str(b.country, 'Country', { max: 80 });
    let website = str(b.website, 'Website', { optional: true, max: 200 });
    if (website && !/^https?:\/\/[^\s<>"']+$/i.test(website)) throw bad('Website must start with http:// or https://');
    const adminName = str(b.adminName, 'Your name', { max: 100 });
    const adminEmail = str(b.adminEmail, 'Email', { max: 150 });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(adminEmail)) throw bad('Please enter a valid email address.');
    if (b.password !== b.confirmPassword) throw bad('Passwords do not match.');
    requireStrongPassword(b.password);
    const username = cleanUsername(b.adminUsername || adminEmail.split('@')[0].replace(/[^a-zA-Z0-9._-]/g, '').padEnd(3, '_'));

    const m = db.master();
    if (m.prepare('SELECT 1 FROM schools WHERE code = ?').get(code)) throw new HttpError(409, 'This school code is already taken. Please choose another.');

    m.prepare(`INSERT INTO schools (code, name, country, website, ib_program, student_count, reason, admin_name, admin_email, status, created_at)
               VALUES (?,?,?,?,?,?,?,?,?, 'pending', ?)`)
      .run(code, name, country, website, str(b.ibProgram, 'IB programme', { optional: true, max: 60 }),
        str(String(b.studentCount ?? ''), 'Student count', { optional: true, max: 20 }),
        str(b.reason, 'Reason', { optional: true, max: 1000 }), adminName, adminEmail, Date.now());

    const sdb = db.schoolDb(code);
    sdb.prepare(`INSERT INTO users (username, display_name, email, password_hash, role, status, title, avatar, created_at)
                 VALUES (?,?,?,?, 'school_admin', 'active', 'School Administrator', ?, ?)`)
      .run(username, adminName, adminEmail, auth.hashPassword(b.password), JSON.stringify({ ...DEFAULT_AVATAR, weapon: 'book' }), Date.now());

    ctx.status = 201;
    return { code, username, status: 'pending' };
  });

  // Used by the sign-up form to show the school's name and whether sign-up is open.
  router.get('/api/schools/lookup', { auth: 'public' }, (ctx) => {
    const school = approvedSchool(normCode(ctx.query.code));
    if (!school) throw new HttpError(404, 'School not found or not active yet.');
    const setting = db.schoolDb(school.code).prepare("SELECT value FROM settings WHERE key='allow_student_signup'").get();
    return { name: school.name, code: school.code, allowStudentSignup: setting?.value === '1' };
  });

  // ------------------------------------------------------------------- login
  router.post('/api/auth/login', { auth: 'public' }, (ctx) => {
    const code = normCode(ctx.body.school);
    const username = str(ctx.body.username, 'Username', { max: 60 });
    const password = str(ctx.body.password, 'Password', { max: 200 });
    const key = `login:${ctx.ip}:${code}:${username.toLowerCase()}`;
    auth.limiterCheck(key);

    const generic = new HttpError(401, 'Invalid school ID, username or password.');
    const fail = () => { auth.limiterFail(key); throw generic; };

    const row = db.CODE_RE.test(code) ? db.master().prepare('SELECT * FROM schools WHERE code = ?').get(code) : null;
    if (!row || !db.schoolExists(code)) { auth.verifyPassword(password, auth.DUMMY_HASH); fail(); }

    const sdb = db.schoolDb(code);
    const user = sdb.prepare('SELECT * FROM users WHERE username = ?').get(username);
    const ok = auth.verifyPassword(password, user ? user.password_hash : auth.DUMMY_HASH);
    if (!user || !ok) fail();

    if (row.status === 'pending') throw new HttpError(403, `"${row.name}" is still waiting for approval by the TaskHero administrator.`);
    if (row.status === 'rejected') throw new HttpError(403, `"${row.name}" was not approved. Please contact TaskHero support.`);
    if (user.status === 'pending') throw new HttpError(403, 'Your account is waiting for approval by your school administrator.');
    if (user.status === 'disabled') throw new HttpError(403, 'This account has been disabled. Please contact your school administrator.');

    auth.limiterReset(key);
    auth.createSession(ctx.res, { kind: 'school', schoolCode: code, userId: user.id });
    return { user: publicUser(user), school: { code, name: row.name } };
  });

  // ------------------------------------------------------------------ sign-up
  router.post('/api/auth/signup', { auth: 'public' }, (ctx) => {
    const key = 'signup:' + ctx.ip;
    auth.limiterCheck(key, 150); // generous: a whole class may sign up from one school IP
    auth.limiterFail(key);

    const b = ctx.body;
    const code = normCode(b.school);
    const school = approvedSchool(code);
    if (!school) throw new HttpError(404, 'School not found or not active yet. Check your School ID.');
    const sdb = db.schoolDb(code);

    const role = oneOf(b.role, 'Role', ['student', 'teacher']);
    const allow = sdb.prepare("SELECT value FROM settings WHERE key='allow_student_signup'").get();
    if (role === 'student' && allow?.value !== '1') {
      throw new HttpError(403, 'Student sign-up is turned off at this school. Ask your school administrator for an account.');
    }
    const username = cleanUsername(b.username);
    const displayName = str(b.displayName, 'Display name', { max: 60 });
    requireStrongPassword(b.password);
    if (sdb.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) throw new HttpError(409, 'That username is already taken at this school.');

    // Teachers must be approved by the school admin - a student cannot just pick "teacher".
    const status = role === 'teacher' ? 'pending' : 'active';
    const info = sdb.prepare(`INSERT INTO users (username, display_name, password_hash, role, status, year_group, title, avatar, created_at)
                              VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(username, displayName, auth.hashPassword(b.password), role, status,
        str(b.yearGroup, 'Year group', { optional: true, max: 20 }) || null,
        titleForLevel(1), JSON.stringify(DEFAULT_AVATAR), Date.now());

    if (status === 'pending') { ctx.status = 202; return { pending: true, message: 'Account created. Your school administrator must approve teacher accounts before you can log in.' }; }
    auth.createSession(ctx.res, { kind: 'school', schoolCode: code, userId: Number(info.lastInsertRowid) });
    const user = sdb.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
    ctx.status = 201;
    return { user: publicUser(user), school: { code, name: school.name } };
  });

  router.post('/api/auth/logout', { auth: 'public' }, (ctx) => {
    auth.destroySession(ctx.req, ctx.res);
    return { ok: true };
  });

  // ---------------------------------------------------------------------- me
  router.get('/api/me', { allowTempPassword: true }, (ctx) => ({
    user: publicUser(ctx.user),
    school: { code: ctx.schoolCode, name: ctx.school.name },
  }));

  router.patch('/api/me', {}, (ctx) => {
    const b = ctx.body;
    const u = ctx.user;
    const displayName = b.displayName !== undefined ? str(b.displayName, 'Display name', { max: 60 }) : u.display_name;
    const title = b.title !== undefined ? (str(b.title, 'Title', { optional: true, max: 30 }) || null) : u.title;
    let avatar = u.avatar;
    if (b.avatar !== undefined) {
      const a = b.avatar || {};
      const next = {};
      for (const k of ['skin', 'hair', 'outfit']) {
        if (typeof a[k] !== 'string' || !HEX_RE.test(a[k])) throw bad(`Avatar ${k} must be a colour like #aabbcc.`);
        next[k] = a[k];
      }
      next.weapon = oneOf(a.weapon, 'Weapon', WEAPONS);
      avatar = JSON.stringify(next);
    }
    ctx.db.prepare('UPDATE users SET display_name = ?, title = ?, avatar = ? WHERE id = ?').run(displayName, title, avatar, u.id);
    return { user: publicUser(ctx.db.prepare('SELECT * FROM users WHERE id = ?').get(u.id)) };
  });

  router.post('/api/me/password', { allowTempPassword: true }, (ctx) => {
    const key = `pw:${ctx.schoolCode}:${ctx.user.id}`;
    auth.limiterCheck(key);
    const { current, next } = ctx.body;
    if (typeof current !== 'string' || !auth.verifyPassword(current, ctx.user.password_hash)) {
      auth.limiterFail(key);
      throw new HttpError(401, 'Your current password is not correct.');
    }
    requireStrongPassword(next);
    if (next === current) throw bad('Choose a password different from the current one.');
    ctx.db.prepare('UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?').run(auth.hashPassword(next), ctx.user.id);
    auth.limiterReset(key);
    return { ok: true };
  });
};

module.exports.approvedSchool = approvedSchool;

'use strict';
const db = require('../lib/db');
const auth = require('../lib/auth');
const { HttpError, bad, str, oneOf } = require('../lib/util');
const { publicUser, DEFAULT_AVATAR } = require('../lib/serialize');
const { titleForLevel } = require('../lib/xp');

const ADMIN = { roles: ['school_admin'] };
const USERNAME_RE = /^[a-zA-Z0-9._-]{3,30}$/;

function killSessions(schoolCode, userId) {
  db.master().prepare('DELETE FROM sessions WHERE school_code = ? AND user_id = ?').run(schoolCode, userId);
}

/** Create one account. Returns { user, tempPassword }. Throws HttpError on a bad row. */
function createAccount(sdb, { username, displayName, role, yearGroup, email, password }) {
  if (!USERNAME_RE.test(username || '')) throw bad(`"${username}": username must be 3-30 letters, numbers, dots, dashes or underscores.`);
  const name = str(displayName, 'Display name', { max: 60 });
  oneOf(role, 'Role', ['student', 'teacher', 'school_admin']);
  if (sdb.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) throw new HttpError(409, `Username "${username}" already exists.`);
  const temp = password || auth.randomPassword(10);
  if (password) { const p = auth.checkPasswordStrength(password); if (p) throw bad(p); }
  const info = sdb.prepare(`INSERT INTO users (username, display_name, email, password_hash, role, status, year_group, title, avatar, must_change_password, created_at)
                            VALUES (?,?,?,?,?, 'active', ?,?,?,1,?)`)
    .run(username, name, email || null, auth.hashPassword(temp), role, yearGroup || null,
      role === 'school_admin' ? 'School Administrator' : titleForLevel(1), JSON.stringify(DEFAULT_AVATAR), Date.now());
  return { id: Number(info.lastInsertRowid), username, displayName: name, role, tempPassword: temp };
}

module.exports = function register(router) {
  router.get('/api/admin/overview', ADMIN, (ctx) => {
    const n = (sql, ...a) => ctx.db.prepare(sql).get(...a).n;
    return {
      students: n("SELECT COUNT(*) AS n FROM users WHERE role='student' AND status='active'"),
      teachers: n("SELECT COUNT(*) AS n FROM users WHERE role='teacher' AND status='active'"),
      pendingTeachers: n("SELECT COUNT(*) AS n FROM users WHERE status='pending'"),
      admins: n("SELECT COUNT(*) AS n FROM users WHERE role='school_admin'"),
      classes: n('SELECT COUNT(*) AS n FROM classes'),
      assignments: n('SELECT COUNT(*) AS n FROM assignments'),
      submissions: n("SELECT COUNT(*) AS n FROM submissions WHERE status != 'draft'"),
    };
  });

  router.get('/api/admin/users', ADMIN, (ctx) => {
    const where = []; const args = [];
    if (ctx.query.role) { where.push('role = ?'); args.push(oneOf(ctx.query.role, 'Role', ['student', 'teacher', 'school_admin'])); }
    if (ctx.query.status) { where.push('status = ?'); args.push(oneOf(ctx.query.status, 'Status', ['active', 'pending', 'disabled'])); }
    if (ctx.query.q) { where.push('(username LIKE ? OR display_name LIKE ?)'); const q = `%${String(ctx.query.q).slice(0, 40)}%`; args.push(q, q); }
    const rows = ctx.db.prepare(`SELECT * FROM users ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY role, display_name LIMIT 1000`).all(...args);
    return { users: rows.map(publicUser) };
  });

  router.post('/api/admin/users', ADMIN, (ctx) => {
    const b = ctx.body;
    const out = createAccount(ctx.db, {
      username: str(b.username, 'Username', { max: 30 }), displayName: b.displayName,
      role: b.role, yearGroup: str(b.yearGroup, 'Year group', { optional: true, max: 20 }),
      email: str(b.email, 'Email', { optional: true, max: 150 }), password: b.password || null,
    });
    ctx.status = 201;
    return out;
  });

  // CSV: username,displayName,role,yearGroup   (header row optional, comma/semicolon/tab separated)
  router.post('/api/admin/users/import', ADMIN, (ctx) => {
    const csv = str(ctx.body.csv, 'CSV data', { max: 200000 });
    const lines = csv.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (lines.length > 501) throw bad('Please import at most 500 users at a time.');
    const created = []; const errors = [];
    lines.forEach((line, i) => {
      const cells = line.split(/[,;\t]/).map((c) => c.trim().replace(/^"|"$/g, ''));
      if (i === 0 && /^username$/i.test(cells[0])) return; // header
      const [username, displayName, role = 'student', yearGroup = ''] = cells;
      try {
        created.push(createAccount(ctx.db, { username, displayName, role: role.toLowerCase(), yearGroup }));
      } catch (e) {
        errors.push({ line: i + 1, error: e.message });
      }
    });
    ctx.status = created.length ? 201 : 200;
    return { created, errors };
  });

  router.patch('/api/admin/users/:id', ADMIN, (ctx) => {
    const id = Number(ctx.params.id);
    const u = ctx.db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    if (!u) throw new HttpError(404, 'User not found.');
    const b = ctx.body;

    const status = b.status !== undefined ? oneOf(b.status, 'Status', ['active', 'pending', 'disabled']) : u.status;
    if (id === ctx.user.id && status !== 'active') throw bad('You cannot disable your own account.');
    const displayName = b.displayName !== undefined ? str(b.displayName, 'Display name', { max: 60 }) : u.display_name;
    const yearGroup = b.yearGroup !== undefined ? (str(b.yearGroup, 'Year group', { optional: true, max: 20 }) || null) : u.year_group;

    let role = u.role;
    if (b.role !== undefined && b.role !== u.role) {
      role = oneOf(b.role, 'Role', ['student', 'teacher']);
      if (u.role === 'school_admin') throw bad('Administrator roles cannot be changed here.');
      if (u.role === 'teacher' && ctx.db.prepare('SELECT 1 FROM classes WHERE teacher_id = ?').get(id)) {
        throw bad('This teacher still has classes. Delete or reassign them first.');
      }
    }
    ctx.db.prepare('UPDATE users SET status = ?, display_name = ?, year_group = ?, role = ? WHERE id = ?').run(status, displayName, yearGroup, role, id);
    if (status !== 'active') killSessions(ctx.schoolCode, id);
    return { user: publicUser(ctx.db.prepare('SELECT * FROM users WHERE id = ?').get(id)) };
  });

  router.post('/api/admin/users/:id/reset-password', ADMIN, (ctx) => {
    const id = Number(ctx.params.id);
    const u = ctx.db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    if (!u) throw new HttpError(404, 'User not found.');
    const temp = auth.randomPassword(10);
    ctx.db.prepare('UPDATE users SET password_hash = ?, must_change_password = 1 WHERE id = ?').run(auth.hashPassword(temp), id);
    if (id !== ctx.user.id) killSessions(ctx.schoolCode, id);
    return { username: u.username, tempPassword: temp };
  });

  router.get('/api/admin/settings', ADMIN, (ctx) => {
    const row = ctx.db.prepare("SELECT value FROM settings WHERE key = 'allow_student_signup'").get();
    return { allowStudentSignup: row?.value === '1' };
  });

  router.patch('/api/admin/settings', ADMIN, (ctx) => {
    if (typeof ctx.body.allowStudentSignup === 'boolean') {
      ctx.db.prepare("INSERT INTO settings (key, value) VALUES ('allow_student_signup', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
        .run(ctx.body.allowStudentSignup ? '1' : '0');
    }
    const row = ctx.db.prepare("SELECT value FROM settings WHERE key = 'allow_student_signup'").get();
    return { allowStudentSignup: row?.value === '1' };
  });
};

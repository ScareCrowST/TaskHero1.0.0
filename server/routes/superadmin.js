'use strict';
const db = require('../lib/db');
const auth = require('../lib/auth');
const { HttpError, bad, str, oneOf } = require('../lib/util');

module.exports = function register(router) {
  router.post('/api/superadmin/login', { auth: 'public' }, (ctx) => {
    const key = 'super:' + ctx.ip;
    auth.limiterCheck(key);
    const username = str(ctx.body.username, 'Username', { max: 60 });
    const password = str(ctx.body.password, 'Password', { max: 200 });
    const row = db.master().prepare('SELECT * FROM super_admin WHERE id = 1').get();
    const ok = auth.verifyPassword(password, row ? row.password_hash : auth.DUMMY_HASH);
    if (!row || !ok || row.username !== username) {
      auth.limiterFail(key);
      throw new HttpError(401, 'Invalid credentials.');
    }
    auth.limiterReset(key);
    auth.createSession(ctx.res, { kind: 'super' });
    return { ok: true };
  });

  router.get('/api/superadmin/me', { auth: 'super' }, () => ({ username: 'superadmin' }));

  router.get('/api/superadmin/schools', { auth: 'super' }, () => {
    const rows = db.master().prepare('SELECT * FROM schools ORDER BY created_at DESC').all();
    const schools = rows.map((s) => {
      let users = 0, classes = 0;
      if (db.schoolExists(s.code)) {
        const sdb = db.schoolDb(s.code);
        users = sdb.prepare('SELECT COUNT(*) AS n FROM users').get().n;
        classes = sdb.prepare('SELECT COUNT(*) AS n FROM classes').get().n;
      }
      return {
        code: s.code, name: s.name, country: s.country, website: s.website, ibProgram: s.ib_program,
        studentCount: s.student_count, reason: s.reason, adminName: s.admin_name, adminEmail: s.admin_email,
        status: s.status, createdAt: s.created_at, decidedAt: s.decided_at, users, classes,
      };
    });
    return {
      schools,
      totals: {
        schools: schools.length,
        pending: schools.filter((s) => s.status === 'pending').length,
        approved: schools.filter((s) => s.status === 'approved').length,
        users: schools.reduce((n, s) => n + s.users, 0),
      },
    };
  });

  router.post('/api/superadmin/schools/:code/status', { auth: 'super' }, (ctx) => {
    const status = oneOf(ctx.body.status, 'Status', ['approved', 'rejected', 'pending']);
    const info = db.master().prepare('UPDATE schools SET status = ?, decided_at = ? WHERE code = ?')
      .run(status, Date.now(), ctx.params.code);
    if (!info.changes) throw new HttpError(404, 'School not found.');
    if (status !== 'approved') db.master().prepare("DELETE FROM sessions WHERE school_code = ?").run(ctx.params.code); // log everyone out
    return { ok: true, status };
  });

  router.delete('/api/superadmin/schools/:code', { auth: 'super' }, (ctx) => {
    if (ctx.body.confirm !== ctx.params.code) throw bad('Type the school code to confirm deletion.');
    if (!db.master().prepare('SELECT 1 FROM schools WHERE code = ?').get(ctx.params.code)) throw new HttpError(404, 'School not found.');
    db.destroySchool(ctx.params.code);
    return { ok: true };
  });
};

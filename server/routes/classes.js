'use strict';
const crypto = require('node:crypto');
const { HttpError, bad, forbidden, notFound, str, int, oneOf } = require('../lib/util');
const { tx } = require('../lib/db');
const A = require('../lib/access');

const SUBJECTS = ['Math', 'Science', 'IS', 'LangLit', 'LangAcq', 'Arts', 'Design', 'PHE', 'Other'];
const TEACHERS = { roles: ['teacher', 'school_admin'] };

function newClassCode(db) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  for (let tries = 0; tries < 20; tries++) {
    const b = crypto.randomBytes(8);
    let s = '';
    for (let i = 0; i < 8; i++) s += alphabet[b[i] % alphabet.length];
    const code = `${s.slice(0, 4)}-${s.slice(4)}`;
    if (!db.prepare('SELECT 1 FROM classes WHERE code = ?').get(code)) return code;
  }
  throw new HttpError(500, 'Could not generate a class code.');
}

function classCard(ctx, c) {
  const db = ctx.db;
  const manage = A.canManage(ctx.user, c);
  const teacher = db.prepare('SELECT id, display_name FROM users WHERE id = ?').get(c.teacher_id);
  const out = {
    id: c.id, name: c.name, subject: c.subject, yearGroup: c.year_group || '', description: c.description || '',
    teacher: teacher ? { id: teacher.id, displayName: teacher.display_name } : null,
    memberCount: db.prepare('SELECT COUNT(*) AS n FROM class_members WHERE class_id = ?').get(c.id).n,
    assignmentCount: db.prepare('SELECT COUNT(*) AS n FROM assignments WHERE class_id = ?').get(c.id).n,
    canManage: manage,
  };
  if (manage) {
    out.code = c.code; // join code is only shown to teachers / admins
    out.toGrade = db.prepare(`SELECT COUNT(*) AS n FROM submissions s JOIN assignments a ON a.id = s.assignment_id
                              WHERE a.class_id = ? AND s.status = 'submitted'`).get(c.id).n;
  } else {
    out.openCount = db.prepare(`SELECT COUNT(*) AS n FROM assignments a
                                WHERE a.class_id = ? AND NOT EXISTS (SELECT 1 FROM submissions s
                                  WHERE s.assignment_id = a.id AND s.student_id = ? AND s.status IN ('submitted','graded'))`)
      .get(c.id, ctx.user.id).n;
  }
  return out;
}

module.exports = function register(router) {
  // ---------------------------------------------------------------- classes
  router.get('/api/classes', {}, (ctx) => {
    let rows;
    if (ctx.user.role === 'school_admin') rows = ctx.db.prepare('SELECT * FROM classes ORDER BY name').all();
    else if (ctx.user.role === 'teacher') rows = ctx.db.prepare('SELECT * FROM classes WHERE teacher_id = ? ORDER BY name').all(ctx.user.id);
    else rows = ctx.db.prepare('SELECT c.* FROM classes c JOIN class_members m ON m.class_id = c.id WHERE m.user_id = ? ORDER BY c.name').all(ctx.user.id);
    return { classes: rows.map((c) => classCard(ctx, c)) };
  });

  router.post('/api/classes', TEACHERS, (ctx) => {
    const b = ctx.body;
    let teacherId = ctx.user.id;
    if (ctx.user.role === 'school_admin') {
      teacherId = int(b.teacherId, 'Teacher', { min: 1 });
      const t = ctx.db.prepare("SELECT 1 FROM users WHERE id = ? AND role = 'teacher' AND status = 'active'").get(teacherId);
      if (!t) throw bad('Choose an active teacher for this class.');
    }
    const info = ctx.db.prepare(`INSERT INTO classes (name, subject, year_group, description, code, teacher_id, created_at) VALUES (?,?,?,?,?,?,?)`)
      .run(str(b.name, 'Class name', { max: 100 }), oneOf(b.subject, 'Subject', SUBJECTS),
        str(b.yearGroup, 'Year group', { optional: true, max: 30 }), str(b.description, 'Description', { optional: true, max: 500 }),
        newClassCode(ctx.db), teacherId, Date.now());
    ctx.status = 201;
    return { class: classCard(ctx, A.loadClass(ctx.db, info.lastInsertRowid)) };
  });

  router.post('/api/classes/join', { roles: ['student'] }, (ctx) => {
    const code = String(ctx.body.code || '').trim().toUpperCase();
    const c = ctx.db.prepare('SELECT * FROM classes WHERE code = ?').get(code);
    if (!c) throw notFound('Class code not found. Check it with your teacher.');
    if (A.isMember(ctx.db, c, ctx.user)) throw new HttpError(409, 'You are already in this class.');
    ctx.db.prepare('INSERT INTO class_members (class_id, user_id, joined_at) VALUES (?,?,?)').run(c.id, ctx.user.id, Date.now());
    return { class: classCard(ctx, c) };
  });

  router.get('/api/classes/:id', {}, (ctx) => {
    const c = A.viewClass(ctx, ctx.params.id);
    const card = classCard(ctx, c);
    if (card.canManage) {
      card.members = ctx.db.prepare(`SELECT u.id, u.username, u.display_name, u.year_group, m.joined_at FROM class_members m
                                     JOIN users u ON u.id = m.user_id WHERE m.class_id = ? ORDER BY u.display_name`).all(c.id)
        .map((u) => ({ id: u.id, username: u.username, displayName: u.display_name, yearGroup: u.year_group || '', joinedAt: u.joined_at }));
    }
    return { class: card };
  });

  router.patch('/api/classes/:id', TEACHERS, (ctx) => {
    const c = A.manageClass(ctx, ctx.params.id);
    const b = ctx.body;
    ctx.db.prepare('UPDATE classes SET name = ?, subject = ?, year_group = ?, description = ? WHERE id = ?').run(
      b.name !== undefined ? str(b.name, 'Class name', { max: 100 }) : c.name,
      b.subject !== undefined ? oneOf(b.subject, 'Subject', SUBJECTS) : c.subject,
      b.yearGroup !== undefined ? str(b.yearGroup, 'Year group', { optional: true, max: 30 }) : c.year_group,
      b.description !== undefined ? str(b.description, 'Description', { optional: true, max: 500 }) : c.description, c.id);
    return { class: classCard(ctx, A.loadClass(ctx.db, c.id)) };
  });

  router.delete('/api/classes/:id', TEACHERS, (ctx) => {
    const c = A.manageClass(ctx, ctx.params.id);
    const ids = ctx.db.prepare('SELECT id FROM assignments WHERE class_id = ?').all(c.id).map((r) => r.id);
    tx(ctx.db, () => {
      A.removeFilesForAssignments(ctx.db, ctx.schoolCode, ids);
      ctx.db.prepare('DELETE FROM classes WHERE id = ?').run(c.id); // cascades to members, assignments, submissions, threads...
    });
    return { ok: true };
  });

  router.post('/api/classes/:id/leave', { roles: ['student'] }, (ctx) => {
    const c = A.viewClass(ctx, ctx.params.id);
    ctx.db.prepare('DELETE FROM class_members WHERE class_id = ? AND user_id = ?').run(c.id, ctx.user.id);
    return { ok: true };
  });

  router.post('/api/classes/:id/members', TEACHERS, (ctx) => {
    const c = A.manageClass(ctx, ctx.params.id);
    const username = str(ctx.body.username, 'Username', { max: 30 });
    const u = ctx.db.prepare("SELECT * FROM users WHERE username = ? AND role = 'student' AND status = 'active'").get(username);
    if (!u) throw notFound('No active student with that username.');
    if (A.isMember(ctx.db, c, u)) throw new HttpError(409, 'That student is already in the class.');
    ctx.db.prepare('INSERT INTO class_members (class_id, user_id, joined_at) VALUES (?,?,?)').run(c.id, u.id, Date.now());
    ctx.status = 201;
    return { ok: true, member: { id: u.id, username: u.username, displayName: u.display_name } };
  });

  router.delete('/api/classes/:id/members/:userId', TEACHERS, (ctx) => {
    const c = A.manageClass(ctx, ctx.params.id);
    ctx.db.prepare('DELETE FROM class_members WHERE class_id = ? AND user_id = ?').run(c.id, Number(ctx.params.userId));
    return { ok: true };
  });

  // --------------------------------------------------------------- gradebook
  router.get('/api/classes/:id/gradebook', TEACHERS, (ctx) => {
    const c = A.manageClass(ctx, ctx.params.id);
    const students = ctx.db.prepare(`SELECT u.id, u.display_name FROM class_members m JOIN users u ON u.id = m.user_id
                                     WHERE m.class_id = ? ORDER BY u.display_name`).all(c.id);
    const assignments = ctx.db.prepare('SELECT id, title, due_at, criteria FROM assignments WHERE class_id = ? ORDER BY due_at').all(c.id);
    const subs = ctx.db.prepare(`SELECT s.id, s.assignment_id, s.student_id, s.status, s.late FROM submissions s
                                 JOIN assignments a ON a.id = s.assignment_id WHERE a.class_id = ?`).all(c.id);
    const grades = ctx.db.prepare(`SELECT g.submission_id, g.criterion, g.level FROM grades g JOIN submissions s ON s.id = g.submission_id
                                   JOIN assignments a ON a.id = s.assignment_id WHERE a.class_id = ?`).all(c.id);
    const gradeBySub = {};
    for (const g of grades) (gradeBySub[g.submission_id] ||= {})[g.criterion] = g.level;
    const cells = {};
    for (const s of subs) cells[`${s.student_id}:${s.assignment_id}`] = { submissionId: s.id, status: s.status, late: !!s.late, grades: gradeBySub[s.id] || {} };
    return {
      students: students.map((s) => ({ id: s.id, displayName: s.display_name })),
      assignments: assignments.map((a) => ({ id: a.id, title: a.title, dueAt: a.due_at, criteria: a.criteria ? a.criteria.split(',') : [] })),
      cells,
    };
  });

  // ----------------------------------------------------------- announcements
  router.get('/api/classes/:id/announcements', {}, (ctx) => {
    const c = A.viewClass(ctx, ctx.params.id);
    const rows = ctx.db.prepare(`SELECT a.*, u.display_name AS author FROM announcements a JOIN users u ON u.id = a.author_id
                                 WHERE a.class_id = ? ORDER BY a.created_at DESC LIMIT 100`).all(c.id);
    return { announcements: rows.map((r) => ({ id: r.id, title: r.title, body: r.body, author: r.author, createdAt: r.created_at })) };
  });

  router.post('/api/classes/:id/announcements', TEACHERS, (ctx) => {
    const c = A.manageClass(ctx, ctx.params.id);
    const info = ctx.db.prepare('INSERT INTO announcements (class_id, author_id, title, body, created_at) VALUES (?,?,?,?,?)')
      .run(c.id, ctx.user.id, str(ctx.body.title, 'Title', { max: 120 }), str(ctx.body.body, 'Message', { max: 4000 }), Date.now());
    ctx.status = 201;
    return { id: Number(info.lastInsertRowid) };
  });

  router.delete('/api/announcements/:id', TEACHERS, (ctx) => {
    const a = ctx.db.prepare('SELECT * FROM announcements WHERE id = ?').get(Number(ctx.params.id));
    if (!a) throw notFound();
    A.manageClass(ctx, a.class_id);
    ctx.db.prepare('DELETE FROM announcements WHERE id = ?').run(a.id);
    return { ok: true };
  });

  // -------------------------------------------------------------- discussions
  router.get('/api/classes/:id/threads', {}, (ctx) => {
    const c = A.viewClass(ctx, ctx.params.id);
    const rows = ctx.db.prepare(`SELECT t.*, u.display_name AS author, u.role AS author_role,
                                   (SELECT COUNT(*) FROM comments WHERE thread_id = t.id) AS comment_count
                                 FROM threads t JOIN users u ON u.id = t.author_id WHERE t.class_id = ? ORDER BY t.created_at DESC LIMIT 100`).all(c.id);
    return {
      threads: rows.map((t) => ({
        id: t.id, title: t.title, body: t.body, author: t.author, authorRole: t.author_role, authorId: t.author_id,
        commentCount: t.comment_count, createdAt: t.created_at, canDelete: t.author_id === ctx.user.id || A.canManage(ctx.user, c),
      })),
    };
  });

  router.post('/api/classes/:id/threads', {}, (ctx) => {
    const c = A.viewClass(ctx, ctx.params.id);
    const info = ctx.db.prepare('INSERT INTO threads (class_id, author_id, title, body, created_at) VALUES (?,?,?,?,?)')
      .run(c.id, ctx.user.id, str(ctx.body.title, 'Title', { max: 150 }), str(ctx.body.body, 'Message', { max: 4000 }), Date.now());
    ctx.status = 201;
    return { id: Number(info.lastInsertRowid) };
  });

  function threadWithClass(ctx) {
    const t = ctx.db.prepare('SELECT * FROM threads WHERE id = ?').get(Number(ctx.params.id));
    if (!t) throw notFound('Discussion not found.');
    return { t, c: A.viewClass(ctx, t.class_id) };
  }

  router.get('/api/threads/:id', {}, (ctx) => {
    const { t, c } = threadWithClass(ctx);
    const comments = ctx.db.prepare(`SELECT m.*, u.display_name AS author, u.role AS author_role FROM comments m JOIN users u ON u.id = m.author_id
                                     WHERE m.thread_id = ? ORDER BY m.created_at`).all(t.id);
    return {
      comments: comments.map((m) => ({
        id: m.id, body: m.body, author: m.author, authorRole: m.author_role, createdAt: m.created_at,
        canDelete: m.author_id === ctx.user.id || A.canManage(ctx.user, c),
      })),
    };
  });

  router.post('/api/threads/:id/comments', {}, (ctx) => {
    const { t } = threadWithClass(ctx);
    const info = ctx.db.prepare('INSERT INTO comments (thread_id, author_id, body, created_at) VALUES (?,?,?,?)')
      .run(t.id, ctx.user.id, str(ctx.body.body, 'Comment', { max: 2000 }), Date.now());
    ctx.status = 201;
    return { id: Number(info.lastInsertRowid) };
  });

  router.delete('/api/threads/:id', {}, (ctx) => {
    const { t, c } = threadWithClass(ctx);
    if (t.author_id !== ctx.user.id && !A.canManage(ctx.user, c)) throw forbidden();
    ctx.db.prepare('DELETE FROM threads WHERE id = ?').run(t.id);
    return { ok: true };
  });

  router.delete('/api/comments/:id', {}, (ctx) => {
    const m = ctx.db.prepare('SELECT * FROM comments WHERE id = ?').get(Number(ctx.params.id));
    if (!m) throw notFound();
    const t = ctx.db.prepare('SELECT * FROM threads WHERE id = ?').get(m.thread_id);
    const c = A.viewClass(ctx, t.class_id);
    if (m.author_id !== ctx.user.id && !A.canManage(ctx.user, c)) throw forbidden();
    ctx.db.prepare('DELETE FROM comments WHERE id = ?').run(m.id);
    return { ok: true };
  });
};

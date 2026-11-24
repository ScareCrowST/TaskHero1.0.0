'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { HttpError, bad, forbidden, notFound, str, int, oneOf, dateStr, dueAt, localDay, localDateTime, cleanFileName, saveUpload } = require('../lib/util');
const { tx, schoolUploadDir } = require('../lib/db');
const xp = require('../lib/xp');
const A = require('../lib/access');

const SUBJECTS = ['Math', 'Science', 'IS', 'LangLit', 'LangAcq', 'Arts', 'Design', 'PHE', 'Other'];
const CRITERIA = ['A', 'B', 'C', 'D'];
const TEACHERS = { roles: ['teacher', 'school_admin'] };
const STUDENTS = { roles: ['student'] };
const MAX_ASSIGNMENT_FILES = 10;
const MAX_SUBMISSION_FILES = 5;
const TASK_XP = 10;           // personal quests are worth a small, fixed amount of XP...
const TASK_XP_PER_DAY = 3;    // ...and only the first 3 each day count (no XP farming)

// ------------------------------------------------------------------ serializers
const fileOut = (f) => ({ id: f.id, name: f.original_name, size: f.size, createdAt: f.created_at });
const filesFor = (db, type, id) =>
  db.prepare('SELECT * FROM files WHERE owner_type = ? AND owner_id = ? ORDER BY id').all(type, id).map(fileOut);

function gradesFor(db, submissionId) {
  const out = {};
  for (const g of db.prepare('SELECT criterion, level FROM grades WHERE submission_id = ?').all(submissionId)) out[g.criterion] = g.level;
  return out;
}

function submissionOut(db, s, { showGrade = true } = {}) {
  if (!s) return null;
  const graded = s.status === 'graded';
  return {
    id: s.id, status: s.status, late: !!s.late, text: s.text || '', submittedAt: s.submitted_at, gradedAt: s.graded_at,
    feedback: graded && showGrade ? s.feedback || '' : '', grades: graded && showGrade ? gradesFor(db, s.id) : {},
    files: filesFor(db, 'submission', s.id),
  };
}

/** What the student should see: todo / overdue / submitted / graded. */
function studentState(a, sub) {
  if (sub && sub.status === 'graded') return 'graded';
  if (sub && sub.status === 'submitted') return 'submitted';
  return localDateTime() > a.due_at ? 'overdue' : 'todo';
}

function assignmentOut(ctx, a, c) {
  const db = ctx.db;
  const out = {
    id: a.id, classId: a.class_id, className: c.name, subject: c.subject, title: a.title, instructions: a.instructions || '',
    dueAt: a.due_at, criteria: a.criteria ? a.criteria.split(',') : [], xp: a.xp, createdAt: a.created_at,
    files: filesFor(db, 'assignment', a.id), canManage: A.canManage(ctx.user, c),
  };
  if (out.canManage) {
    out.counts = {
      students: db.prepare('SELECT COUNT(*) AS n FROM class_members WHERE class_id = ?').get(c.id).n,
      submitted: db.prepare("SELECT COUNT(*) AS n FROM submissions WHERE assignment_id = ? AND status IN ('submitted','graded')").get(a.id).n,
      graded: db.prepare("SELECT COUNT(*) AS n FROM submissions WHERE assignment_id = ? AND status = 'graded'").get(a.id).n,
    };
  } else {
    const sub = db.prepare('SELECT * FROM submissions WHERE assignment_id = ? AND student_id = ?').get(a.id, ctx.user.id);
    out.state = studentState(a, sub);
    out.mySubmission = submissionOut(db, sub);
  }
  return out;
}

function parseCriteria(v) {
  if (v === undefined || v === null) return '';
  if (!Array.isArray(v)) throw bad('Criteria must be a list.');
  const set = [...new Set(v.map(String))];
  for (const c of set) if (!CRITERIA.includes(c)) throw bad('Criteria must be A, B, C or D.');
  return CRITERIA.filter((c) => set.includes(c)).join(',');
}

/** Assignment visible to the user (via its class). */
function viewAssignment(ctx, id) {
  const a = A.loadAssignment(ctx.db, id);
  const c = A.viewClass(ctx, a.class_id);
  return { a, c };
}
function manageAssignment(ctx, id) {
  const a = A.loadAssignment(ctx.db, id);
  const c = A.manageClass(ctx, a.class_id);
  return { a, c };
}

function safeHeaderName(name) { return name.replace(/[^A-Za-z0-9._ -]/g, '_'); }

module.exports = function register(router) {
  // -------------------------------------------------------------- assignments
  router.get('/api/classes/:id/assignments', {}, (ctx) => {
    const c = A.viewClass(ctx, ctx.params.id);
    const rows = ctx.db.prepare('SELECT * FROM assignments WHERE class_id = ? ORDER BY due_at DESC').all(c.id);
    return { assignments: rows.map((a) => assignmentOut(ctx, a, c)) };
  });

  router.post('/api/classes/:id/assignments', TEACHERS, (ctx) => {
    const c = A.manageClass(ctx, ctx.params.id);
    const b = ctx.body;
    const info = ctx.db.prepare('INSERT INTO assignments (class_id, title, instructions, due_at, criteria, xp, created_by, created_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(c.id, str(b.title, 'Title', { max: 150 }), str(b.instructions, 'Instructions', { optional: true, max: 6000 }),
        dueAt(b.dueAt, 'Due date'), parseCriteria(b.criteria), int(b.xp, 'XP', { min: 0, max: 100, fallback: 40 }),
        ctx.user.id, Date.now());
    ctx.status = 201;
    return { assignment: assignmentOut(ctx, A.loadAssignment(ctx.db, info.lastInsertRowid), c) };
  });

  router.get('/api/assignments/:id', {}, (ctx) => {
    const { a, c } = viewAssignment(ctx, ctx.params.id);
    const out = assignmentOut(ctx, a, c);
    if (out.canManage) {
      const students = ctx.db.prepare(`SELECT u.id, u.display_name FROM class_members m JOIN users u ON u.id = m.user_id
                                       WHERE m.class_id = ? ORDER BY u.display_name`).all(c.id);
      out.roster = students.map((st) => {
        const s = ctx.db.prepare('SELECT * FROM submissions WHERE assignment_id = ? AND student_id = ?').get(a.id, st.id);
        const visible = s && s.status !== 'draft' ? s : null; // teachers never see unsent drafts
        return { studentId: st.id, displayName: st.display_name, submission: submissionOut(ctx.db, visible),
          state: visible ? visible.status : (localDateTime() > a.due_at ? 'overdue' : 'todo') };
      });
    }
    return { assignment: out };
  });

  router.patch('/api/assignments/:id', TEACHERS, (ctx) => {
    const { a, c } = manageAssignment(ctx, ctx.params.id);
    const b = ctx.body;
    ctx.db.prepare('UPDATE assignments SET title = ?, instructions = ?, due_at = ?, criteria = ?, xp = ? WHERE id = ?').run(
      b.title !== undefined ? str(b.title, 'Title', { max: 150 }) : a.title,
      b.instructions !== undefined ? str(b.instructions, 'Instructions', { optional: true, max: 6000 }) : a.instructions,
      b.dueAt !== undefined ? dueAt(b.dueAt, 'Due date') : a.due_at,
      b.criteria !== undefined ? parseCriteria(b.criteria) : a.criteria,
      b.xp !== undefined ? int(b.xp, 'XP', { min: 0, max: 100 }) : a.xp, a.id);
    return { assignment: assignmentOut(ctx, A.loadAssignment(ctx.db, a.id), c) };
  });

  router.delete('/api/assignments/:id', TEACHERS, (ctx) => {
    const { a } = manageAssignment(ctx, ctx.params.id);
    tx(ctx.db, () => {
      A.removeFilesForAssignments(ctx.db, ctx.schoolCode, [a.id]);
      ctx.db.prepare('DELETE FROM assignments WHERE id = ?').run(a.id);
    });
    return { ok: true };
  });

  // -------------------------------------------------------------------- files
  router.put('/api/assignments/:id/files', { ...TEACHERS, raw: true }, async (ctx) => {
    const { a } = manageAssignment(ctx, ctx.params.id);
    const name = cleanFileName(ctx.query.name);
    if (ctx.db.prepare("SELECT COUNT(*) AS n FROM files WHERE owner_type = 'assignment' AND owner_id = ?").get(a.id).n >= MAX_ASSIGNMENT_FILES) {
      throw bad(`An assignment can have at most ${MAX_ASSIGNMENT_FILES} files.`);
    }
    const saved = await saveUpload(ctx.req, schoolUploadDir(ctx.schoolCode), name);
    const info = ctx.db.prepare('INSERT INTO files (owner_type, owner_id, original_name, stored_name, size, uploaded_by, created_at) VALUES (?,?,?,?,?,?,?)')
      .run('assignment', a.id, name, saved.storedName, saved.size, ctx.user.id, Date.now());
    ctx.status = 201;
    return { file: fileOut(ctx.db.prepare('SELECT * FROM files WHERE id = ?').get(info.lastInsertRowid)) };
  });

  router.put('/api/assignments/:id/submission/files', { ...STUDENTS, raw: true }, async (ctx) => {
    const { a } = viewAssignment(ctx, ctx.params.id);
    const name = cleanFileName(ctx.query.name);
    let sub = ctx.db.prepare('SELECT * FROM submissions WHERE assignment_id = ? AND student_id = ?').get(a.id, ctx.user.id);
    if (sub && sub.status === 'graded') throw bad('This work has already been graded, so it can no longer be changed.');
    if (!sub) {
      const info = ctx.db.prepare("INSERT INTO submissions (assignment_id, student_id, status, updated_at) VALUES (?,?, 'draft', ?)").run(a.id, ctx.user.id, Date.now());
      sub = ctx.db.prepare('SELECT * FROM submissions WHERE id = ?').get(info.lastInsertRowid);
    }
    if (ctx.db.prepare("SELECT COUNT(*) AS n FROM files WHERE owner_type = 'submission' AND owner_id = ?").get(sub.id).n >= MAX_SUBMISSION_FILES) {
      throw bad(`You can attach at most ${MAX_SUBMISSION_FILES} files.`);
    }
    const saved = await saveUpload(ctx.req, schoolUploadDir(ctx.schoolCode), name);
    const info = ctx.db.prepare('INSERT INTO files (owner_type, owner_id, original_name, stored_name, size, uploaded_by, created_at) VALUES (?,?,?,?,?,?,?)')
      .run('submission', sub.id, name, saved.storedName, saved.size, ctx.user.id, Date.now());
    ctx.db.prepare('UPDATE submissions SET updated_at = ? WHERE id = ?').run(Date.now(), sub.id);
    ctx.status = 201;
    return { file: fileOut(ctx.db.prepare('SELECT * FROM files WHERE id = ?').get(info.lastInsertRowid)) };
  });

  /** Who may touch a file? Returns { f, kind, sub?, a?, c } or throws. */
  function accessFile(ctx, id, { write }) {
    const f = ctx.db.prepare('SELECT * FROM files WHERE id = ?').get(Number(id));
    if (!f) throw notFound('File not found.');
    if (f.owner_type === 'assignment') {
      const a = A.loadAssignment(ctx.db, f.owner_id);
      const c = write ? A.manageClass(ctx, a.class_id) : A.viewClass(ctx, a.class_id);
      return { f, a, c };
    }
    const sub = ctx.db.prepare('SELECT * FROM submissions WHERE id = ?').get(f.owner_id);
    const a = A.loadAssignment(ctx.db, sub.assignment_id);
    const c = A.loadClass(ctx.db, a.class_id);
    if (sub.student_id === ctx.user.id) {
      if (write && sub.status === 'graded') throw bad('Graded work can no longer be changed.');
      return { f, sub, a, c };
    }
    // Teachers/admins may read (never edit) a student's file once it has been submitted.
    if (!write && A.canManage(ctx.user, c) && sub.status !== 'draft') return { f, sub, a, c };
    throw notFound('File not found.');
  }

  router.get('/api/files/:id', {}, (ctx) => {
    const { f } = accessFile(ctx, ctx.params.id, { write: false });
    const full = path.join(schoolUploadDir(ctx.schoolCode), path.basename(f.stored_name));
    let st;
    try { st = fs.statSync(full); } catch { throw notFound('The file is missing on the server.'); }
    ctx.res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': st.size,
      'Content-Disposition': `attachment; filename="${safeHeaderName(f.original_name)}"; filename*=UTF-8''${encodeURIComponent(f.original_name)}`,
      'Cache-Control': 'private, no-store',
    });
    const stream = fs.createReadStream(full);
    stream.on('error', () => ctx.res.destroy());
    stream.pipe(ctx.res);
  });

  router.delete('/api/files/:id', {}, (ctx) => {
    const { f } = accessFile(ctx, ctx.params.id, { write: true });
    A.unlinkStored(ctx.schoolCode, f.stored_name);
    ctx.db.prepare('DELETE FROM files WHERE id = ?').run(f.id);
    return { ok: true };
  });

  // --------------------------------------------------------------- submitting
  router.post('/api/assignments/:id/submit', STUDENTS, (ctx) => {
    const { a } = viewAssignment(ctx, ctx.params.id);
    const text = str(ctx.body.text, 'Your answer', { optional: true, max: 20000 });
    let sub = ctx.db.prepare('SELECT * FROM submissions WHERE assignment_id = ? AND student_id = ?').get(a.id, ctx.user.id);
    if (sub && sub.status === 'graded') throw bad('This work has already been graded, so it can no longer be changed.');
    const fileCount = sub ? ctx.db.prepare("SELECT COUNT(*) AS n FROM files WHERE owner_type = 'submission' AND owner_id = ?").get(sub.id).n : 0;
    if (!text && !fileCount) throw bad('Write an answer or attach at least one file before submitting.');

    const late = localDateTime() > a.due_at ? 1 : 0;
    const now = Date.now();
    let reward = null;
    tx(ctx.db, () => {
      if (!sub) {
        const info = ctx.db.prepare("INSERT INTO submissions (assignment_id, student_id, status, updated_at) VALUES (?,?, 'draft', ?)").run(a.id, ctx.user.id, now);
        sub = ctx.db.prepare('SELECT * FROM submissions WHERE id = ?').get(info.lastInsertRowid);
      }
      ctx.db.prepare("UPDATE submissions SET text = ?, status = 'submitted', submitted_at = ?, late = ?, updated_at = ? WHERE id = ?").run(text, now, late, now, sub.id);
      // XP is server-side and only ever paid once per assignment (re-submitting gives nothing extra).
      reward = xp.award(ctx.db, ctx.user.id, late ? Math.floor(a.xp / 2) : a.xp, `Submitted: ${a.title}`, `sub:${a.id}`);
    });
    const fresh = ctx.db.prepare('SELECT * FROM submissions WHERE id = ?').get(sub.id);
    return { submission: submissionOut(ctx.db, fresh), xp: reward };
  });

  // ------------------------------------------------------------------ grading
  router.post('/api/submissions/:id/grade', TEACHERS, (ctx) => {
    const sub = ctx.db.prepare('SELECT * FROM submissions WHERE id = ?').get(Number(ctx.params.id));
    if (!sub) throw notFound('Submission not found.');
    const a = A.loadAssignment(ctx.db, sub.assignment_id);
    A.manageClass(ctx, a.class_id);
    if (sub.status === 'draft') throw bad('The student has not submitted this work yet.');

    const allowed = a.criteria ? a.criteria.split(',') : [];
    const given = ctx.body.grades && typeof ctx.body.grades === 'object' && !Array.isArray(ctx.body.grades) ? ctx.body.grades : {};
    const keys = Object.keys(given);
    for (const k of keys) if (!allowed.includes(k)) throw bad(`Criterion ${k} is not assessed in this assignment.`);
    const feedback = str(ctx.body.feedback, 'Feedback', { optional: true, max: 4000 });
    if (allowed.length && !keys.length) throw bad('Enter a level (0-8) for at least one criterion.');
    if (!allowed.length && !feedback) throw bad('Write some feedback for the student.');

    tx(ctx.db, () => {
      ctx.db.prepare('DELETE FROM grades WHERE submission_id = ?').run(sub.id);
      for (const k of keys) ctx.db.prepare('INSERT INTO grades (submission_id, criterion, level) VALUES (?,?,?)').run(sub.id, k, int(given[k], `Criterion ${k}`, { min: 0, max: 8 }));
      ctx.db.prepare("UPDATE submissions SET status = 'graded', feedback = ?, graded_at = ?, updated_at = ? WHERE id = ?").run(feedback, Date.now(), Date.now(), sub.id);
    });
    return { submission: submissionOut(ctx.db, ctx.db.prepare('SELECT * FROM submissions WHERE id = ?').get(sub.id)) };
  });

  // -------------------------------------------------------- personal quests
  const taskOut = (t) => ({ id: t.id, title: t.title, subject: t.subject, due: t.due, priority: t.priority, description: t.description || '', done: !!t.done, xpAwarded: !!t.xp_awarded, xp: TASK_XP });

  router.get('/api/tasks', {}, (ctx) => ({
    tasks: ctx.db.prepare('SELECT * FROM tasks WHERE user_id = ? ORDER BY done, due, id').all(ctx.user.id).map(taskOut),
  }));

  router.post('/api/tasks', {}, (ctx) => {
    const b = ctx.body;
    const info = ctx.db.prepare('INSERT INTO tasks (user_id, title, subject, due, priority, description, created_at) VALUES (?,?,?,?,?,?,?)')
      .run(ctx.user.id, str(b.title, 'Quest name', { max: 150 }), oneOf(b.subject, 'Subject', SUBJECTS), dateStr(b.due, 'Due date'),
        oneOf(b.priority, 'Priority', ['low', 'medium', 'high'], 'medium'), str(b.description, 'Description', { optional: true, max: 1000 }), Date.now());
    ctx.status = 201;
    return { task: taskOut(ctx.db.prepare('SELECT * FROM tasks WHERE id = ?').get(info.lastInsertRowid)) };
  });

  const ownTask = (ctx) => {
    const t = ctx.db.prepare('SELECT * FROM tasks WHERE id = ? AND user_id = ?').get(Number(ctx.params.id), ctx.user.id);
    if (!t) throw notFound('Quest not found.');
    return t;
  };

  router.patch('/api/tasks/:id', {}, (ctx) => {
    const t = ownTask(ctx);
    const b = ctx.body;
    ctx.db.prepare('UPDATE tasks SET title = ?, subject = ?, due = ?, priority = ?, description = ? WHERE id = ?').run(
      b.title !== undefined ? str(b.title, 'Quest name', { max: 150 }) : t.title,
      b.subject !== undefined ? oneOf(b.subject, 'Subject', SUBJECTS) : t.subject,
      b.due !== undefined ? dateStr(b.due, 'Due date') : t.due,
      b.priority !== undefined ? oneOf(b.priority, 'Priority', ['low', 'medium', 'high']) : t.priority,
      b.description !== undefined ? str(b.description, 'Description', { optional: true, max: 1000 }) : t.description, t.id);
    return { task: taskOut(ctx.db.prepare('SELECT * FROM tasks WHERE id = ?').get(t.id)) };
  });

  router.post('/api/tasks/:id/toggle', {}, (ctx) => {
    const t = ownTask(ctx);
    const done = t.done ? 0 : 1;
    let reward = null;
    tx(ctx.db, () => {
      ctx.db.prepare('UPDATE tasks SET done = ? WHERE id = ?').run(done, t.id);
      if (done && !t.xp_awarded) {
        const today = ctx.db.prepare("SELECT COUNT(*) AS n FROM xp_log WHERE user_id = ? AND day = ? AND ref LIKE 'task:%'").get(ctx.user.id, localDay()).n;
        if (today < TASK_XP_PER_DAY) {
          reward = xp.award(ctx.db, ctx.user.id, TASK_XP, `Quest: ${t.title}`, `task:${t.id}`);
        }
        ctx.db.prepare('UPDATE tasks SET xp_awarded = 1 WHERE id = ?').run(t.id); // unticking and re-ticking never pays again
      }
    });
    return { task: taskOut(ctx.db.prepare('SELECT * FROM tasks WHERE id = ?').get(t.id)), xp: reward };
  });

  router.delete('/api/tasks/:id', {}, (ctx) => {
    ctx.db.prepare('DELETE FROM tasks WHERE id = ?').run(ownTask(ctx).id);
    return { ok: true };
  });

  // ---------------------------------------------------------------- calendar
  function myAssignments(ctx, whereExtra = '', ...args) {
    const u = ctx.user;
    const base = `SELECT a.*, c.name AS class_name, c.subject AS class_subject FROM assignments a JOIN classes c ON c.id = a.class_id`;
    if (u.role === 'school_admin') return ctx.db.prepare(`${base} WHERE 1=1 ${whereExtra}`).all(...args);
    if (u.role === 'teacher') return ctx.db.prepare(`${base} WHERE c.teacher_id = ? ${whereExtra}`).all(u.id, ...args);
    return ctx.db.prepare(`${base} JOIN class_members m ON m.class_id = c.id WHERE m.user_id = ? ${whereExtra}`).all(u.id, ...args);
  }

  router.get('/api/calendar', {}, (ctx) => {
    const from = dateStr(ctx.query.from, 'from');
    const to = dateStr(ctx.query.to, 'to');
    if (Date.parse(to) - Date.parse(from) > 62 * 86400000 || to < from) throw bad('Choose a date range of at most two months.');
    const events = [];
    for (const a of myAssignments(ctx, 'AND substr(a.due_at,1,10) BETWEEN ? AND ?', from, to)) {
      const e = { type: 'assignment', id: a.id, title: a.title, dueAt: a.due_at, subject: a.class_subject, classId: a.class_id, className: a.class_name };
      if (ctx.user.role === 'student') {
        e.state = studentState(a, ctx.db.prepare('SELECT * FROM submissions WHERE assignment_id = ? AND student_id = ?').get(a.id, ctx.user.id));
      }
      events.push(e);
    }
    for (const t of ctx.db.prepare('SELECT * FROM tasks WHERE user_id = ? AND due BETWEEN ? AND ?').all(ctx.user.id, from, to)) {
      events.push({ type: 'task', id: t.id, title: t.title, dueAt: t.due + 'T23:59', subject: t.subject, done: !!t.done });
    }
    events.sort((x, y) => x.dueAt.localeCompare(y.dueAt));
    return { events };
  });

  // --------------------------------------------------------------- dashboard
  router.get('/api/dashboard', {}, (ctx) => {
    const u = ctx.user;
    const db = ctx.db;
    const classIds = (u.role === 'student'
      ? db.prepare('SELECT class_id AS id FROM class_members WHERE user_id = ?').all(u.id)
      : (u.role === 'teacher' ? db.prepare('SELECT id FROM classes WHERE teacher_id = ?').all(u.id) : db.prepare('SELECT id FROM classes').all())
    ).map((r) => r.id);
    const inClasses = classIds.length ? classIds.join(',') : '0'; // ids are integers from our own DB
    const announcements = db.prepare(`SELECT a.id, a.title, a.body, a.created_at, c.name AS class_name FROM announcements a JOIN classes c ON c.id = a.class_id
                                      WHERE a.class_id IN (${inClasses}) ORDER BY a.created_at DESC LIMIT 5`).all()
      .map((x) => ({ id: x.id, title: x.title, body: x.body, className: x.class_name, createdAt: x.created_at }));

    if (u.role === 'student') {
      const rows = db.prepare(`SELECT a.*, c.name AS class_name, c.subject AS class_subject FROM assignments a JOIN classes c ON c.id = a.class_id
                               WHERE a.class_id IN (${inClasses}) AND NOT EXISTS (SELECT 1 FROM submissions s WHERE s.assignment_id = a.id AND s.student_id = ? AND s.status IN ('submitted','graded'))
                               ORDER BY a.due_at LIMIT 15`).all(u.id);
      const feedback = db.prepare(`SELECT s.id, s.feedback, s.graded_at, a.id AS assignment_id, a.title, c.name AS class_name FROM submissions s
                                   JOIN assignments a ON a.id = s.assignment_id JOIN classes c ON c.id = a.class_id
                                   WHERE s.student_id = ? AND s.status = 'graded' ORDER BY s.graded_at DESC LIMIT 5`).all(u.id)
        .map((f) => ({ assignmentId: f.assignment_id, title: f.title, className: f.class_name, feedback: f.feedback || '', gradedAt: f.graded_at, grades: gradesFor(db, f.id) }));
      const today = localDay();
      const quests = db.prepare('SELECT * FROM tasks WHERE user_id = ? AND done = 0 AND due <= ? ORDER BY due LIMIT 10').all(u.id, today).map(taskOut);
      return {
        role: 'student',
        upcoming: rows.map((a) => ({ id: a.id, title: a.title, className: a.class_name, subject: a.class_subject, dueAt: a.due_at, overdue: localDateTime() > a.due_at })),
        feedback, announcements, quests,
        stats: {
          open: rows.length,
          submitted: db.prepare("SELECT COUNT(*) AS n FROM submissions WHERE student_id = ? AND status IN ('submitted','graded')").get(u.id).n,
          graded: db.prepare("SELECT COUNT(*) AS n FROM submissions WHERE student_id = ? AND status = 'graded'").get(u.id).n,
          questsDone: db.prepare('SELECT COUNT(*) AS n FROM tasks WHERE user_id = ? AND done = 1').get(u.id).n,
        },
      };
    }

    const toGrade = db.prepare(`SELECT s.id, s.submitted_at, s.late, st.display_name AS student, a.id AS assignment_id, a.title, c.id AS class_id, c.name AS class_name
                                FROM submissions s JOIN assignments a ON a.id = s.assignment_id JOIN classes c ON c.id = a.class_id JOIN users st ON st.id = s.student_id
                                WHERE c.id IN (${inClasses}) AND s.status = 'submitted' ORDER BY s.submitted_at LIMIT 15`).all()
      .map((s) => ({ submissionId: s.id, student: s.student, assignmentId: s.assignment_id, title: s.title, classId: s.class_id, className: s.class_name, late: !!s.late, submittedAt: s.submitted_at }));
    const soon = new Date(Date.now() + 7 * 86400000);
    const deadlines = db.prepare(`SELECT a.id, a.title, a.due_at, c.name AS class_name FROM assignments a JOIN classes c ON c.id = a.class_id
                                  WHERE a.class_id IN (${inClasses}) AND a.due_at >= ? AND a.due_at <= ? ORDER BY a.due_at LIMIT 10`)
      .all(localDateTime(), localDateTime(soon)).map((a) => ({ id: a.id, title: a.title, className: a.class_name, dueAt: a.due_at }));
    return {
      role: u.role, toGrade, deadlines, announcements,
      stats: { classes: classIds.length, toGrade: toGrade.length, deadlines: deadlines.length },
    };
  });
};

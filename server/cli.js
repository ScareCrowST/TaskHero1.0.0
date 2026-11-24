'use strict';
/**
 *   node server/cli.js reset-admin [newPassword]   -> set / reset the super-admin password
 *   node server/cli.js seed-demo                   -> create an approved demo school with sample data
 */
const db = require('./lib/db');
const auth = require('./lib/auth');
const { DEFAULT_AVATAR } = require('./lib/serialize');
const { localDay } = require('./lib/util');

const [, , cmd, arg] = process.argv;

function resetAdmin(password) {
  const pw = password || auth.randomPassword(14);
  const m = db.master();
  const hash = auth.hashPassword(pw);
  if (m.prepare('SELECT 1 FROM super_admin WHERE id = 1').get()) m.prepare('UPDATE super_admin SET password_hash = ? WHERE id = 1').run(hash);
  else m.prepare("INSERT INTO super_admin (id, username, password_hash) VALUES (1, 'superadmin', ?)").run(hash);
  m.prepare("DELETE FROM sessions WHERE kind = 'super'").run();
  console.log('Super-admin login:  username "superadmin"   password "' + pw + '"');
}

function seedDemo() {
  const CODE = 'DEMO-SCHOOL';
  const PASSWORD = 'Demo12345';
  const m = db.master();
  if (m.prepare('SELECT 1 FROM schools WHERE code = ?').get(CODE)) { console.log('Demo school already exists. Delete it in /superadmin first to re-create it.'); return; }
  m.prepare(`INSERT INTO schools (code, name, country, ib_program, student_count, admin_name, admin_email, status, created_at, decided_at)
             VALUES (?, 'Demo International School', 'Azerbaijan', 'MYP', '100', 'Demo Admin', 'admin@demo.local', 'approved', ?, ?)`).run(CODE, Date.now(), Date.now());
  const sdb = db.schoolDb(CODE);
  const hash = auth.hashPassword(PASSWORD);
  const add = (username, name, role, year) => Number(sdb.prepare(
    `INSERT INTO users (username, display_name, password_hash, role, status, year_group, title, avatar, created_at) VALUES (?,?,?,?, 'active', ?, ?, ?, ?)`)
    .run(username, name, hash, role, year || null, role === 'school_admin' ? 'School Administrator' : 'Novice Apprentice', JSON.stringify(DEFAULT_AVATAR), Date.now()).lastInsertRowid);

  add('demo_admin', 'Demo Admin', 'school_admin');
  const teacher = add('ms_rivera', 'Ms. Rivera', 'teacher');
  const students = [add('alex', 'Alex Brave', 'student', 'MYP 4'), add('sam', 'Sam Quick', 'student', 'MYP 4'), add('mira', 'Mira Chen', 'student', 'MYP 4')];

  const cls = Number(sdb.prepare(`INSERT INTO classes (name, subject, year_group, description, code, teacher_id, created_at) VALUES ('MYP 4 Math', 'Math', 'MYP 4', 'Algebra and functions', 'DEMO-MATH', ?, ?)`).run(teacher, Date.now()).lastInsertRowid);
  for (const s of students) sdb.prepare('INSERT INTO class_members (class_id, user_id, joined_at) VALUES (?,?,?)').run(cls, s, Date.now());

  const day = (offset) => { const d = new Date(); d.setDate(d.getDate() + offset); return localDay(d) + 'T23:59'; };
  const mk = (title, ins, due, crit, xp) => Number(sdb.prepare('INSERT INTO assignments (class_id, title, instructions, due_at, criteria, xp, created_by, created_at) VALUES (?,?,?,?,?,?,?,?)')
    .run(cls, title, ins, due, crit, xp, teacher, Date.now()).lastInsertRowid);
  const a1 = mk('Quadratic equations worksheet', 'Solve questions 1-12 and show your working.', day(-3), 'A,C', 40);
  mk('Investigation: patterns in sequences', 'Write up your investigation using the MYP report format.', day(4), 'B,C,D', 70);
  mk('Chapter 5 practice', 'Complete the practice set and upload a photo or PDF of your work.', day(1), 'A', 40);

  const sub = Number(sdb.prepare("INSERT INTO submissions (assignment_id, student_id, text, status, submitted_at, late, feedback, graded_at, updated_at) VALUES (?,?,?, 'graded', ?, 0, ?, ?, ?)")
    .run(a1, students[0], 'x = 3 or x = -2. Working shown in the attached notes.', Date.now() - 4 * 86400000, 'Good method. Check your signs in Q7.', Date.now() - 2 * 86400000, Date.now()).lastInsertRowid);
  sdb.prepare("INSERT INTO grades (submission_id, criterion, level) VALUES (?, 'A', 6), (?, 'C', 5)").run(sub, sub);
  sdb.prepare("INSERT INTO announcements (class_id, author_id, title, body, created_at) VALUES (?,?,?,?,?)")
    .run(cls, teacher, 'Welcome to MYP 4 Math', 'Post your questions in Discussions. Assignments are submitted here - no email needed!', Date.now());
  console.log(`Demo school created.\n  School ID: ${CODE}\n  Password for every demo account: ${PASSWORD}\n  Accounts: demo_admin (admin), ms_rivera (teacher), alex / sam / mira (students)\n  Class join code: DEMO-MATH`);
}

if (cmd === 'reset-admin') resetAdmin(arg);
else if (cmd === 'seed-demo') seedDemo();
else console.log('Usage: node server/cli.js <reset-admin [password] | seed-demo>');
db.closeAll();

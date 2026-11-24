'use strict';
/**
 * TaskHero database layer.
 *
 *   data/master.db            -> schools registry, sessions, super-admin login
 *   data/schools/<CODE>.db    -> ONE SQLite file per school (users, classes, work...)
 *   data/uploads/<CODE>/...   -> uploaded files for that school
 *
 * A school's data therefore lives in its own file: it can be backed up, moved
 * or deleted on its own and can never be reached through another school's code.
 */
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = path.resolve(process.env.TASKHERO_DATA || path.join(__dirname, '..', '..', 'data'));
const SCHOOL_DIR = path.join(DATA_DIR, 'schools');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');

// The code is used in file names, so it is validated very strictly (no dots or slashes).
const CODE_RE = /^[A-Z0-9][A-Z0-9-]{2,23}$/;

fs.mkdirSync(SCHOOL_DIR, { recursive: true });
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

function open(file) {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  return db;
}

/** Run fn inside a transaction; rolls back on any thrown error. */
function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* already rolled back */ }
    throw e;
  }
}

// ---------------------------------------------------------------- master DB
let _master = null;
function master() {
  if (_master) return _master;
  _master = open(path.join(DATA_DIR, 'master.db'));
  _master.exec(`
    CREATE TABLE IF NOT EXISTS schools (
      code TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      country TEXT, website TEXT, ib_program TEXT, student_count TEXT, reason TEXT,
      admin_name TEXT, admin_email TEXT,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
      created_at INTEGER NOT NULL,
      decided_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK (kind IN ('school','super')),
      school_code TEXT,
      user_id INTEGER,
      expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS super_admin (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      username TEXT NOT NULL,
      password_hash TEXT NOT NULL
    );
  `);
  return _master;
}

// --------------------------------------------------------------- school DBs
const SCHOOL_SCHEMA = `
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    display_name TEXT NOT NULL,
    email TEXT,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('student','teacher','school_admin')),
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','pending','disabled')),
    year_group TEXT,
    xp INTEGER NOT NULL DEFAULT 0,
    streak INTEGER NOT NULL DEFAULT 0,
    last_active TEXT,
    title TEXT,
    avatar TEXT,
    must_change_password INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS classes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    subject TEXT NOT NULL,
    year_group TEXT,
    description TEXT,
    code TEXT NOT NULL UNIQUE,
    teacher_id INTEGER NOT NULL REFERENCES users(id),
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS class_members (
    class_id INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    joined_at INTEGER NOT NULL,
    PRIMARY KEY (class_id, user_id)
  );
  CREATE TABLE IF NOT EXISTS assignments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    class_id INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    instructions TEXT,
    due_at TEXT NOT NULL,
    criteria TEXT NOT NULL DEFAULT '',
    xp INTEGER NOT NULL DEFAULT 40,
    created_by INTEGER NOT NULL REFERENCES users(id),
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS submissions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    assignment_id INTEGER NOT NULL REFERENCES assignments(id) ON DELETE CASCADE,
    student_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    text TEXT,
    status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','submitted','graded')),
    submitted_at INTEGER,
    late INTEGER NOT NULL DEFAULT 0,
    feedback TEXT,
    graded_at INTEGER,
    updated_at INTEGER NOT NULL,
    UNIQUE (assignment_id, student_id)
  );
  CREATE TABLE IF NOT EXISTS grades (
    submission_id INTEGER NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
    criterion TEXT NOT NULL CHECK (criterion IN ('A','B','C','D')),
    level INTEGER NOT NULL CHECK (level BETWEEN 0 AND 8),
    PRIMARY KEY (submission_id, criterion)
  );
  CREATE TABLE IF NOT EXISTS files (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_type TEXT NOT NULL CHECK (owner_type IN ('assignment','submission')),
    owner_id INTEGER NOT NULL,
    original_name TEXT NOT NULL,
    stored_name TEXT NOT NULL,
    size INTEGER NOT NULL,
    uploaded_by INTEGER NOT NULL REFERENCES users(id),
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_files_owner ON files(owner_type, owner_id);
  CREATE TABLE IF NOT EXISTS announcements (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    class_id INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
    author_id INTEGER NOT NULL REFERENCES users(id),
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS threads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    class_id INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
    author_id INTEGER NOT NULL REFERENCES users(id),
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    thread_id INTEGER NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
    author_id INTEGER NOT NULL REFERENCES users(id),
    body TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    subject TEXT NOT NULL,
    due TEXT NOT NULL,
    priority TEXT NOT NULL DEFAULT 'medium' CHECK (priority IN ('low','medium','high')),
    description TEXT,
    done INTEGER NOT NULL DEFAULT 0,
    xp_awarded INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS xp_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    amount INTEGER NOT NULL,
    reason TEXT NOT NULL,
    ref TEXT NOT NULL,
    day TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE (user_id, ref)
  );
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`;

const _schoolDbs = new Map();

function assertCode(code) {
  if (typeof code !== 'string' || !CODE_RE.test(code)) throw new Error('Invalid school code');
  return code;
}

function schoolFile(code) {
  return path.join(SCHOOL_DIR, assertCode(code) + '.db');
}

function schoolExists(code) {
  return CODE_RE.test(code || '') && fs.existsSync(schoolFile(code));
}

function schoolDb(code) {
  assertCode(code);
  let db = _schoolDbs.get(code);
  if (db) return db;
  db = open(schoolFile(code));
  db.exec(SCHOOL_SCHEMA);
  db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('allow_student_signup', '1')").run();
  _schoolDbs.set(code, db);
  return db;
}

function schoolUploadDir(code) {
  const dir = path.join(UPLOAD_DIR, assertCode(code));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Permanently remove a school's database and uploaded files. */
function destroySchool(code) {
  assertCode(code);
  const db = _schoolDbs.get(code);
  if (db) { try { db.close(); } catch { /* ignore */ } _schoolDbs.delete(code); }
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(schoolFile(code) + suffix); } catch { /* may not exist */ }
  }
  fs.rmSync(path.join(UPLOAD_DIR, code), { recursive: true, force: true });
  master().prepare('DELETE FROM sessions WHERE school_code = ?').run(code);
  master().prepare('DELETE FROM schools WHERE code = ?').run(code);
}

function closeAll() {
  for (const db of _schoolDbs.values()) { try { db.close(); } catch { /* ignore */ } }
  _schoolDbs.clear();
  if (_master) { try { _master.close(); } catch { /* ignore */ } _master = null; }
}

module.exports = {
  DATA_DIR, CODE_RE, tx, master, schoolDb, schoolExists, schoolUploadDir, destroySchool, closeAll,
};

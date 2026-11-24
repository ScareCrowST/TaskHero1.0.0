'use strict';
const crypto = require('node:crypto');
const db = require('./db');
const { HttpError, parseCookies } = require('./util');

const COOKIE = 'th_session';
const SESSION_MS = 7 * 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------- passwords
function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

function verifyPassword(password, stored) {
  try {
    const [scheme, saltHex, hashHex] = String(stored).split('$');
    if (scheme !== 'scrypt') return false;
    const expected = Buffer.from(hashHex, 'hex');
    const actual = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length);
    return crypto.timingSafeEqual(actual, expected);
  } catch { return false; }
}

// A pre-computed hash used so that "unknown user" takes as long as "wrong password".
const DUMMY_HASH = hashPassword('not-a-real-password');

function checkPasswordStrength(pw) {
  if (typeof pw !== 'string' || pw.length < 8) return 'Password must be at least 8 characters.';
  if (pw.length > 200) return 'Password is too long.';
  if (!/[A-Za-z]/.test(pw) || !/[0-9]/.test(pw)) return 'Password must contain at least one letter and one number.';
  return null;
}

// ----------------------------------------------------------------- sessions
const sha = (t) => crypto.createHash('sha256').update(t).digest('hex');

function createSession(res, { kind, schoolCode = null, userId = null }) {
  const token = crypto.randomBytes(32).toString('base64url');
  const m = db.master();
  m.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
  m.prepare('INSERT INTO sessions (token_hash, kind, school_code, user_id, expires_at) VALUES (?,?,?,?,?)')
    .run(sha(token), kind, schoolCode, userId, Date.now() + SESSION_MS);
  const secure = process.env.TASKHERO_COOKIE_SECURE === '1' ? '; Secure' : '';
  res.setHeader('Set-Cookie',
    `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MS / 1000}${secure}`);
}

function destroySession(req, res) {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  if (token) db.master().prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha(token));
  res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
}

/** Returns { kind, schoolCode, user } / { kind:'super' } / null. */
function loadSession(req) {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  if (!token) return null;
  const row = db.master().prepare('SELECT * FROM sessions WHERE token_hash = ?').get(sha(token));
  if (!row || row.expires_at < Date.now()) return null;
  if (row.kind === 'super') return { kind: 'super' };

  const school = db.master().prepare('SELECT * FROM schools WHERE code = ?').get(row.school_code);
  if (!school || school.status !== 'approved' || !db.schoolExists(row.school_code)) return null;
  const sdb = db.schoolDb(row.school_code);
  const user = sdb.prepare('SELECT * FROM users WHERE id = ?').get(row.user_id);
  if (!user || user.status !== 'active') return null;
  return { kind: 'school', schoolCode: row.school_code, school, db: sdb, user };
}

// ------------------------------------------------------------- rate limiting
// Simple in-memory limiter: max 8 failures per key per 10 minutes.
const failures = new Map();
const WINDOW = 10 * 60 * 1000;
const MAX_FAILS = 8;

function limiterCheck(key, max = MAX_FAILS) {
  const now = Date.now();
  const rec = failures.get(key);
  if (rec && now - rec.first > WINDOW) failures.delete(key);
  const cur = failures.get(key);
  if (cur && cur.count >= max) {
    throw new HttpError(429, 'Too many failed attempts. Please wait 10 minutes and try again.');
  }
}
function limiterFail(key) {
  const now = Date.now();
  const rec = failures.get(key);
  if (!rec || now - rec.first > WINDOW) failures.set(key, { first: now, count: 1 });
  else rec.count += 1;
}
function limiterReset(key) { failures.delete(key); }

function randomPassword(len = 10) {
  const chars = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  const bytes = crypto.randomBytes(len);
  for (let i = 0; i < len; i++) out += chars[bytes[i] % chars.length];
  // guarantee at least one letter and one digit
  return out.slice(0, len - 2) + 'k7';
}

module.exports = {
  hashPassword, verifyPassword, DUMMY_HASH, checkPasswordStrength,
  createSession, destroySession, loadSession,
  limiterCheck, limiterFail, limiterReset, randomPassword,
};

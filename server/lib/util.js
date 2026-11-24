'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { pipeline } = require('node:stream/promises');
const { Transform } = require('node:stream');
const crypto = require('node:crypto');

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const bad = (msg) => new HttpError(400, msg);
const forbidden = (msg = 'You do not have permission to do that.') => new HttpError(403, msg);
const notFound = (msg = 'Not found.') => new HttpError(404, msg);

function sendJson(res, status, data, extraHeaders = {}) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...extraHeaders,
  });
  res.end(body);
}

function readJson(req, limit = 256 * 1024) {
  return new Promise((resolve, reject) => {
    const type = (req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    const hasBody = req.headers['transfer-encoding'] !== undefined || Number(req.headers['content-length'] || 0) > 0;
    if (hasBody && type !== 'application/json') return reject(bad('Content-Type must be application/json.'));
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new HttpError(413, 'Request body too large.')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!size) return resolve({});
      try {
        const v = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (v === null || typeof v !== 'object' || Array.isArray(v)) return reject(bad('Body must be a JSON object.'));
        resolve(v);
      } catch { reject(bad('Invalid JSON.')); }
    });
    req.on('error', reject);
  });
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

// ---------- validation helpers ----------
function str(v, label, { min = 1, max = 200, optional = false } = {}) {
  if (v === undefined || v === null || v === '') {
    if (optional) return '';
    throw bad(`${label} is required.`);
  }
  if (typeof v !== 'string') throw bad(`${label} must be text.`);
  const t = v.trim();
  if (t.length < min) throw bad(`${label} is required.`);
  if (t.length > max) throw bad(`${label} is too long (max ${max} characters).`);
  // strip control characters other than newline/tab
  // eslint-disable-next-line no-control-regex
  return t.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
}
function int(v, label, { min = 0, max = 1000000, fallback } = {}) {
  if ((v === undefined || v === null || v === '') && fallback !== undefined) return fallback;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw bad(`${label} must be a whole number between ${min} and ${max}.`);
  return n;
}
function oneOf(v, label, list, fallback) {
  if ((v === undefined || v === null || v === '') && fallback !== undefined) return fallback;
  if (!list.includes(v)) throw bad(`${label} must be one of: ${list.join(', ')}.`);
  return v;
}
function dateStr(v, label) {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(v + 'T00:00:00'))) {
    throw bad(`${label} must be a date (YYYY-MM-DD).`);
  }
  return v;
}
/** "YYYY-MM-DD" or "YYYY-MM-DDTHH:MM" -> "YYYY-MM-DDTHH:MM" (defaults to end of day). */
function dueAt(v, label) {
  if (typeof v !== 'string') throw bad(`${label} is required.`);
  let s = v.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) s += 'T23:59';
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(s) || Number.isNaN(Date.parse(s))) {
    throw bad(`${label} must be a valid date and time.`);
  }
  return s;
}

// ---------- dates (server local time; TaskHero runs on the school's own machine) ----------
const pad = (n) => String(n).padStart(2, '0');
function localDay(d = new Date()) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
function localDateTime(d = new Date()) { return `${localDay(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}`; }
function yesterdayDay() { const d = new Date(); d.setDate(d.getDate() - 1); return localDay(d); }

// ---------- file uploads ----------
const ALLOWED_EXT = new Set([
  'pdf', 'doc', 'docx', 'odt', 'rtf', 'txt', 'md', 'csv', 'ppt', 'pptx', 'odp', 'xls', 'xlsx', 'ods',
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'zip', 'mp3', 'mp4', 'py', 'js', 'html', 'css', 'json',
]);
const MAX_UPLOAD = Number(process.env.TASKHERO_MAX_UPLOAD_MB || 10) * 1024 * 1024;

function cleanFileName(name) {
  let n = String(name || '').replace(/[\\/\u0000-\u001F]/g, '_').replace(/^\.+/, '').trim();
  n = n.slice(-120);
  if (!n) throw bad('File name is missing.');
  const ext = path.extname(n).slice(1).toLowerCase();
  if (!ALLOWED_EXT.has(ext)) throw bad(`File type ".${ext || '?'}" is not allowed.`);
  return n;
}

async function saveUpload(req, dir, originalName) {
  const declared = Number(req.headers['content-length'] || 0);
  if (declared > MAX_UPLOAD) throw new HttpError(413, `File is too large (max ${MAX_UPLOAD / 1024 / 1024} MB).`);
  const storedName = crypto.randomBytes(16).toString('hex');
  const full = path.join(dir, storedName);
  let size = 0;
  const counter = new Transform({
    transform(chunk, _enc, cb) {
      size += chunk.length;
      if (size > MAX_UPLOAD) return cb(new HttpError(413, `File is too large (max ${MAX_UPLOAD / 1024 / 1024} MB).`));
      cb(null, chunk);
    },
  });
  try {
    await pipeline(req, counter, fs.createWriteStream(full, { flags: 'wx' }));
  } catch (e) {
    fs.rmSync(full, { force: true });
    throw e;
  }
  if (size === 0) { fs.rmSync(full, { force: true }); throw bad('The file is empty.'); }
  return { storedName, size, originalName };
}

module.exports = {
  HttpError, bad, forbidden, notFound, sendJson, readJson, parseCookies,
  str, int, oneOf, dateStr, dueAt, localDay, localDateTime, yesterdayDay,
  cleanFileName, saveUpload, MAX_UPLOAD,
};

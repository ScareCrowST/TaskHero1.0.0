'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const db = require('./lib/db');
const auth = require('./lib/auth');
const { Router } = require('./lib/router');
const { HttpError, sendJson, readJson } = require('./lib/util');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.txt': 'text/plain; charset=utf-8',
};
// Clean URLs for the three HTML pages.
const PAGES = { '/': 'index.html', '/register-school': 'register-school.html', '/superadmin': 'superadmin.html' };

const router = new Router();
require('./routes/auth')(router);
require('./routes/superadmin')(router);
require('./routes/schooladmin')(router);
require('./routes/classes')(router);
require('./routes/work')(router);

const SECURITY_HEADERS = {
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; " +
    "font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'",
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
};

function serveStatic(req, res, pathname) {
  const rel = PAGES[pathname] || decodeURIComponent(pathname).replace(/^\/+/, '');
  const full = path.resolve(PUBLIC_DIR, rel);
  // path traversal guard: the resolved path must stay inside public/
  if (full !== PUBLIC_DIR && !full.startsWith(PUBLIC_DIR + path.sep)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.stat(full, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found'); }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(full).toLowerCase()] || 'application/octet-stream',
      'Content-Length': st.size,
      'Cache-Control': 'no-cache',
    });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(full).pipe(res);
  });
}

function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try { return new URL(origin).host === req.headers.host; } catch { return false; }
}

async function handleApi(req, res, url) {
  const found = router.match(req.method, url.pathname);
  if (!found) throw new HttpError(404, 'Unknown API route.');
  if (found.methodNotAllowed) throw new HttpError(405, 'Method not allowed.');
  const { route, params } = found;

  const mutating = req.method !== 'GET' && req.method !== 'HEAD';
  // CSRF defence in depth: SameSite=Strict cookie + custom header + same-origin check.
  if (mutating && (req.headers['x-taskhero'] !== '1' || !sameOrigin(req))) {
    throw new HttpError(403, 'Blocked cross-site request.');
  }

  const ctx = {
    req, res, params, status: 200,
    query: Object.fromEntries(url.searchParams),
    ip: req.socket.remoteAddress || 'unknown',
    body: {}, session: null, user: null, db: null, schoolCode: null, school: null,
  };

  if (route.opts.auth !== 'public') {
    const session = auth.loadSession(req);
    if (route.opts.auth === 'super') {
      if (!session || session.kind !== 'super') throw new HttpError(401, 'Super-admin login required.');
    } else {
      if (!session || session.kind !== 'school') throw new HttpError(401, 'Please log in.');
      ctx.session = session; ctx.user = session.user; ctx.db = session.db;
      ctx.schoolCode = session.schoolCode; ctx.school = session.school;
      if (route.opts.roles && !route.opts.roles.includes(ctx.user.role)) {
        throw new HttpError(403, 'You do not have permission to do that.');
      }
      // Accounts created with a temporary password must set their own first.
      if (ctx.user.must_change_password && !route.opts.allowTempPassword) {
        throw new HttpError(403, 'Please change your temporary password first.');
      }
    }
  }

  if (mutating && !route.opts.raw) ctx.body = await readJson(req);
  const result = await route.handler(ctx);
  if (res.writableEnded || res.headersSent) return; // handler streamed its own response (file download)
  sendJson(res, ctx.status, result === undefined ? { ok: true } : result);
}

const server = http.createServer(async (req, res) => {
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
    return serveStatic(req, res, url.pathname);
  } catch (e) {
    if (res.headersSent) { res.destroy(); return; }
    if (e instanceof HttpError) return sendJson(res, e.status, { error: e.message });
    if (e && /UNIQUE constraint/.test(e.message || '')) return sendJson(res, 409, { error: 'That already exists.' });
    console.error('[error]', req.method, req.url, e);
    return sendJson(res, 500, { error: 'Something went wrong on the server.' });
  }
});

function ensureSuperAdmin() {
  const m = db.master();
  if (m.prepare('SELECT 1 FROM super_admin WHERE id = 1').get()) return null;
  const password = process.env.TASKHERO_ADMIN_PASSWORD || auth.randomPassword(14);
  m.prepare('INSERT INTO super_admin (id, username, password_hash) VALUES (1, ?, ?)')
    .run('superadmin', auth.hashPassword(password));
  return password;
}

function start({ port = Number(process.env.PORT || 3000), host = process.env.HOST || '127.0.0.1', quiet = false } = {}) {
  const firstPassword = ensureSuperAdmin();
  return new Promise((resolve) => {
    server.listen(port, host, () => {
      const actual = server.address().port;
      if (!quiet) {
        console.log(`\n  TaskHero is running at http://${host === '0.0.0.0' ? 'localhost' : host}:${actual}`);
        console.log(`  Data folder: ${db.DATA_DIR}`);
        if (firstPassword) {
          console.log('\n  First start: a super-admin account was created.');
          console.log('    URL:      /superadmin');
          console.log('    Username: superadmin');
          console.log(`    Password: ${firstPassword}   <- save this now, it is shown only once`);
          console.log('    (Forgot it later? run: npm run reset-admin)\n');
        }
      }
      resolve({ server, port: actual, superAdminPassword: firstPassword });
    });
  });
}

if (require.main === module) {
  start();
  const stop = () => { server.close(() => { db.closeAll(); process.exit(0); }); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

module.exports = { start, server };

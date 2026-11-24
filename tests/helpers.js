'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/** Boot a real TaskHero server on a random port with a throw-away data folder. */
async function boot({ maxUploadMb = 1 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'taskhero-test-'));
  process.env.TASKHERO_DATA = dir;
  process.env.TASKHERO_MAX_UPLOAD_MB = String(maxUploadMb);
  process.env.TASKHERO_ADMIN_PASSWORD = 'SuperSecret123';
  process.env.TASKHERO_REG_LIMIT = '1000'; // the suite registers many schools from one IP
  const { start, server } = require('../server/index.js');
  const { port } = await start({ port: 0, quiet: true });
  const base = `http://127.0.0.1:${port}`;
  const db = require('../server/lib/db');
  return {
    base, dir, db,
    async stop() {
      await new Promise((r) => server.close(r));
      db.closeAll();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** A browser-like client with its own cookie jar. */
class Client {
  constructor(base) { this.base = base; this.cookie = ''; }

  async raw(method, url, { body, headers = {}, json = true, csrf = true } = {}) {
    const h = { ...headers };
    if (csrf) h['X-TaskHero'] = '1';
    if (this.cookie) h.Cookie = this.cookie;
    let payload = body;
    if (json && body !== undefined && !(body instanceof Buffer)) { h['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
    const res = await fetch(this.base + url, { method, headers: h, body: payload });
    const set = res.headers.getSetCookie?.() || [];
    for (const c of set) {
      const pair = c.split(';')[0];
      if (/=;?$/.test(pair) || /Max-Age=0/i.test(c)) this.cookie = '';
      else this.cookie = pair;
    }
    return res;
  }

  async call(method, url, body, opts = {}) {
    const res = await this.raw(method, url, { body, ...opts });
    const text = await res.text();
    let data; try { data = JSON.parse(text); } catch { data = text; }
    return { status: res.status, data, headers: res.headers };
  }
  get(u) { return this.call('GET', u); }
  post(u, b = {}) { return this.call('POST', u, b); }
  patch(u, b = {}) { return this.call('PATCH', u, b); }
  del(u, b = {}) { return this.call('DELETE', u, b); }

  async upload(url, name, bytes) {
    const res = await this.raw('PUT', `${url}?name=${encodeURIComponent(name)}`, { body: Buffer.from(bytes), headers: { 'Content-Type': 'application/octet-stream' }, json: false });
    const text = await res.text();
    let data; try { data = JSON.parse(text); } catch { data = text; }
    return { status: res.status, data };
  }
}

const GOOD_PW = 'Passw0rdOK';

/** Register + approve a school and return its admin client. */
async function makeSchool(env, code, name = 'Test School') {
  const anon = new Client(env.base);
  const reg = await anon.post('/api/schools/register', {
    schoolName: name, schoolCode: code, country: 'Azerbaijan', ibProgram: 'MYP', studentCount: '100',
    adminName: 'Head Admin', adminEmail: `admin@${code.toLowerCase()}.test`, adminUsername: 'headadmin', password: GOOD_PW, confirmPassword: GOOD_PW,
  });
  if (reg.status !== 201) throw new Error('register failed: ' + JSON.stringify(reg.data));
  const sup = new Client(env.base);
  const l = await sup.post('/api/superadmin/login', { username: 'superadmin', password: 'SuperSecret123' });
  if (l.status !== 200) throw new Error('super login failed');
  await sup.post(`/api/superadmin/schools/${code}/status`, { status: 'approved' });
  const admin = new Client(env.base);
  const login = await admin.post('/api/auth/login', { school: code, username: 'headadmin', password: GOOD_PW });
  if (login.status !== 200) throw new Error('admin login failed: ' + JSON.stringify(login.data));
  return { admin, sup };
}

/** Create a user through the admin API, log them in (setting their own password) and return a client. */
async function makeUser(env, school, admin, username, displayName, role) {
  const created = await admin.post('/api/admin/users', { username, displayName, role, password: GOOD_PW });
  if (created.status !== 201) throw new Error('create user failed: ' + JSON.stringify(created.data));
  const c = new Client(env.base);
  const login = await c.post('/api/auth/login', { school, username, password: GOOD_PW });
  if (login.status !== 200) throw new Error('user login failed: ' + JSON.stringify(login.data));
  await c.post('/api/me/password', { current: GOOD_PW, next: GOOD_PW + 'x' }); // clears must_change_password
  c.userId = created.data.id;
  return c;
}

module.exports = { boot, Client, makeSchool, makeUser, GOOD_PW };

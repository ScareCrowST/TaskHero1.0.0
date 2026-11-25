'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');

const cli = path.join(__dirname, '..', 'server', 'cli.js');

test('backup produces restorable copies of every school database and the uploads', () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'th-bk-data-'));
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'th-bk-out-')), 'snapshot');
  const env = { ...process.env, TASKHERO_DATA: data };
  execFileSync('node', [cli, 'seed-demo'], { env, stdio: 'ignore' });
  fs.mkdirSync(path.join(data, 'uploads', 'DEMO-SCHOOL'), { recursive: true });
  fs.writeFileSync(path.join(data, 'uploads', 'DEMO-SCHOOL', 'abc'), 'file-bytes');

  execFileSync('node', [cli, 'backup', out], { env, stdio: 'ignore' });
  assert.ok(fs.existsSync(path.join(out, 'master.db')));
  assert.equal(fs.readFileSync(path.join(out, 'uploads', 'DEMO-SCHOOL', 'abc'), 'utf8'), 'file-bytes');

  // the copy opens as a normal database and contains the data
  const copy = new DatabaseSync(path.join(out, 'schools', 'DEMO-SCHOOL.db'));
  assert.equal(copy.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'student'").get().n, 3);
  assert.equal(copy.prepare('SELECT COUNT(*) AS n FROM assignments').get().n, 3);
  assert.equal(copy.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  copy.close();
  const master = new DatabaseSync(path.join(out, 'master.db'));
  assert.equal(master.prepare("SELECT status FROM schools WHERE code = 'DEMO-SCHOOL'").get().status, 'approved');
  master.close();

  // refuses to overwrite an existing backup
  assert.throws(() => execFileSync('node', [cli, 'backup', out], { env, stdio: 'pipe' }));
  fs.rmSync(data, { recursive: true, force: true });
});

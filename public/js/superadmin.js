import { api } from './api.js';
import { actions, forms, setRenderer, setOnUnauthorized } from './core.js';
import { html, mount, toast, formData, confirmBox, emptyState, formatDate, $ } from './ui.js';

let filter = 'all';
let data = null;

actions['toggle-theme'] = () => {
  const next = document.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
  document.documentElement.setAttribute('data-theme', next);
  try { localStorage.setItem('th_theme', next); } catch { /* ignore */ }
};

function showLogin() { $('#panel').classList.remove('active'); $('#loginPage').style.display = 'flex'; }
function showPanel() { $('#loginPage').style.display = 'none'; $('#panel').classList.add('active'); }

async function load() {
  data = await api.get('/api/superadmin/schools');
  paint();
}
setRenderer(load);
setOnUnauthorized(showLogin);

function paint() {
  const t = data.totals;
  const list = data.schools.filter((s) => filter === 'all' || s.status === filter);
  mount($('#content'), html`
    <div class="view-head"><div><h1>🏫 Schools</h1><p>Approve or reject registrations. Each approved school gets its own database file.</p></div></div>
    <div class="stat-grid">
      <div class="stat-card"><div class="stat-ico">🏫</div><div><div class="stat-label">Total schools</div><div class="stat-value">${t.schools}</div></div></div>
      <div class="stat-card"><div class="stat-ico">⏳</div><div><div class="stat-label">Pending</div><div class="stat-value">${t.pending}</div></div></div>
      <div class="stat-card"><div class="stat-ico">✅</div><div><div class="stat-label">Approved</div><div class="stat-value">${t.approved}</div></div></div>
      <div class="stat-card"><div class="stat-ico">👥</div><div><div class="stat-label">Total users</div><div class="stat-value">${t.users}</div></div></div>
    </div>
    <div class="tabs">${['all', 'pending', 'approved', 'rejected'].map((f) => html`<button class="tab ${f === filter ? 'active' : ''}" data-action="filter" data-f="${f}">${f[0].toUpperCase() + f.slice(1)}</button>`)}</div>
    ${list.length ? html`<div class="list">${list.map((s) => html`<div class="panel">
      <div class="row-between"><div><h3>${s.name} <span class="code-pill">${s.code}</span></h3>
        <p class="muted small">${s.country}${s.ibProgram ? ' · ' + s.ibProgram : ''}${s.studentCount ? ' · ' + s.studentCount + ' students' : ''} · registered ${formatDate(s.createdAt)}</p></div>
        <span class="state-badge ${s.status === 'approved' ? 'st-graded' : s.status === 'pending' ? 'st-late' : 'st-overdue'}">${s.status}</span></div>
      <p class="small" style="margin-top:8px">👤 ${s.adminName} · ${s.adminEmail}${s.website ? html` · <span class="muted">${s.website}</span>` : ''}</p>
      ${s.reason ? html`<p class="small muted pre" style="margin-top:6px">“${s.reason}”</p>` : ''}
      <p class="small muted" style="margin-top:6px">${s.users} user${s.users === 1 ? '' : 's'} · ${s.classes} class${s.classes === 1 ? '' : 'es'}</p>
      <div class="head-actions" style="margin-top:12px">
        ${s.status !== 'approved' ? html`<button class="btn btn-primary btn-sm" data-action="set" data-code="${s.code}" data-status="approved">✅ ${s.status === 'pending' ? 'Approve' : 'Re-approve'}</button>` : ''}
        ${s.status !== 'rejected' ? html`<button class="btn btn-ghost btn-sm" data-action="set" data-code="${s.code}" data-status="rejected">${s.status === 'approved' ? 'Revoke access' : '❌ Reject'}</button>` : ''}
        <button class="btn btn-ghost btn-sm" data-action="delete" data-code="${s.code}" data-name="${s.name}">🗑️ Delete school</button></div></div>`)}</div>`
      : emptyState('🏫', 'No schools here yet.')}`);
}

actions.filter = (el) => { filter = el.dataset.f; paint(); };
actions.set = async (el) => {
  const status = el.dataset.status;
  if (status !== 'approved' && !confirmBox('Everyone at this school will be logged out and unable to sign in. Continue?')) return;
  await api.post(`/api/superadmin/schools/${el.dataset.code}/status`, { status });
  toast(status === 'approved' ? '✅ School approved' : '⛔ School access removed');
  await load();
};
actions.delete = async (el) => {
  const code = el.dataset.code;
  const typed = window.prompt(`This permanently deletes ALL data of "${el.dataset.name}" (database and uploaded files).\n\nType the school code (${code}) to confirm:`);
  if (typed === null) return;
  await api.del('/api/superadmin/schools/' + code, { confirm: typed.trim() });
  toast('🗑️ School deleted'); await load();
};
actions.logout = async () => { try { await api.post('/api/auth/logout', {}); } catch { /* ignore */ } showLogin(); };

forms['super-login'] = async (form) => {
  await api.post('/api/superadmin/login', formData(form));
  form.reset(); showPanel(); await load();
};

(async function boot() {
  try { await api.get('/api/superadmin/me'); showPanel(); await load(); } catch { showLogin(); }
})();

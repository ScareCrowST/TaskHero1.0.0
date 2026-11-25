import { api } from '../api.js';
import { S, actions, forms, refresh } from '../core.js';
import { html, mount, toast, openModal, closeModal, formData, confirmBox, emptyState, timeAgo, $ } from '../ui.js';

// ---------------------------------------------------------------- overview
export async function overview(el) {
  const [o, s] = await Promise.all([api.get('/api/admin/overview'), api.get('/api/admin/settings')]);
  mount(el, html`<div class="view-head"><div><h1>🏫 ${S.school.name}</h1><p>School ID: <span class="code-pill">${S.school.code}</span> — students and teachers need this to sign up and log in.</p></div></div>
    ${o.pendingTeachers ? html`<div class="notice" style="margin-bottom:20px">⏳ ${o.pendingTeachers} account${o.pendingTeachers > 1 ? 's are' : ' is'} waiting for approval. <button class="link" data-action="nav" data-path="/users">Review →</button></div>` : ''}
    <div class="stat-grid">
      <div class="stat-card"><div class="stat-ico">🎒</div><div><div class="stat-label">Students</div><div class="stat-value">${o.students}</div></div></div>
      <div class="stat-card"><div class="stat-ico">👩‍🏫</div><div><div class="stat-label">Teachers</div><div class="stat-value">${o.teachers}</div></div></div>
      <div class="stat-card"><div class="stat-ico">📚</div><div><div class="stat-label">Classes</div><div class="stat-value">${o.classes}</div></div></div>
      <div class="stat-card"><div class="stat-ico">📝</div><div><div class="stat-label">Assignments</div><div class="stat-value">${o.assignments}</div></div></div>
      <div class="stat-card"><div class="stat-ico">📤</div><div><div class="stat-label">Submissions</div><div class="stat-value">${o.submissions}</div></div></div>
    </div>
    <div class="panel"><h3>Settings</h3>
      <label class="checks" style="margin-top:14px"><label><input type="checkbox" data-change="toggle-signup" ${s.allowStudentSignup ? 'checked' : ''} /> Students can create their own account with the School ID</label></label>
      <p class="muted small" style="margin-top:8px">Turn this off if you prefer to create every student account yourself (People → Add / Import). Teacher accounts always need your approval.</p></div>`);
}
actions['toggle-signup'] = async (el) => {
  await api.patch('/api/admin/settings', { allowStudentSignup: el.checked });
  toast(el.checked ? '✅ Student sign-up is on' : '🔒 Student sign-up is off');
};

// ------------------------------------------------------------------- users
let filter = { role: '', status: '', q: '' };
export async function users(el) {
  const qs = new URLSearchParams(Object.entries(filter).filter(([, v]) => v)).toString();
  const { users: list } = await api.get('/api/admin/users' + (qs ? '?' + qs : ''));
  const pending = list.filter((u) => u.status === 'pending');
  mount(el, html`<div class="view-head"><div><h1>👥 People</h1><p>Create accounts, approve teachers and reset passwords.</p></div>
      <div class="head-actions"><button class="btn btn-primary" data-action="add-user">➕ Add person</button><button class="btn btn-ghost" data-action="import-users">📄 Import CSV</button></div></div>
    <div class="panel"><form data-form="user-filter" class="head-actions" style="margin-bottom:16px">
      <input name="q" placeholder="Search name or username" value="${filter.q}" style="padding:8px 12px;border-radius:8px;border:1px solid var(--border);background:var(--surface);color:var(--text)" />
      <select name="role" style="padding:8px;border-radius:8px;border:1px solid var(--border);background:var(--surface);color:var(--text)">
        ${[['', 'All roles'], ['student', 'Students'], ['teacher', 'Teachers'], ['school_admin', 'Admins']].map(([v, n]) => html`<option value="${v}" ${filter.role === v ? 'selected' : ''}>${n}</option>`)}</select>
      <select name="status" style="padding:8px;border-radius:8px;border:1px solid var(--border);background:var(--surface);color:var(--text)">
        ${[['', 'Any status'], ['active', 'Active'], ['pending', 'Pending'], ['disabled', 'Disabled']].map(([v, n]) => html`<option value="${v}" ${filter.status === v ? 'selected' : ''}>${n}</option>`)}</select>
      <button class="btn btn-ghost btn-sm" type="submit">Filter</button></form>
      ${pending.length ? html`<div class="notice" style="margin-bottom:14px">⏳ ${pending.length} waiting for approval — use “Approve” below.</div>` : ''}
      ${list.length ? html`<div class="table-wrap"><table class="tbl"><thead><tr><th>Name</th><th>Username</th><th>Role</th><th>Year</th><th>Status</th><th></th></tr></thead><tbody>
        ${list.map((u) => html`<tr><td>${u.displayName}</td><td>${u.username}</td><td>${u.role.replace('_', ' ')}</td><td>${u.yearGroup}</td>
          <td><span class="state-badge ${u.status === 'active' ? 'st-graded' : u.status === 'pending' ? 'st-late' : 'st-overdue'}">${u.status}</span></td>
          <td class="nowrap">${u.status === 'pending' ? html`<button class="btn btn-primary btn-sm" data-action="set-status" data-id="${u.id}" data-status="active">Approve</button> ` : ''}
            ${u.id !== S.user.id ? html`<button class="btn btn-ghost btn-sm" data-action="reset-pass" data-id="${u.id}">Reset password</button>
              <button class="btn btn-ghost btn-sm" data-action="set-status" data-id="${u.id}" data-status="${u.status === 'disabled' ? 'active' : 'disabled'}">${u.status === 'disabled' ? 'Enable' : 'Disable'}</button>` : html`<span class="muted small">you</span>`}</td></tr>`)}</tbody></table></div>`
        : emptyState('👥', 'No people match this filter.')}</div>`);
}
forms['user-filter'] = async (form) => { filter = formData(form); refresh(); };

function credentialsBox(rows) {
  return html`<div class="notice" style="margin:12px 0"><b>Save these temporary passwords now — they are shown only once.</b>
    <p class="small muted">Each person must choose their own password at first login.</p>
    <div class="table-wrap"><table class="tbl"><tbody>${rows.map((r) => html`<tr><td>${r.displayName || r.username}</td><td>${r.username}</td><td><span class="temp-pass">${r.tempPassword}</span></td></tr>`)}</tbody></table></div>
    <button class="btn btn-ghost btn-sm" data-action="copy-creds">📋 Copy as CSV</button></div>`;
}
let lastCreds = [];
actions['copy-creds'] = async () => {
  const csv = 'username,name,temporary password\n' + lastCreds.map((r) => `${r.username},${r.displayName || ''},${r.tempPassword}`).join('\n');
  try { await navigator.clipboard.writeText(csv); toast('📋 Copied'); } catch { toast('Select the passwords and copy them manually.', 'error'); }
};

actions['add-user'] = () => openModal({
  title: 'Add a person', subtitle: 'A temporary password is generated for you.', form: 'add-user', submit: 'Create account',
  body: html`<div class="field-row"><div class="field"><label>Full name</label><input name="displayName" required maxlength="60" /></div>
    <div class="field"><label>Username</label><input name="username" required maxlength="30" placeholder="letters, numbers . _ -" /></div></div>
    <div class="field-row"><div class="field"><label>Role</label><select name="role"><option value="student">Student</option><option value="teacher">Teacher</option><option value="school_admin">School admin</option></select></div>
    <div class="field"><label>Year group</label><input name="yearGroup" placeholder="MYP 4" /></div></div>`,
});
forms['add-user'] = async (form) => {
  const r = await api.post('/api/admin/users', formData(form));
  lastCreds = [r];
  openModal({ title: 'Account created', body: html`${credentialsBox([r])}<div class="modal-actions"><button class="btn btn-primary" data-action="close-modal">Done</button></div>` });
  refresh();
};

actions['import-users'] = () => openModal({
  title: 'Import people from CSV', subtitle: 'One person per line: username, full name, role, year group', form: 'import-users', submit: 'Import', wide: true,
  body: html`<div class="field"><textarea name="csv" rows="8" required placeholder="username,displayName,role,yearGroup&#10;anna,Anna Karimova,student,MYP 4&#10;mr_ali,Mr Ali,teacher,"></textarea></div>
    <p class="field-hint">Role is student, teacher or school_admin (default student). Up to 500 lines.</p>`,
});
forms['import-users'] = async (form) => {
  const r = await api.post('/api/admin/users/import', formData(form));
  lastCreds = r.created;
  openModal({ title: `Imported ${r.created.length} ${r.created.length === 1 ? 'person' : 'people'}`, wide: true,
    body: html`${r.created.length ? credentialsBox(r.created) : ''}
      ${r.errors.length ? html`<div class="notice"><b>${r.errors.length} line${r.errors.length > 1 ? 's' : ''} skipped</b><ul class="small">${r.errors.map((e) => html`<li>Line ${e.line}: ${e.error}</li>`)}</ul></div>` : ''}
      <div class="modal-actions"><button class="btn btn-primary" data-action="close-modal">Done</button></div>` });
  refresh();
};

actions['reset-pass'] = async (el) => {
  if (!confirmBox('Reset this person\'s password? They will be logged out and must choose a new one.')) return;
  const r = await api.post(`/api/admin/users/${el.dataset.id}/reset-password`, {});
  lastCreds = [r];
  openModal({ title: 'Password reset', body: html`${credentialsBox([r])}<div class="modal-actions"><button class="btn btn-primary" data-action="close-modal">Done</button></div>` });
};
actions['set-status'] = async (el) => {
  if (el.dataset.status === 'disabled' && !confirmBox('Disable this account? They will be logged out immediately.')) return;
  await api.patch('/api/admin/users/' + el.dataset.id, { status: el.dataset.status });
  toast('✅ Updated'); refresh();
};

import { api } from '../api.js';
import { S, actions, forms, go, refresh, celebrate, hooks } from '../core.js';
import {
  html, raw, mount, toast, openModal, closeModal, formData, confirmBox, emptyState, avatarHTML, levelBar,
  subjectEmoji, subjectOptions, dayStr, parseDue, $,
} from '../ui.js';

// ------------------------------------------------------------------ calendar
let calMonth = new Date(); calMonth.setDate(1);

export async function calendar(el) {
  const y = calMonth.getFullYear(); const m = calMonth.getMonth();
  const first = new Date(y, m, 1);
  const startOffset = (first.getDay() + 6) % 7; // week starts on Monday
  const gridStart = new Date(y, m, 1 - startOffset);
  const gridEnd = new Date(gridStart); gridEnd.setDate(gridStart.getDate() + 41);
  const { events } = await api.get(`/api/calendar?from=${dayStr(gridStart)}&to=${dayStr(gridEnd)}`);
  const byDay = {};
  for (const e of events) (byDay[e.dueAt.slice(0, 10)] ||= []).push(e);
  const today = dayStr();
  const cells = [];
  for (let i = 0; i < 42; i++) {
    const d = new Date(gridStart); d.setDate(gridStart.getDate() + i);
    const key = dayStr(d);
    const evs = byDay[key] || [];
    cells.push(html`<div class="cal-day ${d.getMonth() !== m ? 'other' : ''} ${key === today ? 'today' : ''}">
      <div class="cal-num">${d.getDate()}</div>
      ${evs.slice(0, 3).map((e) => html`<button class="cal-ev ${e.type === 'task' ? 'task' : ''} ${e.done ? 'done' : ''} ${e.state === 'overdue' ? 'overdue' : ''}" data-action="cal-open" data-type="${e.type}" data-id="${e.id}" title="${e.title}">${subjectEmoji(e.subject)} ${e.title}</button>`)}
      ${evs.length > 3 ? html`<span class="muted small">+${evs.length - 3} more</span>` : ''}</div>`);
  }
  mount(el, html`<div class="view-head"><div><h1>📅 Calendar</h1><p>Deadlines${S.user.role === 'student' ? ' and personal quests' : ''} for the month.</p></div></div>
    <div class="panel"><div class="cal-head"><button class="btn btn-ghost btn-sm" data-action="cal-prev">← Prev</button>
      <h3>${first.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' })}</h3>
      <div><button class="btn btn-ghost btn-sm" data-action="cal-today">Today</button> <button class="btn btn-ghost btn-sm" data-action="cal-next">Next →</button></div></div>
      <div class="cal-grid">${['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => html`<div class="cal-dow">${d}</div>`)}${cells}</div></div>`);
}
actions['cal-prev'] = () => { calMonth = new Date(calMonth.getFullYear(), calMonth.getMonth() - 1, 1); refresh(); };
actions['cal-next'] = () => { calMonth = new Date(calMonth.getFullYear(), calMonth.getMonth() + 1, 1); refresh(); };
actions['cal-today'] = () => { calMonth = new Date(); calMonth.setDate(1); refresh(); };
actions['cal-open'] = (el) => { if (el.dataset.type === 'assignment') go('/assignment/' + el.dataset.id); else go('/quests'); };

let tasksCache = [];
// -------------------------------------------------------------------- quests
export async function quests(el) {
  if (S.user.role !== 'student') { go('/'); return; }
  const { tasks } = await api.get('/api/tasks');
  const today = dayStr();
  const open = tasks.filter((t) => !t.done); const done = tasks.filter((t) => t.done);
  const row = (t) => html`<div class="quest ${t.done ? 'done' : ''}">
    <button class="check ${t.done ? 'on' : ''}" data-action="toggle-task" data-id="${t.id}" aria-label="${t.done ? 'Mark as not done' : 'Mark as done'}">${t.done ? '✓' : ''}</button>
    <div class="row-main"><div class="row-title">${subjectEmoji(t.subject)} ${t.title}</div>
      <div class="row-sub"><span class="${!t.done && t.due < today ? 'overdue-text' : ''}">Due ${t.due}</span> · <span class="prio prio-${t.priority}">${t.priority}</span>${t.description ? ' · ' + t.description : ''}</div></div>
    <div class="row-end"><button class="icon-btn" data-action="edit-task" data-id="${t.id}" aria-label="Edit">✏️</button><button class="icon-btn danger" data-action="delete-task" data-id="${t.id}" aria-label="Delete">🗑️</button></div></div>`;
  tasksCache = tasks;
  mount(el, html`<div class="view-head"><div><h1>⚔️ My quests</h1><p>Your own to-dos. Each quest gives ${tasks[0] ? tasks[0].xp : 10} XP — the first 3 you finish each day count.</p></div>
    <div class="head-actions"><button class="btn btn-primary" data-action="new-task">➕ New quest</button></div></div>
    <div class="panel"><h3>In progress (${open.length})</h3><div class="list" style="margin-top:12px">${open.length ? open.map(row) : emptyState('🏆', 'All quests complete!')}</div></div>
    ${done.length ? html`<div class="panel"><h3>Completed (${done.length})</h3><div class="list" style="margin-top:12px">${done.map(row)}</div></div>` : ''}`);
}

const taskForm = (t = {}) => html`<div class="field"><label>Quest name</label><input name="title" required maxlength="150" value="${t.title || ''}" /></div>
  <div class="field-row"><div class="field"><label>Subject</label><select name="subject">${subjectOptions(t.subject || 'Math')}</select></div>
  <div class="field"><label>Due date</label><input type="date" name="due" required value="${t.due || dayStr()}" /></div></div>
  <div class="field"><label>Priority</label><select name="priority">${['low', 'medium', 'high'].map((p) => raw(`<option value="${p}"${(t.priority || 'medium') === p ? ' selected' : ''}>${p}</option>`))}</select></div>
  <div class="field"><label>Notes (optional)</label><textarea name="description" rows="2" maxlength="1000">${t.description || ''}</textarea></div>`;

let editingTask = null;
actions['new-task'] = () => { editingTask = null; openModal({ title: 'New quest', form: 'task', submit: 'Add quest', body: taskForm() }); };
actions['edit-task'] = (el) => { editingTask = tasksCache.find((t) => t.id === Number(el.dataset.id)); openModal({ title: 'Edit quest', form: 'task', submit: 'Save', body: taskForm(editingTask) }); };
forms.task = async (form) => {
  if (editingTask) await api.patch('/api/tasks/' + editingTask.id, formData(form)); else await api.post('/api/tasks', formData(form));
  closeModal(); toast('✅ Quest saved'); refresh();
};
actions['toggle-task'] = async (el) => {
  const r = await api.post(`/api/tasks/${el.dataset.id}/toggle`, {});
  if (r.xp) { celebrate(r.xp); await hooks.reloadMe(); } else if (r.task.done) toast('✓ Done (no more XP today, or already earned)');
  refresh();
};
actions['delete-task'] = async (el) => { if (!confirmBox('Delete this quest?')) return; await api.del('/api/tasks/' + el.dataset.id); refresh(); };

// ------------------------------------------------------------------- profile
const SKIN = ['#f5d0a9', '#e0ac69', '#c68642', '#8d5524', '#ffdbac', '#f1c27d'];
const HAIR = ['#2b1b17', '#6b3f1d', '#d4a017', '#c0392b', '#3498db', '#9b59b6', '#ecf0f1', '#111111'];
const OUTFIT = ['#3498db', '#e74c3c', '#2ecc71', '#9b59b6', '#f39c12', '#1abc9c', '#e84393', '#34495e'];
const WEAPONS = [['sword', '⚔️ Sword'], ['staff', '🪄 Staff'], ['bow', '🏹 Bow'], ['book', '📖 Book']];
let draft = null;

function swatches(kind, colors) {
  return html`<div class="swatches">${colors.map((c) => html`<button type="button" class="swatch ${draft[kind] === c ? 'on' : ''}" style="background:${c}" data-action="pick-color" data-kind="${kind}" data-color="${c}" aria-label="${kind} ${c}"></button>`)}</div>`;
}

export async function profile(el) {
  const { user: u } = await api.get('/api/me');
  S.user = u;
  const student = u.role === 'student';
  draft = { ...u.avatar };
  mount(el, html`<div class="view-head"><div><h1>${student ? '🧙 My hero' : '⚙️ Account'}</h1><p>${u.displayName} · @${u.username} · ${S.school.name}</p></div></div>
    <div class="profile-grid">
      ${student ? html`<div class="panel profile-card"><div id="avatarPreview">${avatarHTML(draft)}</div><h3 style="margin-top:12px">${u.title}</h3>
        <p class="muted small">Level ${u.level} · ${u.xp} XP · 🔥 ${u.streak} day streak</p>${levelBar(u, true)}
        <p class="muted small" style="margin-top:6px">${u.xpIntoLevel} / ${u.xpNeeded} XP to next level</p></div>` : ''}
      <div class="stack">
        <div class="panel"><h3>Profile</h3><form data-form="profile" style="margin-top:14px">
          <div class="field"><label>Display name</label><input name="displayName" required maxlength="60" value="${u.displayName}" /></div>
          ${student ? html`<div class="field"><label>Hero title</label><input name="title" maxlength="30" value="${u.title}" /></div>
            <div class="field"><label>Skin</label>${swatches('skin', SKIN)}</div><div class="field"><label>Hair</label>${swatches('hair', HAIR)}</div>
            <div class="field"><label>Outfit</label>${swatches('outfit', OUTFIT)}</div>
            <div class="field"><label>Weapon</label><div class="role-tabs">${WEAPONS.map(([k, n]) => html`<button type="button" class="role-tab ${draft.weapon === k ? 'active' : ''}" data-action="pick-weapon" data-weapon="${k}">${n}</button>`)}</div></div>` : ''}
          <div class="form-error" role="alert"></div><button class="btn btn-primary" type="submit">Save profile</button></form></div>
        <div class="panel"><h3>Change password</h3><form data-form="password" style="margin-top:14px">
          <div class="field"><label>Current password</label><input type="password" name="current" required autocomplete="current-password" /></div>
          <div class="field"><label>New password</label><input type="password" name="next" required autocomplete="new-password" placeholder="8+ characters, letters and numbers" /></div>
          <div class="form-error" role="alert"></div><button class="btn btn-primary" type="submit">Update password</button></form></div>
      </div></div>`);
}
function repaintPreview() { mount($('#avatarPreview'), avatarHTML(draft)); }
actions['pick-color'] = (el) => {
  draft[el.dataset.kind] = el.dataset.color;
  el.parentElement.querySelectorAll('.swatch').forEach((s) => s.classList.toggle('on', s === el));
  repaintPreview();
};
actions['pick-weapon'] = (el) => {
  draft.weapon = el.dataset.weapon;
  el.parentElement.querySelectorAll('.role-tab').forEach((t) => t.classList.toggle('active', t === el));
  repaintPreview();
};
forms.profile = async (form) => {
  const d = formData(form);
  const body = { displayName: d.displayName };
  if (S.user.role === 'student') { body.title = d.title; body.avatar = draft; }
  await api.patch('/api/me', body);
  await hooks.reloadMe(); toast('✅ Profile saved'); refresh();
};
forms.password = async (form) => {
  await api.post('/api/me/password', formData(form));
  form.reset(); toast('🔒 Password updated');
};

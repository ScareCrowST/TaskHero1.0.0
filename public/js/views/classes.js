import { api } from '../api.js';
import { S, actions, forms, go, refresh, celebrate } from '../core.js';
import {
  html, raw, mount, toast, openModal, closeModal, formData, confirmBox, emptyState, stateBadge,
  subjectEmoji, subjectName, subjectOptions, formatDue, timeAgo, CRITERIA, SUBJECTS,
} from '../ui.js';

const isStaff = () => S.user.role !== 'student';
let tab = 'work'; // remembered while navigating inside the app
let current = null;

// ------------------------------------------------------------------ list
export async function list(el) {
  const { classes } = await api.get('/api/classes');
  const staff = isStaff();
  mount(el, html`
    <div class="view-head"><div><h1>${S.user.role === 'school_admin' ? 'All classes' : 'My classes'}</h1>
      <p>${staff ? 'Create a class, then share its join code with your students.' : 'Join a class with the code from your teacher.'}</p></div>
      <div class="head-actions">${staff ? html`<button class="btn btn-primary" data-action="new-class">➕ New class</button>`
        : html`<button class="btn btn-primary" data-action="join-class">🔑 Join a class</button>`}</div></div>
    ${classes.length ? html`<div class="cards-grid">${classes.map((c) => html`
      <a class="class-card" href="#/class/${c.id}" data-path="/class/${c.id}">
        <div class="class-emoji">${subjectEmoji(c.subject)}</div><h3>${c.name}</h3>
        <p class="muted small">${subjectName(c.subject)}${c.yearGroup ? ' · ' + c.yearGroup : ''}</p>
        <p class="muted small">👩‍🏫 ${c.teacher ? c.teacher.displayName : '—'} · 👥 ${c.memberCount}</p>
        <div style="margin-top:10px">${c.canManage
          ? html`<span class="chip">${c.toGrade} to grade</span><span class="code-pill">${c.code}</span>`
          : html`<span class="chip">${c.openCount} to hand in</span>`}</div>
      </a>`)}</div>` : emptyState('📚', staff ? 'No classes yet. Create your first one!' : 'You are not in any class yet. Ask your teacher for a join code.')}`);
}

actions['join-class'] = () => openModal({
  title: 'Join a class', subtitle: 'Enter the code your teacher gave you.', form: 'join-class', submit: 'Join',
  body: html`<div class="field"><label>Class code</label><input name="code" required placeholder="e.g. ABCD-2345" autocomplete="off" /></div>`,
});
forms['join-class'] = async (form) => {
  const { class: c } = await api.post('/api/classes/join', formData(form));
  closeModal(); toast('🎉 Joined ' + c.name); go('/class/' + c.id);
};

actions['new-class'] = async () => {
  let teacherField = '';
  if (S.user.role === 'school_admin') {
    const { users } = await api.get('/api/admin/users?role=teacher&status=active');
    teacherField = html`<div class="field"><label>Teacher</label><select name="teacherId" required>${users.map((t) => html`<option value="${t.id}">${t.displayName}</option>`)}</select></div>`;
    if (!users.length) { toast('Create an active teacher account first (People page).', 'error'); return; }
  }
  openModal({
    title: 'New class', form: 'new-class', submit: 'Create class',
    body: html`<div class="field"><label>Class name</label><input name="name" required maxlength="100" placeholder="e.g. MYP 4 Math" /></div>
      <div class="field-row"><div class="field"><label>Subject</label><select name="subject">${subjectOptions('Math')}</select></div>
      <div class="field"><label>Year group</label><input name="yearGroup" placeholder="MYP 4" /></div></div>
      ${teacherField}
      <div class="field"><label>Description (optional)</label><textarea name="description" rows="2" maxlength="500"></textarea></div>`,
  });
};
forms['new-class'] = async (form) => {
  const d = formData(form);
  if (d.teacherId) d.teacherId = Number(d.teacherId);
  const { class: c } = await api.post('/api/classes', d);
  closeModal(); toast('✅ Class created'); go('/class/' + c.id);
};

// ---------------------------------------------------------------- detail
export async function detail(el, id) {
  const { class: c } = await api.get('/api/classes/' + id);
  current = c;
  if (!c.canManage && (tab === 'people' || tab === 'grades')) tab = 'work';
  const tabs = [['work', 'Assignments'], ['news', 'Announcements'], ['talk', 'Discussion']];
  if (c.canManage) tabs.push(['people', 'People'], ['grades', 'Gradebook']);

  mount(el, html`
    <a class="link back-link" href="#/classes" data-path="/classes">← All classes</a>
    <div class="view-head"><div><h1>${subjectEmoji(c.subject)} ${c.name}</h1>
      <p>${subjectName(c.subject)}${c.yearGroup ? ' · ' + c.yearGroup : ''} · 👩‍🏫 ${c.teacher ? c.teacher.displayName : '—'}${c.description ? ' · ' + c.description : ''}</p></div>
      <div class="head-actions">
        ${c.canManage ? html`<span title="Students join with this code">Join code: <span class="code-pill">${c.code}</span></span>
          <button class="btn btn-primary" data-action="new-assignment">➕ New assignment</button>
          <button class="btn btn-ghost" data-action="edit-class">✏️</button><button class="btn btn-ghost" data-action="delete-class">🗑️</button>`
          : html`<button class="btn btn-ghost" data-action="leave-class">Leave class</button>`}
      </div></div>
    <div class="tabs">${tabs.map(([k, label]) => html`<button class="tab ${k === tab ? 'active' : ''}" data-action="class-tab" data-tab="${k}">${label}</button>`)}</div>
    <div id="classBody"></div>`);
  await paintTab();
}

actions['class-tab'] = async (el) => {
  tab = el.dataset.tab;
  document.querySelectorAll('.tabs .tab').forEach((t) => t.classList.toggle('active', t === el));
  await paintTab();
};

async function paintTab() {
  const body = document.getElementById('classBody');
  if (!body || !current) return;
  const c = current;
  if (tab === 'work') {
    const { assignments } = await api.get(`/api/classes/${c.id}/assignments`);
    mount(body, assignments.length ? html`<div class="list">${assignments.map((a) => html`
      <a class="row-item" href="#/assignment/${a.id}" data-path="/assignment/${a.id}">
        <div class="row-ico">📝</div>
        <div class="row-main"><div class="row-title">${a.title}</div>
          <div class="row-sub">Due ${formatDue(a.dueAt)} ${a.criteria.map((k) => html`<span class="chip crit-chip">${k}</span>`)}</div></div>
        <div class="row-end">${a.canManage
          ? html`<span class="chip">${a.counts.submitted}/${a.counts.students} submitted</span><span class="chip">${a.counts.graded} graded</span>`
          : html`${stateBadge(a.state, a.mySubmission && a.mySubmission.late)}`}</div>
      </a>`)}</div>` : emptyState('📝', c.canManage ? 'No assignments yet. Create the first one!' : 'No assignments yet.'));
  } else if (tab === 'news') {
    const { announcements } = await api.get(`/api/classes/${c.id}/announcements`);
    mount(body, html`${c.canManage ? html`<div style="margin-bottom:16px"><button class="btn btn-primary btn-sm" data-action="new-announcement">📢 Post announcement</button></div>` : ''}
      ${announcements.length ? html`<div class="list">${announcements.map((a) => html`<div class="post"><div class="row-between"><div class="meta">${a.author} · ${timeAgo(a.createdAt)}</div>
        ${c.canManage ? html`<button class="icon-btn danger" data-action="delete-announcement" data-id="${a.id}" aria-label="Delete">🗑️</button>` : ''}</div>
        <b>${a.title}</b><p class="pre">${a.body}</p></div>`)}</div>` : emptyState('📢', 'No announcements yet.')}`);
  } else if (tab === 'talk') {
    const { threads } = await api.get(`/api/classes/${c.id}/threads`);
    mount(body, html`<div style="margin-bottom:16px"><button class="btn btn-primary btn-sm" data-action="new-thread">💬 Start a discussion</button></div>
      ${threads.length ? html`<div class="list">${threads.map((t) => html`<div class="post" id="thread-${t.id}">
        <div class="row-between"><div class="meta">${t.author}<span class="role-tag">${t.authorRole}</span> · ${timeAgo(t.createdAt)}</div>
          ${t.canDelete ? html`<button class="icon-btn danger" data-action="delete-thread" data-id="${t.id}" aria-label="Delete discussion">🗑️</button>` : ''}</div>
        <b>${t.title}</b><p class="pre">${t.body}</p>
        <button class="link small" data-action="toggle-thread" data-id="${t.id}">💬 ${t.commentCount} ${t.commentCount === 1 ? 'reply' : 'replies'}</button>
        <div class="thread-body" hidden></div></div>`)}</div>` : emptyState('💬', 'No discussions yet. Ask a question!')}`);
  } else if (tab === 'people') {
    mount(body, html`<div class="panel"><div class="panel-head"><h3>👥 ${c.members.length} students</h3>
        <form data-form="add-member" class="head-actions"><input name="username" placeholder="Student username" required style="padding:8px 12px;border-radius:8px;border:1px solid var(--border);background:var(--surface);color:var(--text)" />
        <button class="btn btn-primary btn-sm" type="submit">Add</button></form></div>
      <div class="form-error" role="alert"></div>
      ${c.members.length ? html`<div class="table-wrap"><table class="tbl"><thead><tr><th>Name</th><th>Username</th><th>Year</th><th></th></tr></thead><tbody>
        ${c.members.map((m) => html`<tr><td>${m.displayName}</td><td>${m.username}</td><td>${m.yearGroup}</td>
          <td><button class="btn btn-ghost btn-sm" data-action="remove-member" data-id="${m.id}">Remove</button></td></tr>`)}</tbody></table></div>`
        : emptyState('👥', 'No students yet. Share the join code, or add them by username.')}</div>`);
  } else if (tab === 'grades') {
    const gb = await api.get(`/api/classes/${c.id}/gradebook`);
    if (!gb.students.length || !gb.assignments.length) { mount(body, emptyState('📊', 'The gradebook appears once the class has students and assignments.')); return; }
    mount(body, html`<div class="panel"><div class="table-wrap"><table class="tbl"><thead><tr><th>Student</th>
      ${gb.assignments.map((a) => html`<th class="gb-cell"><a class="link" href="#/assignment/${a.id}" data-path="/assignment/${a.id}">${a.title}</a></th>`)}</tr></thead><tbody>
      ${gb.students.map((s) => html`<tr><td>${s.displayName}</td>${gb.assignments.map((a) => {
        const cell = gb.cells[`${s.id}:${a.id}`];
        if (!cell || cell.status === 'draft') return html`<td class="gb-cell gb-none">—</td>`;
        if (cell.status === 'submitted') return html`<td class="gb-cell">${stateBadge('submitted', cell.late)}</td>`;
        return html`<td class="gb-cell">${Object.entries(cell.grades).map(([k, v]) => html`<span class="chip crit-chip">${k}${v}</span>`)}</td>`;
      })}</tr>`)}</tbody></table></div></div>`);
  }
}

// ------------------------------------------------------------ class actions
actions['edit-class'] = () => openModal({
  title: 'Edit class', form: 'edit-class', submit: 'Save',
  body: html`<div class="field"><label>Class name</label><input name="name" required value="${current.name}" /></div>
    <div class="field-row"><div class="field"><label>Subject</label><select name="subject">${subjectOptions(current.subject)}</select></div>
    <div class="field"><label>Year group</label><input name="yearGroup" value="${current.yearGroup}" /></div></div>
    <div class="field"><label>Description</label><textarea name="description" rows="2">${current.description}</textarea></div>`,
});
forms['edit-class'] = async (form) => { await api.patch('/api/classes/' + current.id, formData(form)); closeModal(); toast('✅ Saved'); refresh(); };
actions['delete-class'] = async () => {
  if (!confirmBox(`Delete "${current.name}" with all its assignments, submissions and files? This cannot be undone.`)) return;
  await api.del('/api/classes/' + current.id); toast('🗑️ Class deleted'); go('/classes');
};
actions['leave-class'] = async () => {
  if (!confirmBox('Leave this class? Your submissions stay with the teacher.')) return;
  await api.post(`/api/classes/${current.id}/leave`, {}); go('/classes');
};

actions['new-assignment'] = () => openModal({
  title: 'New assignment', form: 'new-assignment', submit: 'Post assignment', wide: true,
  body: html`<div class="field"><label>Title</label><input name="title" required maxlength="150" /></div>
    <div class="field"><label>Instructions</label><textarea name="instructions" rows="5" maxlength="6000"></textarea></div>
    <div class="field-row"><div class="field"><label>Due date</label><input type="datetime-local" name="dueAt" required /></div>
    <div class="field"><label>XP reward</label><input type="number" name="xp" min="0" max="100" value="40" /></div></div>
    <div class="field"><label>MYP criteria assessed</label><div class="checks">${Object.entries(CRITERIA).map(([k, n]) => html`<label><input type="checkbox" name="crit" value="${k}" /> ${k} · ${n}</label>`)}</div></div>
    <p class="field-hint">You can attach worksheets after posting the assignment.</p>`,
});
forms['new-assignment'] = async (form) => {
  const d = formData(form);
  const criteria = [...form.querySelectorAll('input[name=crit]:checked')].map((i) => i.value);
  const { assignment } = await api.post(`/api/classes/${current.id}/assignments`, { title: d.title, instructions: d.instructions, dueAt: d.dueAt, xp: Number(d.xp), criteria });
  closeModal(); toast('✅ Assignment posted'); go('/assignment/' + assignment.id);
};

actions['new-announcement'] = () => openModal({
  title: 'Post announcement', form: 'new-announcement', submit: 'Post',
  body: html`<div class="field"><label>Title</label><input name="title" required maxlength="120" /></div><div class="field"><label>Message</label><textarea name="body" rows="5" required maxlength="4000"></textarea></div>`,
});
forms['new-announcement'] = async (form) => { await api.post(`/api/classes/${current.id}/announcements`, formData(form)); closeModal(); toast('📢 Posted'); await paintTab(); };
actions['delete-announcement'] = async (el) => { if (!confirmBox('Delete this announcement?')) return; await api.del('/api/announcements/' + el.dataset.id); await paintTab(); };

actions['new-thread'] = () => openModal({
  title: 'Start a discussion', form: 'new-thread', submit: 'Post',
  body: html`<div class="field"><label>Title</label><input name="title" required maxlength="150" /></div><div class="field"><label>Message</label><textarea name="body" rows="4" required maxlength="4000"></textarea></div>`,
});
forms['new-thread'] = async (form) => { await api.post(`/api/classes/${current.id}/threads`, formData(form)); closeModal(); await paintTab(); };
actions['delete-thread'] = async (el) => { if (!confirmBox('Delete this discussion and its replies?')) return; await api.del('/api/threads/' + el.dataset.id); await paintTab(); };

async function loadThread(box, id) {
  const { comments } = await api.get('/api/threads/' + id);
  mount(box, html`${comments.map((m) => html`<div class="comment"><div class="meta small muted">${m.author}<span class="role-tag">${m.authorRole}</span> · ${timeAgo(m.createdAt)}
      ${m.canDelete ? html` · <button class="link" data-action="delete-comment" data-id="${m.id}" data-thread="${id}">delete</button>` : ''}</div><p class="pre">${m.body}</p></div>`)}
    <form data-form="add-comment" data-thread="${id}" style="display:flex;gap:8px;margin-top:10px"><input name="body" required maxlength="2000" placeholder="Write a reply…" style="flex:1;padding:8px 12px;border-radius:8px;border:1px solid var(--border);background:var(--surface);color:var(--text)" />
    <button class="btn btn-primary btn-sm" type="submit">Reply</button></form><div class="form-error" role="alert"></div>`);
}
actions['toggle-thread'] = async (el) => {
  const box = el.parentElement.querySelector('.thread-body');
  box.hidden = !box.hidden;
  if (!box.hidden) await loadThread(box, el.dataset.id);
};
forms['add-comment'] = async (form) => {
  const id = form.dataset.thread;
  await api.post(`/api/threads/${id}/comments`, formData(form));
  await loadThread(form.closest('.thread-body'), id);
};
actions['delete-comment'] = async (el) => { await api.del('/api/comments/' + el.dataset.id); await loadThread(el.closest('.thread-body'), el.dataset.thread); };

forms['add-member'] = async (form) => {
  await api.post(`/api/classes/${current.id}/members`, formData(form));
  const { class: c } = await api.get('/api/classes/' + current.id); current = c; toast('✅ Student added'); await paintTab();
};
actions['remove-member'] = async (el) => {
  if (!confirmBox('Remove this student from the class?')) return;
  await api.del(`/api/classes/${current.id}/members/${el.dataset.id}`);
  const { class: c } = await api.get('/api/classes/' + current.id); current = c; await paintTab();
};

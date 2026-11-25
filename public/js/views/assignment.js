import { api } from '../api.js';
import { S, actions, forms, go, refresh, celebrate, hooks } from '../core.js';
import {
  html, mount, toast, openModal, closeModal, formData, confirmBox, emptyState, stateBadge,
  formatDue, dueIn, timeAgo, fileSize, CRITERIA, $,
} from '../ui.js';

let A = null; // the assignment currently shown

const fileRow = (f, canDelete) => html`<div class="file-item">📎 <a href="/api/files/${f.id}" download>${f.name}</a>
  <span class="muted small">${fileSize(f.size)}</span>${canDelete ? html`<button class="icon-btn danger" data-action="delete-file" data-id="${f.id}" aria-label="Remove file">✕</button>` : ''}</div>`;

const gradePills = (grades) => html`<div class="grade-row">${Object.entries(grades).map(([k, v]) => html`<div class="grade-pill"><b>${v}</b><span>${k} · ${CRITERIA[k]}</span></div>`)}</div>`;

export async function render(el, id) {
  const { assignment: a } = await api.get('/api/assignments/' + id);
  A = a;
  const head = html`
    <a class="link back-link" href="#/class/${a.classId}" data-path="/class/${a.classId}">← ${a.className}</a>
    <div class="view-head"><div><h1>${a.title}</h1>
      <p>${a.className} · Due ${formatDue(a.dueAt)} · <span class="${a.state === 'overdue' ? 'overdue-text' : ''}">${dueIn(a.dueAt)}</span>
      ${a.criteria.map((k) => html` <span class="chip crit-chip" title="${CRITERIA[k]}">${k}</span>`)} · ⚡ ${a.xp} XP</p></div>
      <div class="head-actions">${a.canManage ? html`<button class="btn btn-ghost" data-action="edit-assignment">✏️ Edit</button><button class="btn btn-ghost" data-action="delete-assignment">🗑️ Delete</button>` : stateBadge(a.state, a.mySubmission && a.mySubmission.late)}</div></div>`;

  const info = html`<div class="panel"><h3>Instructions</h3>
    ${a.instructions ? html`<p class="pre" style="margin-top:10px">${a.instructions}</p>` : html`<p class="muted" style="margin-top:10px">No written instructions.</p>`}
    ${a.files.length ? html`<h3 style="margin-top:18px">Resources</h3><div class="file-list">${a.files.map((f) => fileRow(f, a.canManage))}</div>` : ''}
    ${a.canManage ? html`<label class="file-drop" style="margin-top:14px">📎 Attach a worksheet or resource<input type="file" data-change="upload-assignment-file" /></label>` : ''}</div>`;

  mount(el, a.canManage ? html`${head}<div class="stack">${info}${teacherPanel(a)}</div>` : html`${head}<div class="detail-grid">${info}${studentPanel(a)}</div>`);
}

// -------------------------------------------------------------- student side
function studentPanel(a) {
  const s = a.mySubmission;
  const locked = s && s.status === 'graded';
  if (locked) {
    return html`<div class="panel"><h3>🎯 Your result</h3>${Object.keys(s.grades).length ? gradePills(s.grades) : ''}
      ${s.feedback ? html`<div class="feedback-box"><b>Teacher feedback</b><p class="pre" style="margin-top:6px">${s.feedback}</p></div>` : ''}
      <h3 style="margin-top:18px">Your submission</h3>${s.text ? html`<p class="pre small">${s.text}</p>` : ''}
      <div class="file-list">${s.files.map((f) => fileRow(f, false))}</div>
      <p class="muted small">Graded work is locked and can no longer be changed.</p></div>`;
  }
  return html`<div class="panel"><h3>${s && s.status === 'submitted' ? '✅ Submitted — you can still update it until it is graded' : '📤 Your work'}</h3>
    ${s && s.status === 'submitted' ? html`<p class="muted small">Submitted ${timeAgo(s.submittedAt)}${s.late ? ' (late)' : ''}.</p>` : ''}
    ${a.state === 'overdue' ? html`<p class="notice small">⏰ This assignment is overdue. You can still hand it in, but it will be marked late and give half XP.</p>` : ''}
    <form data-form="submit-work"><div class="field" style="margin-top:12px"><label>Your answer (optional if you attach a file)</label>
      <textarea class="big" name="text" maxlength="20000" placeholder="Type your answer here…">${s ? s.text : ''}</textarea></div>
      <div class="file-list" id="myFiles">${(s ? s.files : []).map((f) => fileRow(f, true))}</div>
      <label class="file-drop">📎 Click to attach a file (max 10 MB)<input type="file" data-change="upload-submission-file" /></label>
      <div class="form-error" role="alert"></div>
      <button class="btn btn-primary btn-block" type="submit" style="margin-top:14px">${s && s.status === 'submitted' ? 'Update submission' : 'Submit work →'}</button></form></div>`;
}

forms['submit-work'] = async (form) => {
  const d = formData(form);
  const r = await api.post(`/api/assignments/${A.id}/submit`, { text: d.text });
  toast('✅ Work submitted!');
  celebrate(r.xp);
  await hooks.reloadMe();
  refresh();
};

actions['upload-submission-file'] = async (input) => {
  const file = input.files[0]; if (!file) return;
  const text = $('textarea[name=text]') ? $('textarea[name=text]').value : '';
  toast('Uploading ' + file.name + '…');
  await api.upload(`/api/assignments/${A.id}/submission/files`, file);
  input.value = '';
  // keep what the student already typed
  const typed = text;
  await refresh();
  const box = $('textarea[name=text]'); if (box && typed && !box.value) box.value = typed;
  toast('📎 File attached');
};

// -------------------------------------------------------------- teacher side
function teacherPanel(a) {
  const total = a.roster.length;
  return html`<div class="panel"><div class="panel-head"><h3>📥 Submissions</h3><span class="muted small">${a.counts.submitted}/${total} handed in · ${a.counts.graded} graded</span></div>
    ${total ? html`<div class="list">${a.roster.map((r) => html`<div class="row-item ${r.submission ? 'clickable' : ''}" ${r.submission ? html`data-action="open-grading" data-student="${r.studentId}"` : ''}>
      <div class="row-main"><div class="row-title">${r.displayName}</div>
        <div class="row-sub">${r.submission ? 'Submitted ' + timeAgo(r.submission.submittedAt) : 'Nothing handed in'}</div></div>
      <div class="row-end">${r.submission && Object.keys(r.submission.grades).length ? Object.entries(r.submission.grades).map(([k, v]) => html`<span class="chip crit-chip">${k}${v}</span>`) : ''}
        ${stateBadge(r.state, r.submission && r.submission.late)}${r.submission ? html`<span class="link">${r.state === 'graded' ? 'Review' : 'Grade'} →</span>` : ''}</div></div>`)}</div>` : emptyState('👥', 'No students in this class yet.')}</div>`;
}

actions['open-grading'] = (el) => {
  const r = A.roster.find((x) => x.studentId === Number(el.dataset.student));
  const s = r.submission;
  openModal({
    title: `Grade: ${r.displayName}`, subtitle: A.title, wide: true,
    form: 'grade', submit: s.status === 'graded' ? 'Update grade' : 'Save grade',
    body: html`<input type="hidden" name="sid" value="${s.id}" />
      <div class="panel" style="margin-bottom:14px"><b>Student's answer</b>${s.text ? html`<p class="pre" style="margin-top:6px">${s.text}</p>` : html`<p class="muted small">No written answer.</p>`}
        <div class="file-list">${s.files.map((f) => fileRow(f, false))}</div>${s.late ? html`<span class="state-badge st-late">Submitted late</span>` : ''}</div>
      ${A.criteria.length ? html`<div class="field"><label>MYP criteria (0–8)</label><div class="grade-row">${A.criteria.map((k) => html`<div><div class="muted small">${k} · ${CRITERIA[k]}</div>
        <input class="grade-input" type="number" min="0" max="8" name="g${k}" value="${s.grades[k] ?? ''}" required /></div>`)}</div></div>` : ''}
      <div class="field"><label>Feedback for the student</label><textarea name="feedback" rows="4" maxlength="4000" ${A.criteria.length ? '' : 'required'}>${s.feedback}</textarea></div>`,
  });
};
forms.grade = async (form) => {
  const d = formData(form);
  const grades = {};
  for (const k of A.criteria) grades[k] = Number(d['g' + k]);
  await api.post(`/api/submissions/${d.sid}/grade`, { grades, feedback: d.feedback });
  closeModal(); toast('🎯 Grade saved'); refresh();
};

actions['upload-assignment-file'] = async (input) => {
  const file = input.files[0]; if (!file) return;
  toast('Uploading ' + file.name + '…');
  await api.upload(`/api/assignments/${A.id}/files`, file);
  toast('📎 File attached'); refresh();
};
actions['delete-file'] = async (el) => {
  if (!confirmBox('Remove this file?')) return;
  const text = $('textarea[name=text]') ? $('textarea[name=text]').value : '';
  await api.del('/api/files/' + el.dataset.id);
  await refresh();
  const box = $('textarea[name=text]'); if (box && text && !box.value) box.value = text;
};

actions['edit-assignment'] = () => openModal({
  title: 'Edit assignment', form: 'edit-assignment', submit: 'Save', wide: true,
  body: html`<div class="field"><label>Title</label><input name="title" required value="${A.title}" /></div>
    <div class="field"><label>Instructions</label><textarea name="instructions" rows="5">${A.instructions}</textarea></div>
    <div class="field-row"><div class="field"><label>Due date</label><input type="datetime-local" name="dueAt" required value="${A.dueAt}" /></div>
    <div class="field"><label>XP reward</label><input type="number" name="xp" min="0" max="100" value="${A.xp}" /></div></div>
    <div class="field"><label>MYP criteria assessed</label><div class="checks">${Object.entries(CRITERIA).map(([k, n]) => html`<label><input type="checkbox" name="crit" value="${k}" ${A.criteria.includes(k) ? 'checked' : ''} /> ${k} · ${n}</label>`)}</div></div>`,
});
forms['edit-assignment'] = async (form) => {
  const d = formData(form);
  const criteria = [...form.querySelectorAll('input[name=crit]:checked')].map((i) => i.value);
  await api.patch('/api/assignments/' + A.id, { title: d.title, instructions: d.instructions, dueAt: d.dueAt, xp: Number(d.xp), criteria });
  closeModal(); toast('✅ Saved'); refresh();
};
actions['delete-assignment'] = async () => {
  if (!confirmBox('Delete this assignment with every submission and file? This cannot be undone.')) return;
  const classId = A.classId;
  await api.del('/api/assignments/' + A.id); toast('🗑️ Assignment deleted'); go('/class/' + classId);
};

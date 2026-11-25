// UI helpers. The `html` tag escapes every interpolated value by default, so user-supplied
// text (names, titles, answers...) can never be interpreted as markup (no XSS).
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);

class Raw { constructor(s) { this.s = s; } toString() { return this.s; } }
export const raw = (s) => new Raw(String(s));

const part = (v) => (v instanceof Raw ? v.s : esc(v));
export function html(strings, ...vals) {
  let out = '';
  strings.forEach((s, i) => {
    out += s;
    if (i < vals.length) {
      const v = vals[i];
      out += Array.isArray(v) ? v.map(part).join('') : part(v);
    }
  });
  return new Raw(out);
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
export function mount(el, tpl) { el.innerHTML = tpl instanceof Raw ? tpl.s : String(tpl); }

// ------------------------------------------------------------------ toasts
export function toast(msg, kind = '') {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast' + (kind ? ' ' + kind : '');
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.add('hidden'), 3200);
}

// ------------------------------------------------------------------ subjects
export const SUBJECTS = {
  Math: ['📐', 'Math'], Science: ['🧪', 'Science'], IS: ['🌍', 'Individuals & Societies'],
  LangLit: ['📖', 'Language & Literature'], LangAcq: ['🗣️', 'Language Acquisition'],
  Arts: ['🎨', 'Arts'], Design: ['💻', 'Design'], PHE: ['🏃', 'PHE'], Other: ['📋', 'Other'],
};
export const subjectEmoji = (k) => (SUBJECTS[k] || SUBJECTS.Other)[0];
export const subjectName = (k) => (SUBJECTS[k] || SUBJECTS.Other)[1];
export const subjectOptions = (selected) =>
  raw(Object.entries(SUBJECTS).map(([k, [e, n]]) => `<option value="${k}"${k === selected ? ' selected' : ''}>${e} ${esc(n)}</option>`).join(''));

export const CRITERIA = { A: 'Knowing & understanding', B: 'Investigating patterns', C: 'Communicating', D: 'Applying maths in real-life' };

// ------------------------------------------------------------------- dates
const pad = (n) => String(n).padStart(2, '0');
export const dayStr = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const parseDue = (s) => new Date(s.length === 10 ? s + 'T23:59' : s);

export function formatDue(dueAt) {
  const d = parseDue(dueAt);
  return d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }) + ' · ' +
    `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
export function formatDate(ts) {
  return new Date(ts).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}
export function timeAgo(ts) {
  const mins = Math.floor((Date.now() - ts) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return days < 30 ? `${days}d ago` : formatDate(ts);
}
export function dueIn(dueAt) {
  const diff = parseDue(dueAt).getTime() - Date.now();
  const abs = Math.abs(diff);
  const days = Math.floor(abs / 86400000);
  const hrs = Math.floor((abs % 86400000) / 3600000);
  const txt = days >= 1 ? `${days} day${days > 1 ? 's' : ''}` : `${hrs} hour${hrs === 1 ? '' : 's'}`;
  return diff < 0 ? `${txt} overdue` : `due in ${txt}`;
}
export const fileSize = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1048576).toFixed(1)} MB`);

// ------------------------------------------------------------------ widgets
const STATES = {
  todo: ['To do', 'st-todo'], overdue: ['Overdue', 'st-overdue'], submitted: ['Submitted', 'st-submitted'],
  graded: ['Graded', 'st-graded'], draft: ['Draft', 'st-todo'],
};
export const stateBadge = (state, late) => {
  const [label, cls] = STATES[state] || STATES.todo;
  return html`<span class="state-badge ${cls}">${label}</span>${late ? html`<span class="state-badge st-late">Late</span>` : ''}`;
};

export function avatarHTML(avatar, size = '') {
  const a = avatar || {};
  const style = `--skin:${a.skin || '#f5d0a9'};--hair:${a.hair || '#2b1b17'};--outfit:${a.outfit || '#3498db'}`;
  return raw(`<div class="avatar-holder" style="${esc(style)}"><div class="pixel-hero ${size}">
    <div class="ph-aura"></div><div class="ph-cape"></div>
    <div class="ph-head"><div class="ph-eye ph-eye-l"></div><div class="ph-eye ph-eye-r"></div></div>
    <div class="ph-body"><div class="ph-belt"></div><div class="ph-emblem">⚔</div></div>
    <div class="ph-arm ph-arm-l"></div><div class="ph-arm ph-arm-r"><div class="ph-weapon ph-weapon-${esc(a.weapon || 'sword')}"></div></div>
    <div class="ph-leg ph-leg-l"></div><div class="ph-leg ph-leg-r"></div>
    <div class="ph-sparkle sp1">✦</div><div class="ph-sparkle sp2">✧</div><div class="ph-sparkle sp3">✦</div>
  </div></div>`);
}

export const emptyState = (icon, text) => html`<div class="empty-state"><div class="empty-icon">${icon}</div><p>${text}</p></div>`;

export function levelBar(u, large = false) {
  const pct = Math.min(100, Math.round((u.xpIntoLevel / u.xpNeeded) * 100));
  return html`<div class="xp-bar ${large ? 'lg' : ''}"><div class="xp-fill" style="width:${pct}%"></div></div>`;
}

// ------------------------------------------------------------------- modals
export function closeModal() {
  const root = $('#modalRoot');
  root.innerHTML = '';
}
/** Opens a modal containing a <form data-form="formName">. body is html`...` with the fields. */
export function openModal({ title, subtitle = '', form, body, submit = 'Save', wide = false }) {
  const root = $('#modalRoot');
  mount(root, html`<div class="modal">
    <div class="modal-backdrop" data-action="close-modal"></div>
    <div class="modal-card ${wide ? 'wide' : ''}" role="dialog" aria-modal="true" aria-label="${title}">
      <button class="modal-close" data-action="close-modal" aria-label="Close">✕</button>
      <div class="auth-head"><h2>${title}</h2>${subtitle ? html`<p>${subtitle}</p>` : ''}</div>
      ${form ? html`<form data-form="${form}" novalidate>
        ${body}
        <div class="form-error" role="alert"></div>
        <div class="modal-actions">
          <button type="button" class="btn btn-ghost" data-action="close-modal">Cancel</button>
          <button type="submit" class="btn btn-primary">${submit}</button>
        </div></form>` : body}
    </div></div>`);
  const first = $('input:not([type=hidden]), textarea, select', root);
  if (first) first.focus();
}
export function confirmBox(message) { return window.confirm(message); }
export function formData(form) {
  const out = {};
  new FormData(form).forEach((v, k) => { out[k] = typeof v === 'string' ? v : ''; });
  return out;
}

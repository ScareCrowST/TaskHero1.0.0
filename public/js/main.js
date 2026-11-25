import { api } from './api.js';
import { S, hooks, actions, forms, go, currentPath, setRenderer, setOnUnauthorized, refresh, handleError } from './core.js';
import { $, $$, html, mount, toast, avatarHTML, formData, openModal, closeModal } from './ui.js';
import * as dashboard from './views/dashboard.js';
import * as classes from './views/classes.js';
import * as assignment from './views/assignment.js';
import * as personal from './views/personal.js';
import * as admin from './views/admin.js';

// ----------------------------------------------------------------- theme
actions['toggle-theme'] = () => {
  const next = document.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
  document.documentElement.setAttribute('data-theme', next);
  try { localStorage.setItem('th_theme', next); } catch { /* storage blocked: theme just won't persist */ }
};

// ------------------------------------------------------------ auth modal
const showAuth = (which) => {
  $('#authModal').classList.remove('hidden');
  $('#loginForm').classList.toggle('hidden', which !== 'login');
  $('#signupForm').classList.toggle('hidden', which !== 'signup');
  const f = $(which === 'login' ? '#loginForm input' : '#signupForm input[name=displayName]');
  if (f) f.focus();
};
actions['show-login'] = () => showAuth('login');
actions['show-signup'] = () => showAuth('signup');
actions['switch-login'] = () => showAuth('login');
actions['switch-signup'] = () => showAuth('signup');
actions['close-auth'] = () => $('#authModal').classList.add('hidden');
actions['set-role'] = (el) => {
  $$('.role-tab').forEach((t) => t.classList.toggle('active', t === el));
  $('#signupForm input[name=role]').value = el.dataset.role;
  $('#teacherNote').hidden = el.dataset.role !== 'teacher';
};

forms.login = async (form) => {
  const d = formData(form);
  const r = await api.post('/api/auth/login', d);
  await enterApp(r);
};
forms.signup = async (form) => {
  const d = formData(form);
  const r = await api.post('/api/auth/signup', d);
  if (r.pending) {
    $('#authModal').classList.add('hidden');
    toast('✅ ' + r.message);
    return;
  }
  await enterApp(r);
  toast('🎉 Welcome to TaskHero, ' + r.user.displayName + '!');
};
actions.logout = async () => {
  try { await api.post('/api/auth/logout', {}); } catch { /* already logged out */ }
  leaveApp();
};

// ------------------------------------------------------------------- shell
async function enterApp(r) {
  S.user = r.user; S.school = r.school;
  $('#authModal').classList.add('hidden');
  $('#landing').classList.remove('active');
  $('#app').classList.add('active');
  $('#schoolChip').textContent = S.school.name;
  paintHeader();
  if (S.user.mustChangePassword) return forcePasswordChange();
  if (!location.hash || location.hash === '#/') go('/');
  return refresh();
}

function leaveApp() {
  S.user = null; S.school = null;
  closeModal();
  $('#app').classList.remove('active');
  $('#landing').classList.add('active');
  location.hash = '';
  window.scrollTo(0, 0);
}
setOnUnauthorized(() => { toast('Your session has expired. Please log in again.', 'error'); leaveApp(); showAuth('login'); });

function paintHeader() {
  const u = S.user;
  $('#userName').textContent = u.displayName;
  const isStudent = u.role === 'student';
  $('#streakBadge').hidden = !isStudent;
  $('#levelBadgeWrap').hidden = !isStudent;
  $('#streakCount').textContent = u.streak;
  $('#levelBadge').textContent = u.level;
  const holder = $('.mini-avatar');
  if (isStudent) mount(holder, avatarHTML(u.avatar, 'tiny'));
  else holder.textContent = u.role === 'teacher' ? '👩‍🏫' : '🏫';
}

async function reloadMe() {
  const r = await api.get('/api/me');
  S.user = r.user;
  paintHeader();
}

hooks.reloadMe = reloadMe;

function forcePasswordChange() {
  openModal({
    title: 'Choose your own password', subtitle: 'Your account was created with a temporary password. Set a new one to continue.',
    form: 'force-password', submit: 'Save password',
    body: html`<div class="field"><label>Temporary password</label><input type="password" name="current" required autocomplete="current-password" /></div>
      <div class="field"><label>New password</label><input type="password" name="next" required autocomplete="new-password" placeholder="8+ characters, letters and numbers" /></div>`,
  });
  // this dialog cannot be dismissed until the password is changed
  $('#modalRoot .modal-backdrop').removeAttribute('data-action');
  $('#modalRoot .modal-close').remove();
  $$('#modalRoot [data-action=close-modal]').forEach((b) => b.remove());
}
forms['force-password'] = async (form) => {
  await api.post('/api/me/password', formData(form));
  await reloadMe();
  closeModal();
  toast('🔒 Password updated.');
  go('/');
  refresh();
};

// ----------------------------------------------------------------- sidebar
const NAV = {
  student: [['/', '🏠', 'Dashboard'], ['/classes', '📚', 'My classes'], ['/calendar', '📅', 'Calendar'], ['/quests', '⚔️', 'Quests'], ['/profile', '🧙', 'My hero']],
  teacher: [['/', '🏠', 'Dashboard'], ['/classes', '📚', 'My classes'], ['/calendar', '📅', 'Calendar'], ['/profile', '⚙️', 'Account']],
  school_admin: [['/', '🏠', 'Overview'], ['/users', '👥', 'People'], ['/classes', '📚', 'All classes'], ['/calendar', '📅', 'Calendar'], ['/profile', '⚙️', 'Account']],
};

function paintSidebar(path) {
  const items = NAV[S.user.role];
  const active = items.find(([p]) => (p === '/' ? path === '/' : path === p || path.startsWith(p + '/')));
  mount($('#sidebar'), html`<div class="side-section"><div class="side-label">Menu</div>
    ${items.map(([p, ico, label]) => html`<button class="side-btn ${active && active[0] === p ? 'active' : ''}" data-action="nav" data-path="${p}">${ico} ${label}</button>`)}</div>`);
}
actions.nav = (el) => go(el.dataset.path);
actions.link = (el) => go(el.dataset.path);
document.addEventListener('click', (e) => {
  const a = e.target.closest('a[data-path]');
  if (a) { e.preventDefault(); go(a.dataset.path); }
});

// ------------------------------------------------------------------ router
const ROUTES = [
  [/^\/$/, (el) => (S.user.role === 'school_admin' ? admin.overview(el) : dashboard.render(el))],
  [/^\/classes$/, (el) => classes.list(el)],
  [/^\/class\/(\d+)$/, (el, m) => classes.detail(el, Number(m[1]))],
  [/^\/assignment\/(\d+)$/, (el, m) => assignment.render(el, Number(m[1]))],
  [/^\/calendar$/, (el) => personal.calendar(el)],
  [/^\/quests$/, (el) => personal.quests(el)],
  [/^\/profile$/, (el) => personal.profile(el)],
  [/^\/users$/, (el) => admin.users(el)],
];

let renderToken = 0;
async function render() {
  if (!S.user || S.user.mustChangePassword) return;
  const path = currentPath();
  paintSidebar(path);
  const el = $('#view');
  const token = ++renderToken;
  const hit = ROUTES.map(([re, fn]) => [re.exec(path), fn]).find(([m]) => m);
  if (!hit) { mount(el, html`<div class="empty-state"><div class="empty-icon">🧭</div><p>That page does not exist.</p></div>`); return; }
  try {
    await hit[1](el, hit[0], () => token === renderToken);
  } catch (err) {
    if (token !== renderToken) return;
    if (err && err.status === 404) mount(el, html`<div class="empty-state"><div class="empty-icon">🔍</div><p>${err.message}</p><button class="btn btn-ghost" data-action="nav" data-path="/">Back to dashboard</button></div>`);
    else { handleError(err); mount(el, html`<div class="empty-state"><div class="empty-icon">⚠️</div><p>${err.message || 'Could not load this page.'}</p></div>`); }
  }
  window.scrollTo(0, 0);
}
setRenderer(render);
window.addEventListener('hashchange', render);

// ------------------------------------------------------------------- start
(async function boot() {
  try {
    const r = await api.get('/api/me');
    await enterApp(r);
  } catch { /* not logged in: stay on the landing page */ }
})();

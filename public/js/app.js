/* ============================================
   TaskHero · js/app.js
   Complete Application Logic (Step 4 Integrated)
   ============================================ */

// ---------- Storage helpers ----------
const Store = {
  get(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch { return fallback; }
  },
  set(key, val) { localStorage.setItem(key, JSON.stringify(val)); },
  remove(key) { localStorage.removeItem(key); }
};

// ---------- State ----------
const state = {
  users: Store.get('th_users', []),
  currentUser: Store.get('th_current', null),
  tasks: Store.get('th_tasks', {}),
  classes: Store.get('th_classes', []),
  assignments: Store.get('th_assignments', []),
  discussions: Store.get('th_discussions', []),
  filter: 'all',
  editingTaskId: null
};

// ---------- Utils ----------
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.add('hidden'), 2600);
}

function save() {
  Store.set('th_users', state.users);
  Store.set('th_current', state.currentUser);
  Store.set('th_tasks', state.tasks);
  Store.set('th_classes', state.classes);
  Store.set('th_assignments', state.assignments);
  Store.set('th_discussions', state.discussions);
}

function xpForLevel(level) { return 100 + (level - 1) * 50; }
function titleForLevel(level) {
  const titles = [
    'Novice Apprentice', 'Eager Scribe', 'Knowledge Seeker', 'Rising Scholar',
    'Task Tamer', 'Quest Keeper', 'Study Knight', 'Homework Hero',
    'Wisdom Warrior', 'Master of Tasks', 'Legendary Scholar', 'Grand TaskHero'
  ];
  return titles[Math.min(level - 1, titles.length - 1)];
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

// ---------- Auth ----------
function showAuth(which, preRole) {
  $('#authModal').classList.remove('hidden');
  $('#loginForm').classList.toggle('hidden', which !== 'login');
  $('#signupForm').classList.toggle('hidden', which !== 'signup');
  if (preRole) setAuthRole(preRole);
}

function closeModal() {
  $$('.modal').forEach(m => m.classList.add('hidden'));
}

function setAuthRole(role) {
  const activeForm = $('#loginForm').classList.contains('hidden') ? $('#signupForm') : $('#loginForm');
  activeForm.querySelectorAll('.role-tab').forEach(tab => {
    tab.classList.toggle('active', tab.dataset.role === role);
  });
  const hiddenInput = activeForm.querySelector('input[name="role"]');
  if (hiddenInput) hiddenInput.value = role;
}

function validateSchool(schoolId) {
  if (!schoolId || !schoolId.trim()) return { valid: false, message: 'School ID is required' };
  const normalizedId = schoolId.trim().toUpperCase();
  const schools = Store.get('th_schools', []);
  const school = schools.find(s => s.code === normalizedId);

  if (!school) return { valid: false, message: 'School not found. Check your School ID or ask your admin to register the school.' };
  if (school.status === 'pending') return { valid: false, message: `School "${school.name}" is pending approval. Please wait for admin approval.` };
  if (school.status === 'rejected') return { valid: false, message: `School "${school.name}" was rejected. Contact TaskHero support.` };
  return { valid: true, school };
}

function signup(data) {
  const schoolCheck = validateSchool(data.schoolId);
  if (!schoolCheck.valid) { toast('❌ ' + schoolCheck.message); return false; }

  const exists = state.users.find(u => u.username === data.username && u.schoolId === schoolCheck.school.code);
  if (exists) { toast('Username already taken at this school!'); return false; }

  const user = {
    id: uid(), username: data.username, password: data.password,
    displayName: data.displayName, schoolId: schoolCheck.school.code,
    schoolName: schoolCheck.school.name, role: data.role,
    xp: 0, level: 1, streak: 0, lastActive: null,
    title: 'Novice Apprentice',
    avatar: { skin: '#f5d0a9', hair: '#2b1b17', outfit: '#3498db', weapon: 'sword' },
    createdAt: Date.now()
  };

  state.users.push(user);
  state.currentUser = user;
  state.tasks[user.id] = [];
  save();
  toast(`Welcome to ${schoolCheck.school.name}, ${user.displayName}! 🎉`);
  enterDashboard();
  return true;
}

function login(schoolId, username, password, role) {
  const schoolCheck = validateSchool(schoolId);
  if (!schoolCheck.valid) { toast('❌ ' + schoolCheck.message); return false; }

  const normalizedSchool = schoolCheck.school.code;
  const user = state.users.find(u =>
    u.schoolId === normalizedSchool && u.username === username && u.password === password && u.role === role
  );

  if (!user) { toast('Invalid credentials. Check School ID, username, password, and role.'); return false; }

  state.currentUser = user;
  updateStreak();
  save();
  toast(`Welcome back, ${user.displayName}!`);
  enterDashboard();
  return true;
}

function logout() {
  state.currentUser = null;
  Store.remove('th_current');
  $('#dashboard').classList.remove('active');
  $('#landing').classList.add('active');
  window.scrollTo(0, 0);
}

// ---------- Streak ----------
function updateStreak() {
  const u = state.currentUser;
  if (!u) return;
  const today = new Date().toDateString();
  const last = u.lastActive ? new Date(u.lastActive).toDateString() : null;
  const yesterday = new Date(Date.now() - 86400000).toDateString();

  if (last === today) return;
  if (last === yesterday) u.streak = (u.streak || 0) + 1;
  else if (last !== today) u.streak = 1;
  u.lastActive = Date.now();
}

function streakMultiplier(streak) {
  if (streak >= 30) return 5;
  if (streak >= 14) return 3;
  if (streak >= 7) return 2;
  if (streak >= 3) return 1.5;
  return 1;
}

// ---------- XP & Leveling ----------
function awardXP(amount) {
  const u = state.currentUser;
  const mult = streakMultiplier(u.streak || 0);
  const gained = Math.round(amount * mult);
  u.xp = (u.xp || 0) + gained;

  let needed = xpForLevel(u.level);
  let leveled = false;
  while (u.xp >= needed) {
    u.xp -= needed; u.level += 1; u.title = titleForLevel(u.level);
    needed = xpForLevel(u.level); leveled = true;
  }
  save(); renderAll();
  if (leveled) showLevelUp(u.level, u.title);
  return gained;
}

function showLevelUp(level, title) {
  $('#luLevel').textContent = level;
  $('#luTitle').textContent = title;
  const el = $('#levelUp');
  el.classList.remove('hidden');
  setTimeout(() => el.classList.add('hidden'), 2800);
}

// ---------- Avatar rendering ----------
function applyAvatar(el, avatar) {
  if (!el || !avatar) return;
  el.style.setProperty('--skin', avatar.skin);
  el.style.setProperty('--hair', avatar.hair);
  el.style.setProperty('--outfit', avatar.outfit);
  const weaponEl = el.querySelector('.ph-weapon');
  if (weaponEl) weaponEl.className = 'ph-weapon ph-weapon-' + avatar.weapon;
}

function renderAvatars() {
  const u = state.currentUser;
  if (!u) return;
  ['#landingAvatar', '#dashAvatar', '#profileAvatar'].forEach(sel => applyAvatar($(sel), u.avatar));
  $('#heroName').textContent = u.displayName;
  $('#heroTitle').textContent = u.title || titleForLevel(u.level);
  $('#heroSchool').textContent = '🏫 ' + (u.schoolName || u.schoolId || '—');
  $('#profileName').textContent = u.displayName;
  $('#profileTitle').textContent = u.title || titleForLevel(u.level);
}

// ---------- Tasks ----------
function userTasks() { return state.tasks[state.currentUser.id] || []; }

function saveTask(task) {
  const list = state.tasks[state.currentUser.id] || [];
  const idx = list.findIndex(t => t.id === task.id);
  if (idx >= 0) list[idx] = task; else list.push(task);
  state.tasks[state.currentUser.id] = list;
  save();
}

function deleteTask(id) {
  state.tasks[state.currentUser.id] = userTasks().filter(t => t.id !== id);
  save(); renderTasks(); renderStats();
}

function toggleTask(id) {
  const list = userTasks();
  const t = list.find(x => x.id === id);
  if (!t) return;
  const wasDone = t.done;
  t.done = !t.done;

  if (t.isClassAssignment && t.assignmentId) {
    const assign = (state.assignments || []).find(a => a.id === t.assignmentId);
    if (assign) {
      if (!assign.completions) assign.completions = [];
      if (t.done && !assign.completions.includes(state.currentUser.id)) {
        assign.completions.push(state.currentUser.id);
      } else if (!t.done) {
        assign.completions = assign.completions.filter(uid => uid !== state.currentUser.id);
      }
    }
  }

  saveTask(t);
  if (!wasDone && t.done) {
    const gained = awardXP(t.xp);
    toast(`+${gained} XP earned! ⚡`);
  }
  renderTasks(); renderStats(); renderClasses();
}

function prioRank(p) { return p === 'high' ? 0 : p === 'medium' ? 1 : 2; }

function taskHTML(t) {
  const subjectEmoji = { Math: '📐', Science: '🧪', IS: '🌍', LangLit: '📖', LangAcq: '🗣️', Arts: '🎨', Design: '💻', PHE: '🏃' }[t.subject] || '📋';
  const dueDate = new Date(t.due);
  const dueStr = dueDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  const overdue = !t.done && t.due < new Date().toISOString().slice(0, 10);
  return `
    <div class="task-item ${t.done ? 'done' : ''}" data-id="${t.id}">
      <button class="task-check" data-id="${t.id}">${t.done ? '✓' : ''}</button>
      <div class="task-info">
        <div class="task-title">${escapeHtml(t.title)}</div>
        <div class="task-meta">
          <span class="task-tag">${subjectEmoji} ${t.subject}</span>
          <span class="task-tag prio-${t.priority}">${t.priority}</span>
          <span style="${overdue ? 'color:#f87171' : ''}">📅 ${dueStr}${overdue ? ' · overdue' : ''}</span>
        </div>
      </div>
      <div class="task-xp">+${t.xp} XP</div>
      <div class="task-actions">
        <button class="icon-btn task-edit" data-id="${t.id}" title="Edit">✏️</button>
        <button class="icon-btn danger task-del" data-id="${t.id}" title="Delete">🗑️</button>
      </div>
    </div>
  `;
}

function renderTasks() {
  const list = userTasks();
  const today = new Date().toISOString().slice(0, 10);

  const todayList = list.filter(t => !t.done && t.due === today).sort((a, b) => prioRank(a.priority) - prioRank(b.priority));
  const todayEl = $('#todayTasks');
  todayEl.innerHTML = todayList.length
    ? todayList.map(taskHTML).join('')
    : `<div class="empty-state"><div class="empty-icon">🎯</div><p>No quests due today. Nice work!</p></div>`;

  const filtered = state.filter === 'all' ? list : list.filter(t => t.subject === state.filter);
  const sorted = [...filtered].sort((a, b) => {
    if (a.done !== b.done) return a.done ? 1 : -1;
    return prioRank(a.priority) - prioRank(b.priority);
  });
  const allEl = $('#allTasks');
  allEl.innerHTML = sorted.length
    ? sorted.map(taskHTML).join('')
    : `<div class="empty-state"><div class="empty-icon">📭</div><p>No quests here yet. Create one!</p></div>`;

  $$('.task-check').forEach(btn => { btn.onclick = () => toggleTask(btn.dataset.id); });
  $$('.task-edit').forEach(btn => { btn.onclick = () => openTaskModal(btn.dataset.id); });
  $$('.task-del').forEach(btn => { btn.onclick = () => { if (confirm('Delete this quest?')) deleteTask(btn.dataset.id); }; });
}

// ---------- Stats ----------
function renderStats() {
  const u = state.currentUser;
  if (!u) return;
  const list = userTasks();
  const active = list.filter(t => !t.done).length;
  const done = list.filter(t => t.done).length;
  const totalXp = (u.xp || 0) + Array.from({length: u.level - 1}, (_, i) => xpForLevel(i + 1)).reduce((a, b) => a + b, 0);

  $('#statActive').textContent = active;
  $('#statDone').textContent = done;
  $('#statXp').textContent = totalXp;
  $('#statStreak').textContent = `${u.streak || 0} days`;
  $('#streakCount').textContent = u.streak || 0;
  $('#levelBadge').textContent = u.level;
  $('#userName').textContent = u.displayName;

  const needed = xpForLevel(u.level);
  const pct = Math.min(100, (u.xp / needed) * 100);
  $('#sideLevel').textContent = u.level;
  $('#sideXp').textContent = `${u.xp} / ${needed} XP`;
  $('#sideXpFill').style.width = pct + '%';
  $('#sideNext').textContent = `${needed - u.xp} XP`;
  $('#heroXpFill').style.width = pct + '%';
  $('#heroXpText').textContent = `${u.xp} / ${needed} XP to Level ${u.level + 1}`;

  const hour = new Date().getHours();
  const greet = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  $('#greet').textContent = `${greet}, ${u.displayName} 👋`;
  $('#todayDate').textContent = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
}

// ---------- Classes & Assignments ----------
function generateClassCode(schoolId, subject, grade) {
  const sub = subject.substring(0, 4).toUpperCase();
  const grd = grade.replace(/[^a-zA-Z0-9]/g, '').substring(0, 3).toUpperCase();
  const rand = Math.random().toString(36).substring(2, 4).toUpperCase();
  return `${schoolId}-${sub}-${grd}${rand}`;
}

function getAssignmentsForClass(classCode) {
  return state.assignments ? state.assignments.filter(a => a.classCode === classCode) : [];
}

function renderClasses() {
  const u = state.currentUser;
  if (!u) return;
  const isTeacher = u.role === 'teacher';
  document.body.dataset.role = u.role;
  
  $('#classesSub').textContent = isTeacher 
    ? 'Manage your classes, post assignments, and track progress.' 
    : 'Join classes using a code from your teacher.';

  const actionsEl = $('#classActions');
  actionsEl.innerHTML = isTeacher 
    ? `<button class="btn btn-primary" data-action="open-create-class">+ Create Class</button>`
    : `<button class="btn btn-primary" data-action="open-join-class">🔑 Join with Code</button>`;

  const list = $('#classesList');
  const userClasses = state.classes.filter(c => {
    if (isTeacher) return c.teacherId === u.id;
    return c.members && c.members.includes(u.id);
  });

  if (!userClasses.length) {
    list.innerHTML = `<div class="empty-state" style="grid-column:1/-1"><div class="empty-icon">🏫</div><p>${isTeacher ? 'Create your first class to get started.' : 'Join a class using a code from your teacher.'}</p></div>`;
    return;
  }

  list.innerHTML = userClasses.map(c => {
    const memberCount = c.members ? c.members.length : 0;
    const assignments = getAssignmentsForClass(c.code);
    const completedCount = isTeacher 
      ? assignments.filter(a => a.completions && a.completions.length === memberCount).length 
      : assignments.filter(a => a.completions && a.completions.includes(u.id)).length;

    return `
      <div class="class-card">
        <div class="class-head-row" style="display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:12px;">
          <div>
            <div class="class-subject">${c.subject} · ${c.grade || ''}</div>
            <div class="class-name">${escapeHtml(c.name)}</div>
          </div>
          ${isTeacher ? `<div class="class-code-badge" onclick="copyCode('${c.code}')" style="cursor:pointer; font-family:monospace; background:rgba(34,211,238,0.1); color:#22d3ee; padding:4px 8px; border-radius:6px; font-size:0.8rem;">${c.code} 📋</div>` : ''}
        </div>
        <div class="class-desc">${escapeHtml(c.description || 'No description')}</div>
        <div class="class-stats" style="display:flex; gap:16px; margin:12px 0; font-size:0.85rem; color:var(--muted);">
          <span>👥 ${memberCount} students</span>
          <span>📝 ${assignments.length} assignments</span>
          <span>✅ ${completedCount} completed</span>
        </div>
        <div class="class-actions" style="display:flex; gap:8px; flex-wrap:wrap;">
          ${isTeacher ? `
            <button class="btn btn-primary btn-sm" onclick="openAssignmentModal('${c.code}', '${escapeHtml(c.name)}')">📝 Post Assignment</button>
            <button class="btn btn-ghost btn-sm" onclick="viewClassMembers('${c.code}')">👥 Members</button>
            <button class="btn btn-ghost btn-sm danger" onclick="deleteClass('${c.id}')">🗑️</button>
          ` : `
            <button class="btn btn-ghost btn-sm danger" onclick="leaveClass('${c.code}')">🚪 Leave</button>
          `}
        </div>
      </div>
    `;
  }).join('');
}

// Global window functions for class actions
window.copyCode = (code) => {
  navigator.clipboard.writeText(code);
  toast('Class code copied! 📋');
};

window.openAssignmentModal = (code, name) => {
  $('#assignClassName').textContent = `For class: ${name} (${code})`;
  const form = $('#assignmentForm');
  form.reset();
  form.classCode.value = code;
  form.due.value = new Date().toISOString().slice(0, 10);
  $('#assignmentModal').classList.remove('hidden');
};

window.viewClassMembers = (code) => {
  const c = state.classes.find(x => x.code === code);
  if (!c || !c.members || !c.members.length) { toast('No students have joined yet.'); return; }
  const names = c.members.map(id => {
    const u = state.users.find(x => x.id === id);
    return u ? u.displayName : 'Unknown';
  }).join('\n');
  alert(`Members of ${c.name}:\n\n${names}`);
};

window.deleteClass = (id) => {
  if (!confirm('Delete this class and all its assignments?')) return;
  const c = state.classes.find(x => x.id === id);
  state.classes = state.classes.filter(x => x.id !== id);
  if (c) state.assignments = (state.assignments || []).filter(a => a.classCode !== c.code);
  save(); renderClasses(); toast('Class deleted');
};

window.leaveClass = (code) => {
  if (!confirm('Leave this class? You will lose access to assignments.')) return;
  const c = state.classes.find(x => x.code === code);
  if (c && c.members) c.members = c.members.filter(id => id !== state.currentUser.id);
  save(); renderClasses(); renderTasks(); toast('Left class');
};

// ---------- Discussions ----------
function renderDiscussions() {
  const list = $('#discussionsList');
  if (!state.discussions.length) {
    list.innerHTML = `<div class="empty-state"><div class="empty-icon">💬</div><p>No discussions yet. Start one!</p></div>`;
    return;
  }
  list.innerHTML = state.discussions.map(d => `
    <div class="disc-item" data-id="${d.id}">
      <div class="disc-head">
        <div>
          <div class="disc-title">${escapeHtml(d.title)}</div>
          <div class="disc-meta">
            <span class="task-tag">${d.subject}</span>
            <span>by ${escapeHtml(d.author)}</span>
            <span>· ${timeAgo(d.createdAt)}</span>
          </div>
        </div>
        ${d.authorId === state.currentUser.id ? `<button class="icon-btn danger disc-del" data-id="${d.id}">🗑️</button>` : ''}
      </div>
      <div class="disc-body">${escapeHtml(d.body)}</div>
      <div class="disc-actions">
        <button class="disc-toggle" data-id="${d.id}">💬 ${d.comments.length} comment${d.comments.length !== 1 ? 's' : ''}</button>
      </div>
      <div class="comments hidden" data-for="${d.id}">
        ${d.comments.map(c => `
          <div class="comment">
            <div class="comment-head"><b>${escapeHtml(c.author)}</b> · ${timeAgo(c.createdAt)}</div>
            <div>${escapeHtml(c.body)}</div>
          </div>
        `).join('') || '<div class="muted small">No comments yet.</div>'}
        <form class="comment-form" data-for="${d.id}">
          <input type="text" placeholder="Write a comment..." required />
          <button type="submit">Post</button>
        </form>
      </div>
    </div>
  `).join('');

  $$('.disc-del').forEach(btn => { btn.onclick = () => { if (confirm('Delete this discussion?')) { state.discussions = state.discussions.filter(d => d.id !== btn.dataset.id); save(); renderDiscussions(); } }; });
  $$('.disc-toggle').forEach(btn => { btn.onclick = () => { const c = $(`.comments[data-for="${btn.dataset.id}"]`); c.classList.toggle('hidden'); }; });
  $$('.comment-form').forEach(form => {
    form.onsubmit = (e) => {
      e.preventDefault();
      const input = form.querySelector('input');
      const d = state.discussions.find(x => x.id === form.dataset.for);
      if (!d) return;
      d.comments.push({ id: uid(), author: state.currentUser.displayName, authorId: state.currentUser.id, body: input.value.trim(), createdAt: Date.now() });
      save(); renderDiscussions(); input.value = '';
    };
  });
}

function timeAgo(ts) {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

// ---------- Profile ----------
function renderProfile() {
  const u = state.currentUser;
  if (!u) return;
  $$('.swatches').forEach(group => {
    const key = group.dataset.custom;
    $$('.swatch', group).forEach(sw => {
      sw.classList.toggle('active', sw.dataset.val === u.avatar[key]);
      sw.onclick = () => { u.avatar[key] = sw.dataset.val; save(); renderAvatars(); renderProfile(); };
    });
  });
  $$('.weapon-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.val === u.avatar.weapon);
    btn.onclick = () => { u.avatar.weapon = btn.dataset.val; save(); renderAvatars(); renderProfile(); };
  });
  $('#titleInput').value = u.title || '';
}

$('#titleInput').addEventListener('input', (e) => {
  state.currentUser.title = e.target.value || titleForLevel(state.currentUser.level);
  save(); renderAvatars();
});

// ---------- View switching ----------
function switchView(name) {
  $$('.dash-view').forEach(v => v.classList.remove('active'));
  $(`#view-${name}`).classList.add('active');
  $$('.side-btn').forEach(b => b.classList.toggle('active', b.dataset.view === name));
  if (name === 'tasks') renderTasks();
  if (name === 'classes') renderClasses();
  if (name === 'discussions') renderDiscussions();
  if (name === 'profile') renderProfile();
}

// ---------- Render all ----------
function renderAll() {
  renderAvatars(); renderStats(); renderTasks(); renderClasses(); renderDiscussions();
}

function enterDashboard() {
  $('#landing').classList.remove('active');
  $('#dashboard').classList.add('active');
  document.body.dataset.role = state.currentUser.role;
  renderAll();
  window.scrollTo(0, 0);
}

// ---------- Modal: Task ----------
function openTaskModal(editId) {
  state.editingTaskId = editId || null;
  const form = $('#taskForm');
  form.reset();
  $('#taskModalTitle').textContent = editId ? 'Edit Quest' : 'New Quest';
  if (editId) {
    const t = userTasks().find(x => x.id === editId);
    if (t) {
      form.id.value = t.id; form.title.value = t.title; form.subject.value = t.subject;
      form.due.value = t.due; form.xp.value = t.xp; form.priority.value = t.priority;
      form.description.value = t.description || '';
    }
  } else { form.due.value = new Date().toISOString().slice(0, 10); }
  $('#taskModal').classList.remove('hidden');
}

// ---------- Form Submissions ----------
$('#taskForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const task = {
    id: fd.get('id') || uid(), title: fd.get('title').trim(), subject: fd.get('subject'),
    due: fd.get('due'), xp: parseInt(fd.get('xp')), priority: fd.get('priority'),
    description: fd.get('description').trim(), done: false, createdAt: Date.now()
  };
  if (state.editingTaskId) {
    const existing = userTasks().find(t => t.id === state.editingTaskId);
    task.done = existing.done; task.createdAt = existing.createdAt;
  }
  saveTask(task); closeModal(); renderTasks(); renderStats();
  toast(state.editingTaskId ? 'Quest updated!' : 'New quest added! 🎯');
  state.editingTaskId = null;
});

$('#createClassForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const code = generateClassCode(state.currentUser.schoolId, fd.get('subject'), fd.get('grade'));
  
  state.classes.push({
    id: uid(), code: code, name: fd.get('name').trim(), subject: fd.get('subject'),
    grade: fd.get('grade').trim(), description: fd.get('description').trim(),
    teacherId: state.currentUser.id, schoolId: state.currentUser.schoolId,
    members: [], createdAt: Date.now()
  });
  save(); closeModal(); renderClasses();
  toast(`Class created! Code: ${code} 🎉`);
});

$('#joinClassForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const code = new FormData(e.target).get('code').trim().toUpperCase();
  const c = state.classes.find(x => x.code === code);
  
  if (!c) { toast('❌ Class code not found!'); return; }
  if (c.members && c.members.includes(state.currentUser.id)) { toast('You are already in this class!'); return; }
  
  if (!c.members) c.members = [];
  c.members.push(state.currentUser.id);
  save(); closeModal(); renderClasses();
  toast(`Joined ${c.name}! 🎒`);
});

$('#assignmentForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const classCode = fd.get('classCode');
  const c = state.classes.find(x => x.code === classCode);
  
  if (!state.assignments) state.assignments = [];
  
  const assignment = {
    id: uid(), classCode: classCode, title: fd.get('title').trim(),
    due: fd.get('due'), xp: parseInt(fd.get('xp')), description: fd.get('description').trim(),
    createdBy: state.currentUser.id, createdAt: Date.now(), completions: []
  };
  state.assignments.push(assignment);
  
  if (c && c.members) {
    c.members.forEach(studentId => {
      if (!state.tasks[studentId]) state.tasks[studentId] = [];
      state.tasks[studentId].push({
        id: `assign_${assignment.id}_${studentId}`,
        title: `[${c.name}] ${assignment.title}`, subject: c.subject,
        due: assignment.due, xp: assignment.xp, priority: 'medium',
        description: assignment.description, done: false,
        isClassAssignment: true, classCode: classCode,
        assignmentId: assignment.id, createdAt: Date.now()
      });
    });
  }
  save(); closeModal(); renderClasses();
  toast('Assignment posted to class! 📝');
});

$('#discussionForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  state.discussions.unshift({
    id: uid(), title: fd.get('title').trim(), subject: fd.get('subject'),
    body: fd.get('body').trim(), author: state.currentUser.displayName,
    authorId: state.currentUser.id, comments: [], createdAt: Date.now()
  });
  save(); closeModal(); renderDiscussions();
  toast('Discussion posted! 💬');
});

// ---------- Auth forms ----------
$('#loginFormEl').addEventListener('submit', (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  if (login(fd.get('schoolId'), fd.get('username').trim(), fd.get('password'), fd.get('role'))) closeModal();
});

$('#signupFormEl').addEventListener('submit', (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  if (signup({ displayName: fd.get('displayName').trim(), schoolId: fd.get('schoolId'), username: fd.get('username').trim(), password: fd.get('password'), role: fd.get('role') })) closeModal();
});

// ---------- Role tabs ----------
document.addEventListener('click', (e) => {
  const tab = e.target.closest('.role-tab');
  if (tab) {
    const form = tab.closest('.auth-form');
    form.querySelectorAll('.role-tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    const hiddenInput = form.querySelector('input[name="role"]');
    if (hiddenInput) hiddenInput.value = tab.dataset.role;
  }
});

// ---------- Global event delegation ----------
document.addEventListener('click', (e) => {
  const action = e.target.closest('[data-action]')?.dataset.action;
  const view = e.target.closest('[data-view]')?.dataset.view;

  if (action === 'show-login') showAuth('login');
  else if (action === 'show-signup') showAuth('signup');
  else if (action === 'switch-login') { $('#loginForm').classList.remove('hidden'); $('#signupForm').classList.add('hidden'); }
  else if (action === 'switch-signup') { $('#signupForm').classList.remove('hidden'); $('#loginForm').classList.add('hidden'); }
  else if (action === 'close-modal') closeModal();
  else if (action === 'logout') logout();
  else if (action === 'open-task-modal') openTaskModal();
  else if (action === 'open-create-class') { $('#createClassForm').reset(); $('#createClassModal').classList.remove('hidden'); }
  else if (action === 'open-join-class') { $('#joinClassForm').reset(); $('#joinClassModal').classList.remove('hidden'); }
  else if (action === 'open-discussion-modal') { $('#discussionForm').reset(); $('#discussionModal').classList.remove('hidden'); }

  if (view) switchView(view);
});

// Filter chips
document.addEventListener('click', (e) => {
  if (e.target.matches('.chip[data-filter]')) {
    $$('.chip').forEach(c => c.classList.remove('active'));
    e.target.classList.add('active');
    state.filter = e.target.dataset.filter;
    renderTasks();
  }
});

$$('.modal-backdrop').forEach(b => b.addEventListener('click', closeModal));
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });

// ---------- Init ----------
(function init() {
  if (state.currentUser) { updateStreak(); save(); enterDashboard(); }
})();
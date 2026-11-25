import { api } from '../api.js';
import { S, actions } from '../core.js';
import { html, mount, subjectEmoji, formatDue, dueIn, timeAgo, levelBar, avatarHTML, emptyState, CRITERIA } from '../ui.js';

const critLine = (grades) => Object.entries(grades || {}).map(([k, v]) => html`<span class="chip crit-chip" title="${CRITERIA[k] || ''}">${k}: ${v}</span>`);

function announcementList(list) {
  if (!list.length) return emptyState('📢', 'No announcements yet.');
  return html`<div class="list">${list.map((a) => html`<div class="post"><div class="meta">${a.className} · ${timeAgo(a.createdAt)}</div><b>${a.title}</b><p class="pre small">${a.body}</p></div>`)}</div>`;
}

export async function render(el) {
  const d = await api.get('/api/dashboard');
  const u = S.user;

  if (d.role === 'student') {
    mount(el, html`
      <div class="view-head"><div><h1>Welcome back, ${u.displayName} 👋</h1><p>Here is what needs your attention.</p></div></div>
      <div class="stat-grid">
        <div class="stat-card"><div class="stat-ico">📝</div><div><div class="stat-label">To hand in</div><div class="stat-value">${d.stats.open}</div></div></div>
        <div class="stat-card"><div class="stat-ico">📤</div><div><div class="stat-label">Submitted</div><div class="stat-value">${d.stats.submitted}</div></div></div>
        <div class="stat-card"><div class="stat-ico">🎯</div><div><div class="stat-label">Graded</div><div class="stat-value">${d.stats.graded}</div></div></div>
        <div class="stat-card"><div class="stat-ico">🔥</div><div><div class="stat-label">Streak</div><div class="stat-value">${u.streak}</div></div></div>
      </div>
      <div class="two-col">
        <div class="stack">
          <div class="panel"><div class="panel-head"><h3>📝 Coming up</h3><a class="link" href="#/classes" data-path="/classes">All classes →</a></div>
            ${d.upcoming.length ? html`<div class="list">${d.upcoming.map((a) => html`
              <a class="row-item" href="#/assignment/${a.id}" data-path="/assignment/${a.id}">
                <div class="row-ico">${subjectEmoji(a.subject)}</div>
                <div class="row-main"><div class="row-title">${a.title}</div><div class="row-sub">${a.className} · ${formatDue(a.dueAt)}</div></div>
                <div class="row-end"><span class="${a.overdue ? 'overdue-text' : 'muted'} small">${dueIn(a.dueAt)}</span></div>
              </a>`)}</div>` : emptyState('🎉', 'Nothing to hand in. Enjoy it!')}
          </div>
          <div class="panel"><div class="panel-head"><h3>💬 Recent feedback</h3></div>
            ${d.feedback.length ? html`<div class="list">${d.feedback.map((f) => html`
              <a class="row-item" href="#/assignment/${f.assignmentId}" data-path="/assignment/${f.assignmentId}">
                <div class="row-main"><div class="row-title">${f.title}</div><div class="row-sub">${f.className}</div>
                  <div style="margin-top:6px">${critLine(f.grades)}</div>${f.feedback ? html`<p class="small pre" style="margin-top:6px">${f.feedback}</p>` : ''}</div>
              </a>`)}</div>` : emptyState('📭', 'Graded work and teacher feedback will appear here.')}
          </div>
        </div>
        <div class="stack">
          <div class="panel profile-card">${avatarHTML(u.avatar)}
            <h3 style="margin-top:12px">${u.title}</h3><p class="muted small">Level ${u.level} · ${u.xp} XP</p>
            ${levelBar(u)}<p class="muted small" style="margin-top:6px">${u.xpIntoLevel} / ${u.xpNeeded} XP to level ${u.level + 1}</p>
          </div>
          <div class="panel"><div class="panel-head"><h3>⚔️ Quests due</h3><a class="link" href="#/quests" data-path="/quests">Open →</a></div>
            ${d.quests.length ? html`<div class="list">${d.quests.map((q) => html`<div class="row-item"><div class="row-main"><div class="row-title">${q.title}</div><div class="row-sub">${q.due}</div></div></div>`)}</div>` : emptyState('✨', 'No quests due.')}
          </div>
          <div class="panel"><div class="panel-head"><h3>📢 Announcements</h3></div>${announcementList(d.announcements)}</div>
        </div>
      </div>`);
    return;
  }

  // teacher
  mount(el, html`
    <div class="view-head"><div><h1>Hello, ${u.displayName} 👋</h1><p>Your classes at a glance.</p></div>
      <div class="head-actions"><button class="btn btn-primary" data-action="nav" data-path="/classes">Go to classes</button></div></div>
    <div class="stat-grid">
      <div class="stat-card"><div class="stat-ico">📚</div><div><div class="stat-label">Classes</div><div class="stat-value">${d.stats.classes}</div></div></div>
      <div class="stat-card"><div class="stat-ico">🖊️</div><div><div class="stat-label">To grade</div><div class="stat-value">${d.stats.toGrade}</div></div></div>
      <div class="stat-card"><div class="stat-ico">⏰</div><div><div class="stat-label">Due this week</div><div class="stat-value">${d.stats.deadlines}</div></div></div>
    </div>
    <div class="two-col">
      <div class="panel"><div class="panel-head"><h3>🖊️ Waiting to be graded</h3></div>
        ${d.toGrade.length ? html`<div class="list">${d.toGrade.map((s) => html`
          <a class="row-item" href="#/assignment/${s.assignmentId}" data-path="/assignment/${s.assignmentId}">
            <div class="row-main"><div class="row-title">${s.student} — ${s.title}</div><div class="row-sub">${s.className} · submitted ${timeAgo(s.submittedAt)}</div></div>
            <div class="row-end">${s.late ? html`<span class="state-badge st-late">Late</span>` : ''}<span class="link">Grade →</span></div>
          </a>`)}</div>` : emptyState('✅', 'Nothing waiting to be graded.')}
      </div>
      <div class="stack">
        <div class="panel"><div class="panel-head"><h3>⏰ Deadlines this week</h3></div>
          ${d.deadlines.length ? html`<div class="list">${d.deadlines.map((a) => html`<a class="row-item" href="#/assignment/${a.id}" data-path="/assignment/${a.id}"><div class="row-main"><div class="row-title">${a.title}</div><div class="row-sub">${a.className} · ${formatDue(a.dueAt)}</div></div></a>`)}</div>` : emptyState('🗓️', 'No deadlines in the next 7 days.')}
        </div>
        <div class="panel"><div class="panel-head"><h3>📢 Announcements</h3></div>${announcementList(d.announcements)}</div>
      </div>
    </div>`);
}

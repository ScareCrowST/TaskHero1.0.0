'use strict';
/**
 * XP, levels and streaks. ALL of this runs on the server so a student cannot
 * edit their own XP (the old localStorage version could be cheated and also lost
 * progress after a page reload).
 *
 * Rules
 *  - XP is only awarded ONCE per "ref" (e.g. "sub:12" or "task:5") - enforced by a UNIQUE index.
 *  - A streak day is counted when the student earns XP on a new calendar day.
 *  - The streak multiplier is applied to the base amount.
 */
const { localDay, yesterdayDay } = require('./util');

const TITLES = [
  'Novice Apprentice', 'Eager Scribe', 'Knowledge Seeker', 'Rising Scholar',
  'Task Tamer', 'Quest Keeper', 'Study Knight', 'Homework Hero',
  'Wisdom Warrior', 'Master of Tasks', 'Legendary Scholar', 'Grand TaskHero',
];

const xpForLevel = (level) => 100 + (level - 1) * 50;
const titleForLevel = (level) => TITLES[Math.min(level - 1, TITLES.length - 1)];

/** Turn lifetime XP into { level, into, needed }. */
function levelInfo(totalXp) {
  let level = 1;
  let left = Math.max(0, totalXp);
  while (left >= xpForLevel(level)) { left -= xpForLevel(level); level += 1; }
  return { level, into: left, needed: xpForLevel(level), title: titleForLevel(level) };
}

function streakMultiplier(streak) {
  if (streak >= 30) return 5;
  if (streak >= 14) return 3;
  if (streak >= 7) return 2;
  if (streak >= 3) return 1.5;
  return 1;
}

/** Count today as an active day; returns the user's streak after the update. */
function touchStreak(db, user) {
  const today = localDay();
  if (user.last_active === today) return user.streak;
  const streak = user.last_active === yesterdayDay() ? user.streak + 1 : 1;
  db.prepare('UPDATE users SET streak = ?, last_active = ? WHERE id = ?').run(streak, today, user.id);
  user.streak = streak;
  user.last_active = today;
  return streak;
}

/**
 * Award XP once for `ref`. Returns { gained, leveledUp, level } or null if it
 * was already awarded for this ref.
 */
function award(db, userId, baseAmount, reason, ref) {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!user || baseAmount <= 0) return null;
  const already = db.prepare('SELECT 1 FROM xp_log WHERE user_id = ? AND ref = ?').get(userId, ref);
  if (already) return null;

  const before = levelInfo(user.xp).level;
  const streak = touchStreak(db, user);
  const gained = Math.round(baseAmount * streakMultiplier(streak));
  db.prepare('UPDATE users SET xp = xp + ? WHERE id = ?').run(gained, userId);
  db.prepare('INSERT INTO xp_log (user_id, amount, reason, ref, day, created_at) VALUES (?,?,?,?,?,?)')
    .run(userId, gained, reason, ref, localDay(), Date.now());
  const after = levelInfo(user.xp + gained);
  if (after.level > before) {
    db.prepare('UPDATE users SET title = ? WHERE id = ? AND (title IS NULL OR title = ?)')
      .run(after.title, userId, titleForLevel(before));
  }
  return { gained, multiplier: streakMultiplier(streak), leveledUp: after.level > before, level: after.level, title: after.title };
}

/** XP earned today from a given kind of ref prefix (used for the daily personal-task cap). */
function earnedTodayWithPrefix(db, userId, prefix) {
  const row = db.prepare(
    "SELECT COALESCE(SUM(amount),0) AS n FROM xp_log WHERE user_id = ? AND day = ? AND ref LIKE ?"
  ).get(userId, localDay(), prefix + '%');
  return row.n;
}

module.exports = { xpForLevel, titleForLevel, levelInfo, streakMultiplier, award, earnedTodayWithPrefix };

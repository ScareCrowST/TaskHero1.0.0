'use strict';
const { levelInfo, titleForLevel } = require('./xp');

const DEFAULT_AVATAR = { skin: '#f5d0a9', hair: '#2b1b17', outfit: '#3498db', weapon: 'sword' };

function parseAvatar(raw) {
  try { return { ...DEFAULT_AVATAR, ...(raw ? JSON.parse(raw) : {}) }; } catch { return { ...DEFAULT_AVATAR }; }
}

/** Never send password hashes to the browser. */
function publicUser(u) {
  const lv = levelInfo(u.xp);
  return {
    id: u.id,
    username: u.username,
    displayName: u.display_name,
    email: u.email || '',
    role: u.role,
    status: u.status,
    yearGroup: u.year_group || '',
    xp: u.xp,
    level: lv.level,
    xpIntoLevel: lv.into,
    xpNeeded: lv.needed,
    title: u.title || titleForLevel(lv.level),
    streak: u.streak,
    avatar: parseAvatar(u.avatar),
    mustChangePassword: !!u.must_change_password,
    createdAt: u.created_at,
  };
}

function personRef(u) {
  return u ? { id: u.id, displayName: u.display_name, role: u.role } : null;
}

module.exports = { publicUser, personRef, parseAvatar, DEFAULT_AVATAR };

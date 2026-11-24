'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { notFound, forbidden } = require('./util');
const dbm = require('./db');

function loadClass(db, id) {
  const c = db.prepare('SELECT * FROM classes WHERE id = ?').get(Number(id));
  if (!c) throw notFound('Class not found.');
  return c;
}

/** The class teacher, or any school admin, may manage a class. */
const canManage = (user, c) => user.role === 'school_admin' || (user.role === 'teacher' && c.teacher_id === user.id);

const isMember = (db, c, user) =>
  !!db.prepare('SELECT 1 FROM class_members WHERE class_id = ? AND user_id = ?').get(c.id, user.id);

/** Class the user may see (manager or enrolled student). Hides the existence of other classes. */
function viewClass(ctx, id) {
  const c = loadClass(ctx.db, id);
  if (canManage(ctx.user, c)) return c;
  if (ctx.user.role === 'student' && isMember(ctx.db, c, ctx.user)) return c;
  throw notFound('Class not found.');
}

/** Class the user may manage. Enrolled students get 403, strangers get 404. */
function manageClass(ctx, id) {
  const c = loadClass(ctx.db, id);
  if (canManage(ctx.user, c)) return c;
  if (ctx.user.role === 'student' && isMember(ctx.db, c, ctx.user)) throw forbidden();
  throw notFound('Class not found.');
}

function loadAssignment(db, id) {
  const a = db.prepare('SELECT * FROM assignments WHERE id = ?').get(Number(id));
  if (!a) throw notFound('Assignment not found.');
  return a;
}

// ------------------------------------------------------------------ files on disk
function unlinkStored(schoolCode, storedName) {
  try { fs.unlinkSync(path.join(dbm.schoolUploadDir(schoolCode), storedName)); } catch { /* already gone */ }
}

/** Delete file rows (and the bytes on disk) matching a WHERE clause. */
function removeFilesWhere(db, schoolCode, where, ...args) {
  const rows = db.prepare(`SELECT id, stored_name FROM files WHERE ${where}`).all(...args);
  for (const r of rows) unlinkStored(schoolCode, r.stored_name);
  if (rows.length) db.prepare(`DELETE FROM files WHERE ${where}`).run(...args);
}

function removeFilesForAssignments(db, schoolCode, assignmentIds) {
  for (const aid of assignmentIds) {
    removeFilesWhere(db, schoolCode, "owner_type = 'assignment' AND owner_id = ?", aid);
    removeFilesWhere(db, schoolCode,
      "owner_type = 'submission' AND owner_id IN (SELECT id FROM submissions WHERE assignment_id = ?)", aid);
  }
}

module.exports = {
  loadClass, canManage, isMember, viewClass, manageClass, loadAssignment,
  unlinkStored, removeFilesWhere, removeFilesForAssignments,
};

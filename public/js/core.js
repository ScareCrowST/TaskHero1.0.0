// Shared application state, a tiny hash router and delegated event handling.
// No inline event handlers anywhere: elements use data-action / data-form attributes instead,
// which keeps the Content-Security-Policy strict (no inline scripts allowed).
import { toast, $, closeModal } from './ui.js';
import { ApiError } from './api.js';

export const S = { user: null, school: null };
export const hooks = {}; // filled in by main.js (avoids circular imports)
export const actions = {};
export const forms = {};

let renderer = null;
export const setRenderer = (fn) => { renderer = fn; };
export const refresh = () => (renderer ? renderer() : undefined);

export function go(path) {
  if (location.hash === '#' + path) return refresh();
  location.hash = '#' + path;
  return undefined;
}
export const currentPath = () => (location.hash.replace(/^#/, '') || '/');

let onUnauthorized = () => {};
export const setOnUnauthorized = (fn) => { onUnauthorized = fn; };

export function handleError(err, form) {
  if (err instanceof ApiError && err.status === 401 && S.user) { onUnauthorized(); return; }
  const msg = err && err.message ? err.message : 'Something went wrong.';
  const box = form && form.querySelector('.form-error');
  if (box) { box.textContent = msg; box.classList.add('show'); } else toast('❌ ' + msg, 'error');
}

document.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const fn = actions[el.dataset.action];
  if (!fn) return;
  e.preventDefault();
  try { await fn(el, e); } catch (err) { handleError(err); }
});

document.addEventListener('change', async (e) => {
  const el = e.target.closest('[data-change]');
  if (!el) return;
  const fn = actions[el.dataset.change];
  if (!fn) return;
  try { await fn(el, e); } catch (err) { handleError(err); }
});

document.addEventListener('submit', async (e) => {
  const form = e.target.closest('form[data-form]');
  if (!form) return;
  e.preventDefault();
  const fn = forms[form.dataset.form];
  if (!fn) return;
  const box = form.querySelector('.form-error');
  if (box) { box.textContent = ''; box.classList.remove('show'); }
  const btns = form.querySelectorAll('button[type=submit]');
  btns.forEach((b) => { b.disabled = true; });
  try { await fn(form, e); } catch (err) { handleError(err, form); } finally { btns.forEach((b) => { b.disabled = false; }); }
});

actions['close-modal'] = () => closeModal();
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });

// Keep the "level up" overlay logic in one place.
export function celebrate(reward) {
  if (!reward) return;
  toast(`+${reward.gained} XP earned! ⚡${reward.multiplier > 1 ? ` (streak ×${reward.multiplier})` : ''}`);
  if (reward.leveledUp) {
    $('#luLevel').textContent = reward.level;
    $('#luTitle').textContent = reward.title;
    const el = $('#levelUp');
    el.classList.remove('hidden');
    setTimeout(() => el.classList.add('hidden'), 2800);
  }
}

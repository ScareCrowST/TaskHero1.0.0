import { api } from './api.js';

const form = document.getElementById('schoolRegisterForm');
const errBox = document.getElementById('regError');

form.schoolCode.addEventListener('input', () => { form.schoolCode.value = form.schoolCode.value.toUpperCase().replace(/[^A-Z0-9-]/g, ''); });

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  errBox.classList.remove('show'); errBox.textContent = '';
  const d = Object.fromEntries(new FormData(form));
  const fail = (m) => { errBox.textContent = m; errBox.classList.add('show'); errBox.scrollIntoView({ block: 'center' }); };
  if (!form.terms.checked) return fail('Please accept the terms to continue.');
  const btn = form.querySelector('button[type=submit]');
  btn.disabled = true;
  try {
    const r = await api.post('/api/schools/register', d);
    document.getElementById('displaySchoolCode').textContent = r.code;
    document.getElementById('successModal').classList.remove('hidden');
  } catch (err) { fail(err.message); } finally { btn.disabled = false; }
});

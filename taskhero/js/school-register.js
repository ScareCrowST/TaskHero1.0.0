/* ============================================
   School Registration · js/school-register.js
   ============================================ */

const Store = {
  get(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch { return fallback; }
  },
  set(key, val) { localStorage.setItem(key, JSON.stringify(val)); }
};

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

// Initialize schools array if not exists
if (!Store.get('th_schools')) {
  Store.set('th_schools', []);
}

// Form validation
const form = document.getElementById('schoolRegisterForm');

form.addEventListener('submit', (e) => {
  e.preventDefault();
  
  const formData = new FormData(form);
  const data = Object.fromEntries(formData.entries());
  
  // Validation
  if (data.password !== data.confirmPassword) {
    alert('Passwords do not match!');
    return;
  }
  
  // Validate school code format
  const codePattern = /^[A-Z0-9\-]+$/;
  if (!codePattern.test(data.schoolCode)) {
    alert('School code must contain only uppercase letters, numbers, and hyphens.');
    return;
  }
  
  // Check if school code already exists
  const schools = Store.get('th_schools', []);
  if (schools.find(s => s.code === data.schoolCode.toUpperCase())) {
    alert('This school code is already taken. Please choose a different one.');
    return;
  }
  
  // Check if email already exists
  const users = Store.get('th_users', []);
  if (users.find(u => u.email === data.adminEmail)) {
    alert('This email is already registered. Please use a different email or log in.');
    return;
  }
  
  // Create school
  const school = {
    id: uid(),
    name: data.schoolName,
    code: data.schoolCode.toUpperCase(),
    country: data.country,
    website: data.website || '',
    studentCount: data.studentCount,
    ibProgram: data.ibProgram,
    reason: data.reason,
    status: 'pending', // pending, approved, rejected
    createdAt: Date.now(),
    approvedAt: null,
    approvedBy: null
  };
  
  // Create admin user
  const adminUser = {
    id: uid(),
    schoolId: school.code,
    role: 'school_admin',
    username: data.adminEmail.split('@')[0], // Use email prefix as username
    email: data.adminEmail,
    password: data.password, // In real app, this would be hashed
    displayName: data.adminName,
    position: data.adminPosition,
    phone: data.adminPhone || '',
    avatar: {
      skin: '#f5d0a9',
      hair: '#2b1b17',
      outfit: '#3498db',
      weapon: 'book'
    },
    xp: 0,
    level: 1,
    streak: 0,
    lastActive: null,
    title: 'School Administrator',
    createdAt: Date.now()
  };
  
  // Save to storage
  schools.push(school);
  users.push(adminUser);
  Store.set('th_schools', schools);
  Store.set('th_users', users);
  
  // Show success modal
  document.getElementById('displaySchoolCode').textContent = school.code;
  document.getElementById('displayEmail').textContent = adminUser.email;
  document.getElementById('successModal').classList.remove('hidden');
  
  // Log for debugging
  console.log('School registered:', school);
  console.log('Admin created:', adminUser);
});

// Real-time validation for school code
const codeInput = form.querySelector('input[name="schoolCode"]');
codeInput.addEventListener('input', (e) => {
  e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9\-]/g, '');
});
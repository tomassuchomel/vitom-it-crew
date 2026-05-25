import axios from 'axios';

// V dev režimu Vite proxy přesměruje /api → :4000.
// V produkci frontend i backend běží na stejné doméně (Render), takže /api funguje napřímo.
export const api = axios.create({
  baseURL: '/api',
  withCredentials: true,
});

// X-Team-Id header je posílaný s každým requestem, aby backend věděl, do kterého
// teamu právě uživatel "kouká". Hodnota je uložena v localStorage (přežije reload).
// Změna probíhá přes TeamContext (setCurrentTeam) – samotný interceptor je read-only.
api.interceptors.request.use((config) => {
  const teamId = localStorage.getItem('current_team_id');
  if (teamId) config.headers['X-Team-Id'] = teamId;
  return config;
});

// API klient pro multi-team. Endpointy obsluhuje server/src/routes/teams.js.
export const teams = {
  list:        () => api.get('/teams').then(r => r.data),
  get:         (id) => api.get(`/teams/${id}`).then(r => r.data),
  create:      (data) => api.post('/teams', data).then(r => r.data),
  update:      (id, data) => api.put(`/teams/${id}`, data).then(r => r.data),
  addMember:   (id, data) => api.post(`/teams/${id}/members`, data).then(r => r.data),
  removeMember:(id, userId) => api.delete(`/teams/${id}/members/${userId}`).then(r => r.data),
};

// Pomocné helpery pro běžné akce
export const auth = {
  me:        () => api.get('/auth/me').then(r => r.data),
  config:    () => api.get('/auth/config').then(r => r.data),
  devUsers:  () => api.get('/auth/dev-users').then(r => r.data),
  devLogin:  (userId) => api.post('/auth/dev-login', { userId }).then(r => r.data),
  login:     (email, password) => api.post('/auth/login', { email, password }).then(r => r.data),
  changePassword: (currentPassword, newPassword) =>
    api.post('/auth/change-password', { currentPassword, newPassword }).then(r => r.data),
  logout:    () => api.post('/auth/logout').then(r => r.data),
};

export const projects = {
  list:    () => api.get('/projects').then(r => r.data),
  get:     (id) => api.get(`/projects/${id}`).then(r => r.data),
  edits:   (id) => api.get(`/projects/${id}/edits`).then(r => r.data),
  create:  (data) => api.post('/projects', data).then(r => r.data),
  update:  (id, data) => api.put(`/projects/${id}`, data).then(r => r.data),
  remove:  (id) => api.delete(`/projects/${id}`).then(r => r.data),
};

export const tasks = {
  mine:    (params) => api.get('/tasks/mine', { params }).then(r => r.data),
  create:  (data) => api.post('/tasks', data).then(r => r.data),
  update:  (id, data) => api.put(`/tasks/${id}`, data).then(r => r.data),
  remove:  (id) => api.delete(`/tasks/${id}`).then(r => r.data),
  estimate:(id) => api.post(`/tasks/${id}/estimate`).then(r => r.data),
};

// Review workflow – schvalování a vrácení úkolů. Endpointy obsluhuje
// server/src/routes/reviews.js. Jen manager projektu nebo admin smí review.
export const reviews = {
  queue:   () => api.get('/tasks/review-queue').then(r => r.data),
  // verdict: 'approved' | 'rejected'; pro rejected je comment povinný.
  decide:  (taskId, verdict, comment) =>
    api.post(`/tasks/${taskId}/review`, { verdict, comment }).then(r => r.data),
  // Historie všech rozhodnutí pro task – pro programátora, aby viděl, co bylo vráceno.
  history: (taskId) => api.get(`/tasks/${taskId}/reviews`).then(r => r.data),
};

export const questions = {
  list:    (params) => api.get('/questions', { params }).then(r => r.data),
  counts:  () => api.get('/questions/counts').then(r => r.data),
  create:  (data) => api.post('/questions', data).then(r => r.data),
  answer:  (id, answer) => api.post(`/questions/${id}/answer`, { answer }).then(r => r.data),
  reopen:  (id) => api.post(`/questions/${id}/reopen`).then(r => r.data),
  remove:  (id) => api.delete(`/questions/${id}`).then(r => r.data),
};

export const ai = {
  status:   () => api.get('/ai/status').then(r => r.data),
  advice:   () => api.get('/ai/advice').then(r => r.data),
  chat:     (messages) => api.post('/ai/chat', { messages }).then(r => r.data),
  accuracy: () => api.get('/ai/accuracy').then(r => r.data),
};

// AI agent (Claude vykonává úkoly autonomně)
// Endpointy obsluhuje server/src/routes/aiAgent.js
export const aiAgent = {
  // Globální preflight: vrátí, jestli je AI agent vůbec připraven běžet
  // (config OK, worker žije). Volá se z dashboardu / globálního banneru.
  preflight:        () => api.get('/ai-agent/preflight').then(r => r.data),
  // Per-task preflight – obsahuje issues specifické pro daný úkol
  // (chybí repo_url, není ai_assignee, špatný stav…).
  taskPreflight:    (taskId) => api.get(`/ai-agent/preflight/${taskId}`).then(r => r.data),
  // Zařadí task do fronty pro agenta. Vrátí 400 + issues pokud preflight selže.
  enqueue:          (taskId) => api.post(`/tasks/${taskId}/enqueue`).then(r => r.data),
  // Status + activity log pro detail úkolu (poll po enqueue).
  status:           (taskId) => api.get(`/tasks/${taskId}/ai-status`).then(r => r.data),
};

export const attachments = {
  list:   (taskId) => api.get(`/attachments/by-task/${taskId}`).then(r => r.data),
  upload: (taskId, files) => {
    const fd = new FormData();
    for (const f of files) fd.append('files', f);
    return api.post(`/attachments/by-task/${taskId}`, fd, {
      headers: { 'Content-Type': 'multipart/form-data' },
    }).then(r => r.data);
  },
  remove: (id) => api.delete(`/attachments/${id}`).then(r => r.data),
  url:    (a) => `/uploads/${a.filename}`,
};

export const time = {
  list:    (params) => api.get('/time', { params }).then(r => r.data),
  create:  (data) => api.post('/time', data).then(r => r.data),
  update:  (id, data) => api.put(`/time/${id}`, data).then(r => r.data),
  remove:  (id) => api.delete(`/time/${id}`).then(r => r.data),
};

export const users = {
  // Default: team-scoped (jen členové current teamu).
  list:    () => api.get('/users').then(r => r.data),
  // Admin-only: všichni useři + jejich team membership v poli `teams`.
  // Použij v /admin sekci pro globální správu napříč teamy.
  listAll: () => api.get('/users', { params: { scope: 'all' } }).then(r => r.data),
  create:  (data) => api.post('/users', data).then(r => r.data),
  update:  (id, data) => api.put(`/users/${id}`, data).then(r => r.data),
  remove:  (id) => api.delete(`/users/${id}`).then(r => r.data),
  updateMe: (data) => api.put('/users/me', data).then(r => r.data),
  uploadAvatar: (file) => {
    const fd = new FormData();
    fd.append('avatar', file);
    return api.post('/users/me/avatar', fd, {
      headers: { 'Content-Type': 'multipart/form-data' },
    }).then(r => r.data);
  },
  removeAvatar: () => api.delete('/users/me/avatar').then(r => r.data),
  resetPassword: (id) => api.post(`/users/${id}/reset-password`).then(r => r.data),
  avatarUrl: (user) => {
    if (!user?.id) return null;
    const v = user.avatar_updated_at ? new Date(user.avatar_updated_at).getTime() : (user.id || 0);
    return `/api/users/${user.id}/avatar?v=${v}`;
  },
};

export const reports = {
  summary: (params) => api.get('/reports/summary', { params }).then(r => r.data),
  costs:   () => api.get('/reports/projects-cost').then(r => r.data),
  who:     () => api.get('/reports/who-works-on-what').then(r => r.data),
  done:    (params) => api.get('/reports/who-completed-what', { params }).then(r => r.data),
};

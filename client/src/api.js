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
  login:     (email, password) => api.post('/auth/login', { email, password }).then(r => r.data),
  changePassword: (currentPassword, newPassword) =>
    api.post('/auth/change-password', { currentPassword, newPassword }).then(r => r.data),
  logout:    () => api.post('/auth/logout').then(r => r.data),
};

export const projects = {
  list:    () => api.get('/projects').then(r => r.data),
  // Cross-team: pro admin/manager/senior_dev — projekty napříč všemi týmy,
  // kde je user členem (admin globálně). Pro zakládání úkolu mezi týmy.
  listAll: () => api.get('/projects', { params: { scope: 'all' } }).then(r => r.data),
  get:     (id) => api.get(`/projects/${id}`).then(r => r.data),
  edits:   (id) => api.get(`/projects/${id}/edits`).then(r => r.data),
  create:  (data) => api.post('/projects', data).then(r => r.data),
  update:  (id, data) => api.put(`/projects/${id}`, data).then(r => r.data),
  remove:  (id) => api.delete(`/projects/${id}`).then(r => r.data),
};

export const tasks = {
  mine:    (params) => api.get('/tasks/mine', { params }).then(r => r.data),
  get:     (id) => api.get(`/tasks/${id}`).then(r => r.data),
  create:  (data) => api.post('/tasks', data).then(r => r.data),
  update:  (id, data) => api.put(`/tasks/${id}`, data).then(r => r.data),
  remove:  (id) => api.delete(`/tasks/${id}`).then(r => r.data),
  estimate:(id) => api.post(`/tasks/${id}/estimate`).then(r => r.data),
  // Hledání úkolů podle uživatele/týmu/projektu/statusu.
  search:  (params) => api.get('/tasks/search', { params }).then(r => r.data),
};

// Review workflow – schvalování a vrácení úkolů. Endpointy obsluhuje
// server/src/routes/reviews.js. Jen manager projektu nebo admin smí review.
export const reviews = {
  queue:    () => api.get('/tasks/review-queue').then(r => r.data),
  // Programátorův pohled: úkoly vrácené k opravě (status='needs_fix') přiřazené
  // aktuálnímu uživateli, scoped na current team. Obsahuje latest_review_comment
  // + reviewer + počet příloh.
  needsFix: () => api.get('/tasks/needs-fix').then(r => r.data),
  // verdict: 'approved' | 'rejected'; pro rejected je comment povinný.
  decide:   (taskId, verdict, comment) =>
    api.post(`/tasks/${taskId}/review`, { verdict, comment }).then(r => r.data),
  // Historie všech rozhodnutí pro task – pro programátora, aby viděl, co bylo vráceno.
  history:  (taskId) => api.get(`/tasks/${taskId}/reviews`).then(r => r.data),
};

export const questions = {
  list:    (params) => api.get('/questions', { params }).then(r => r.data),
  counts:  () => api.get('/questions/counts').then(r => r.data),
  create:  (data) => api.post('/questions', data).then(r => r.data),
  answer:  (id, answer) => api.post(`/questions/${id}/answer`, { answer }).then(r => r.data),
  reopen:  (id) => api.post(`/questions/${id}/reopen`).then(r => r.data),
  remove:  (id) => api.delete(`/questions/${id}`).then(r => r.data),
  markAnswersRead: () => api.post('/questions/mark-answers-read').then(r => r.data),
};

// Sjednocené počty pro badge v levém menu. Nahrazuje 3 samostatná volání
// (questions/counts, review-queue, needs-fix) — Layout je volá 1x/30s.
// Každá kategorie vrací { total, byTeam: { <team_id>: <count> } }.
export const navCounts = {
  get: () => api.get('/nav-counts').then(r => r.data),
};

// Porady — sekce pro pravidelné schůzky/porady. Typy porad → jednotlivé zápisy.
export const meetings = {
  listTypes:      () => api.get('/meetings/types').then(r => r.data),
  createType:     (data) => api.post('/meetings/types', data).then(r => r.data),
  getType:        (id) => api.get(`/meetings/types/${id}`).then(r => r.data),
  updateType:     (id, data) => api.patch(`/meetings/types/${id}`, data).then(r => r.data),
  removeType:     (id) => api.delete(`/meetings/types/${id}`).then(r => r.data),
  listMeetings:   (typeId) => api.get(`/meetings/types/${typeId}/meetings`).then(r => r.data),
  createMeeting:  (typeId, data) => api.post(`/meetings/types/${typeId}/meetings`, data).then(r => r.data),
  getMeeting:     (id) => api.get(`/meetings/meetings/${id}`).then(r => r.data),
  updateMeeting:  (id, data) => api.patch(`/meetings/meetings/${id}`, data).then(r => r.data),
  removeMeeting:  (id) => api.delete(`/meetings/meetings/${id}`).then(r => r.data),
  // AI: shrnutí předchozích porad + status úkolů + doporučení
  summary:        (id) => api.post(`/meetings/meetings/${id}/summary`).then(r => r.data),
  // AI: návrh dalších bodů agendy (mimo kostru)
  suggestAgenda:  (id) => api.post(`/meetings/meetings/${id}/agenda-suggest`).then(r => r.data),
  // AI: shrne obsah aktuálního zápisu (3-5 vět)
  summarizeNotes: (id) => api.post(`/meetings/meetings/${id}/summarize-notes`).then(r => r.data),
  // AI: navrhne úkoly ze zápisu (reuse processNote — vrací suggestion strukturu jako Poznámky)
  suggestTasks:   (id) => api.post(`/meetings/meetings/${id}/suggest-tasks`).then(r => r.data),
  // List úkolů propojených se zápisem (tasks.meeting_id)
  listTasks:      (id) => api.get(`/meetings/meetings/${id}/tasks`).then(r => r.data),
  // Přechod stavu draft/in_progress/completed. reason povinný pro reopen.
  transition:     (id, to, reason, extra) => api.post(`/meetings/meetings/${id}/transition`, { to, reason, ...(extra || {}) }).then(r => r.data),
  // Follow-up mail účastníkům po zápisu (šéf/admin only)
  followUp:       (id) => api.post(`/meetings/meetings/${id}/followup`).then(r => r.data),
  // Audit log editací
  edits:          (id) => api.get(`/meetings/meetings/${id}/edits`).then(r => r.data),
};

// MZV (Měsíční Zpětná Vazba). F1: subordinates, profile CRUD, meetings CRUD.
// F2: PATCH, complete, reopen, delete, AI summarize + suggest tasks, list tasks.
export const mzv = {
  subordinates: () => api.get('/mzv/subordinates').then(r => r.data),
  getProfile:   (userId) => api.get(`/mzv/profile/${userId}`).then(r => r.data),
  putProfile:   (userId, data) => api.put(`/mzv/profile/${userId}`, data).then(r => r.data),
  listMeetings: (subordinateId) => api.get('/mzv/meetings', { params: { subordinate_id: subordinateId } }).then(r => r.data),
  createMeeting: (subordinateId, meetingDate) => api.post('/mzv/meetings', { subordinate_id: subordinateId, meeting_date: meetingDate }).then(r => r.data),
  getMeeting:   (id) => api.get(`/mzv/meetings/${id}`).then(r => r.data),
  updateMeeting: (id, data) => api.patch(`/mzv/meetings/${id}`, data).then(r => r.data),
  complete:     (id) => api.post(`/mzv/meetings/${id}/complete`).then(r => r.data),
  reopen:       (id) => api.post(`/mzv/meetings/${id}/reopen`).then(r => r.data),
  removeMeeting: (id) => api.delete(`/mzv/meetings/${id}`).then(r => r.data),
  summarize:    (id) => api.post(`/mzv/meetings/${id}/summarize`).then(r => r.data),
  // AI shrnutí historie MZV konkrétního podřízeného + doporučení co dnes řešit.
  historySummary: (userId) => api.post(`/mzv/subordinates/${userId}/summary`).then(r => r.data),
  suggestTasks: (id) => api.post(`/mzv/meetings/${id}/suggest-tasks`).then(r => r.data),
  listTasks:    (id) => api.get(`/mzv/meetings/${id}/tasks`).then(r => r.data),
};

// MCP tokeny — každý uživatel si spravuje vlastní tokeny pro připojení
// externího Claude klienta (Cowork/Desktop/Code) ke svým úkolům.
export const mcpTokens = {
  list:   () => api.get('/mcp-tokens').then(r => r.data),
  create: (name) => api.post('/mcp-tokens', { name }).then(r => r.data),
  remove: (id) => api.delete(`/mcp-tokens/${id}`).then(r => r.data),
};

// Žádosti o změnu termínu úkolu.
export const dueChangeRequests = {
  list:      (box) => api.get('/due-change-requests', { params: { box } }).then(r => r.data),
  counts:    () => api.get('/due-change-requests/counts').then(r => r.data),
  create:    (task_id, requested_due, requester_note) =>
             api.post('/due-change-requests', { task_id, requested_due, requester_note }).then(r => r.data),
  approve:   (id, counter_due, reviewer_note) =>
             api.post(`/due-change-requests/${id}/approve`, { counter_due, reviewer_note }).then(r => r.data),
  reject:    (id, reviewer_note) =>
             api.post(`/due-change-requests/${id}/reject`, { reviewer_note }).then(r => r.data),
  markSeen:  () => api.post('/due-change-requests/mark-seen').then(r => r.data),
};

export const ai = {
  status:   () => api.get('/ai/status').then(r => r.data),
  // scope: 'team' (default) | 'all' (executive view, jen pro privilegované uživatele)
  advice:   (scope = 'team') => api.get('/ai/advice', { params: { scope } }).then(r => r.data),
  chat:     (messages, scope = 'team') => api.post('/ai/chat', { messages, scope }).then(r => r.data),
  accuracy: () => api.get('/ai/accuracy').then(r => r.data),
};

// Whisper bere přípony jako hint pro container. WebM (Chrome/Firefox) vs MP4
// (iOS Safari). Bez správné přípony někdy Whisper vrací 400.
const audioExt = (blob) => {
  const t = (blob?.type || '').toLowerCase();
  if (t.includes('mp4')) return '.m4a';
  if (t.includes('ogg')) return '.ogg';
  if (t.includes('wav')) return '.wav';
  if (t.includes('mpeg') || t.includes('mp3')) return '.mp3';
  return '.webm';
};

// Poznámky – hierarchický strom (množina/podmnožina), team-scoped.
// Backend server/src/routes/notes.js. Do budoucna čteno AI agentem.
export const notes = {
  // scope: 'team' (default) | 'personal' | 'shared'
  list:    (scope = 'team') => api.get('/notes', { params: { scope } }).then(r => r.data),
  create:  (data) => api.post('/notes', data).then(r => r.data),
  update:  (id, data) => api.put(`/notes/${id}`, data).then(r => r.data),
  remove:  (id) => api.delete(`/notes/${id}`).then(r => r.data),
  // AI asistent: { question, history } → { reply, usage }
  aiAsk:   (question, history) => api.post('/notes/ai-ask', { question, history }).then(r => r.data),
  // AI zpracování poznámky: action 'summarize' | 'suggest_tasks' → { reply }
  aiProcess: (id, action) => api.post(`/notes/${id}/ai-process`, { action }).then(r => r.data),
  // Úkoly, které vznikly z této poznámky (přes suggest_tasks / Quick Capture).
  tasks:     (id) => api.get(`/notes/${id}/tasks`).then(r => r.data),
  // Přepis nahrávky porady přes Whisper → { text }
  transcribe: (audioBlob) => {
    const fd = new FormData();
    fd.append('audio', audioBlob, `porada${audioExt(audioBlob)}`);
    return api.post('/notes/transcribe', fd, {
      headers: { 'Content-Type': 'multipart/form-data' },
      timeout: 120000, // přepis může trvat
    }).then(r => r.data);
  },
  // Real-time: jeden ~10s chunk → text
  transcribeChunk: (audioBlob) => {
    const fd = new FormData();
    fd.append('audio', audioBlob, `chunk${audioExt(audioBlob)}`);
    return api.post('/notes/transcribe-chunk', fd, {
      headers: { 'Content-Type': 'multipart/form-data' },
      timeout: 60000,
    }).then(r => r.data);
  },
  // Cleanup syrového přepisu přes Claude → { cleaned }
  cleanupTranscript: (text) =>
    api.post('/notes/transcript-cleanup', { text }, { timeout: 60000 }).then(r => r.data),
  // Quick Capture: AI klasifikuje text → { intent, summary, params }
  classify: (text) => api.post('/notes/ai-classify', { text }, { timeout: 30000 }).then(r => r.data),
  // Sdílení s jiným uživatelem
  share:   (id, userId) => api.post(`/notes/${id}/share`, { user_id: userId }).then(r => r.data),
  unshare: (id, userId) => api.delete(`/notes/${id}/share/${userId}`).then(r => r.data),
  shares:  (id) => api.get(`/notes/${id}/shares`).then(r => r.data),
};

// Email agent (M365). Phase 1 = OAuth + Inbox. Phase 2a = AI klasifikace + úkoly.
export const email = {
  status:     () => api.get('/email/status').then(r => r.data),
  // /connect je 302 redirect na MS — voláme přes plain location, ne axios.
  connectUrl: () => '/api/email/connect',
  disconnect: () => api.post('/email/disconnect').then(r => r.data),
  messages:   (top = 20) => api.get('/email/messages', { params: { top } }).then(r => r.data),
  // Pošleme zhuštěné info o viditelných zprávách, server klasifikuje + uloží.
  classify:   (messages) => api.post('/email/classify', { messages }, { timeout: 60000 }).then(r => r.data),
  // Z jednoho emailu AI vytáhne návrhy úkolů (SuggestedTasksModal-kompatibilní).
  extractTasks: (msgId) => api.post(`/email/${encodeURIComponent(msgId)}/extract-tasks`, {}, { timeout: 60000 }).then(r => r.data),
};

// Per-user email notification preferences (Resend integration).
export const notifications = {
  get:    () => api.get('/notifications/me').then(r => r.data),
  update: (prefs) => api.put('/notifications/me', prefs).then(r => r.data),
};

// Nápadník — sběr, řízení a schvalování interních návrhů.
// Public endpoint (bez auth) je pro veřejný formulář.
export const ideas = {
  list:         () => api.get('/ideas').then(r => r.data),
  get:          (id) => api.get(`/ideas/${id}`).then(r => r.data),
  patch:        (id, data) => api.patch(`/ideas/${id}`, data).then(r => r.data),
  meta:         () => api.get('/ideas/_meta/enums').then(r => r.data),
  transitions:  (id) => api.get(`/ideas/${id}/transitions`).then(r => r.data),
  transition:   (id, to_state, comment) => api.post(`/ideas/${id}/state`, { to_state, comment }).then(r => r.data),
  createProject:(id, team_id, name) => api.post(`/ideas/${id}/create-project`, { team_id, name }).then(r => r.data),
  saveAnalysis: (id, data) => api.put(`/ideas/${id}/analysis`, data).then(r => r.data),
  report:       () => api.get('/ideas/_report').then(r => r.data),
  stats:        () => api.get('/ideas/_stats').then(r => r.data),
  turnstileMeta:() => api.get('/ideas/_meta/turnstile').then(r => r.data),
  perms:        () => api.get('/ideas/_meta/perms').then(r => r.data),
  pmsList:      () => api.get('/ideas/_pms').then(r => r.data),
  pmAdd:        (user_id) => api.post('/ideas/_pms', { user_id }).then(r => r.data),
  pmRemove:     (user_id) => api.delete(`/ideas/_pms/${user_id}`).then(r => r.data),
  exportCsvUrl: () => `${api.defaults.baseURL}/ideas/_export.csv`,
  submitPublic: (payload) => api.post('/ideas/public', payload).then(r => r.data),
};

// Web Push — VAPID klíč + (un)subscribe. Backend server/src/routes/push.js.
export const push = {
  vapidKey:    () => api.get('/push/vapid-public-key').then(r => r.data),
  subscribe:   (subscription) => api.post('/push/subscribe', subscription).then(r => r.data),
  unsubscribe: (endpoint) => api.post('/push/unsubscribe', { endpoint }).then(r => r.data),
  test:        () => api.post('/push/test').then(r => r.data),
};

// Scoreboard – per-user task completion stats v rámci current teamu.
// Server filtruje by req.team_id, takže klient nemusí nic specifikovat.
export const scoreboard = {
  // team_id=null → server použije current team; team_id=0 → admin cross-team.
  // months=null → all-time snapshot; months=1..24 → time-filtered.
  list:          (team_id, months) => api.get('/scoreboard', {
    params: { ...(team_id != null ? { team_id } : {}), ...(months ? { months } : {}) },
  }).then(r => r.data),
  history:       (team_id, months = 6) => api.get('/scoreboard/history', { params: { months, ...(team_id != null ? { team_id } : {}) } }).then(r => r.data),
  teamsOverview: () => api.get('/scoreboard/teams-overview').then(r => r.data),
  tasks:         (user_id, category, team_id, months) => api.get('/scoreboard/tasks', {
    params: { user_id, category, ...(team_id != null ? { team_id } : {}), ...(months ? { months } : {}) },
  }).then(r => r.data),
  attendance:    (team_id, months) => api.get('/scoreboard/attendance', {
    params: { ...(team_id != null ? { team_id } : {}), ...(months ? { months } : {}) },
  }).then(r => r.data),
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
  // Binární data se streamují z DB přes BYTEA endpoint. Předtím to byly
  // statické soubory v /uploads/, ale Render free tier nemá persistent disk
  // a po deployi se ztrácely. Tady cache-bust nepotřebujeme — id je
  // immutable a Cache-Control: private max-age=86400 je v pohodě.
  url:    (a) => `/api/attachments/${a.id}/file`,
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
  // Členové konkrétního týmu — pro cross-team task creation (assignee dropdown
  // po výběru projektu z jiného týmu). Server ověří, že user je členem.
  listInTeam: (teamId) => api.get('/users', { params: { team_id: teamId } }).then(r => r.data),
  // Distinct členové VŠECH mých týmů — pro cross-team podúkoly, kdy Patricia
  // (host úkolu z jiného týmu) přiděluje podúkol svému kolegovi.
  listAcrossMyTeams: () => api.get('/users', { params: { scope: 'my-teams' } }).then(r => r.data),
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

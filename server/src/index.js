// Express entrypoint – VITOM IT Crew
// MUSÍ být první import: nastaví process.env z .env (s override) ještě před db/auth/ai.
import './env.js';
import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

import { migrate, runFileMigrations, backfillAuth } from './db.js';
import { autoSeedIfEmpty } from './seed.js';
import { passport, HAS_GOOGLE } from './auth.js';

import authRoutes from './routes/auth.js';
import usersRoutes from './routes/users.js';
import projectsRoutes from './routes/projects.js';
import tasksRoutes from './routes/tasks.js';
import timeRoutes from './routes/time.js';
import reportsRoutes from './routes/reports.js';
import questionsRoutes from './routes/questions.js';
import attachmentsRoutes, { uploadsDir } from './routes/attachments.js';
import aiRoutes from './routes/ai.js';
import aiAgentRoutes from './routes/aiAgent.js';
import reviewsRoutes from './routes/reviews.js';
import teamsRoutes from './routes/teams.js';
import scoreboardRoutes from './routes/scoreboard.js';
import notesRoutes from './routes/notes.js';
import pushRoutes from './routes/push.js';
import emailRoutes from './routes/email.js';
import notificationsRoutes from './routes/notifications.js';
import ideasRoutes from './routes/ideas.js';
import navCountsRoutes from './routes/nav-counts.js';
import { startPushCron } from './pushCron.js';
import { agentConfig, describeAgentConfig, validateAgentConfig } from './aiAgent/config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 4000;
const CLIENT_URL = process.env.CLIENT_URL || 'http://localhost:5173';
const IS_PROD = process.env.NODE_ENV === 'production';

app.use(cors({ origin: CLIENT_URL, credentials: true }));
app.use(express.json());
app.use(cookieParser());
if (HAS_GOOGLE) app.use(passport.initialize());

// Healthcheck
app.get('/api/health', (req, res) => res.json({ ok: true, googleAuth: HAS_GOOGLE }));

// API
app.use('/api/auth', authRoutes);
app.use('/api/users', usersRoutes);
app.use('/api/teams', teamsRoutes);
app.use('/api/scoreboard', scoreboardRoutes);
app.use('/api/notes', notesRoutes);
app.use('/api/projects', projectsRoutes);
// aiAgentRoutes obsluhuje smíšené cesty: /api/ai-agent/preflight* i /api/tasks/:id/enqueue,
// MUSÍ být před tasksRoutes – statická cesta "enqueue" by jinak kolidovala s /:id.
// reviewsRoutes definuje /api/tasks/review-queue, /api/tasks/:id/review, /api/tasks/:id/reviews,
// taky před tasksRoutes (statická "review-queue" cesta).
app.use('/api', aiAgentRoutes);
app.use('/api', reviewsRoutes);
app.use('/api/tasks', tasksRoutes);
app.use('/api/time', timeRoutes);
app.use('/api/reports', reportsRoutes);
app.use('/api/questions', questionsRoutes);
app.use('/api/attachments', attachmentsRoutes);
app.use('/api/ai', aiRoutes);
app.use('/api/push', pushRoutes);
app.use('/api/email', emailRoutes);
app.use('/api/notifications', notificationsRoutes);
app.use('/api/ideas', ideasRoutes);
app.use('/api/nav-counts', navCountsRoutes);

// Statické přílohy
app.use('/uploads', express.static(uploadsDir, {
  setHeaders: (res) => res.setHeader('Cache-Control', 'public, max-age=86400'),
}));

// V produkci servírujeme statický build klienta (Render single-service deploy)
if (IS_PROD) {
  const clientDist = path.join(__dirname, '..', '..', 'client', 'dist');
  if (fs.existsSync(clientDist)) {
    app.use(express.static(clientDist));
    // SPA fallback
    app.get('*', (req, res, next) => {
      if (req.path.startsWith('/api') || req.path.startsWith('/uploads')) return next();
      res.sendFile(path.join(clientDist, 'index.html'));
    });
  } else {
    console.warn('[server] client/dist neexistuje – frontend nebude obsloužen');
  }
}

// Globální error handler
app.use((err, req, res, next) => {
  console.error('[api error]', err);
  res.status(500).json({ error: 'server_error', message: err.message });
});

// Spuštění – nejdřív migrace, pak listen
async function start() {
  try {
    await migrate();
    // File-based migrace v server/src/migrations/*.sql (idempotentní). Spouští se po
    // inline schématu, takže může jen rozšiřovat existující tabulky.
    await runFileMigrations();
    // Auto-seed: pokud je DB prázdná (po prvním deployi), naplň ukázková data.
    // Lze vypnout proměnnou DISABLE_AUTOSEED=1.
    if (process.env.DISABLE_AUTOSEED !== '1') {
      await autoSeedIfEmpty();
    }
    // Backfill hesel + jmen pro existující uživatele (idempotentní)
    await backfillAuth();
  } catch (err) {
    console.error('[server] Migrace/seed selhala:', err.message);
    process.exit(1);
  }
  // Push cron — deadline reminders 18:00 + daily digest 08:00 (Europe/Prague).
  startPushCron();

  app.listen(PORT, () => {
    console.log(`\n🚀 VITOM IT Crew server běží na portu ${PORT}`);
    console.log(`   Frontend očekáván na: ${CLIENT_URL}`);
    console.log(`   Google OAuth: ${HAS_GOOGLE ? 'ENABLED ✅' : 'DISABLED (jen dev login)'}`);
    console.log(`   Prostředí: ${IS_PROD ? 'production' : 'development'}`);

    // AI agent config – jen booleany, nikdy hodnoty klíčů.
    // Pomáhá ověřit po deployi, jestli jsou ENV proměnné správně načtené.
    const cfgDesc = describeAgentConfig(agentConfig);
    const v = validateAgentConfig(agentConfig);
    console.log(`\n   AI agent config:`);
    console.log(`     enabled:           ${cfgDesc.enabled ? '✅' : '❌'}`);
    console.log(`     ANTHROPIC_API_KEY: ${cfgDesc.has_anthropic_key ? '✅' : '❌ chybí'}`);
    console.log(`     GITHUB_TOKEN:      ${cfgDesc.has_github_token ? '✅' : '❌ chybí'}`);
    console.log(`     AI_AGENT_WORKDIR:  ${cfgDesc.work_dir_set ? '✅' : '❌ chybí'}`);
    console.log(`     branch_prefix:     ${cfgDesc.branch_prefix}`);
    console.log(`     limit/task:        $${cfgDesc.max_cost_per_task_usd}`);
    console.log(`     limit/day:         $${cfgDesc.max_cost_per_day_usd}`);
    if (cfgDesc.enabled && !v.ok) {
      console.log(`     ⚠ validation errors:`);
      v.errors.forEach(e => console.log(`       - ${e}`));
    } else if (cfgDesc.enabled && v.ok) {
      console.log(`     → web preflight: ready ✅ (worker musí běžet samostatně)`);
    }

    // Mailer config — startup sanity
    import('./mailer.js').then(({ describeMailerConfig }) => {
      const m = describeMailerConfig();
      console.log(`\n   Mailer (M365 Graph):`);
      console.log(`     MICROSOFT_CLIENT_ID:     ${m.has_client_id ? '✅' : '❌ chybí'}`);
      console.log(`     MICROSOFT_CLIENT_SECRET: ${m.has_client_secret ? '✅' : '❌ chybí'}`);
      console.log(`     MICROSOFT_TENANT_ID:     ${m.has_tenant_id ? '✅' : '❌ chybí'}`);
      console.log(`     MAIL_M365_MAILBOX:       ${m.has_mailbox ? `✅ ${m.mailbox}` : '❌ chybí'}`);
    }).catch(() => {});
  });
}
start();

// Express entrypoint – VITOM IT Crew
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

import { migrate, backfillAuth } from './db.js';
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
app.use('/api/projects', projectsRoutes);
app.use('/api/tasks', tasksRoutes);
app.use('/api/time', timeRoutes);
app.use('/api/reports', reportsRoutes);
app.use('/api/questions', questionsRoutes);
app.use('/api/attachments', attachmentsRoutes);
app.use('/api/ai', aiRoutes);

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
  app.listen(PORT, () => {
    console.log(`\n🚀 VITOM IT Crew server běží na portu ${PORT}`);
    console.log(`   Frontend očekáván na: ${CLIENT_URL}`);
    console.log(`   Google OAuth: ${HAS_GOOGLE ? 'ENABLED ✅' : 'DISABLED (jen dev login)'}`);
    console.log(`   Prostředí: ${IS_PROD ? 'production' : 'development'}`);
  });
}
start();

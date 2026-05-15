// PostgreSQL přes node-postgres (pg).
// Připojení přes DATABASE_URL z .env (Neon / Render / lokálně).
// API: query(text, params) → Promise<{ rows, rowCount }>
// Migrace schématu se spustí automaticky při startu serveru.
import pg from 'pg';
import bcrypt from 'bcryptjs';

export const DEFAULT_PASSWORD = 'ITCrew23';
export const PASSWORD_SALT_ROUNDS = 10;

const { Pool } = pg;

// Konfigurace poolu – Neon vyžaduje SSL, lokální Postgres typicky ne.
// V Renderu má proměnná SSL=true; v Neonu URL obsahuje ?sslmode=require.
const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error('[db] CHYBA: DATABASE_URL není nastaveno. Přidej ho do server/.env');
  console.error('[db] Příklad: DATABASE_URL=postgres://user:pass@host/db?sslmode=require');
}

export const pool = new Pool({
  connectionString,
  ssl: process.env.DATABASE_SSL === 'false'
    ? false
    : { rejectUnauthorized: false },   // Neon/Render používají self-signed cert
  max: 10,
  idleTimeoutMillis: 30_000,
});

// Krátký helper pro queries
export const query = (text, params) => pool.query(text, params);

// Schéma – idempotentní (CREATE TABLE IF NOT EXISTS).
// Při změně typu sloupce použij ALTER TABLE.
export async function migrate() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id            SERIAL PRIMARY KEY,
      email         TEXT NOT NULL UNIQUE,
      name          TEXT NOT NULL,
      role          TEXT NOT NULL CHECK (role IN ('admin','manager','senior_dev','external_dev')),
      hourly_rate   REAL NOT NULL DEFAULT 0,
      google_id     TEXT UNIQUE,
      active        BOOLEAN NOT NULL DEFAULT TRUE,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS projects (
      id            SERIAL PRIMARY KEY,
      name          TEXT NOT NULL,
      description   TEXT,
      start_date    DATE NOT NULL,
      -- due_date je volitelný; pokud chybí, UI ho odvozuje z nejbližšího aktivního úkolu
      due_date      DATE,
      status        TEXT NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active','done','cancelled')),
      manager_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
      budget        REAL,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS tasks (
      id            SERIAL PRIMARY KEY,
      project_id    INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      parent_id     INTEGER REFERENCES tasks(id) ON DELETE CASCADE,
      title         TEXT NOT NULL,
      description   TEXT,
      assignee_id   INTEGER REFERENCES users(id) ON DELETE SET NULL,
      status        TEXT NOT NULL DEFAULT 'todo'
                    CHECK (status IN ('todo','in_progress','review','done')),
      priority      TEXT NOT NULL DEFAULT 'normal'
                    CHECK (priority IN ('low','normal','high','urgent')),
      estimated_h   REAL,
      due_date      DATE,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS time_entries (
      id            SERIAL PRIMARY KEY,
      user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      project_id    INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      task_id       INTEGER REFERENCES tasks(id) ON DELETE SET NULL,
      date          DATE NOT NULL,
      hours         REAL NOT NULL CHECK (hours > 0 AND hours <= 24),
      description   TEXT,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS questions (
      id            SERIAL PRIMARY KEY,
      task_id       INTEGER REFERENCES tasks(id) ON DELETE CASCADE,
      project_id    INTEGER REFERENCES projects(id) ON DELETE CASCADE,
      from_user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      to_user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      question      TEXT NOT NULL,
      answer        TEXT,
      status        TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','answered')),
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      answered_at   TIMESTAMPTZ
    );

    CREATE TABLE IF NOT EXISTS attachments (
      id            SERIAL PRIMARY KEY,
      task_id       INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      uploader_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      filename      TEXT NOT NULL,
      original_name TEXT NOT NULL,
      mime_type     TEXT NOT NULL,
      size          INTEGER NOT NULL,
      kind          TEXT NOT NULL CHECK (kind IN ('image','video','other')),
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS project_edits (
      id            SERIAL PRIMARY KEY,
      project_id    INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      action        TEXT NOT NULL DEFAULT 'update'    -- 'create' | 'update' | 'delete'
                    CHECK (action IN ('create','update','delete')),
      field         TEXT,                              -- u 'update' název změněného pole
      old_value     TEXT,
      new_value     TEXT,
      note          TEXT,                              -- volitelný komentář
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id);
    CREATE INDEX IF NOT EXISTS idx_tasks_parent  ON tasks(parent_id);
    CREATE INDEX IF NOT EXISTS idx_te_user_date  ON time_entries(user_id, date);
    CREATE INDEX IF NOT EXISTS idx_te_project    ON time_entries(project_id);
    CREATE INDEX IF NOT EXISTS idx_q_to_status   ON questions(to_user_id, status);
    CREATE INDEX IF NOT EXISTS idx_q_from        ON questions(from_user_id);
    CREATE INDEX IF NOT EXISTS idx_q_task        ON questions(task_id);
    CREATE INDEX IF NOT EXISTS idx_att_task      ON attachments(task_id);
    CREATE INDEX IF NOT EXISTS idx_pe_project    ON project_edits(project_id, created_at DESC);

    -- AI odhad času úkolu (idempotentní ALTER pro starší DB)
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                     WHERE table_name='tasks' AND column_name='ai_estimated_h') THEN
        ALTER TABLE tasks ADD COLUMN ai_estimated_h REAL;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                     WHERE table_name='tasks' AND column_name='ai_estimate_note') THEN
        ALTER TABLE tasks ADD COLUMN ai_estimate_note TEXT;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                     WHERE table_name='tasks' AND column_name='ai_estimate_status') THEN
        -- 'idle' | 'pending' | 'done' | 'error'
        ALTER TABLE tasks ADD COLUMN ai_estimate_status TEXT DEFAULT 'idle';
      END IF;
      IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                     WHERE table_name='tasks' AND column_name='ai_estimate_at') THEN
        ALTER TABLE tasks ADD COLUMN ai_estimate_at TIMESTAMPTZ;
      END IF;
    END $$;

    -- Odstranění už nepotřebného sloupce client u projektů (stavíme si sami pro sebe)
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name='projects' AND column_name='client') THEN
        ALTER TABLE projects DROP COLUMN client;
      END IF;
    END $$;

    -- Projekty mohou být bez termínu (odvodí se z aktivního úkolu, pokud existuje)
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name='projects' AND column_name='due_date' AND is_nullable = 'NO') THEN
        ALTER TABLE projects ALTER COLUMN due_date DROP NOT NULL;
      END IF;
    END $$;

    -- Přihlášení heslem + profil (idempotentní ALTER)
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                     WHERE table_name='users' AND column_name='password_hash') THEN
        ALTER TABLE users ADD COLUMN password_hash TEXT;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                     WHERE table_name='users' AND column_name='must_change_password') THEN
        ALTER TABLE users ADD COLUMN must_change_password BOOLEAN NOT NULL DEFAULT TRUE;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                     WHERE table_name='users' AND column_name='first_name') THEN
        ALTER TABLE users ADD COLUMN first_name TEXT;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                     WHERE table_name='users' AND column_name='last_name') THEN
        ALTER TABLE users ADD COLUMN last_name TEXT;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                     WHERE table_name='users' AND column_name='avatar_data') THEN
        ALTER TABLE users ADD COLUMN avatar_data BYTEA;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                     WHERE table_name='users' AND column_name='avatar_mime') THEN
        ALTER TABLE users ADD COLUMN avatar_mime TEXT;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                     WHERE table_name='users' AND column_name='avatar_updated_at') THEN
        ALTER TABLE users ADD COLUMN avatar_updated_at TIMESTAMPTZ;
      END IF;
    END $$;
  `);
  console.log('[db] PostgreSQL schéma připraveno');
}

// Post-migrace: pro existující uživatele bez password_hash / first_name nastav výchozí hodnoty.
// Idempotentní – běh proběhne při každém startu, ale upraví jen řádky, kde to dává smysl.
export async function backfillAuth() {
  // 1) Rozdělit `name` na first_name + last_name pro řádky, kde to chybí
  const missingName = await query(
    `SELECT id, name FROM users WHERE first_name IS NULL OR last_name IS NULL`
  );
  for (const u of missingName.rows) {
    const parts = String(u.name || '').trim().split(/\s+/);
    const first = parts.length > 0 ? parts[0] : '';
    const last  = parts.length > 1 ? parts.slice(1).join(' ') : '';
    await query(
      `UPDATE users SET first_name = COALESCE(first_name, $1), last_name = COALESCE(last_name, $2) WHERE id = $3`,
      [first, last, u.id]
    );
  }
  if (missingName.rows.length > 0) {
    console.log(`[db] backfill: rozděleno jméno u ${missingName.rows.length} uživatelů`);
  }

  // 2) Pro uživatele bez hesla nastav výchozí heslo + must_change_password
  const missingPwd = await query(`SELECT id FROM users WHERE password_hash IS NULL`);
  if (missingPwd.rows.length > 0) {
    const hash = await bcrypt.hash(DEFAULT_PASSWORD, PASSWORD_SALT_ROUNDS);
    for (const u of missingPwd.rows) {
      await query(
        `UPDATE users SET password_hash = $1, must_change_password = TRUE WHERE id = $2`,
        [hash, u.id]
      );
    }
    console.log(`[db] backfill: výchozí heslo nastaveno u ${missingPwd.rows.length} uživatelů (musí si změnit)`);
  }
}

// Provede migrate při importu (volá se v index.js)
export default { pool, query, migrate, backfillAuth };

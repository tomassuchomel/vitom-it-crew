-- AI klasifikace emailů (Phase 2a Email agent).
-- Per (user, message_id) — klasifikace je per-uživatel (různí lidi mohou kategorii vidět jinak)
-- a per Graph message ID.
--
-- category enum: task | question | fyi | answer_needed | spam | other
-- summary = 1 věta shrnutí (od AI), pomáhá rychle pochopit obsah bez otevření
-- Stored at: classified_at, source = 'auto' (batch) / 'manual' (user-triggered re-run)

CREATE TABLE IF NOT EXISTS email_classifications (
  user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  message_id     TEXT NOT NULL,
  category       TEXT NOT NULL,
  summary        TEXT,
  confidence     REAL,
  source         TEXT NOT NULL DEFAULT 'auto',
  classified_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, message_id)
);

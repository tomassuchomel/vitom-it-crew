-- 2026-05-21: Task review workflow
--
-- Workflow:
--   in_progress  → review        (programátor klikne "Předat k review")
--   review       → done          (manager schválí)
--   review       → needs_fix     (manager neschválí, napíše důvod, případně foto)
--   needs_fix    → in_progress   (programátor se vrátí k práci)
--
-- Tabulka task_reviews uchovává historii všech rozhodnutí managera
-- (kdo, kdy, verdict, komentář). Přílohy k rejectu používají existující
-- attachments tabulku (uploadují se přímo k taskId – nepotřebujeme review_id).
--
-- IDEMPOTENTNÍ: každý běh produkuje stejný výsledek. Drop+add CHECK constraint
-- s explicitním názvem 'tasks_status_check' je bezpečné – PostgreSQL stejně
-- auto-pojmenovává CHECK constraint pod tímto názvem (table_column_check).

-- 1) Rozšířit status CHECK constraint o 'needs_fix'
ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_status_check;
ALTER TABLE tasks ADD CONSTRAINT tasks_status_check
  CHECK (status IN ('todo','in_progress','review','done','needs_fix'));

-- 2) Tabulka pro historii reviews
CREATE TABLE IF NOT EXISTS task_reviews (
  id            SERIAL PRIMARY KEY,
  task_id       INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  reviewer_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  verdict       TEXT NOT NULL CHECK (verdict IN ('approved','rejected')),
  comment       TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_task_reviews_task    ON task_reviews(task_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_task_reviews_pending ON task_reviews(reviewer_id) WHERE verdict = 'rejected';

-- Žádosti o změnu termínu úkolu.
-- Když assignee (kdo nezadal úkol) chce posunout termín, vzniká pending žádost,
-- kterou schvaluje "zadavatel" úkolu (tasks.created_by, fallback manager projektu).
-- Reviewer může buď schválit s user's termínem, schválit s vlastním counter_due,
-- nebo zamítnout.
--
-- tasks.created_by: sloupec kdo zadal úkol. Backfill NULL; fallback logic = manager.

ALTER TABLE tasks ADD COLUMN IF NOT EXISTS created_by INTEGER REFERENCES users(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS task_due_change_requests (
  id             SERIAL PRIMARY KEY,
  task_id        INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  requester_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reviewer_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  original_due   DATE,
  requested_due  DATE NOT NULL,
  counter_due    DATE,
  requester_note TEXT,
  reviewer_note  TEXT,
  status         TEXT NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending','approved','rejected')),
  seen_by_requester BOOLEAN NOT NULL DEFAULT FALSE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at    TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_dcr_reviewer_pending
  ON task_due_change_requests(reviewer_id, status)
  WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_dcr_requester
  ON task_due_change_requests(requester_id, status);
CREATE INDEX IF NOT EXISTS idx_dcr_task
  ON task_due_change_requests(task_id);

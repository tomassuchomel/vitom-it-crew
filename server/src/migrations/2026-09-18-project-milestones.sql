-- Projektové milníky (sekce 4 zadání).
-- Projekt lze rozdělit na libovolný počet částí s vlastním termínem.
-- Celkový deadline projektu zůstává v projects.due_date — tohle ho nenahrazuje.

CREATE TABLE IF NOT EXISTS project_milestones (
  id          SERIAL PRIMARY KEY,
  project_id  INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  deadline    DATE,
  -- Pořadí v seznamu. Řadíme podle něj, ne podle termínu — milník bez data
  -- si tak drží místo, kam patří.
  position    INTEGER NOT NULL DEFAULT 0,
  -- Volitelná vazba na konkrétní úkol projektu. SET NULL: smazaný úkol
  -- milník nezruší, jen ho odpojí.
  task_id     INTEGER REFERENCES tasks(id) ON DELETE SET NULL,
  created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_project_milestones_project
  ON project_milestones(project_id, position);
CREATE INDEX IF NOT EXISTS idx_project_milestones_task
  ON project_milestones(task_id) WHERE task_id IS NOT NULL;

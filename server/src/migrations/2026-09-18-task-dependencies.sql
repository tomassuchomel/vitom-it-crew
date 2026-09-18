-- Závislosti mezi úkoly (sekce 15) + stav „Čekám na" (sekce 16).
--
-- Stejný vzor jako 2026-05-21: drop+add CHECK s explicitním názvem je
-- idempotentní, PostgreSQL ho tak jako tak pojmenuje 'tasks_status_check'.

-- 1) Nový stav úkolu 'waiting' = „Čekám na".
ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_status_check;
ALTER TABLE tasks ADD CONSTRAINT tasks_status_check
  CHECK (status IN ('todo','in_progress','review','done','needs_fix','waiting'));

-- 2) Na co/koho se čeká. Držíme u úkolu, ne ve zvláštní tabulce — je to
-- vždy nejvýš jeden aktuální důvod čekání, ne historie.
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS waiting_for TEXT;    -- na koho/na co
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS waiting_note TEXT;   -- upřesnění
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS waiting_until DATE;  -- kdy to připomenout

-- 3) Návaznosti: task_id ČEKÁ NA depends_on_id.
-- Obrácený směr („blokuje") je tentýž řádek čtený z druhé strany, proto
-- jedna tabulka a ne dvě.
CREATE TABLE IF NOT EXISTS task_dependencies (
  id             SERIAL PRIMARY KEY,
  task_id        INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  depends_on_id  INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  -- Úkol nemůže čekat sám na sebe a stejnou vazbu nemá smysl mít dvakrát.
  CONSTRAINT task_dependencies_no_self CHECK (task_id <> depends_on_id),
  CONSTRAINT task_dependencies_unique UNIQUE (task_id, depends_on_id)
);

CREATE INDEX IF NOT EXISTS idx_task_dependencies_task ON task_dependencies(task_id);
CREATE INDEX IF NOT EXISTS idx_task_dependencies_blocker ON task_dependencies(depends_on_id);

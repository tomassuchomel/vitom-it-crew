-- 2026-05-19: AI agent task fields
--
-- Rozšiřuje tabulku `tasks` o pole pro AI agenta (Claude), který bude úkoly
-- plánovat, implementovat a otevírat PR. Žádná existující logika se nemění.
--
-- Idempotence: `ADD COLUMN IF NOT EXISTS` (PG 9.6+). Soubor lze spustit opakovaně.
-- CHECK constrainty zabaleny do DO bloků, aby se daly přidat jen pokud chybí.

-- ai_assignee – je úkol pro Claude?
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS ai_assignee BOOLEAN NOT NULL DEFAULT FALSE;

-- execution_mode – auto (pustí se hned) | manual (čeká na schválení)
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS execution_mode TEXT NOT NULL DEFAULT 'manual';
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_name = 'tasks' AND constraint_name = 'tasks_execution_mode_check'
  ) THEN
    ALTER TABLE tasks
      ADD CONSTRAINT tasks_execution_mode_check
      CHECK (execution_mode IN ('auto', 'manual'));
  END IF;
END $$;

-- acceptance_criteria – JSON array stringů; co musí být splněno, aby AI úkol uzavřela
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS acceptance_criteria JSONB NOT NULL DEFAULT '[]'::jsonb;

-- out_of_scope – JSON array stringů; co Claude NESMÍ dělat
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS out_of_scope JSONB NOT NULL DEFAULT '[]'::jsonb;

-- scope_paths – JSON array stringů; povolené složky/soubory pro úpravu
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS scope_paths JSONB NOT NULL DEFAULT '[]'::jsonb;

-- iteration_count – kolikrát Claude proběhl review smyčku
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS iteration_count INTEGER NOT NULL DEFAULT 0;

-- max_iterations – horní limit na review smyčky; po překročení → needs_human
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS max_iterations INTEGER NOT NULL DEFAULT 3;

-- ai_status – životní cyklus AI agenta na tomto tasku
-- (nezaměňovat s ai_estimate_status, který je o jednorázovém AI odhadu času)
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS ai_status TEXT NOT NULL DEFAULT 'idle';
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_name = 'tasks' AND constraint_name = 'tasks_ai_status_check'
  ) THEN
    ALTER TABLE tasks
      ADD CONSTRAINT tasks_ai_status_check
      CHECK (ai_status IN (
        'idle','queued','planning','implementing','in_review',
        'needs_changes','done','failed','needs_human'
      ));
  END IF;
END $$;

-- ai_branch – název git branche, kterou si Claude vyrobil pro tenhle task
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS ai_branch TEXT;

-- ai_pr_url – odkaz na PR (GitHub) vytvořený Claude
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS ai_pr_url TEXT;

-- ai_cost_usd – nasčítané náklady (Anthropic tokeny) za tenhle task, v USD
-- NUMERIC(10,4) → max ~999,999.9999 USD, přesnost na desetinu centu
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS ai_cost_usd NUMERIC(10, 4) NOT NULL DEFAULT 0;

-- Užitečný index pro fronty AI agenta: rychlé filtrování "co teď čeká"
CREATE INDEX IF NOT EXISTS idx_tasks_ai_status ON tasks(ai_status)
  WHERE ai_assignee = TRUE;

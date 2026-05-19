-- 2026-05-19: AI agent activity log
--
-- Append-only log akcí agenta nad konkrétními tasky.
-- task_id váže záznam na tasks.id; FK CASCADE protože když mažeme task,
-- nemá smysl držet jeho historii.
--
-- details: volně strukturovaný JSON podle typu akce (worktree path, error,
-- transition from/to, …). cost_usd se přičítá do tasks.ai_cost_usd jen
-- pokud je relevantní (např. plánovací / implementační kroky).

CREATE TABLE IF NOT EXISTS ai_agent_activity (
  id            SERIAL PRIMARY KEY,
  task_id       INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  action        TEXT NOT NULL,
  details       JSONB NOT NULL DEFAULT '{}'::jsonb,
  cost_usd      NUMERIC(10, 4) NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_aaa_task ON ai_agent_activity(task_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_aaa_action_recent ON ai_agent_activity(action, created_at DESC);

-- Navazující úkol: nový úkol pokračuje v jiném (už hotovém) úkolu. Původní zůstane
-- 'done' (skóre nedotčené), nová práce se hodnotí samostatně s vlastním termínem.
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS continues_task_id INTEGER REFERENCES tasks(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_tasks_continues ON tasks(continues_task_id) WHERE continues_task_id IS NOT NULL;

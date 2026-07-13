-- Propojení úkolů z MZV zápisů. Jako meeting_id u porad — úkol vytažený
-- z konkrétního MZV zápisu má vazbu, aby ho ve fázi review zobrazil
-- v sekci „Úkoly z MZV" u daného pracovníka.

ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS mzv_meeting_id INT REFERENCES mzv_meetings(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_tasks_mzv_meeting ON tasks(mzv_meeting_id) WHERE mzv_meeting_id IS NOT NULL;

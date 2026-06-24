-- Propojení úkolů s poznámkou, ze které vznikly (přes AI suggest_tasks
-- nebo Quick Capture). Umožní v editoru poznámky zobrazit panel "Úkoly
-- z této poznámky" s 1:1 stavem.
--
-- ON DELETE SET NULL: smazání poznámky neudrop úkol, jen ho odpojí.
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS source_note_id INTEGER REFERENCES notes(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_tasks_source_note ON tasks(source_note_id) WHERE source_note_id IS NOT NULL;

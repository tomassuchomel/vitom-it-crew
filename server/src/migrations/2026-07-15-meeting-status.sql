-- Porady: zápisy mají životní cyklus (příprava → probíhá → uzavřeno).
-- Reopen = přechod zpět z 'completed' do 'draft' (jen organizer/admin).

ALTER TABLE meetings ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'draft'
  CHECK (status IN ('draft', 'in_progress', 'completed'));

CREATE INDEX IF NOT EXISTS idx_meetings_status ON meetings(status);

-- 2026-05-28: poznámky – osobní vs týmové (visibility)
--
-- visibility = 'team'     → vidí všichni členové teamu (default, zachová
--                           dosavadní chování)
-- visibility = 'personal' → vidí jen autor (user_id). Soukromé poznámky
--                           v rámci current teamu.
--
-- Podpoznámky dědí visibility rodiče (vynuceno v API). Strom je tedy buď
-- celý týmový, nebo celý osobní.

ALTER TABLE notes ADD COLUMN IF NOT EXISTS visibility TEXT NOT NULL DEFAULT 'team';

-- CHECK constraint (idempotentně)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'notes_visibility_check'
  ) THEN
    ALTER TABLE notes ADD CONSTRAINT notes_visibility_check
      CHECK (visibility IN ('team','personal'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_notes_visibility ON notes(team_id, visibility, user_id);

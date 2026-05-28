-- 2026-05-28: sdílení poznámek s jednotlivými uživateli
--
-- note_shares: poznámka (note_id) je sdílená s uživatelem (shared_with_user_id).
-- Příjemce ji uvidí v sekci „🔗 Sdílené" jako read-only. shared_by = kdo sdílel.
--
-- Sdílí se vždy jedna konkrétní poznámka (ne celý strom). Příjemce nemusí být
-- ve stejném teamu — sdílení překračuje hranice teamu (osobní gesto).

CREATE TABLE IF NOT EXISTS note_shares (
  note_id             INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  shared_with_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  shared_by           INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (note_id, shared_with_user_id)
);

CREATE INDEX IF NOT EXISTS idx_note_shares_user ON note_shares(shared_with_user_id);

-- 2026-05-28: Poznámky (notes) – hierarchická struktura (množina/podmnožina)
--
-- Strom: parent_id self-reference. Top-level poznámka má parent_id = NULL,
-- podpoznámky odkazují na rodiče. position řídí pořadí mezi sourozenci.
--
-- Team scoping: každá poznámka patří do jednoho teamu (team_id). Poznámky
-- jsou navržené tak, aby je v budoucnu mohl AI agent číst napříč a vytvářet
-- z nich úkoly (title + content jsou strukturovaný vstup; hierarchie dává
-- AI kontext "tohle je podúkol tamtoho").
--
-- user_id = autor poznámky (informativní, ON DELETE SET NULL — poznámka
-- přežije smazání autora).
--
-- ai_processed_at: až AI z poznámky vytvoří úkoly (Fáze 2), označí kdy.
-- NULL = ještě nezpracováno. Připraveno dopředu, ať nemusíme měnit schéma.

CREATE TABLE IF NOT EXISTS notes (
  id              SERIAL PRIMARY KEY,
  team_id         INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  parent_id       INTEGER REFERENCES notes(id) ON DELETE CASCADE,
  user_id         INTEGER REFERENCES users(id) ON DELETE SET NULL,
  title           TEXT NOT NULL DEFAULT 'Nová poznámka',
  content         TEXT,
  position        INTEGER NOT NULL DEFAULT 0,
  ai_processed_at TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_notes_team   ON notes(team_id);
CREATE INDEX IF NOT EXISTS idx_notes_parent ON notes(parent_id);

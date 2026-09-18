-- Nápadník — rozšíření (sekce 6, 7, 9, 12, 13 zadání).
-- Vše idempotentní a bezpečné pro existující data.

-- ---------------------------------------------------------------------------
-- 6) Zdroj nápadu + kdo ho založil interně.
-- Existující řádky vznikly veřejným formulářem → default 'public_form' sedí.
-- ---------------------------------------------------------------------------
ALTER TABLE ideas ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'public_form';
ALTER TABLE ideas ADD COLUMN IF NOT EXISTS created_by_id INTEGER REFERENCES users(id) ON DELETE SET NULL;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ideas_source_check') THEN
    ALTER TABLE ideas ADD CONSTRAINT ideas_source_check
      CHECK (source IN ('public_form', 'internal'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_ideas_source ON ideas(source);

-- ---------------------------------------------------------------------------
-- 12) Sloučení nápadů — kam byl nápad sloučen.
-- ---------------------------------------------------------------------------
ALTER TABLE ideas ADD COLUMN IF NOT EXISTS merged_into_id BIGINT REFERENCES ideas(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_ideas_merged_into ON ideas(merged_into_id) WHERE merged_into_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 7) Přílohy u nápadů. Sloupec attachments.idea_id už existuje (migrace
-- 2026-07-02), ale task_id je NOT NULL, takže příloha bez úkolu nejde uložit.
-- Uvolníme ho a hlídáme, že je vyplněná právě jedna vazba.
-- ---------------------------------------------------------------------------
ALTER TABLE attachments ALTER COLUMN task_id DROP NOT NULL;

DO $$ BEGIN
  -- FK na idea_id doplňujeme jen pokud chybí (db.js failsafe ho přidal bez FK).
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'attachments_idea_id_fkey') THEN
    ALTER TABLE attachments ADD CONSTRAINT attachments_idea_id_fkey
      FOREIGN KEY (idea_id) REFERENCES ideas(id) ON DELETE CASCADE;
  END IF;
  -- NOT VALID: constraint platí pro nové a měněné řádky, ale nevaliduje celou
  -- tabulku plnou BYTEA blobů. Kdyby v ní historicky byl řádek, který pravidlo
  -- porušuje, migrace by jinak shodila start serveru.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'attachments_owner_check') THEN
    ALTER TABLE attachments ADD CONSTRAINT attachments_owner_check
      CHECK ((task_id IS NOT NULL) <> (idea_id IS NOT NULL)) NOT VALID;
  END IF;
END $$;

-- Veřejný formulář nahrává bez přihlášení → uploader_id musí být volitelný.
ALTER TABLE attachments ALTER COLUMN uploader_id DROP NOT NULL;

-- ---------------------------------------------------------------------------
-- 13) Poznámky u nápadu — každá vlastní záznam (dřív jediné pole pm_note).
-- pm_note zůstává kvůli zpětné kompatibilitě, nemažeme ho.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS idea_notes (
  id          BIGSERIAL PRIMARY KEY,
  idea_id     BIGINT NOT NULL REFERENCES ideas(id) ON DELETE CASCADE,
  text        TEXT NOT NULL,
  author_id   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_idea_notes_idea ON idea_notes(idea_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- 9) Realizace nápadu úkolem. Na jeden nápad může viset víc úkolů, proto
-- vazební tabulka — nápad je Hotovo až když jsou hotové všechny realizace.
-- Vazba na projekt už existuje jako ideas.linked_project_id.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS idea_tasks (
  idea_id     BIGINT NOT NULL REFERENCES ideas(id) ON DELETE CASCADE,
  task_id     INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  PRIMARY KEY (idea_id, task_id)
);
CREATE INDEX IF NOT EXISTS idx_idea_tasks_task ON idea_tasks(task_id);

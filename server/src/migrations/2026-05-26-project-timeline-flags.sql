-- 2026-05-26: dva nové project flagy pro Timeline kontrolu
--
-- no_timeline:           projekt nemá časové ohraničení OD DO (start_date a
--                        due_date nejsou relevantní). Timeline zobrazí jako
--                        "běžící bez termínu" — jen součet hodin.
--                        Důsledek: start_date musí být nullable.
--
-- hidden_from_timeline:  projekt se v Timeline vůbec nezobrazí. Vhodné pro
--                        archivní, šablonové nebo neaktivní projekty,
--                        které admin nechce mazat, ale nechce v hlavním
--                        dashboardu.
--
-- Idempotentní (IF NOT EXISTS / DROP NOT NULL je no-op když už není NOT NULL).

ALTER TABLE projects ADD COLUMN IF NOT EXISTS no_timeline BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS hidden_from_timeline BOOLEAN NOT NULL DEFAULT FALSE;

-- start_date už nemusí být NOT NULL – uvolníme constraint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name='projects' AND column_name='start_date' AND is_nullable = 'NO') THEN
    ALTER TABLE projects ALTER COLUMN start_date DROP NOT NULL;
  END IF;
END $$;

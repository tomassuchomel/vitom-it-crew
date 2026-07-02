-- Skrytí hlavního úkolu (parent) pro řešitele podúkolu.
-- Use case: cross-team podúkol — Patricia dostane úkol z IT, přidá
-- podúkol pro svůj Management tým. Řešitel podúkolu nemá vidět,
-- z jakého parent úkolu podúkol vznikl (info leak z jiného týmu).
--
-- Default TRUE — bezpečná volba pro cross-team scenariá. Uvnitř týmu
-- (parent + subtask v jednom projektu) může admin/manager toggle při
-- vytváření vypnout.
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS parent_hidden BOOLEAN NOT NULL DEFAULT TRUE;

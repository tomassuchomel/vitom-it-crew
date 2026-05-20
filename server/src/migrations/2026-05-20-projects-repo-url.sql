-- 2026-05-20: projects.repo_url
--
-- Bez tohoto sloupce AI worker neví, který GitHub repository má clonovat
-- pro daný projekt. Vyžadováno pro každý projekt, který chce použít AI agenta.
--
-- Format: plná HTTPS URL, např. "https://github.com/owner/repo".
-- Validace na vstupu probíhá v API vrstvě.

ALTER TABLE projects ADD COLUMN IF NOT EXISTS repo_url TEXT;

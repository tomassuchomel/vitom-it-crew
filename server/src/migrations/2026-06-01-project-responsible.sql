-- Zodpovědná osoba za projekt — odpovídá za organizaci a běh, ale NESCHVALUJE
-- review (to zůstává `manager_id`). FK na users s ON DELETE SET NULL,
-- ať smazání usera neudrop projekt.
ALTER TABLE projects ADD COLUMN IF NOT EXISTS responsible_id INTEGER REFERENCES users(id) ON DELETE SET NULL;

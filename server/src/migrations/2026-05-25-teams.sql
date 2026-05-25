-- 2026-05-25: Multi-team support
--
-- Cíl: jedna instalace app slouží více teamům (IT, Management, …).
-- Každý projekt patří přesně jednomu teamu. User může být v N teamech,
-- v každém s jinou týmovou rolí (orthogonal k globální users.role).
--
-- Migrace je idempotentní (safe to re-run): používá CREATE IF NOT EXISTS,
-- ON CONFLICT DO NOTHING a guarded DO blocks.

-- ──────────────────────────────────────────────────────────────────────
-- 1) Schema: teams + team_members + projects.team_id
-- ──────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS teams (
  id          SERIAL PRIMARY KEY,
  name        TEXT NOT NULL,
  slug        TEXT NOT NULL UNIQUE,             -- 'it', 'management', …
  description TEXT,
  -- Feature flags per team. Příklad: {"ai_agent": true, "review_workflow": false}
  features    JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS team_members (
  team_id     INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Týmová role je nezávislá na globální users.role.
  -- Příklady: 'reditel', 'manager', 'lead', 'dev', 'member'.
  team_role   TEXT NOT NULL DEFAULT 'member',
  joined_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (team_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_team_members_user ON team_members(user_id);

-- Projekty patří přesně do jednoho teamu. Nullable během backfillu, NOT NULL po něm.
ALTER TABLE projects ADD COLUMN IF NOT EXISTS team_id INTEGER REFERENCES teams(id);

-- ──────────────────────────────────────────────────────────────────────
-- 2) Bootstrap "IT" team + přiřazení existujících dat
-- ──────────────────────────────────────────────────────────────────────

DO $$
DECLARE
  it_id INTEGER;
BEGIN
  INSERT INTO teams (name, slug, description, features)
  VALUES ('IT Crew', 'it', 'Tým vývoje a IT',
          '{"ai_agent": true, "review_workflow": true, "code_repo": true}'::jsonb)
  ON CONFLICT (slug) DO NOTHING;

  SELECT id INTO it_id FROM teams WHERE slug = 'it';

  -- Stávající projekty bez teamu → IT
  UPDATE projects SET team_id = it_id WHERE team_id IS NULL;

  -- Všichni stávající useři → členové IT teamu.
  -- Mapování globální role na týmovou roli v IT teamu:
  --   admin       → admin
  --   manager     → manager
  --   senior_dev  → lead
  --   external_dev→ dev
  INSERT INTO team_members (team_id, user_id, team_role)
  SELECT it_id, u.id,
    CASE u.role
      WHEN 'admin'        THEN 'admin'
      WHEN 'manager'      THEN 'manager'
      WHEN 'senior_dev'   THEN 'lead'
      WHEN 'external_dev' THEN 'dev'
      ELSE 'member'
    END
  FROM users u
  WHERE u.active = TRUE
  ON CONFLICT (team_id, user_id) DO NOTHING;
END $$;

-- Po backfillu projects.team_id NOT NULL
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name='projects' AND column_name='team_id' AND is_nullable = 'YES') THEN
    ALTER TABLE projects ALTER COLUMN team_id SET NOT NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_projects_team ON projects(team_id);

-- ──────────────────────────────────────────────────────────────────────
-- 3) Management team + uživatelé + jejich členství
-- ──────────────────────────────────────────────────────────────────────

INSERT INTO teams (name, slug, description, features)
VALUES ('Management', 'management', 'Vedení společnosti a project management',
        '{"ai_agent": false, "review_workflow": false, "code_repo": false}'::jsonb)
ON CONFLICT (slug) DO NOTHING;

-- Přejmenuj user #5 z "Radovan" na "Radovan Kočárník" – jeden a tentýž člověk,
-- jen pod plným jménem. Email radovan.koci@vitom.cz zůstává beze změny.
UPDATE users
  SET name = 'Radovan Kočárník', first_name = 'Radovan', last_name = 'Kočárník'
  WHERE email = 'radovan.koci@vitom.cz' AND name IN ('Radovan', 'Radovan ');

-- Noví uživatelé pro Management team.
-- must_change_password = TRUE → při prvním loginu si nastaví vlastní heslo.
-- password_hash zůstává NULL → backfillAuth() při startu serveru jim nastaví
-- výchozí (DEFAULT_PASSWORD = 'ITCrew23'). Po loginu si změní.
INSERT INTO users (email, name, first_name, last_name, role, hourly_rate, active, must_change_password)
VALUES
  ('martin.hron@vitom.cz',       'Martin Hron',       'Martin',   'Hron',     'manager', 0, true, true),
  ('veronika.sixtova@vitom.cz',  'Veronika Sixtová',  'Veronika', 'Sixtová',  'manager', 0, true, true),
  ('libor.kocarnik@vitom.cz',    'Libor Kočárník',    'Libor',    'Kočárník', 'manager', 0, true, true),
  ('patricia.geratova@vitom.cz', 'Patrícia Geratová', 'Patrícia', 'Geratová', 'manager', 0, true, true),
  ('viktor.mejzlik@vitom.cz',    'Viktor Mejzlík',    'Viktor',   'Mejzlík',  'manager', 0, true, true)
ON CONFLICT (email) DO NOTHING;

-- Přiřazení v Management teamu:
--   - reditel: tomas.suchomel@vitom.cz, viktor.mejzlik@vitom.cz
--   - manager: martin.hron, veronika.sixtova, libor.kocarnik, patricia.geratova, radovan.koci
DO $$
DECLARE
  mgmt_id INTEGER;
BEGIN
  SELECT id INTO mgmt_id FROM teams WHERE slug = 'management';

  -- Ředitelé
  INSERT INTO team_members (team_id, user_id, team_role)
  SELECT mgmt_id, u.id, 'reditel'
  FROM users u
  WHERE u.email IN ('tomas.suchomel@vitom.cz', 'viktor.mejzlik@vitom.cz')
  ON CONFLICT (team_id, user_id) DO UPDATE SET team_role = EXCLUDED.team_role;

  -- Manageři
  INSERT INTO team_members (team_id, user_id, team_role)
  SELECT mgmt_id, u.id, 'manager'
  FROM users u
  WHERE u.email IN (
    'martin.hron@vitom.cz',
    'veronika.sixtova@vitom.cz',
    'libor.kocarnik@vitom.cz',
    'patricia.geratova@vitom.cz',
    'radovan.koci@vitom.cz'
  )
  ON CONFLICT (team_id, user_id) DO UPDATE SET team_role = EXCLUDED.team_role;
END $$;

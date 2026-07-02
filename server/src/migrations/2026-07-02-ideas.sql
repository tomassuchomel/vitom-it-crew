-- Nápadník: sběr, řízení a schvalování interních návrhů (zlepšení, automatizace, AI).
-- Public form → wishlist → workflow (schvalování Management) → projekt.

CREATE TABLE IF NOT EXISTS ideas (
  id                          BIGSERIAL PRIMARY KEY,
  -- Kontakt navrhovatele
  proposer_name               TEXT NOT NULL,
  proposer_email              TEXT NOT NULL,
  -- Obsah nápadu
  title                       TEXT NOT NULL,
  department                  TEXT NOT NULL,
  category                    TEXT NOT NULL,
  problem_description         TEXT NOT NULL,
  solution_proposal           TEXT NOT NULL,
  impact_scope                TEXT,            -- dopad (počet lidí + frekvence)
  estimated_time_savings      TEXT,            -- odhad úspory času (volný text)
  external_link               TEXT,            -- volitelný odkaz
  -- Workflow
  state                       TEXT NOT NULL DEFAULT 'zadano',
  approval_without_analysis   BOOLEAN NOT NULL DEFAULT FALSE,  -- schváleno bez analýzy
  -- Metadata řízení
  priority                    TEXT DEFAULT 'normal',
  pm_recommendation           TEXT,            -- A / B / C / D
  garant_id                   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  pm_note                     TEXT,
  linked_project_id           INTEGER REFERENCES projects(id) ON DELETE SET NULL,
  linked_project_team_id      INTEGER REFERENCES teams(id) ON DELETE SET NULL,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ideas_state       ON ideas(state);
CREATE INDEX IF NOT EXISTS idx_ideas_garant      ON ideas(garant_id) WHERE garant_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ideas_department  ON ideas(department);

-- Události/audit log pro každou akci nad nápadem
-- action: state_change, comment, assign_garant, edit_pm_note, ...
CREATE TABLE IF NOT EXISTS idea_events (
  id           BIGSERIAL PRIMARY KEY,
  idea_id      BIGINT NOT NULL REFERENCES ideas(id) ON DELETE CASCADE,
  action       TEXT NOT NULL,
  from_state   TEXT,
  to_state     TEXT,
  comment      TEXT,
  user_id      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_idea_events_idea ON idea_events(idea_id, created_at);

-- Analýza dopadu a proveditelnosti (vyplňuje garant/Management ve stavu „čeká na analýzu")
CREATE TABLE IF NOT EXISTS idea_analysis (
  idea_id                   BIGINT PRIMARY KEY REFERENCES ideas(id) ON DELETE CASCADE,
  time_current_h_per_month  NUMERIC(10,2),
  time_after_h_per_month    NUMERIC(10,2),
  financial_savings         TEXT,
  internal_hourly_cost      TEXT,
  onetime_costs_kc          INTEGER,
  monthly_annual_costs      TEXT,
  target_date               TEXT,
  complexity                TEXT,   -- 'low' | 'medium' | 'high'
  dependencies              TEXT,
  risks                     TEXT,
  summary                   TEXT,
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Přílohy k nápadům: reuse existující attachments tabulky přes idea_id sloupec.
ALTER TABLE attachments ADD COLUMN IF NOT EXISTS idea_id BIGINT REFERENCES ideas(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_attachments_idea ON attachments(idea_id) WHERE idea_id IS NOT NULL;

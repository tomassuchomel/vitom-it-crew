-- MZV (Měsíční Zpětná Vazba) — manažer 1:1 s podřízeným, jednou měsíčně.
-- F1: profil pracovníka + zápis MZV. F2 přidá KPI hodnocení, F3 AI.

-- Profil pracovníka: 1:1 na users (subordinate). Slouží manažerovi jako "kdo to je,
-- kam směřuje". Radical Candor inspirace — kolonky pro motivaci, ambici, styl feedbacku.
CREATE TABLE IF NOT EXISTS mzv_profiles (
  user_id            INT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  birth_date         DATE,
  hire_date          DATE,
  children           JSONB DEFAULT '[]'::jsonb,       -- [{name, birth_date}]
  work_motivation    TEXT,                            -- proč pracuje, co peníze řeší
  life_goals         TEXT,                            -- osobní cíle
  career_direction   TEXT,                            -- kam v kariéře, co vyzkoušet
  ambition_type      TEXT,                            -- 'growth' (superstar) | 'stability' (rockstar) | NULL
  strengths          TEXT,                            -- silné stránky
  development_areas  TEXT,                            -- vývojové oblasti
  feedback_style     TEXT,                            -- preferovaný styl (přímý/jemný...)
  energy_sources     TEXT,                            -- co ho nabíjí / vyčerpává
  personal_context   TEXT,                            -- aktuální osobní kontext
  feedback_history   TEXT,                            -- shrnutí opakovaných témat
  kpi_sections       JSONB DEFAULT '[]'::jsonb,       -- 5 slotů: [{name, description}]
  created_by         INT REFERENCES users(id) ON DELETE SET NULL,
  created_at         TIMESTAMPTZ DEFAULT NOW(),
  updated_at         TIMESTAMPTZ DEFAULT NOW()
);

-- MZV zápisy. subordinate_id = kdo dostává, manager_id = kdo dělá.
-- Sdílená část (rozhovor + priorities + to_improve + to_continue) vidí i subordinate;
-- kpi_ratings + manager_notes jsou POUZE pro managera.
CREATE TABLE IF NOT EXISTS mzv_meetings (
  id             SERIAL PRIMARY KEY,
  subordinate_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  manager_id     INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  meeting_date   DATE NOT NULL DEFAULT CURRENT_DATE,
  status         TEXT NOT NULL DEFAULT 'draft',       -- 'draft' | 'completed'
  rozhovor       TEXT DEFAULT '',                     -- volný text
  priorities     TEXT DEFAULT '',                     -- priority na další období
  to_improve     TEXT DEFAULT '',                     -- co zlepšit
  to_continue    TEXT DEFAULT '',                     -- v čem pokračovat
  kpi_ratings    JSONB DEFAULT '[]'::jsonb,           -- [{rating: 1-5, comment}] — manager only
  manager_notes  TEXT DEFAULT '',                     -- privátní poznámky managera
  created_by     INT REFERENCES users(id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ DEFAULT NOW(),
  updated_at     TIMESTAMPTZ DEFAULT NOW(),
  completed_at   TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_mzv_meetings_subordinate ON mzv_meetings(subordinate_id, meeting_date DESC);
CREATE INDEX IF NOT EXISTS idx_mzv_meetings_manager ON mzv_meetings(manager_id, meeting_date DESC);

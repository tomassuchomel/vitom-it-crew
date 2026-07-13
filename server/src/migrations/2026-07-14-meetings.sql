-- Porady: sekce pro pravidelné schůzky/porady.
-- Struktura: typ porady ("středeční porada IT") → jednotlivé zápisy s datem.
-- Editor Tiptap JSON (jako Poznámky). Prezence: členové týmu (checkbox) + guest s emailem.

-- Typ porady: kostra pro pravidelné porady. Šéf (organizer) je odpovědný za agendu.
CREATE TABLE IF NOT EXISTS meeting_types (
  id                SERIAL PRIMARY KEY,
  team_id           INTEGER REFERENCES teams(id) ON DELETE CASCADE,
  name              TEXT NOT NULL,
  description       TEXT,
  agenda_template   JSONB NOT NULL DEFAULT '[]'::jsonb,  -- array of {text}
  visibility        TEXT NOT NULL DEFAULT 'team'
                    CHECK (visibility IN ('team', 'custom')),
  custom_users      JSONB NOT NULL DEFAULT '[]'::jsonb,  -- array of user_id (when visibility='custom')
  organizer_id      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_by        INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_meeting_types_team ON meeting_types(team_id);
CREATE INDEX IF NOT EXISTS idx_meeting_types_organizer ON meeting_types(organizer_id);

-- Jednotlivý zápis. content_json = Tiptap dokument (jako v notes).
-- attendees = pole {user_id?, guest_name?, guest_email?, present:bool}.
CREATE TABLE IF NOT EXISTS meetings (
  id                    SERIAL PRIMARY KEY,
  type_id               INTEGER NOT NULL REFERENCES meeting_types(id) ON DELETE CASCADE,
  title                 TEXT NOT NULL,
  meeting_date          DATE,               -- kdy se koná/konala; NULL = nedatováno
  meeting_time          TEXT,               -- HH:MM (informativní, ne pro cron)
  agenda                JSONB NOT NULL DEFAULT '[]'::jsonb, -- array of {text, checked, source:'template'|'ai'|'user'}
  agenda_finalized_at   TIMESTAMPTZ,        -- kdy byla agenda schválena šéfem (nebo AI auto)
  agenda_source         TEXT,               -- 'organizer' | 'ai_auto'
  content_json          JSONB NOT NULL DEFAULT '{"type":"doc","content":[]}'::jsonb,
  attendees             JSONB NOT NULL DEFAULT '[]'::jsonb,
  followed_up_at        TIMESTAMPTZ,        -- kdy byl poslán follow-up mail
  is_locked             BOOLEAN NOT NULL DEFAULT FALSE,
  created_by            INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_meetings_type ON meetings(type_id, meeting_date DESC);
CREATE INDEX IF NOT EXISTS idx_meetings_date_pending ON meetings(meeting_date)
  WHERE agenda_finalized_at IS NULL;

-- Audit log editací zápisu. Před uložením ukládáme snapshot rozdílu.
CREATE TABLE IF NOT EXISTS meeting_edits (
  id             SERIAL PRIMARY KEY,
  meeting_id     INTEGER NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  editor_id      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  change_type    TEXT NOT NULL,   -- 'notes' | 'agenda' | 'attendees' | 'title' | 'date'
  before_value   JSONB,
  after_value    JSONB,
  edited_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_meeting_edits_meeting ON meeting_edits(meeting_id, edited_at DESC);

-- Propojení úkolů se zápisem porady (pro follow-up mail — jaké úkoly kdo z porady dostal).
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS meeting_id INTEGER REFERENCES meetings(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_tasks_meeting ON tasks(meeting_id) WHERE meeting_id IS NOT NULL;

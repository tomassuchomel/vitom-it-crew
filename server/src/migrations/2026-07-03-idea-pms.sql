-- Role „PM Nápadníku" — user, který sleduje/vyhodnocuje/reportuje Nápadník,
-- ale NEschvaluje (to zůstává Managementu). Přiřazuje jen admin.

CREATE TABLE IF NOT EXISTS idea_pms (
  user_id      INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  assigned_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  assigned_by  INTEGER REFERENCES users(id) ON DELETE SET NULL
);

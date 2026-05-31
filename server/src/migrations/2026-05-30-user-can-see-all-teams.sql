-- Per-user flag pro executive AI coach napříč všemi týmy.
-- True = user vidí v AI Coach toggle „Tento tým / Celá firma".
-- Default FALSE — uživatel vidí jen svůj currently-selected team.
--
-- Backfill: globální admini + ředitelé (tomas.suchomel + viktor.mejzlik per zadání).
ALTER TABLE users ADD COLUMN IF NOT EXISTS can_see_all_teams BOOLEAN NOT NULL DEFAULT FALSE;

UPDATE users SET can_see_all_teams = TRUE
  WHERE role = 'admin'
     OR email IN ('tomas.suchomel@vitom.cz', 'viktor.mejzlik@vitom.cz');

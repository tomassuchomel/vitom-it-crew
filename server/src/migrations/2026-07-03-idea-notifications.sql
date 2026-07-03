-- Nápadník F4: 3 nové notification prefs pro Nápadník.
-- Idempotent — bezpečné re-run.

ALTER TABLE user_notification_prefs
  ADD COLUMN IF NOT EXISTS email_idea_new              BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS email_idea_approved         BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS email_idea_assigned_garant  BOOLEAN NOT NULL DEFAULT TRUE;

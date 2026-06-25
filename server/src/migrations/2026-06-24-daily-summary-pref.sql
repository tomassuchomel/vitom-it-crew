-- Nový opt-in: denní email shrnutí ("reminder asistent")
-- Default TRUE — user si vypne, pokud nechce.
ALTER TABLE user_notification_prefs
  ADD COLUMN IF NOT EXISTS email_daily_summary BOOLEAN NOT NULL DEFAULT TRUE;

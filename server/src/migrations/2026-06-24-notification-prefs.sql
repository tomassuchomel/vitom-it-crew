-- Per-user email notification preferences.
-- Booleans per event type, default TRUE (opt-out). User si vypne, co nechce.
CREATE TABLE IF NOT EXISTS user_notification_prefs (
  user_id              INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  email_task_assigned  BOOLEAN NOT NULL DEFAULT TRUE,
  email_task_returned  BOOLEAN NOT NULL DEFAULT TRUE,
  email_task_approved  BOOLEAN NOT NULL DEFAULT TRUE,
  email_new_question   BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

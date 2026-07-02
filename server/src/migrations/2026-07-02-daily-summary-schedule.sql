-- Per-user rozvrh denního emailového shrnutí.
--   daily_summary_days: JSON array [0-6] kde 0=neděle ... 6=sobota (výchozí PO-PA)
--   daily_summary_time: HH:MM string (výchozí 08:05 Prague)
--
-- Cron kontroluje per user, jestli je dnes v jeho dnech + v ±5 min okně jeho času.
ALTER TABLE user_notification_prefs
  ADD COLUMN IF NOT EXISTS daily_summary_days JSONB NOT NULL DEFAULT '[1,2,3,4,5]'::jsonb,
  ADD COLUMN IF NOT EXISTS daily_summary_time TEXT NOT NULL DEFAULT '08:05';

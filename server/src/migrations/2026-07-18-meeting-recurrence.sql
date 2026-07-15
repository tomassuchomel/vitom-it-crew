-- Opakovaná porada: typ může mít pravidelný den v týdnu + čas.
-- Když se porada uzavře (transition → completed), automaticky se vygeneruje
-- další zápis na příští weekday (day-of-week 0=neděle .. 6=sobota, standard JS).

ALTER TABLE meeting_types
  ADD COLUMN IF NOT EXISTS is_recurring       BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS recurrence_weekday INT,          -- 0-6 (JS Date.getDay)
  ADD COLUMN IF NOT EXISTS recurrence_time    TIME;         -- HH:MM

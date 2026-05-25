-- 2026-05-25: zapnutí timeline_forecast feature v IT teamu
--
-- timeline_forecast = na Gantt chart se přidá další tenká linka,
-- která začíná NOW a její délka = sum(estimated_h pro nedokončené úkoly) / 8 h.
-- Pokud přesahuje deadline projektu, je červená — upozornění na overcommit.
-- Idempotentní (UPDATE … || jsonb).

UPDATE teams
  SET features = features || '{"timeline_forecast": true}'::jsonb
  WHERE slug = 'it';

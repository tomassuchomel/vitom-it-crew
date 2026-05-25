-- 2026-05-25: zapnutí success_metrics feature v Management teamu
--
-- Idempotentní – feature klíč přidá/přepíše na true. Ostatní features
-- (ai_agent, review_workflow, code_repo) zachovává.
-- Když je tento flag zapnutý, frontend ukáže polozku "Skóre" v sidebaru
-- (stránka /scoreboard se per-user statistikou plnění úkolů v termínu).

UPDATE teams
  SET features = features || '{"success_metrics": true}'::jsonb
  WHERE slug = 'management';

-- Cleanup: existující týmy bez team_roles dostávají sane default.
-- Bez tohohle nový tým (např. „design") nemá v Admin UI žádné role v dropdownu.
-- Patrné z předchozí verze POST /teams, která nezakládala features.team_roles.
UPDATE teams
  SET features = features || '{"team_roles": {"admin": "Admin", "manager": "Manager", "member": "Člen"}}'::jsonb
  WHERE features ->> 'team_roles' IS NULL;

-- Cleanup: globální admini, kteří byli creator teamu, ale nestali se jeho členy
-- (předchozí POST /teams je nepřidal automaticky). Bez tohohle vidí ghost team
-- ve switcher, ale po přepnutí spadnou na default team.
--
-- Heuristika: pokud team nemá ŽÁDNÉHO admina (team_role='admin'), přidáme
-- všechny globální adminy (users.role='admin' a active=TRUE). Bezpečné, protože
-- globální admin má stejně přístup ke všemu přes user.role check v ostatních
-- route handlerech.
INSERT INTO team_members (team_id, user_id, team_role)
SELECT t.id, u.id, 'admin'
FROM teams t
CROSS JOIN users u
WHERE u.role = 'admin' AND u.active = TRUE
  AND NOT EXISTS (
    SELECT 1 FROM team_members tm WHERE tm.team_id = t.id AND tm.user_id = u.id
  )
  AND NOT EXISTS (
    SELECT 1 FROM team_members tm WHERE tm.team_id = t.id AND tm.team_role = 'admin'
  )
ON CONFLICT (team_id, user_id) DO NOTHING;

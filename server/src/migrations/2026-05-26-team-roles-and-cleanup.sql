-- 2026-05-26: Per-team role enum + cleanup IT memberships
--
-- Část 1 — CLEANUP: Migrace 2026-05-25-teams.sql měla bug — IT bootstrap
-- na re-run přidával NOVÉ uživatele (Mgmt-only: Martin Hron, Veronika
-- Sixtová, Libor Kočárník, Patrícia Geratová, Viktor Mejzlík) i do IT
-- teamu, pokud byli active. Důsledek: tihle lidé se objevovali ve výpisech
-- IT teamu (assignee dropdown atd.), což user nechtěl. Bug v původní
-- migraci je už opraven (přidána NOT EXISTS klauzule), ale data je třeba
-- ručně srovnat.
--
-- Radovana Kočárníka (#5) ponechat v IT — tam patřil odjakživa. Smažeme
-- jen těch 5 lidí, kteří byli přidáni do Managementu a do IT nepatří.
DELETE FROM team_members
WHERE team_id = (SELECT id FROM teams WHERE slug = 'it')
  AND user_id IN (
    SELECT u.id FROM users u
    WHERE u.email IN (
      'martin.hron@vitom.cz',
      'veronika.sixtova@vitom.cz',
      'libor.kocarnik@vitom.cz',
      'patricia.geratova@vitom.cz',
      'viktor.mejzlik@vitom.cz'
    )
  );

-- Část 2 — TEAM-SPECIFIC ROLES: každý team má teď definovaný enum povolených
-- týmových rolí v features.team_roles. Mapa { role_key: human_label }.
-- Backend validuje team_role proti tomuto seznamu při add/edit memberu.
-- Frontend Admin renderuje dropdown místo free-text inputu.
--
-- IT team má 4 role: admin, lead, dev, manager (odpovídá mapování z bootstrapu).
-- Management má jen 2: ředitel a manager (per zadání).
UPDATE teams
  SET features = features || '{"team_roles": {"admin": "Admin", "lead": "Lead programátor", "dev": "Programátor", "manager": "Manager"}}'::jsonb
  WHERE slug = 'it';

UPDATE teams
  SET features = features || '{"team_roles": {"reditel": "Ředitel", "manager": "Manager"}}'::jsonb
  WHERE slug = 'management';

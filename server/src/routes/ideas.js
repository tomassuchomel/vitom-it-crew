// Nápadník — sběr, řízení a schvalování interních návrhů.
// Fáze 1: schema + veřejný form + wishlist tabulka. Workflow tranzice
// (Fáze 2), analýza (F3), dashboard (F4), export + Turnstile (F5).

import express from 'express';
import { requireAuth } from '../auth.js';
import { query } from '../db.js';

const router = express.Router();

// Povolené hodnoty enumu — validace před INSERT (defenzivně, kdyby
// klient poslal blbost).
const DEPARTMENTS = [
  'Management', 'Zákaznický servis a backoffice', 'Obchod',
  'Technické služby', 'Účetnictví a finance', 'Marketing', 'HR',
  'IT / Digitalizace', 'Jiné',
];
const CATEGORIES = [
  'Automatizace rutinní práce', 'AI využití', 'Reporting a data',
  'Zákaznický servis', 'Obchod a leady', 'Technické služby',
  'Účetnictví a finance', 'Dokumenty a smlouvy', 'Procesní změna',
  'Integrace systémů', 'Gina',
];
const VALID_STATES = [
  'zadano', 'ke_schvaleni', 'schvaleno_ceka_na_analyzu',
  'ke_schvaleni_analyzy', 'schvalena_analyza', 'rozpracovano',
  'hotovo', 'zamitnuto', 'odlozeno',
];

// Public endpoint: veřejný formulář, bez autentizace.
// Vytvoří nový nápad ve stavu 'zadano'.
// Fáze 5 přidá Turnstile check.
router.post('/public', async (req, res) => {
  const b = req.body || {};
  // Validace povinných polí
  const errors = {};
  const trim = (v) => String(v || '').trim();
  if (!trim(b.proposer_name)) errors.proposer_name = 'Vyplň jméno.';
  if (!/^[^@]+@[^@]+\.[a-z]{2,}$/i.test(trim(b.proposer_email))) errors.proposer_email = 'Vyplň platný e-mail.';
  if (!trim(b.title)) errors.title = 'Vyplň název nápadu.';
  if (!DEPARTMENTS.includes(trim(b.department))) errors.department = 'Vyber oddělení.';
  if (!CATEGORIES.includes(trim(b.category))) errors.category = 'Vyber kategorii.';
  if (!trim(b.problem_description)) errors.problem_description = 'Popiš problém.';
  if (!trim(b.solution_proposal)) errors.solution_proposal = 'Navrhni řešení.';
  if (Object.keys(errors).length > 0) {
    return res.status(400).json({ error: 'validation', fields: errors });
  }

  const r = await query(`
    INSERT INTO ideas (
      proposer_name, proposer_email, title, department, category,
      problem_description, solution_proposal, impact_scope,
      estimated_time_savings, external_link
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
    RETURNING id, created_at
  `, [
    trim(b.proposer_name), trim(b.proposer_email), trim(b.title),
    trim(b.department), trim(b.category),
    trim(b.problem_description), trim(b.solution_proposal),
    trim(b.impact_scope) || null,
    trim(b.estimated_time_savings) || null,
    trim(b.external_link) || null,
  ]);
  // Log event
  await query(`
    INSERT INTO idea_events (idea_id, action, to_state, comment)
    VALUES ($1, 'created', 'zadano', $2)
  `, [r.rows[0].id, `Podal ${trim(b.proposer_name)} přes veřejný formulář.`]);
  res.status(201).json({ ok: true, id: r.rows[0].id });
});

// SELECT s garantem + linked project — společný pro list i detail.
const SELECT_FULL = `
  SELECT i.*,
    gu.name AS garant_name,
    lp.name AS linked_project_name,
    lt.name AS linked_project_team_name
  FROM ideas i
  LEFT JOIN users gu ON gu.id = i.garant_id
  LEFT JOIN projects lp ON lp.id = i.linked_project_id
  LEFT JOIN teams lt ON lt.id = i.linked_project_team_id
`;

// Auth endpoint: seznam všech nápadů (interní wishlist).
router.get('/', requireAuth, async (req, res) => {
  const r = await query(`${SELECT_FULL} ORDER BY i.created_at DESC`);
  res.json({ ideas: r.rows });
});

// Auth endpoint: detail 1 nápadu.
router.get('/:id', requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  const r = await query(`${SELECT_FULL} WHERE i.id = $1`, [id]);
  if (r.rows.length === 0) return res.status(404).json({ error: 'not_found' });
  // Analýza + events
  const [analysisR, eventsR] = await Promise.all([
    query('SELECT * FROM idea_analysis WHERE idea_id = $1', [id]),
    query(`
      SELECT ie.*, u.name AS user_name
      FROM idea_events ie
      LEFT JOIN users u ON u.id = ie.user_id
      WHERE ie.idea_id = $1
      ORDER BY ie.created_at DESC
    `, [id]),
  ]);
  res.json({
    idea: r.rows[0],
    analysis: analysisR.rows[0] || null,
    events: eventsR.rows,
  });
});

// PATCH: edituje běžná manažerská pole (garant, priorita, doporučení PM,
// poznámka PM). Fáze 2 přidá state change.
router.patch('/:id', requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  const b = req.body || {};
  const sets = [];
  const params = [];
  const push = (col, val) => { params.push(val); sets.push(`${col} = $${params.length}`); };

  if ('garant_id' in b)         push('garant_id', b.garant_id ? Number(b.garant_id) : null);
  if ('priority' in b)          push('priority', b.priority || 'normal');
  if ('pm_recommendation' in b) push('pm_recommendation', b.pm_recommendation || null);
  if ('pm_note' in b)           push('pm_note', b.pm_note || null);

  if (sets.length === 0) return res.status(400).json({ error: 'no_fields' });
  sets.push(`updated_at = NOW()`);
  params.push(id);
  await query(`UPDATE ideas SET ${sets.join(', ')} WHERE id = $${params.length}`, params);

  // Log každou změnu jako event (jednoduše, hromadně)
  await query(`
    INSERT INTO idea_events (idea_id, action, user_id, comment)
    VALUES ($1, 'edit', $2, $3)
  `, [id, req.user.id, JSON.stringify(b).slice(0, 500)]);

  const r = await query(`${SELECT_FULL} WHERE i.id = $1`, [id]);
  res.json({ idea: r.rows[0] });
});

// Meta: pro klienta — dropdowny (oddělení, kategorie, stavy)
router.get('/_meta/enums', async (req, res) => {
  res.json({ departments: DEPARTMENTS, categories: CATEGORIES, states: VALID_STATES });
});

export default router;

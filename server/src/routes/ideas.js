// Nápadník — sběr, řízení a schvalování interních návrhů.
// Fáze 2: workflow tranzice + komentáře + role check + Vytvořit projekt.

import express from 'express';
import { requireAuth } from '../auth.js';
import { query } from '../db.js';

const router = express.Router();

// Management role = admin globálně NEBO člen týmu se slug='management'.
async function isManagement(userId, userRole) {
  if (userRole === 'admin') return true;
  const r = await query(
    `SELECT 1 FROM team_members tm JOIN teams t ON t.id = tm.team_id
     WHERE tm.user_id = $1 AND t.slug = 'management' LIMIT 1`,
    [userId]
  );
  return r.rows.length > 0;
}

// Workflow graf — z jakého stavu jsou povolené jaké přechody + kdo je smí provést.
// role: 'management' (jen Management), 'garant' (jen přiřazený garant),
//       'garant_or_management' (obojí).
const TRANSITIONS = {
  zadano: [
    { to: 'ke_schvaleni',              action: 'Poslat ke schválení',    role: 'garant_or_management', requireGarant: true,  requireComment: false },
  ],
  ke_schvaleni: [
    { to: 'schvaleno_ceka_na_analyzu', action: 'Schválit → analýza',      role: 'management',           requireComment: true },
    { to: 'schvalena_analyza',         action: 'Schválit bez analýzy',    role: 'management',           requireComment: true, markSkippedAnalysis: true },
    { to: 'zamitnuto',                 action: 'Zamítnout',               role: 'management',           requireComment: true },
    { to: 'odlozeno',                  action: 'Odložit',                 role: 'management',           requireComment: true },
  ],
  schvaleno_ceka_na_analyzu: [
    { to: 'ke_schvaleni_analyzy',      action: 'Analýza hotová',          role: 'garant_or_management', requireComment: false },
  ],
  ke_schvaleni_analyzy: [
    { to: 'schvalena_analyza',         action: 'Schválit analýzu',        role: 'management',           requireComment: true },
    { to: 'zamitnuto',                 action: 'Zamítnout',               role: 'management',           requireComment: true },
    { to: 'odlozeno',                  action: 'Odložit',                 role: 'management',           requireComment: true },
  ],
  schvalena_analyza: [
    // "Vytvořit projekt" má samostatný endpoint /create-project (vyžaduje team + název)
  ],
  rozpracovano: [
    { to: 'hotovo',                    action: 'Dokončit',                role: 'garant_or_management', requireComment: false },
  ],
  odlozeno: [
    { to: 'ke_schvaleni',              action: 'Obnovit',                 role: 'garant_or_management', requireComment: false },
  ],
  hotovo:    [],
  zamitnuto: [],
};

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

// Vrátí povolené přechody pro nápad + kdo je smí provést (per current user).
// FE volá pro render workflow tlačítek.
router.get('/:id/transitions', requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  const r = await query(`SELECT id, state, garant_id FROM ideas WHERE id = $1`, [id]);
  if (r.rows.length === 0) return res.status(404).json({ error: 'not_found' });
  const idea = r.rows[0];
  const mgr = await isManagement(req.user.id, req.user.role);
  const isGarant = idea.garant_id && idea.garant_id === req.user.id;
  const available = (TRANSITIONS[idea.state] || []).map(t => {
    let allowed = false;
    if (t.role === 'management') allowed = mgr;
    else if (t.role === 'garant') allowed = isGarant;
    else if (t.role === 'garant_or_management') allowed = mgr || isGarant;
    if (t.requireGarant && !idea.garant_id) allowed = false;
    return { to: t.to, action: t.action, requireComment: !!t.requireComment, allowed };
  });
  // Speciální akce: Vytvořit projekt (jen ve stavu schvalena_analyza, jen garant)
  if (idea.state === 'schvalena_analyza' && isGarant) {
    available.push({ to: 'rozpracovano', action: 'Vytvořit projekt', requireComment: false, allowed: true, special: 'create_project' });
  }
  res.json({ state: idea.state, transitions: available, isManagement: mgr, isGarant });
});

// Provede state transition. Body: { to_state, comment }
router.post('/:id/state', requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  const b = req.body || {};
  const toState = String(b.to_state || '').trim();
  const comment = b.comment ? String(b.comment).trim().slice(0, 5000) : null;

  const r = await query(`SELECT * FROM ideas WHERE id = $1`, [id]);
  if (r.rows.length === 0) return res.status(404).json({ error: 'not_found' });
  const idea = r.rows[0];

  const allowed = (TRANSITIONS[idea.state] || []).find(t => t.to === toState);
  if (!allowed) return res.status(400).json({ error: 'invalid_transition', from: idea.state, to: toState });

  // Autorizace
  const mgr = await isManagement(req.user.id, req.user.role);
  const isGarant = idea.garant_id && idea.garant_id === req.user.id;
  const canDo =
    (allowed.role === 'management' && mgr) ||
    (allowed.role === 'garant' && isGarant) ||
    (allowed.role === 'garant_or_management' && (mgr || isGarant));
  if (!canDo) return res.status(403).json({ error: 'forbidden', message: 'Tuhle akci nemáš oprávnění provést.' });

  // Vyžadovaný komentář (Management akce)
  if (allowed.requireComment && !comment) {
    return res.status(400).json({ error: 'comment_required', message: 'K téhle akci prosím napiš komentář.' });
  }
  // Vyžadovaný garant (pro „Poslat ke schválení")
  if (allowed.requireGarant && !idea.garant_id) {
    return res.status(400).json({ error: 'garant_required', message: 'Nejdřív přiřaď garanta.' });
  }

  // Update state. Kdo a kdy akci provedl je v idea_events — duplikovat
  // do ideas nemá smysl pro F2. Až F4 dashboard bude chtít rychlý sort
  // podle "kdy schváleno", přidám sloupce migrací.
  await query(
    `UPDATE ideas SET state = $1, updated_at = NOW() WHERE id = $2`,
    [toState, id]
  );

  await query(`
    INSERT INTO idea_events (idea_id, action, from_state, to_state, user_id, comment)
    VALUES ($1, $2, $3, $4, $5, $6)
  `, [id, 'state_change', idea.state, toState, req.user.id, comment]);

  const out = await query(`${SELECT_FULL} WHERE i.id = $1`, [id]);
  res.json({ idea: out.rows[0] });
});

// Speciální akce: Vytvořit reálný projekt z nápadu.
// Přechází state schvalena_analyza → rozpracovano + vytvoří projekt
// v cílovém týmu + linked_project_id na nápadu.
// Jen garant nápadu.
router.post('/:id/create-project', requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  const b = req.body || {};
  const teamId = Number(b.team_id);
  const projectName = String(b.name || '').trim();
  if (!Number.isInteger(teamId) || teamId <= 0) return res.status(400).json({ error: 'team_required' });
  if (!projectName) return res.status(400).json({ error: 'name_required' });

  const r = await query(`SELECT * FROM ideas WHERE id = $1`, [id]);
  if (r.rows.length === 0) return res.status(404).json({ error: 'not_found' });
  const idea = r.rows[0];
  if (idea.state !== 'schvalena_analyza') return res.status(400).json({ error: 'invalid_state', message: 'Projekt lze vytvořit jen po schválení analýzy.' });
  const isGarant = idea.garant_id && idea.garant_id === req.user.id;
  if (!isGarant) return res.status(403).json({ error: 'forbidden', message: 'Projekt může založit jen garant nápadu.' });

  // Ověř členství v cílovém týmu (nepovolíme založit projekt v týmu, kde nejsme)
  const memb = await query(`SELECT 1 FROM team_members WHERE user_id = $1 AND team_id = $2 LIMIT 1`, [req.user.id, teamId]);
  if (memb.rows.length === 0 && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'not_team_member', message: 'V tomto týmu nejsi členem.' });
  }

  // Vytvoř projekt — manager = garant, zodpovědnost = garant, start dnes.
  // Projekt bez pevného timeline (no_timeline) — bude viditelný v Projektech,
  // datum si nastaví garant sám.
  const proj = await query(`
    INSERT INTO projects (name, description, start_date, team_id, manager_id, responsible_id, no_timeline)
    VALUES ($1, $2, CURRENT_DATE, $3, $4, $4, TRUE)
    RETURNING id, name, team_id
  `, [projectName, idea.solution_proposal || idea.problem_description || null, teamId, req.user.id]);

  // Propoj nápad → projekt + posun state
  await query(`
    UPDATE ideas
    SET state = 'rozpracovano', linked_project_id = $1, linked_project_team_id = $2, updated_at = NOW()
    WHERE id = $3
  `, [proj.rows[0].id, teamId, id]);

  await query(`
    INSERT INTO idea_events (idea_id, action, from_state, to_state, user_id, comment)
    VALUES ($1, 'create_project', $2, 'rozpracovano', $3, $4)
  `, [id, idea.state, req.user.id, `Založen projekt „${projectName}" v týmu #${teamId}.`]);

  const out = await query(`${SELECT_FULL} WHERE i.id = $1`, [id]);
  res.json({ idea: out.rows[0], project: proj.rows[0] });
});

// PUT /ideas/:id/analysis — upsert do idea_analysis.
// Jen garant nebo Management. Povoleno ve stavech schvaleno_ceka_na_analyzu
// (kdy garant vyplňuje) a ke_schvaleni_analyzy (kdy Management upravuje před schválením).
router.put('/:id/analysis', requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  const r = await query(`SELECT id, state, garant_id FROM ideas WHERE id = $1`, [id]);
  if (r.rows.length === 0) return res.status(404).json({ error: 'not_found' });
  const idea = r.rows[0];

  const mgr = await isManagement(req.user.id, req.user.role);
  const isGarant = idea.garant_id && idea.garant_id === req.user.id;
  if (!mgr && !isGarant) return res.status(403).json({ error: 'forbidden' });
  if (!['schvaleno_ceka_na_analyzu', 'ke_schvaleni_analyzy'].includes(idea.state)) {
    return res.status(400).json({ error: 'invalid_state', message: 'Analýzu lze editovat jen ve stavu čekání / před schválením.' });
  }

  const b = req.body || {};
  const num = (v) => (v === '' || v == null) ? null : Number(v);
  const str = (v) => (v == null || v === '') ? null : String(v).trim().slice(0, 5000);
  const cx  = ['low', 'medium', 'high'].includes(b.complexity) ? b.complexity : null;

  await query(`
    INSERT INTO idea_analysis (
      idea_id, time_current_h_per_month, time_after_h_per_month,
      financial_savings, internal_hourly_cost, onetime_costs_kc, monthly_annual_costs,
      target_date, complexity, dependencies, risks, summary, updated_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW())
    ON CONFLICT (idea_id) DO UPDATE SET
      time_current_h_per_month = EXCLUDED.time_current_h_per_month,
      time_after_h_per_month   = EXCLUDED.time_after_h_per_month,
      financial_savings        = EXCLUDED.financial_savings,
      internal_hourly_cost     = EXCLUDED.internal_hourly_cost,
      onetime_costs_kc         = EXCLUDED.onetime_costs_kc,
      monthly_annual_costs     = EXCLUDED.monthly_annual_costs,
      target_date              = EXCLUDED.target_date,
      complexity               = EXCLUDED.complexity,
      dependencies             = EXCLUDED.dependencies,
      risks                    = EXCLUDED.risks,
      summary                  = EXCLUDED.summary,
      updated_at               = NOW()
  `, [
    id, num(b.time_current_h_per_month), num(b.time_after_h_per_month),
    str(b.financial_savings), str(b.internal_hourly_cost),
    b.onetime_costs_kc === '' || b.onetime_costs_kc == null ? null : Math.round(Number(b.onetime_costs_kc)),
    str(b.monthly_annual_costs), str(b.target_date), cx,
    str(b.dependencies), str(b.risks), str(b.summary),
  ]);

  await query(`
    INSERT INTO idea_events (idea_id, action, user_id, comment)
    VALUES ($1, 'edit_analysis', $2, $3)
  `, [id, req.user.id, 'Aktualizace analýzy.']);

  const out = await query('SELECT * FROM idea_analysis WHERE idea_id = $1', [id]);
  res.json({ analysis: out.rows[0] });
});

// GET /ideas/_report — Management report: aggregace + seznamy pro rozhodování.
// Vidí jen Management (admin nebo tým 'management').
router.get('/_report', requireAuth, async (req, res) => {
  const mgr = await isManagement(req.user.id, req.user.role);
  if (!mgr) return res.status(403).json({ error: 'forbidden' });

  const [byState, awaiting, waitAnalysis, active, savings] = await Promise.all([
    query(`SELECT state, COUNT(*)::int AS n FROM ideas GROUP BY state`),
    query(`${SELECT_FULL} WHERE i.state IN ('ke_schvaleni','ke_schvaleni_analyzy') ORDER BY i.created_at ASC`),
    query(`${SELECT_FULL} WHERE i.state = 'schvaleno_ceka_na_analyzu' ORDER BY i.created_at ASC`),
    query(`${SELECT_FULL} WHERE i.state = 'rozpracovano' ORDER BY i.updated_at DESC`),
    query(`
      SELECT
        COUNT(*)::int AS n_with_analysis,
        COALESCE(SUM(GREATEST(0, time_current_h_per_month - time_after_h_per_month)), 0)::float
          AS total_saved_h_per_month,
        COALESCE(SUM(onetime_costs_kc), 0)::int AS total_onetime_kc
      FROM idea_analysis a JOIN ideas i ON i.id = a.idea_id
      WHERE i.state NOT IN ('zamitnuto', 'odlozeno')
    `),
  ]);
  res.json({
    by_state: Object.fromEntries(byState.rows.map(r => [r.state, r.n])),
    awaiting_approval: awaiting.rows,
    waiting_analysis: waitAnalysis.rows,
    active: active.rows,
    savings: savings.rows[0],
  });
});

// Meta: pro klienta — dropdowny (oddělení, kategorie, stavy)
router.get('/_meta/enums', async (req, res) => {
  res.json({ departments: DEPARTMENTS, categories: CATEGORIES, states: VALID_STATES });
});

export default router;

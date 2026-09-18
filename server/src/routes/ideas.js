// Nápadník — sběr, řízení a schvalování interních návrhů.
// Fáze 2: workflow tranzice + komentáře + role check + Vytvořit projekt.

import express from 'express';
import { requireAuth } from '../auth.js';
import { query } from '../db.js';
import { sendMail, getNotificationPrefs, buildIdeaEmailHtml } from '../mailer.js';
import { isManagement, isIdeaPM, requireIdeaAccess } from '../ideaAccess.js';
import {
  publicIdeaUpload, publicFormUpload, saveIdeaAttachments, describeUploadError,
  MAX_IDEA_FILES, MAX_PUBLIC_FILES,
} from '../ideaAttachments.js';

const router = express.Router();

// Vrátí seznam Management uživatelů (admin + členové týmu se slug='management').
// Fire-and-forget: chyba je warn, nevyhazuje.
async function getManagementUsers() {
  const r = await query(`
    SELECT DISTINCT u.id, u.email, u.name
    FROM users u
    WHERE u.active = TRUE AND (
      u.role = 'admin'
      OR EXISTS (
        SELECT 1 FROM team_members tm
        JOIN teams t ON t.id = tm.team_id
        WHERE tm.user_id = u.id AND t.slug = 'management'
      )
    )
  `);
  return r.rows;
}

// Odešle idea email s respektem k user prefs. Log chyba, nevyhazuje.
async function sendIdeaMail(userId, email, prefKey, subject, title, body) {
  try {
    const prefs = await getNotificationPrefs(userId);
    if (!prefs[prefKey]) return;
    const html = buildIdeaEmailHtml({ title, body });
    await sendMail({ to: email, subject, html });
  } catch (err) {
    console.warn('[mail/idea]', prefKey, err.message);
  }
}

// Cloudflare Turnstile server-side verify. Když TURNSTILE_SECRET není nastaven,
// vrací true (bypass — dev/local i nasazení bez klíčů funguje). Token je z FE.
async function verifyTurnstile(token, remoteIp) {
  const secret = process.env.TURNSTILE_SECRET;
  if (!secret) {
    // V produkci je veřejný endpoint bez antispamu otevřený sklad — raději
    // odmítneme, než abychom tiše pustili kohokoli s přílohami.
    if (process.env.NODE_ENV === 'production') {
      console.warn('[turnstile] TURNSTILE_SECRET není nastaven — veřejný formulář odmítá odeslání.');
      return false;
    }
    return true;
  }
  if (!token) return false;
  try {
    const params = new URLSearchParams();
    params.set('secret', secret);
    params.set('response', token);
    if (remoteIp) params.set('remoteip', remoteIp);
    const r = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST', body: params,
    });
    const data = await r.json();
    return !!data.success;
  } catch (err) {
    console.warn('[turnstile] verify failed', err.message);
    return false;
  }
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

const trim = (v) => String(v || '').trim();

// Validace polí nápadu — sdílená veřejným formulářem i interním založením,
// ať mají obě cesty stejná pravidla a nevznikne druhý datový model.
// Jméno a e-mail navrhovatele se interně předvyplní z přihlášeného uživatele,
// proto je lze přeskočit (`skipProposer`).
function validateIdeaFields(b, { skipProposer = false } = {}) {
  const errors = {};
  if (!skipProposer) {
    if (!trim(b.proposer_name)) errors.proposer_name = 'Vyplň jméno.';
    if (!/^[^@]+@[^@]+\.[a-z]{2,}$/i.test(trim(b.proposer_email))) errors.proposer_email = 'Vyplň platný e-mail.';
  }
  if (!trim(b.title)) errors.title = 'Vyplň název nápadu.';
  if (!DEPARTMENTS.includes(trim(b.department))) errors.department = 'Vyber oddělení.';
  if (!CATEGORIES.includes(trim(b.category))) errors.category = 'Vyber kategorii.';
  if (!trim(b.problem_description)) errors.problem_description = 'Popiš problém.';
  if (!trim(b.solution_proposal)) errors.solution_proposal = 'Navrhni řešení.';
  return errors;
}

// Vloží nápad. Stejná tabulka i stavový vstup ('zadano') pro obě cesty vzniku.
function insertIdea(b, { source, createdById = null, proposerName, proposerEmail }) {
  return query(`
    INSERT INTO ideas (
      proposer_name, proposer_email, title, department, category,
      problem_description, solution_proposal, impact_scope,
      estimated_time_savings, external_link, source, created_by_id
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
    RETURNING id, created_at
  `, [
    proposerName, proposerEmail, trim(b.title),
    trim(b.department), trim(b.category),
    trim(b.problem_description), trim(b.solution_proposal),
    trim(b.impact_scope) || null,
    trim(b.estimated_time_savings) || null,
    trim(b.external_link) || null,
    source, createdById,
  ]);
}

// Public endpoint: veřejný formulář, bez autentizace.
// Vytvoří nový nápad ve stavu 'zadano'.
// Fáze 5 přidá Turnstile check.
router.post('/public', publicFormUpload.array('files', MAX_PUBLIC_FILES), async (req, res) => {
  const b = req.body || {};
  const errors = validateIdeaFields(b);
  if (Object.keys(errors).length > 0) {
    return res.status(400).json({ error: 'validation', fields: errors });
  }

  // Cloudflare Turnstile ověření (spam ochrana). Přeskočí se, když
  // TURNSTILE_SECRET není nastaven (dev / lokální).
  const tsOk = await verifyTurnstile(b.turnstile_token, req.ip);
  if (!tsOk) {
    return res.status(400).json({ error: 'turnstile_failed', message: 'Ověření anti‑spam selhalo. Zkus prosím znovu.' });
  }

  const r = await insertIdea(b, {
    source: 'public_form',
    proposerName: trim(b.proposer_name),
    proposerEmail: trim(b.proposer_email),
  });
  // Log event
  await query(`
    INSERT INTO idea_events (idea_id, action, to_state, comment)
    VALUES ($1, 'created', 'zadano', $2)
  `, [r.rows[0].id, `Podal ${trim(b.proposer_name)} přes veřejný formulář.`]);

  // Přílohy dorazily ve stejném multipart requestu — uložíme je až teď,
  // kdy známe idea_id. Žádné osiřelé soubory z nedokončeného formuláře.
  await saveIdeaAttachments(r.rows[0].id, req.files, null);

  res.status(201).json({ ok: true, id: r.rows[0].id });

  // Notify Management (fire-and-forget)
  const ideaId = r.rows[0].id;
  const title = trim(b.title);
  const dept = trim(b.department);
  getManagementUsers().then(mgmt => {
    mgmt.forEach(u => sendIdeaMail(
      u.id, u.email, 'email_idea_new',
      `VITOM Nápadník: nový nápad — ${title}`,
      `💡 Nový nápad k posouzení`,
      `<p><strong>${escapeMail(trim(b.proposer_name))}</strong> podal nápad:</p>
       <p style="background:#f8f5f0;padding:10px;border-radius:6px;"><strong>${escapeMail(title)}</strong><br><span style="color:#5b7177;font-size:12px;">${escapeMail(dept)}</span></p>
       <p style="color:#5b7177;font-size:13px;">Otevři Nápadník pro schválení nebo přiřazení garanta.</p>`
    ));
  }).catch(err => console.warn('[mail/idea] mgmt lookup', err.message));
});

function escapeMail(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Interní založení nápadu (PM Nápadníku / Management). Stejná tabulka, stejný
// vstupní stav i workflow jako u veřejného formuláře — liší se jen `source`
// a tím, že navrhovatel se bere z přihlášeného uživatele.
// Oprávnění vynucené na backendu, ne jen skrytím tlačítka v UI.
router.post('/internal', requireAuth, requireIdeaAccess,
  publicIdeaUpload.array('files', MAX_IDEA_FILES), async (req, res) => {
    const b = req.body || {};
    const errors = validateIdeaFields(b, { skipProposer: true });
    if (Object.keys(errors).length > 0) {
      return res.status(400).json({ error: 'validation', fields: errors });
    }

    const me = (await query(`SELECT name, email FROM users WHERE id = $1`, [req.user.id])).rows[0] || {};
    const r = await insertIdea(b, {
      source: 'internal',
      createdById: req.user.id,
      proposerName: me.name || req.user.name || 'Interní návrh',
      proposerEmail: me.email || req.user.email || '',
    });
    const ideaId = r.rows[0].id;

    await query(`
      INSERT INTO idea_events (idea_id, action, to_state, user_id, comment)
      VALUES ($1, 'created_internal', 'zadano', $2, $3)
    `, [ideaId, req.user.id, `Nápad založen interně uživatelem ${me.name || ''}.`.trim()]);

    const attachments = await saveIdeaAttachments(ideaId, req.files, req.user.id);
    res.status(201).json({ ok: true, id: ideaId, attachments });

    // Management informujeme stejně jako u veřejného nápadu.
    const title = trim(b.title);
    getManagementUsers().then(mgmt => {
      mgmt.filter(u => u.id !== req.user.id).forEach(u => sendIdeaMail(
        u.id, u.email, 'email_idea_new',
        `VITOM Nápadník: nový nápad — ${title}`,
        `💡 Nový nápad k posouzení`,
        `<p><strong>${escapeMail(me.name || '')}</strong> založil nápad interně:</p>
         <p style="background:#f8f5f0;padding:10px;border-radius:6px;"><strong>${escapeMail(title)}</strong></p>`
      ));
    }).catch(err => console.warn('[mail/idea] mgmt lookup', err.message));
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

// Stavy, které ve výchozím seznamu nechceme — nápad je vyřešený nebo odložený.
// Nemažou se, jen se schovají; přes filtr stavu je uživatel kdykoli zobrazí.
const DEFAULT_HIDDEN_STATES = ['rozpracovano', 'hotovo', 'odlozeno'];

// Auth endpoint: seznam nápadů (interní wishlist).
// Filtry se kombinují (AND): stav, text, garant, oddělení, kategorie, zdroj, období.
router.get('/', requireAuth, requireIdeaAccess, async (req, res) => {
  const q = req.query || {};
  const where = [];
  const params = [];
  // `$?` se nahradí číslem právě přidaného parametru — i vícekrát v jednom
  // výrazu (fulltext hledá stejný řetězec ve více sloupcích).
  const add = (sql, val) => { params.push(val); where.push(sql.replaceAll('$?', `$${params.length}`)); };

  // Stav — multiselect (?state=zadano,hotovo). Bez filtru schováme vyřešené.
  const states = String(q.state || '').split(',').map(s => s.trim()).filter(Boolean);
  const valid = states.filter(s => VALID_STATES.includes(s));
  if (states.length > 0 && valid.length === 0) {
    return res.status(400).json({ error: 'validation', fields: { state: 'Neznámý stav nápadu.' } });
  }
  if (valid.length > 0) {
    add('i.state = ANY($?::text[])', valid);
  } else if (q.state === undefined) {
    add('i.state <> ALL($?::text[])', DEFAULT_HIDDEN_STATES);
  }
  // Sloučené nápady drží data kvůli historii, ale v seznamu jen matou.
  // ?include_merged=1 je zobrazí.
  if (q.include_merged !== '1') where.push('i.merged_into_id IS NULL');

  // Fulltext přes text nápadu a jméno navrhovatele.
  if (trim(q.q)) {
    add(
      '(i.title ILIKE $? OR i.problem_description ILIKE $? OR i.solution_proposal ILIKE $? OR i.proposer_name ILIKE $?)',
      `%${trim(q.q)}%`
    );
  }
  if (Number(q.garant_id))   add('i.garant_id = $?', Number(q.garant_id));
  if (trim(q.department))    add('i.department = $?', trim(q.department));
  if (trim(q.category))      add('i.category = $?', trim(q.category));
  if (trim(q.source))        add('i.source = $?', trim(q.source));
  if (/^\d{4}-\d{2}-\d{2}$/.test(trim(q.from))) add('i.created_at >= $?::date', trim(q.from));
  // `to` je včetně celého dne → porovnáváme proti následujícímu dni.
  if (/^\d{4}-\d{2}-\d{2}$/.test(trim(q.to)))   add(`i.created_at < ($?::date + 1)`, trim(q.to));

  const sql = `${SELECT_FULL} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY i.created_at DESC`;
  const r = await query(sql, params);
  res.json({ ideas: r.rows });
});

// GET /ideas/_report — Management report: aggregace + seznamy pro rozhodování.
// Vidí jen Management (admin nebo tým 'management').
// POZOR: statické cesty (`_report`, `_stats`) musí být PŘED dynamic `/:id`,
// jinak je Express zpracuje jako id="_report" a spadne to na Number(NaN).
router.get('/_report', requireAuth, requireIdeaAccess, async (req, res) => {

  const [byState, awaiting, waitAnalysis, active, savings] = await Promise.all([
    query(`SELECT state, COUNT(*)::int AS n FROM ideas WHERE merged_into_id IS NULL GROUP BY state`),
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

// GET /ideas/_stats — data pro Dashboard grafy.
router.get('/_stats', requireAuth, requireIdeaAccess, async (req, res) => {
  const [byState, byDept, byCat, monthly, topProposers, byRec] = await Promise.all([
    query(`SELECT state, COUNT(*)::int AS n FROM ideas WHERE merged_into_id IS NULL GROUP BY state`),
    query(`SELECT department, COUNT(*)::int AS n FROM ideas WHERE merged_into_id IS NULL GROUP BY department ORDER BY n DESC`),
    query(`SELECT category, COUNT(*)::int AS n FROM ideas WHERE merged_into_id IS NULL GROUP BY category ORDER BY n DESC`),
    query(`
      SELECT TO_CHAR(date_trunc('month', created_at), 'YYYY-MM') AS ym,
             COUNT(*)::int AS n
      FROM ideas
      WHERE created_at >= NOW() - INTERVAL '6 months' AND merged_into_id IS NULL
      GROUP BY ym ORDER BY ym ASC
    `),
    query(`
      SELECT proposer_name, COUNT(*)::int AS n
      FROM ideas
      WHERE merged_into_id IS NULL
      GROUP BY proposer_name
      ORDER BY n DESC, proposer_name ASC
      LIMIT 5
    `),
    query(`SELECT COALESCE(pm_recommendation, '?') AS rec, COUNT(*)::int AS n FROM ideas WHERE merged_into_id IS NULL GROUP BY rec ORDER BY rec`),
  ]);
  res.json({
    by_state:      Object.fromEntries(byState.rows.map(r => [r.state, r.n])),
    by_department: byDept.rows,
    by_category:   byCat.rows,
    monthly_intake: monthly.rows,
    top_proposers: topProposers.rows,
    by_pm_recommendation: byRec.rows,
  });
});

// GET /ideas/_export.csv — CSV export všech nápadů. Management-only
// (obsahuje interní PM poznámky, garanty, analytická pole).
router.get('/_export.csv', requireAuth, requireIdeaAccess, async (req, res) => {

  const r = await query(`
    SELECT i.*,
      gu.name AS garant_name,
      lp.name AS linked_project_name,
      lt.name AS linked_project_team_name,
      a.time_current_h_per_month, a.time_after_h_per_month,
      a.financial_savings, a.onetime_costs_kc, a.complexity, a.summary
    FROM ideas i
    LEFT JOIN users gu ON gu.id = i.garant_id
    LEFT JOIN projects lp ON lp.id = i.linked_project_id
    LEFT JOIN teams lt ON lt.id = i.linked_project_team_id
    LEFT JOIN idea_analysis a ON a.idea_id = i.id
    WHERE i.merged_into_id IS NULL
    ORDER BY i.created_at DESC
  `);

  const cols = [
    'id', 'created_at', 'state', 'title', 'department', 'category',
    'proposer_name', 'proposer_email',
    'problem_description', 'solution_proposal', 'impact_scope',
    'estimated_time_savings', 'external_link',
    'garant_name', 'priority', 'pm_recommendation', 'pm_note',
    'linked_project_name', 'linked_project_team_name',
    'time_current_h_per_month', 'time_after_h_per_month',
    'financial_savings', 'onetime_costs_kc', 'complexity', 'summary',
  ];
  const esc = (v) => {
    if (v == null) return '';
    const s = String(v);
    // Excel-safe: uvozovky zdvojit, vše obalit, konce řádků respektovat.
    return `"${s.replace(/"/g, '""')}"`;
  };
  const header = cols.join(';');
  const rows = r.rows.map(row => cols.map(c => esc(row[c])).join(';'));
  // BOM aby Excel poznal UTF-8; oddělovač ; kvůli čárkám v textech (cs-CZ locale).
  const csv = '﻿' + [header, ...rows].join('\r\n');

  const stamp = new Date().toISOString().slice(0, 10);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="napadnik-${stamp}.csv"`);
  res.send(csv);
});

// Meta: pro klienta — Turnstile site key (pokud je nastaven).
router.get('/_meta/turnstile', (req, res) => {
  res.json({ site_key: process.env.TURNSTILE_SITE_KEY || null });
});

// Meta: kdo jsem v Nápadníku (pro FE — tab visibility, tlačítka).
router.get('/_meta/perms', requireAuth, async (req, res) => {
  const [mgr, pm] = await Promise.all([
    isManagement(req.user.id, req.user.role),
    isIdeaPM(req.user.id),
  ]);
  res.json({ is_management: mgr, is_idea_pm: pm });
});

// Seznam PMek Nápadníku. Vidí Management + PM (kvůli přehledu).
router.get('/_pms', requireAuth, requireIdeaAccess, async (req, res) => {
  const r = await query(`
    SELECT ip.user_id, ip.assigned_at, u.name, u.email,
           ab.name AS assigned_by_name
    FROM idea_pms ip
    JOIN users u ON u.id = ip.user_id
    LEFT JOIN users ab ON ab.id = ip.assigned_by
    ORDER BY u.name ASC
  `);
  res.json({ pms: r.rows });
});

// Přidat PM. Jen admin.
router.post('/_pms', requireAuth, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'forbidden' });
  const userId = Number(req.body?.user_id);
  if (!Number.isInteger(userId) || userId <= 0) return res.status(400).json({ error: 'invalid_user_id' });
  const u = await query(`SELECT id FROM users WHERE id = $1 AND active = TRUE`, [userId]);
  if (u.rows.length === 0) return res.status(404).json({ error: 'user_not_found' });
  await query(`
    INSERT INTO idea_pms (user_id, assigned_by) VALUES ($1, $2)
    ON CONFLICT (user_id) DO NOTHING
  `, [userId, req.user.id]);
  res.status(201).json({ ok: true });
});

// Odebrat PM. Jen admin.
router.delete('/_pms/:userId', requireAuth, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'forbidden' });
  const userId = Number(req.params.userId);
  await query(`DELETE FROM idea_pms WHERE user_id = $1`, [userId]);
  res.json({ ok: true });
});

// Auth endpoint: detail 1 nápadu.
router.get('/:id', requireAuth, requireIdeaAccess, async (req, res) => {
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
router.patch('/:id', requireAuth, requireIdeaAccess, async (req, res) => {
  const id = Number(req.params.id);
  const b = req.body || {};
  // Zjisti current stav (kvůli garant-change notifikaci)
  const prevR = await query(`SELECT garant_id, title FROM ideas WHERE id = $1`, [id]);
  const prev = prevR.rows[0];
  if (!prev) return res.status(404).json({ error: 'not_found' });

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

  // Notify newly assigned garant (jen když se opravdu změnil a není to self-assign)
  const newGarantId = 'garant_id' in b ? (b.garant_id ? Number(b.garant_id) : null) : prev.garant_id;
  if (newGarantId && newGarantId !== prev.garant_id && newGarantId !== req.user.id) {
    query(`SELECT id, email, name FROM users WHERE id = $1 AND active = TRUE`, [newGarantId])
      .then(u => {
        const g = u.rows[0];
        if (!g) return;
        sendIdeaMail(
          g.id, g.email, 'email_idea_assigned_garant',
          `VITOM Nápadník: přidělen ti nápad — ${prev.title}`,
          `👤 Byl(a) jsi přiřazen(a) jako garant`,
          `<p>Nápad: <strong>${escapeMail(prev.title)}</strong></p>
           <p style="color:#5b7177;font-size:13px;">Otevři si nápad a pusť ho ke schválení nebo naplánuj analýzu.</p>`
        );
      })
      .catch(err => console.warn('[mail/idea] garant lookup', err.message));
  }
});

// Vrátí povolené přechody pro nápad + kdo je smí provést (per current user).
// FE volá pro render workflow tlačítek.
router.get('/:id/transitions', requireAuth, requireIdeaAccess, async (req, res) => {
  const id = Number(req.params.id);
  const r = await query(`SELECT id, state, garant_id FROM ideas WHERE id = $1`, [id]);
  if (r.rows.length === 0) return res.status(404).json({ error: 'not_found' });
  const idea = r.rows[0];
  const [mgr, pm] = await Promise.all([
    isManagement(req.user.id, req.user.role),
    isIdeaPM(req.user.id),
  ]);
  const isGarant = idea.garant_id && idea.garant_id === req.user.id;
  // PM Nápadníku má garant-role practical rights (posouvá analýzu, dokončí),
  // ale NEschvaluje / nezamítá — role 'management' zůstává striktní.
  const canGarant = isGarant || pm;
  const available = (TRANSITIONS[idea.state] || []).map(t => {
    let allowed = false;
    if (t.role === 'management') allowed = mgr;
    else if (t.role === 'garant') allowed = canGarant;
    else if (t.role === 'garant_or_management') allowed = mgr || canGarant;
    if (t.requireGarant && !idea.garant_id) allowed = false;
    return { to: t.to, action: t.action, requireComment: !!t.requireComment, allowed };
  });
  // Speciální akce: Vytvořit projekt (schvalena_analyza) — garant nebo PM Nápadníku.
  if (idea.state === 'schvalena_analyza' && canGarant) {
    available.push({ to: 'rozpracovano', action: 'Vytvořit projekt', requireComment: false, allowed: true, special: 'create_project' });
  }
  res.json({ state: idea.state, transitions: available, isManagement: mgr, isGarant, isIdeaPM: pm });
});

// Provede state transition. Body: { to_state, comment }
router.post('/:id/state', requireAuth, requireIdeaAccess, async (req, res) => {
  const id = Number(req.params.id);
  const b = req.body || {};
  const toState = String(b.to_state || '').trim();
  const comment = b.comment ? String(b.comment).trim().slice(0, 5000) : null;

  const r = await query(`SELECT * FROM ideas WHERE id = $1`, [id]);
  if (r.rows.length === 0) return res.status(404).json({ error: 'not_found' });
  const idea = r.rows[0];

  const allowed = (TRANSITIONS[idea.state] || []).find(t => t.to === toState);
  if (!allowed) return res.status(400).json({ error: 'invalid_transition', from: idea.state, to: toState });

  // Autorizace. PM Nápadníku má garant-role rights (posun analýzy, dokončení),
  // ale NE schvalování / zamítání.
  const [mgr, pm] = await Promise.all([
    isManagement(req.user.id, req.user.role),
    isIdeaPM(req.user.id),
  ]);
  const isGarant = idea.garant_id && idea.garant_id === req.user.id;
  const canGarant = isGarant || pm;
  const canDo =
    (allowed.role === 'management' && mgr) ||
    (allowed.role === 'garant' && canGarant) ||
    (allowed.role === 'garant_or_management' && (mgr || canGarant));
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

  // Notify proposera když je nápad definitivně rozhodnut (schválen / zamítnut / odložen).
  // Interní přechody (poslat ke schválení, čeká na analýzu) neposílají.
  const notifyStates = ['schvalena_analyza', 'zamitnuto', 'odlozeno'];
  if (notifyStates.includes(toState) && idea.proposer_email) {
    const label = toState === 'schvalena_analyza' ? 'schválen a jde do realizace 🎉'
                : toState === 'zamitnuto'         ? 'zamítnut'
                : 'odložen';
    const proposerName = idea.proposer_name || '';
    // Proposer je externí — nemá user_id → prefs nejde kontrolovat.
    // Pošleme přímo (public forma), text lidský.
    const html = buildIdeaEmailHtml({
      title: `Tvůj nápad byl ${label}`,
      body:  `<p>Ahoj ${escapeMail(proposerName)},</p>
              <p>tvůj nápad <strong>${escapeMail(idea.title)}</strong> byl <strong>${label}</strong>.</p>
              ${comment ? `<p style="background:#f8f5f0;padding:10px;border-radius:6px;font-size:13px;"><strong>Komentář:</strong><br>${escapeMail(comment)}</p>` : ''}
              <p style="color:#5b7177;font-size:12px;">Díky za podnět!</p>`,
    });
    sendMail({
      to: idea.proposer_email,
      subject: `VITOM Nápadník: tvůj nápad byl ${label} — ${idea.title}`,
      html,
    }).catch(err => console.warn('[mail/idea] proposer', err.message));
  }
});

// Speciální akce: Vytvořit reálný projekt z nápadu.
// Přechází state schvalena_analyza → rozpracovano + vytvoří projekt
// v cílovém týmu + linked_project_id na nápadu.
// Garant nápadu nebo PM Nápadníku.
router.post('/:id/create-project', requireAuth, requireIdeaAccess, async (req, res) => {
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
  const pm = await isIdeaPM(req.user.id);
  const canDoProject = (idea.garant_id && idea.garant_id === req.user.id) || pm;
  if (!canDoProject) return res.status(403).json({ error: 'forbidden', message: 'Projekt může založit jen garant nápadu nebo PM Nápadníku.' });

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
router.put('/:id/analysis', requireAuth, requireIdeaAccess, async (req, res) => {
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

// Meta: pro klienta — dropdowny (oddělení, kategorie, stavy)
router.get('/_meta/enums', async (req, res) => {
  res.json({ departments: DEPARTMENTS, categories: CATEGORIES, states: VALID_STATES });
});

// ===========================================================================
// POZNÁMKY (sekce 13) — každá poznámka vlastní záznam, editovatelná zvlášť.
// ===========================================================================

router.get('/:id/notes', requireAuth, requireIdeaAccess, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'bad_id' });
  const r = await query(`
    SELECT n.id, n.idea_id, n.text, n.author_id, n.created_at, n.updated_at,
           u.name AS author_name
    FROM idea_notes n
    LEFT JOIN users u ON u.id = n.author_id
    WHERE n.idea_id = $1
    ORDER BY n.created_at DESC
  `, [id]);
  res.json({ notes: r.rows });
});

router.post('/:id/notes', requireAuth, requireIdeaAccess, async (req, res) => {
  const id = Number(req.params.id);
  const text = trim(req.body?.text);
  if (!text) return res.status(400).json({ error: 'validation', fields: { text: 'Napiš text poznámky.' } });

  const exists = await query('SELECT 1 FROM ideas WHERE id = $1', [id]);
  if (exists.rows.length === 0) return res.status(404).json({ error: 'not_found' });

  const r = await query(`
    INSERT INTO idea_notes (idea_id, text, author_id) VALUES ($1, $2, $3)
    RETURNING id, idea_id, text, author_id, created_at, updated_at
  `, [id, text, req.user.id]);

  await query(`
    INSERT INTO idea_events (idea_id, action, user_id, comment)
    VALUES ($1, 'note_created', $2, $3)
  `, [id, req.user.id, text.slice(0, 500)]);

  res.status(201).json({ note: r.rows[0] });
});

router.patch('/:id/notes/:noteId', requireAuth, requireIdeaAccess, async (req, res) => {
  const id = Number(req.params.id);
  const noteId = Number(req.params.noteId);
  const text = trim(req.body?.text);
  if (!text) return res.status(400).json({ error: 'validation', fields: { text: 'Napiš text poznámky.' } });

  const cur = (await query('SELECT * FROM idea_notes WHERE id = $1 AND idea_id = $2', [noteId, id])).rows[0];
  if (!cur) return res.status(404).json({ error: 'not_found' });
  // Cizí poznámku smí přepsat jen Management — jinak by si PM navzájem
  // přepisovali zápisy a audit by to jen zaznamenal, nezabránil tomu.
  if (cur.author_id !== req.user.id && !req.ideaPerms?.isManagement) {
    return res.status(403).json({ error: 'forbidden', message: 'Upravit můžeš jen vlastní poznámku.' });
  }

  const r = await query(`
    UPDATE idea_notes SET text = $1, updated_at = NOW() WHERE id = $2
    RETURNING id, idea_id, text, author_id, created_at, updated_at
  `, [text, noteId]);

  // Audit drží starou i novou hodnotu, ať je dohledatelné, co se změnilo.
  await query(`
    INSERT INTO idea_events (idea_id, action, user_id, comment)
    VALUES ($1, 'note_edited', $2, $3)
  `, [id, req.user.id, `Původně: ${cur.text.slice(0, 250)} → nově: ${text.slice(0, 250)}`]);

  res.json({ note: r.rows[0] });
});

// ===========================================================================
// PŘÍLOHY NÁPADU (sekce 7) — sdílí tabulku attachments přes idea_id.
// ===========================================================================

router.get('/:id/attachments', requireAuth, requireIdeaAccess, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'bad_id' });
  const r = await query(`
    SELECT a.id, a.idea_id, a.uploader_id, a.original_name, a.mime_type, a.size, a.kind, a.created_at,
           u.name AS uploader_name
    FROM attachments a
    LEFT JOIN users u ON u.id = a.uploader_id
    WHERE a.idea_id = $1
    ORDER BY a.created_at
  `, [id]);
  res.json({ attachments: r.rows });
});

router.post('/:id/attachments', requireAuth, requireIdeaAccess,
  publicIdeaUpload.array('files', MAX_IDEA_FILES), async (req, res) => {
    const id = Number(req.params.id);
    const exists = await query('SELECT 1 FROM ideas WHERE id = $1', [id]);
    if (exists.rows.length === 0) return res.status(404).json({ error: 'not_found' });

    const saved = await saveIdeaAttachments(id, req.files, req.user.id);
    if (saved.length === 0) return res.status(400).json({ error: 'no_files', message: 'Nepřišel žádný soubor.' });

    await query(`
      INSERT INTO idea_events (idea_id, action, user_id, comment)
      VALUES ($1, 'attachment_added', $2, $3)
    `, [id, req.user.id, saved.map(a => a.original_name).join(', ').slice(0, 500)]);

    res.status(201).json({ attachments: saved });
  });

// ===========================================================================
// SLOUČIT / PŘIŘADIT (sekce 12)
// ===========================================================================

// Sloučí tento nápad do cílového. Data se nemažou — přílohy a poznámky
// přesuneme na cílový nápad, zdrojový zůstane kvůli historii označený
// přes merged_into_id.
router.post('/:id/merge', requireAuth, requireIdeaAccess, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'bad_id' });
  const targetId = Number(req.body?.target_id);
  if (!Number.isInteger(targetId)) return res.status(400).json({ error: 'validation', fields: { target_id: 'Vyber cílový nápad.' } });
  if (targetId === id) return res.status(400).json({ error: 'self_merge', message: 'Nápad nelze sloučit sám se sebou.' });

  const src = (await query('SELECT * FROM ideas WHERE id = $1', [id])).rows[0];
  const dst = (await query('SELECT * FROM ideas WHERE id = $1', [targetId])).rows[0];
  if (!src || !dst) return res.status(404).json({ error: 'not_found' });
  if (src.merged_into_id) return res.status(400).json({ error: 'already_merged', message: 'Tento nápad už byl sloučen.' });
  // Řetězení by vedlo k cyklu (A→B, B→A) a k nedohledatelnému originálu.
  if (dst.merged_into_id) return res.status(400).json({ error: 'target_merged', message: 'Cílový nápad je sám sloučený do jiného.' });

  // Přílohy a poznámky přesuneme, ať se sloučením nic neztratí.
  await query('UPDATE attachments SET idea_id = $1 WHERE idea_id = $2', [targetId, id]);
  await query('UPDATE idea_notes SET idea_id = $1 WHERE idea_id = $2', [targetId, id]);

  // Popis zdrojového nápadu připojíme do poznámek cíle, ať text nezmizí.
  await query(`
    INSERT INTO idea_notes (idea_id, text, author_id) VALUES ($1, $2, $3)
  `, [targetId,
      `Sloučeno z nápadu #${id} „${src.title}" (podal ${src.proposer_name}).\n\nProblém: ${src.problem_description}\n\nŘešení: ${src.solution_proposal}`,
      req.user.id]);

  await query(`UPDATE ideas SET merged_into_id = $1, updated_at = NOW() WHERE id = $2`, [targetId, id]);

  await query(`
    INSERT INTO idea_events (idea_id, action, user_id, comment)
    VALUES ($1, 'merged_into', $2, $3), ($4, 'merged_from', $2, $5)
  `, [id, req.user.id, `Sloučeno do #${targetId} „${dst.title}".`,
      targetId, `Sem byl sloučen nápad #${id} „${src.title}".`]);

  res.json({ ok: true, merged_into_id: targetId });
});

// Vytvoří z nápadu úkol v existujícím projektu (záložka PROJEKTY v modalu
// Sloučit/přiřadit, a zároveň akce „Vytvořit úkol" po schválení analýzy).
// Používá standardní tabulku tasks — žádný druhý systém úkolů.
router.post('/:id/create-task', requireAuth, requireIdeaAccess, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'bad_id' });
  const projectId = Number(req.body?.project_id);
  if (!Number.isInteger(projectId)) {
    return res.status(400).json({ error: 'validation', fields: { project_id: 'Vyber projekt.' } });
  }

  const idea = (await query('SELECT * FROM ideas WHERE id = $1', [id])).rows[0];
  if (!idea) return res.status(404).json({ error: 'not_found' });
  // Úkol smí vzniknout jen z nápadu, který se opravdu řeší. Bez tohohle by
  // zamítnutý nebo odložený nápad tiše obešel workflow graf, a u hotového by
  // přibyl otevřený úkol, který už nikdo nepřepočítá.
  const CAN_SPAWN_TASK = ['zadano', 'ke_schvaleni', 'schvaleno_ceka_na_analyzu',
    'ke_schvaleni_analyzy', 'schvalena_analyza', 'rozpracovano'];
  if (!CAN_SPAWN_TASK.includes(idea.state)) {
    return res.status(400).json({ error: 'invalid_state', message: `Z nápadu ve stavu „${idea.state}" úkol vytvořit nelze.` });
  }

  const project = (await query('SELECT id, team_id FROM projects WHERE id = $1', [projectId])).rows[0];
  if (!project) return res.status(404).json({ error: 'project_not_found' });

  // Multi-team izolace: úkol nelze založit v cizím týmu (stejně jako u
  // /create-project). Bez toho by PM Nápadníku sahal do všech týmů.
  if (req.user.role !== 'admin') {
    const memb = await query(
      `SELECT 1 FROM team_members WHERE user_id = $1 AND team_id = $2 LIMIT 1`,
      [req.user.id, project.team_id]
    );
    if (memb.rows.length === 0) {
      return res.status(403).json({ error: 'not_team_member', message: 'V týmu tohoto projektu nejsi členem.' });
    }
  }

  const title = trim(req.body?.title) || idea.title;
  const description = trim(req.body?.description)
    || `Z nápadu #${idea.id}.\n\nProblém: ${idea.problem_description}\n\nNavržené řešení: ${idea.solution_proposal}`;
  // Řešitel musí být členem týmu projektu — jinak by šlo přiřadit úkol komukoli.
  const assigneeId = Number(req.body?.assignee_id) || null;
  if (assigneeId) {
    const ok = await query(
      `SELECT 1 FROM team_members WHERE user_id = $1 AND team_id = $2 LIMIT 1`,
      [assigneeId, project.team_id]
    );
    if (ok.rows.length === 0) {
      return res.status(400).json({ error: 'validation', fields: { assignee_id: 'Řešitel není členem týmu projektu.' } });
    }
  }
  const priority = ['low', 'normal', 'high', 'urgent'].includes(req.body?.priority) ? req.body.priority : 'normal';
  const dueDate = /^\d{4}-\d{2}-\d{2}$/.test(trim(req.body?.due_date)) ? trim(req.body.due_date) : null;

  const t = await query(`
    INSERT INTO tasks (project_id, title, description, assignee_id, priority, due_date, status)
    VALUES ($1, $2, $3, $4, $5, $6::date, 'todo')
    RETURNING *
  `, [projectId, title, description, assigneeId, priority, dueDate]);
  const task = t.rows[0];

  await query(`
    INSERT INTO idea_tasks (idea_id, task_id, created_by) VALUES ($1, $2, $3)
    ON CONFLICT DO NOTHING
  `, [id, task.id, req.user.id]);

  // Vznikla realizace → nápad je rozpracovaný (sekce 9).
  const fromState = idea.state;
  if (idea.state !== 'rozpracovano' && idea.state !== 'hotovo') {
    await query(`UPDATE ideas SET state = 'rozpracovano', updated_at = NOW() WHERE id = $1`, [id]);
  }
  await query(`
    INSERT INTO idea_events (idea_id, action, from_state, to_state, user_id, comment)
    VALUES ($1, 'create_task', $2, 'rozpracovano', $3, $4)
  `, [id, fromState, req.user.id, `Vytvořen úkol #${task.id} „${title}".`]);

  res.status(201).json({ task });
});

// Znovu aktivovat odložený nápad (sekce 14).
router.post('/:id/reactivate', requireAuth, requireIdeaAccess, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'bad_id' });
  const idea = (await query('SELECT * FROM ideas WHERE id = $1', [id])).rows[0];
  if (!idea) return res.status(404).json({ error: 'not_found' });
  if (idea.state !== 'odlozeno') {
    return res.status(400).json({ error: 'invalid_state', message: 'Znovu aktivovat lze jen odložený nápad.' });
  }
  await query(`UPDATE ideas SET state = 'zadano', updated_at = NOW() WHERE id = $1`, [id]);
  await query(`
    INSERT INTO idea_events (idea_id, action, from_state, to_state, user_id, comment)
    VALUES ($1, 'reactivated', 'odlozeno', 'zadano', $2, $3)
  `, [id, req.user.id, trim(req.body?.comment) || 'Nápad znovu aktivován.']);
  res.json({ ok: true, state: 'zadano' });
});

// Chyby uploadu (typ / velikost / počet) přeložíme na srozumitelnou hlášku.
// Musí být až za routami, aby zachytilo chyby z multeru.
router.use((err, req, res, next) => {
  const described = describeUploadError(err);
  if (described) return res.status(400).json(described);
  next(err);
});

export default router;

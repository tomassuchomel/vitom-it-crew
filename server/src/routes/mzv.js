// MZV (Měsíční Zpětná Vazba) — manager 1:1 s podřízeným, jednou měsíčně.
// Manager = uživatel s team_role='manager' v týmu podřízeného. Cross-team:
// pokud je subordinate ve víc týmech, pro každého managera to je samostatný vztah.
//
// F1: subordinates list, profile CRUD, meetings list + create draft.
// Zápis editace + AI přijde ve F2.

import { Router } from 'express';
import { query } from '../db.js';
import { requireAuth } from '../auth.js';
import { callAI, stripHtml } from '../meetingsAi.js';
import { processNote } from '../ai.js';

const router = Router();

// Vrátí ID týmů, ve kterých je uživatel manager.
async function managerTeams(userId) {
  const r = await query(
    `SELECT team_id FROM team_members WHERE user_id = $1 AND team_role = 'manager'`,
    [userId]
  );
  return r.rows.map(x => x.team_id);
}

// Ověří, zda cur.user je manager subordinate (má společný tým, kde cur.user je manager),
// nebo admin.
async function canManage(currentUserId, currentRole, subordinateId) {
  if (currentRole === 'admin') return true;
  if (currentUserId === subordinateId) return false; // manager sebe nedělá
  const r = await query(`
    SELECT 1 FROM team_members mgr
    JOIN team_members sub ON sub.team_id = mgr.team_id
    WHERE mgr.user_id = $1 AND mgr.team_role = 'manager'
      AND sub.user_id = $2
    LIMIT 1
  `, [currentUserId, subordinateId]);
  return r.rowCount > 0;
}

// Seznam „mých lidí" — všichni členové týmů, kde jsem manager (nebo pro admina všichni useři).
// Vrací i datum poslední MZV a kdy je „další v pořadí" (=+30 dní od poslední).
router.get('/subordinates', requireAuth, async (req, res) => {
  const isAdmin = req.user.role === 'admin';
  let teamIds = [];
  if (!isAdmin) {
    teamIds = await managerTeams(req.user.id);
    if (teamIds.length === 0) return res.json({ subordinates: [] });
  }

  const params = [req.user.id];
  let filter = '';
  if (!isAdmin) {
    params.push(teamIds);
    filter = `
      AND EXISTS (
        SELECT 1 FROM team_members tm
        WHERE tm.user_id = u.id AND tm.team_id = ANY($2::int[])
      )
    `;
  }

  const r = await query(`
    SELECT
      u.id, u.name, u.email, u.avatar_updated_at, u.role,
      (SELECT MAX(meeting_date) FROM mzv_meetings m
        WHERE m.subordinate_id = u.id
          AND ($1::int = 0 OR m.manager_id = $1 OR $1::int IN (SELECT id FROM users WHERE role='admin')))
        AS last_mzv_date,
      (SELECT COUNT(*)::int FROM mzv_meetings m
        WHERE m.subordinate_id = u.id
          AND ($1::int = 0 OR m.manager_id = $1 OR $1::int IN (SELECT id FROM users WHERE role='admin')))
        AS total_mzv,
      EXISTS(SELECT 1 FROM mzv_profiles p WHERE p.user_id = u.id) AS has_profile
    FROM users u
    WHERE u.id != $1
      ${filter}
    ORDER BY last_mzv_date ASC NULLS FIRST, u.name ASC
  `, params);

  res.json({ subordinates: r.rows });
});

// GET profil podřízeného. Jen manager tohoto člověka nebo admin.
router.get('/profile/:userId', requireAuth, async (req, res) => {
  const userId = Number(req.params.userId);
  if (!await canManage(req.user.id, req.user.role, userId)) {
    return res.status(403).json({ error: 'forbidden' });
  }
  const r = await query(`SELECT * FROM mzv_profiles WHERE user_id = $1`, [userId]);
  const uR = await query(`SELECT id, name, email, avatar_updated_at, role FROM users WHERE id = $1`, [userId]);
  if (!uR.rows[0]) return res.status(404).json({ error: 'not_found' });
  res.json({ user: uR.rows[0], profile: r.rows[0] || null });
});

// PUT profil (upsert). Manager nebo admin.
router.put('/profile/:userId', requireAuth, async (req, res) => {
  const userId = Number(req.params.userId);
  if (!await canManage(req.user.id, req.user.role, userId)) {
    return res.status(403).json({ error: 'forbidden' });
  }
  const b = req.body || {};
  // Validace: kpi_sections max 5 slotů, children jako array.
  const kpi = Array.isArray(b.kpi_sections)
    ? b.kpi_sections.slice(0, 5).map(s => ({
        name: String(s?.name || '').slice(0, 100),
        description: String(s?.description || '').slice(0, 500),
      }))
    : [];
  const children = Array.isArray(b.children)
    ? b.children.slice(0, 20).map(c => ({
        name: String(c?.name || '').slice(0, 100),
        birth_date: /^\d{4}-\d{2}-\d{2}$/.test(c?.birth_date || '') ? c.birth_date : null,
      }))
    : [];
  const AMBITION = ['growth', 'stability'];
  const ambition = AMBITION.includes(b.ambition_type) ? b.ambition_type : null;

  await query(`
    INSERT INTO mzv_profiles (
      user_id, birth_date, hire_date, children,
      work_motivation, life_goals, career_direction, ambition_type,
      strengths, development_areas, feedback_style, energy_sources,
      personal_context, feedback_history, kpi_sections,
      created_by, created_at, updated_at
    ) VALUES (
      $1, $2, $3, $4::jsonb,
      $5, $6, $7, $8,
      $9, $10, $11, $12,
      $13, $14, $15::jsonb,
      $16, NOW(), NOW()
    )
    ON CONFLICT (user_id) DO UPDATE SET
      birth_date = EXCLUDED.birth_date,
      hire_date = EXCLUDED.hire_date,
      children = EXCLUDED.children,
      work_motivation = EXCLUDED.work_motivation,
      life_goals = EXCLUDED.life_goals,
      career_direction = EXCLUDED.career_direction,
      ambition_type = EXCLUDED.ambition_type,
      strengths = EXCLUDED.strengths,
      development_areas = EXCLUDED.development_areas,
      feedback_style = EXCLUDED.feedback_style,
      energy_sources = EXCLUDED.energy_sources,
      personal_context = EXCLUDED.personal_context,
      feedback_history = EXCLUDED.feedback_history,
      kpi_sections = EXCLUDED.kpi_sections,
      updated_at = NOW()
  `, [
    userId,
    /^\d{4}-\d{2}-\d{2}$/.test(b.birth_date || '') ? b.birth_date : null,
    /^\d{4}-\d{2}-\d{2}$/.test(b.hire_date || '') ? b.hire_date : null,
    JSON.stringify(children),
    b.work_motivation || null,
    b.life_goals || null,
    b.career_direction || null,
    ambition,
    b.strengths || null,
    b.development_areas || null,
    b.feedback_style || null,
    b.energy_sources || null,
    b.personal_context || null,
    b.feedback_history || null,
    JSON.stringify(kpi),
    req.user.id,
  ]);

  const r = await query(`SELECT * FROM mzv_profiles WHERE user_id = $1`, [userId]);
  res.json({ profile: r.rows[0] });
});

// Seznam MZV zápisů pro daného podřízeného. Manager tohoto člověka nebo admin.
router.get('/meetings', requireAuth, async (req, res) => {
  const subordinateId = Number(req.query.subordinate_id);
  if (!subordinateId) return res.status(400).json({ error: 'subordinate_id_required' });
  if (!await canManage(req.user.id, req.user.role, subordinateId)) {
    return res.status(403).json({ error: 'forbidden' });
  }
  const r = await query(`
    SELECT m.id, m.subordinate_id, m.manager_id, m.meeting_date, m.status,
           m.created_at, m.updated_at, m.completed_at,
           mgr.name AS manager_name
    FROM mzv_meetings m
    LEFT JOIN users mgr ON mgr.id = m.manager_id
    WHERE m.subordinate_id = $1
    ORDER BY m.meeting_date DESC, m.id DESC
  `, [subordinateId]);
  res.json({ meetings: r.rows });
});

// Vytvořit nový MZV zápis (draft). Manager tohoto člověka nebo admin.
router.post('/meetings', requireAuth, async (req, res) => {
  const subordinateId = Number(req.body?.subordinate_id);
  if (!subordinateId) return res.status(400).json({ error: 'subordinate_id_required' });
  if (!await canManage(req.user.id, req.user.role, subordinateId)) {
    return res.status(403).json({ error: 'forbidden' });
  }
  const meetingDate = /^\d{4}-\d{2}-\d{2}$/.test(req.body?.meeting_date || '')
    ? req.body.meeting_date
    : new Date().toISOString().slice(0, 10);
  const r = await query(`
    INSERT INTO mzv_meetings (subordinate_id, manager_id, meeting_date, status, created_by)
    VALUES ($1, $2, $3, 'draft', $2)
    RETURNING *
  `, [subordinateId, req.user.id, meetingDate]);
  res.json({ meeting: r.rows[0] });
});

// Detail zápisu. Manager tohoto člověka nebo admin. F2 přidá subordinate view (bez kpi/notes).
router.get('/meetings/:id', requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  const r = await query(`SELECT * FROM mzv_meetings WHERE id = $1`, [id]);
  const m = r.rows[0];
  if (!m) return res.status(404).json({ error: 'not_found' });
  if (!await canManage(req.user.id, req.user.role, m.subordinate_id)) {
    return res.status(403).json({ error: 'forbidden' });
  }
  res.json({ meeting: m });
});

// PATCH — parciální update polí zápisu. Manager tohoto člověka nebo admin.
// Když je meeting completed, editovat nesmí (musí nejdřív reopen).
router.patch('/meetings/:id', requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  const cur = (await query(`SELECT * FROM mzv_meetings WHERE id = $1`, [id])).rows[0];
  if (!cur) return res.status(404).json({ error: 'not_found' });
  if (!await canManage(req.user.id, req.user.role, cur.subordinate_id)) {
    return res.status(403).json({ error: 'forbidden' });
  }
  if (cur.status === 'completed') {
    return res.status(400).json({ error: 'meeting_completed', message: 'Zápis je uzavřený — nejdřív ho otevři k opravě.' });
  }

  const b = req.body || {};
  const sets = [];
  const params = [];
  const push = (col, val, cast = '') => { params.push(val); sets.push(`${col} = $${params.length}${cast}`); };

  if ('meeting_date' in b) {
    const d = /^\d{4}-\d{2}-\d{2}$/.test(b.meeting_date || '') ? b.meeting_date : null;
    push('meeting_date', d);
  }
  if ('rozhovor' in b)      push('rozhovor',      String(b.rozhovor || ''));
  if ('priorities' in b)    push('priorities',    String(b.priorities || ''));
  if ('to_improve' in b)    push('to_improve',    String(b.to_improve || ''));
  if ('to_continue' in b)   push('to_continue',   String(b.to_continue || ''));
  if ('manager_notes' in b) push('manager_notes', String(b.manager_notes || ''));
  if ('kpi_ratings' in b) {
    // Whitelist: [{rating: 1-5, comment}]. Max 5 slotů.
    const kpi = Array.isArray(b.kpi_ratings)
      ? b.kpi_ratings.slice(0, 5).map(x => ({
          rating: Number.isInteger(x?.rating) && x.rating >= 1 && x.rating <= 5 ? x.rating : null,
          comment: String(x?.comment || '').slice(0, 500),
        }))
      : [];
    push('kpi_ratings', JSON.stringify(kpi), '::jsonb');
  }
  if (sets.length === 0) return res.status(400).json({ error: 'no_fields' });
  sets.push('updated_at = NOW()');
  params.push(id);
  await query(`UPDATE mzv_meetings SET ${sets.join(', ')} WHERE id = $${params.length}`, params);
  const r = await query(`SELECT * FROM mzv_meetings WHERE id = $1`, [id]);
  res.json({ meeting: r.rows[0] });
});

// Uzavřít zápis (draft → completed). Manager nebo admin.
router.post('/meetings/:id/complete', requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  const cur = (await query(`SELECT * FROM mzv_meetings WHERE id = $1`, [id])).rows[0];
  if (!cur) return res.status(404).json({ error: 'not_found' });
  if (!await canManage(req.user.id, req.user.role, cur.subordinate_id)) {
    return res.status(403).json({ error: 'forbidden' });
  }
  if (cur.status === 'completed') return res.json({ meeting: cur });
  await query(`UPDATE mzv_meetings SET status = 'completed', completed_at = NOW(), updated_at = NOW() WHERE id = $1`, [id]);
  const r = await query(`SELECT * FROM mzv_meetings WHERE id = $1`, [id]);
  res.json({ meeting: r.rows[0] });
});

// Otevřít zpět k opravě (completed → draft). Manager nebo admin.
router.post('/meetings/:id/reopen', requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  const cur = (await query(`SELECT * FROM mzv_meetings WHERE id = $1`, [id])).rows[0];
  if (!cur) return res.status(404).json({ error: 'not_found' });
  if (!await canManage(req.user.id, req.user.role, cur.subordinate_id)) {
    return res.status(403).json({ error: 'forbidden' });
  }
  await query(`UPDATE mzv_meetings SET status = 'draft', completed_at = NULL, updated_at = NOW() WHERE id = $1`, [id]);
  const r = await query(`SELECT * FROM mzv_meetings WHERE id = $1`, [id]);
  res.json({ meeting: r.rows[0] });
});

// Smazat zápis. Manager (jeho vlastní) nebo admin.
router.delete('/meetings/:id', requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  const cur = (await query(`SELECT * FROM mzv_meetings WHERE id = $1`, [id])).rows[0];
  if (!cur) return res.status(404).json({ error: 'not_found' });
  const isMine = cur.manager_id === req.user.id;
  if (!isMine && req.user.role !== 'admin') return res.status(403).json({ error: 'forbidden' });
  await query(`DELETE FROM mzv_meetings WHERE id = $1`, [id]);
  res.json({ ok: true });
});

// AI: shrň obsah zápisu (rozhovor + priority + zlepšit + pokračovat).
// Vrátí text. Manager tohoto člověka nebo admin.
router.post('/meetings/:id/summarize', requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  const cur = (await query(`SELECT * FROM mzv_meetings WHERE id = $1`, [id])).rows[0];
  if (!cur) return res.status(404).json({ error: 'not_found' });
  if (!await canManage(req.user.id, req.user.role, cur.subordinate_id)) {
    return res.status(403).json({ error: 'forbidden' });
  }

  const parts = [
    ['Rozhovor',                cur.rozhovor],
    ['Priority na další období', cur.priorities],
    ['Co zlepšit',              cur.to_improve],
    ['V čem pokračovat',        cur.to_continue],
  ].map(([label, html]) => {
    const t = stripHtml(html);
    return t ? `## ${label}\n${t}` : null;
  }).filter(Boolean).join('\n\n');

  if (!parts.trim()) {
    return res.status(400).json({ error: 'empty_notes', message: 'Zápis je prázdný — nemám co shrnout.' });
  }

  const system = `Jsi asistent, který shrne zápis z měsíční zpětné vazby (MZV) mezi manažerem
a podřízeným. Odpověz česky, věcně, max 5 odrážek nebo 4 věty. Vytáhni klíčové body,
priority a rozhodnutí. Nevymýšlej nic, co v zápise není.`;
  const userMsg = `Shrň tento MZV zápis:\n\n${parts.slice(0, 6000)}`;

  const out = await callAI(system, userMsg, 1200);
  if (out.error) return res.status(500).json(out);
  res.json({ text: out.text });
});

// AI: navrhne úkoly ze zápisu — hlavně z Priorit a „co zlepšit". Reuse processNote.
router.post('/meetings/:id/suggest-tasks', requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  const cur = (await query(`SELECT * FROM mzv_meetings WHERE id = $1`, [id])).rows[0];
  if (!cur) return res.status(404).json({ error: 'not_found' });
  if (!await canManage(req.user.id, req.user.role, cur.subordinate_id)) {
    return res.status(403).json({ error: 'forbidden' });
  }

  // Zdroj pro AI: hlavně Priority + Co zlepšit (akční části). Rozhovor je diskuse,
  // to_continue je pochvala — z těch úkoly nedělat.
  const html = [
    cur.priorities ? `<h3>Priority</h3>${cur.priorities}` : '',
    cur.to_improve ? `<h3>Co zlepšit</h3>${cur.to_improve}` : '',
  ].join('');
  if (!stripHtml(html).trim()) {
    return res.status(400).json({ error: 'empty_notes', message: 'V zápise není nic akčního (Priority ani „Co zlepšit" nejsou vyplněné).' });
  }

  const subordinate = (await query(`SELECT name FROM users WHERE id = $1`, [cur.subordinate_id])).rows[0];
  const result = await processNote({
    noteTitle: `MZV s ${subordinate?.name || 'pracovníkem'} — ${cur.meeting_date}`,
    noteContent: html,
    action: 'suggest_tasks',
    teamId: null,       // cross-team fallback (admin/manager může vidět všechny týmy)
    userId: req.user.id,
  });
  if (result.error) return res.status(500).json(result);
  res.json(result);
});

// Seznam úkolů propojených s tímto zápisem (tasks.mzv_meeting_id).
router.get('/meetings/:id/tasks', requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  const cur = (await query(`SELECT subordinate_id FROM mzv_meetings WHERE id = $1`, [id])).rows[0];
  if (!cur) return res.status(404).json({ error: 'not_found' });
  if (!await canManage(req.user.id, req.user.role, cur.subordinate_id)) {
    return res.status(403).json({ error: 'forbidden' });
  }
  try {
    const r = await query(`
      SELECT t.id, t.title, t.status, t.priority, t.due_date, t.completed_at,
             u.name AS assignee_name, p.name AS project_name
      FROM tasks t
      LEFT JOIN users u ON u.id = t.assignee_id
      LEFT JOIN projects p ON p.id = t.project_id
      WHERE t.mzv_meeting_id = $1
      ORDER BY
        CASE t.status WHEN 'todo' THEN 0 WHEN 'in_progress' THEN 1 WHEN 'review' THEN 2 WHEN 'done' THEN 3 ELSE 4 END,
        t.due_date NULLS LAST, t.id
    `, [id]);
    res.json({ tasks: r.rows });
  } catch (err) {
    if (err.code === '42703') return res.json({ tasks: [] }); // sloupec ještě neexistuje
    throw err;
  }
});

export default router;

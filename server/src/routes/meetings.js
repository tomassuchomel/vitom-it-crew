// Porady — sekce pro pravidelné schůzky/porady.
//
// Model: meeting_types (kostra) → meetings (jednotlivé zápisy).
// Visibility:
//   - 'team': vidí členové team_id (jako notes)
//   - 'custom': vidí jen user_id v custom_users (mimo team)
//
// F1a: CRUD, prezence, editor (Tiptap JSON).
// F1b (další commit): AI sumář, agenda AI návrh, rozhodnutí blok.
// F1c: 24h deadline, follow-up mail, audit log.

import { Router } from 'express';
import { requireAuth } from '../auth.js';
import { query } from '../db.js';

const router = Router();

// Helper: uživatel má přístup k danému typu porady?
// - visibility='team': musí být člen týmu (nebo admin)
// - visibility='custom': musí být v custom_users nebo organizer nebo admin
async function canAccessType(userId, userRole, type) {
  if (userRole === 'admin') return true;
  if (type.organizer_id === userId) return true;
  if (type.visibility === 'team' && type.team_id) {
    const r = await query(
      `SELECT 1 FROM team_members WHERE user_id = $1 AND team_id = $2 LIMIT 1`,
      [userId, type.team_id]
    );
    return r.rows.length > 0;
  }
  if (type.visibility === 'custom') {
    const list = Array.isArray(type.custom_users) ? type.custom_users : [];
    return list.map(Number).includes(Number(userId));
  }
  return false;
}

// ===== Types =====

// Seznam typů porad, kam user má přístup.
router.get('/types', requireAuth, async (req, res) => {
  const uid = req.user.id;
  const isAdmin = req.user.role === 'admin';
  const r = await query(`
    SELECT t.*, tm.name AS team_name,
      u.name AS organizer_name,
      (SELECT COUNT(*)::int FROM meetings m WHERE m.type_id = t.id) AS meetings_count
    FROM meeting_types t
    LEFT JOIN teams tm ON tm.id = t.team_id
    LEFT JOIN users u ON u.id = t.organizer_id
    WHERE $2::boolean = TRUE
       OR t.organizer_id = $1
       OR (t.visibility = 'team' AND t.team_id IN (SELECT team_id FROM team_members WHERE user_id = $1))
       OR (t.visibility = 'custom' AND t.custom_users @> to_jsonb($1::int))
    ORDER BY t.name ASC
  `, [uid, isAdmin]);
  res.json({ types: r.rows });
});

// Vytvořit typ porady.
router.post('/types', requireAuth, async (req, res) => {
  const b = req.body || {};
  const name = String(b.name || '').trim().slice(0, 200);
  if (!name) return res.status(400).json({ error: 'name_required' });
  const visibility = ['team', 'custom'].includes(b.visibility) ? b.visibility : 'team';
  const teamId = visibility === 'team' ? (b.team_id ? Number(b.team_id) : req.team_id) : null;
  const customUsers = Array.isArray(b.custom_users) ? b.custom_users.map(Number).filter(Number.isFinite) : [];
  const organizerId = b.organizer_id ? Number(b.organizer_id) : req.user.id;
  const agendaTemplate = Array.isArray(b.agenda_template)
    ? b.agenda_template.filter(x => x && typeof x.text === 'string').map(x => ({ text: String(x.text).slice(0, 500) }))
    : [];

  const r = await query(`
    INSERT INTO meeting_types (team_id, name, description, agenda_template, visibility, custom_users, organizer_id, created_by)
    VALUES ($1, $2, $3, $4::jsonb, $5, $6::jsonb, $7, $8)
    RETURNING *
  `, [teamId, name, b.description || null, JSON.stringify(agendaTemplate), visibility, JSON.stringify(customUsers), organizerId, req.user.id]);
  res.status(201).json({ type: r.rows[0] });
});

// Detail typu.
router.get('/types/:id', requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  const r = await query(`
    SELECT t.*, tm.name AS team_name, u.name AS organizer_name
    FROM meeting_types t
    LEFT JOIN teams tm ON tm.id = t.team_id
    LEFT JOIN users u ON u.id = t.organizer_id
    WHERE t.id = $1
  `, [id]);
  const type = r.rows[0];
  if (!type) return res.status(404).json({ error: 'not_found' });
  if (!await canAccessType(req.user.id, req.user.role, type)) return res.status(403).json({ error: 'forbidden' });
  res.json({ type });
});

// Update typu.
router.patch('/types/:id', requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  const cur = (await query(`SELECT * FROM meeting_types WHERE id = $1`, [id])).rows[0];
  if (!cur) return res.status(404).json({ error: 'not_found' });
  // Editovat smí organizer nebo admin
  if (cur.organizer_id !== req.user.id && req.user.role !== 'admin') return res.status(403).json({ error: 'forbidden' });

  const b = req.body || {};
  const sets = [];
  const params = [];
  const push = (col, val, cast = '') => { params.push(val); sets.push(`${col} = $${params.length}${cast}`); };
  if ('name' in b)             push('name', String(b.name || '').trim().slice(0, 200));
  if ('description' in b)      push('description', b.description || null);
  if ('agenda_template' in b)  push('agenda_template', JSON.stringify(Array.isArray(b.agenda_template) ? b.agenda_template : []), '::jsonb');
  if ('visibility' in b && ['team', 'custom'].includes(b.visibility)) push('visibility', b.visibility);
  if ('team_id' in b)          push('team_id', b.team_id ? Number(b.team_id) : null);
  if ('custom_users' in b)     push('custom_users', JSON.stringify(Array.isArray(b.custom_users) ? b.custom_users.map(Number) : []), '::jsonb');
  if ('organizer_id' in b)     push('organizer_id', b.organizer_id ? Number(b.organizer_id) : null);
  if (sets.length === 0) return res.status(400).json({ error: 'no_fields' });
  sets.push('updated_at = NOW()');
  params.push(id);
  await query(`UPDATE meeting_types SET ${sets.join(', ')} WHERE id = $${params.length}`, params);
  const r = await query(`SELECT * FROM meeting_types WHERE id = $1`, [id]);
  res.json({ type: r.rows[0] });
});

// Smazat typ (cascadne meetings + edits).
router.delete('/types/:id', requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  const cur = (await query(`SELECT organizer_id FROM meeting_types WHERE id = $1`, [id])).rows[0];
  if (!cur) return res.status(404).json({ error: 'not_found' });
  if (cur.organizer_id !== req.user.id && req.user.role !== 'admin') return res.status(403).json({ error: 'forbidden' });
  await query(`DELETE FROM meeting_types WHERE id = $1`, [id]);
  res.json({ ok: true });
});

// ===== Meetings (jednotlivé zápisy) =====

// Seznam zápisů typu (chronologicky sestupně).
router.get('/types/:id/meetings', requireAuth, async (req, res) => {
  const typeId = Number(req.params.id);
  const type = (await query(`SELECT * FROM meeting_types WHERE id = $1`, [typeId])).rows[0];
  if (!type) return res.status(404).json({ error: 'not_found' });
  if (!await canAccessType(req.user.id, req.user.role, type)) return res.status(403).json({ error: 'forbidden' });

  const r = await query(`
    SELECT m.id, m.title, m.meeting_date, m.meeting_time, m.agenda_finalized_at,
           m.is_locked, m.created_at, m.updated_at,
           u.name AS created_by_name,
           (SELECT COUNT(*)::int FROM jsonb_array_elements(m.attendees) a
              WHERE (a->>'present')::boolean = TRUE) AS present_count,
           (SELECT COUNT(*)::int FROM jsonb_array_elements(m.attendees)) AS attendee_count
    FROM meetings m
    LEFT JOIN users u ON u.id = m.created_by
    WHERE m.type_id = $1
    ORDER BY m.meeting_date DESC NULLS LAST, m.created_at DESC
  `, [typeId]);
  res.json({ meetings: r.rows });
});

// Nový zápis. Předvyplní agendu z template a předvyplní attendees prázdné (šéf zaškrtá).
router.post('/types/:id/meetings', requireAuth, async (req, res) => {
  const typeId = Number(req.params.id);
  const type = (await query(`SELECT * FROM meeting_types WHERE id = $1`, [typeId])).rows[0];
  if (!type) return res.status(404).json({ error: 'not_found' });
  if (!await canAccessType(req.user.id, req.user.role, type)) return res.status(403).json({ error: 'forbidden' });

  const b = req.body || {};
  const title = String(b.title || '').trim().slice(0, 300) || `${type.name} — ${(b.meeting_date || new Date().toISOString().slice(0, 10))}`;
  const meetingDate = b.meeting_date || null;
  const meetingTime = b.meeting_time ? String(b.meeting_time).slice(0, 8) : null;

  // Předvyplněná agenda z template (source='template', checked=false).
  const template = Array.isArray(type.agenda_template) ? type.agenda_template : [];
  const agenda = template.map(t => ({ text: t.text || '', checked: false, source: 'template' }));

  const r = await query(`
    INSERT INTO meetings (type_id, title, meeting_date, meeting_time, agenda, created_by)
    VALUES ($1, $2, $3, $4, $5::jsonb, $6)
    RETURNING *
  `, [typeId, title, meetingDate, meetingTime, JSON.stringify(agenda), req.user.id]);
  res.status(201).json({ meeting: r.rows[0] });
});

// Detail zápisu.
router.get('/meetings/:id', requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  const r = await query(`
    SELECT m.*, t.name AS type_name, t.team_id, t.visibility, t.custom_users, t.organizer_id,
      u.name AS created_by_name
    FROM meetings m
    JOIN meeting_types t ON t.id = m.type_id
    LEFT JOIN users u ON u.id = m.created_by
    WHERE m.id = $1
  `, [id]);
  const m = r.rows[0];
  if (!m) return res.status(404).json({ error: 'not_found' });
  if (!await canAccessType(req.user.id, req.user.role, m)) return res.status(403).json({ error: 'forbidden' });
  res.json({ meeting: m });
});

// Update zápisu (content, agenda, attendees, title, date).
// Editovatelný pro všechny účastníky, organizer, admin (F1a — audit log přijde F1c).
router.patch('/meetings/:id', requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  const cur = (await query(`
    SELECT m.*, t.visibility, t.team_id, t.custom_users, t.organizer_id
    FROM meetings m JOIN meeting_types t ON t.id = m.type_id
    WHERE m.id = $1
  `, [id])).rows[0];
  if (!cur) return res.status(404).json({ error: 'not_found' });
  if (!await canAccessType(req.user.id, req.user.role, cur)) return res.status(403).json({ error: 'forbidden' });
  if (cur.is_locked && cur.organizer_id !== req.user.id && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'locked', message: 'Zápis je zamknutý pro editaci.' });
  }

  const b = req.body || {};
  const sets = [];
  const params = [];
  const push = (col, val, cast = '') => { params.push(val); sets.push(`${col} = $${params.length}${cast}`); };

  if ('title' in b)         push('title', String(b.title || '').trim().slice(0, 300));
  if ('meeting_date' in b)  push('meeting_date', b.meeting_date || null);
  if ('meeting_time' in b)  push('meeting_time', b.meeting_time ? String(b.meeting_time).slice(0, 8) : null);
  if ('content_json' in b)  push('content_json', JSON.stringify(b.content_json || { type: 'doc', content: [] }), '::jsonb');
  if ('agenda' in b)        push('agenda', JSON.stringify(Array.isArray(b.agenda) ? b.agenda : []), '::jsonb');
  if ('attendees' in b)     push('attendees', JSON.stringify(Array.isArray(b.attendees) ? sanitizeAttendees(b.attendees) : []), '::jsonb');
  if ('agenda_finalized_at' in b) push('agenda_finalized_at', b.agenda_finalized_at ? new Date(b.agenda_finalized_at) : null);
  if ('agenda_source' in b)       push('agenda_source', b.agenda_source || null);
  if (sets.length === 0) return res.status(400).json({ error: 'no_fields' });
  sets.push('updated_at = NOW()');
  params.push(id);
  await query(`UPDATE meetings SET ${sets.join(', ')} WHERE id = $${params.length}`, params);
  const r = await query(`SELECT * FROM meetings WHERE id = $1`, [id]);
  res.json({ meeting: r.rows[0] });
});

// Sanitize attendees array — chrání DB proti garbage.
function sanitizeAttendees(list) {
  return list.map(a => {
    const out = { present: !!a.present };
    if (a.user_id) out.user_id = Number(a.user_id);
    if (a.guest_name) out.guest_name = String(a.guest_name).slice(0, 200);
    if (a.guest_email) out.guest_email = String(a.guest_email).slice(0, 200);
    return out;
  });
}

// Smazat zápis.
router.delete('/meetings/:id', requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  const cur = (await query(`
    SELECT m.created_by, t.organizer_id
    FROM meetings m JOIN meeting_types t ON t.id = m.type_id
    WHERE m.id = $1
  `, [id])).rows[0];
  if (!cur) return res.status(404).json({ error: 'not_found' });
  if (cur.created_by !== req.user.id && cur.organizer_id !== req.user.id && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'forbidden' });
  }
  await query(`DELETE FROM meetings WHERE id = $1`, [id]);
  res.json({ ok: true });
});

export default router;

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
import { callAI, stripHtml, collectPrevContext, generateAgendaSuggestion } from '../meetingsAi.js';
import { sendMail } from '../mailer.js';

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
              WHERE a->>'status' IN ('present', 'late')
                 OR (a->>'status' IS NULL AND (a->>'present')::boolean = TRUE)) AS present_count,
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

  // Audit log — sesbírej změny klíčových polí (title, date, agenda, content, attendees).
  // Před save si uložíme snapshot těch, co se mění. Jen krátká hodnota → JSONB.
  const auditChanges = [];
  const truncate = (v) => typeof v === 'string' ? v.slice(0, 4000) : v;
  const truncateJson = (v) => {
    const s = typeof v === 'string' ? v : JSON.stringify(v || null);
    return s.length > 4000 ? s.slice(0, 4000) + '…' : s;
  };

  if ('title' in b) {
    push('title', String(b.title || '').trim().slice(0, 300));
    if (String(b.title || '') !== String(cur.title || '')) {
      auditChanges.push({ type: 'title', before: cur.title, after: String(b.title).slice(0, 300) });
    }
  }
  if ('meeting_date' in b) {
    push('meeting_date', b.meeting_date || null);
    if (String(b.meeting_date || '') !== String(cur.meeting_date || '').slice(0, 10)) {
      auditChanges.push({ type: 'date', before: cur.meeting_date, after: b.meeting_date });
    }
  }
  if ('meeting_time' in b) {
    push('meeting_time', b.meeting_time ? String(b.meeting_time).slice(0, 8) : null);
  }
  if ('content_json' in b) {
    const newContent = typeof b.content_json === 'string' ? b.content_json : JSON.stringify(b.content_json);
    push('content_json', JSON.stringify(b.content_json || ''), '::jsonb');
    const oldContent = typeof cur.content_json === 'string' ? cur.content_json : JSON.stringify(cur.content_json || '');
    if (oldContent !== newContent) {
      auditChanges.push({ type: 'notes', before: truncate(oldContent), after: truncate(newContent) });
    }
  }
  if ('agenda' in b) {
    push('agenda', JSON.stringify(Array.isArray(b.agenda) ? b.agenda : []), '::jsonb');
    auditChanges.push({ type: 'agenda', before: cur.agenda, after: b.agenda });
  }
  if ('attendees' in b) {
    push('attendees', JSON.stringify(Array.isArray(b.attendees) ? sanitizeAttendees(b.attendees) : []), '::jsonb');
    auditChanges.push({ type: 'attendees', before: cur.attendees, after: sanitizeAttendees(b.attendees) });
  }
  if ('agenda_finalized_at' in b) push('agenda_finalized_at', b.agenda_finalized_at ? new Date(b.agenda_finalized_at) : null);
  if ('agenda_source' in b)       push('agenda_source', b.agenda_source || null);
  if (sets.length === 0) return res.status(400).json({ error: 'no_fields' });
  sets.push('updated_at = NOW()');
  params.push(id);
  await query(`UPDATE meetings SET ${sets.join(', ')} WHERE id = $${params.length}`, params);

  // Zapiš audit log fire-and-forget (neblokuje response).
  for (const c of auditChanges) {
    query(`
      INSERT INTO meeting_edits (meeting_id, editor_id, change_type, before_value, after_value)
      VALUES ($1, $2, $3, $4::jsonb, $5::jsonb)
    `, [id, req.user.id, c.type, JSON.stringify(truncateJson(c.before)), JSON.stringify(truncateJson(c.after))])
      .catch(err => console.warn('[meetings/audit]', c.type, err.message));
  }

  const r = await query(`SELECT * FROM meetings WHERE id = $1`, [id]);
  res.json({ meeting: r.rows[0] });
});

// Sanitize attendees array — chrání DB proti garbage.
// status: 'present' | 'late' | 'missed'. Backward compat: pokud přijde jen
// `present: bool`, přeložíme na status ('present' nebo 'missed').
const VALID_STATUS = ['present', 'late', 'missed'];
function sanitizeAttendees(list) {
  return list.map(a => {
    let status = a.status;
    if (!VALID_STATUS.includes(status)) {
      // Backward-compat: převod present: true|false → present|missed.
      status = a.present === true ? 'present' : a.present === false ? 'missed' : 'present';
    }
    const out = { status };
    if (a.user_id) out.user_id = Number(a.user_id);
    if (a.guest_name) out.guest_name = String(a.guest_name).slice(0, 200);
    if (a.guest_email) out.guest_email = String(a.guest_email).slice(0, 200);
    return out;
  });
}

// AI: shrnutí předchozích porad + status úkolů + doporučení co řešit.
router.post('/meetings/:id/summary', requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  const cur = (await query(`
    SELECT m.*, t.name AS type_name, t.team_id, t.visibility, t.custom_users, t.organizer_id
    FROM meetings m JOIN meeting_types t ON t.id = m.type_id
    WHERE m.id = $1
  `, [id])).rows[0];
  if (!cur) return res.status(404).json({ error: 'not_found' });
  if (!await canAccessType(req.user.id, req.user.role, cur)) return res.status(403).json({ error: 'forbidden' });

  const { previousMeetings, relatedTasks } = await collectPrevContext(cur.type_id, id);
  if (previousMeetings.length === 0) {
    return res.json({ text: '_Zatím nejsou žádné předchozí porady tohoto typu — první zápis._', empty: true });
  }

  const prevSummary = previousMeetings.map(m => ({
    date: m.meeting_date,
    title: m.title,
    notes: stripHtml(typeof m.content_json === 'string' ? m.content_json : JSON.stringify(m.content_json)).slice(0, 1500),
    agenda: Array.isArray(m.agenda) ? m.agenda.map(a => `${a.checked ? '✓' : '○'} ${a.text}`).join('; ') : '',
  }));
  const tasksSummary = relatedTasks.map(t => ({
    title: t.title,
    status: t.status,
    assignee: t.assignee_name,
    due: t.due_date,
    completed: t.completed_at,
    overdue: t.status !== 'done' && t.due_date && new Date(t.due_date) < new Date(),
  }));

  const system = `Jsi asistent pro pracovní porady. Shrneš předchozí porady a stav úkolů, které z nich vzešly. Píšeš česky, věcně, strukturovaně.`;
  const userMsg = `Typ porady: "${cur.type_name}"
Aktuální zápis (${cur.meeting_date}): "${cur.title}"

PŘEDCHOZÍ ZÁPISY (od nejnovějšího):
${JSON.stringify(prevSummary, null, 2)}

ÚKOLY vzešlé z předchozích porad:
${JSON.stringify(tasksSummary, null, 2)}

VYTVOŘ SHRNUTÍ v tomto formátu (Markdown, česky):

## Co se dělo v minulých poradách
(2-4 věty přehledu, klíčové body / trendy)

## Úkoly — status
- ✅ **Splněné včas** (počet + krátký seznam)
- ⏰ **Splněné pozdě** (počet + kdo)
- 🔥 **Nesplněné po termínu** (počet + kdo + jaké úkoly)
- ▶️ **Rozpracované** (počet)

## 📌 Doporučení k řešení dnes
(3-5 konkrétních bodů, na co se v této poradě zaměřit — návazně na výše. Konkrétní jména a úkoly.)`;

  const out = await callAI(system, userMsg, 2500);
  if (out.error) return res.status(500).json(out);
  res.json({ text: out.text });
});

// AI: návrh bodů agendy pro tento zápis (dopředu, před poradou).
router.post('/meetings/:id/agenda-suggest', requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  const cur = (await query(`
    SELECT m.*, t.name AS name_for_type, t.agenda_template, t.team_id, t.visibility, t.custom_users, t.organizer_id
    FROM meetings m JOIN meeting_types t ON t.id = m.type_id
    WHERE m.id = $1
  `, [id])).rows[0];
  if (!cur) return res.status(404).json({ error: 'not_found' });
  if (!await canAccessType(req.user.id, req.user.role, cur)) return res.status(403).json({ error: 'forbidden' });

  const type = { id: cur.type_id, name: cur.name_for_type, agenda_template: cur.agenda_template };
  const out = await generateAgendaSuggestion(cur, type);
  if (out.error) return res.status(500).json(out.error);
  res.json({ items: out.items });
});

// Follow-up mail účastníkům po zápisu. Každý účastník (user_id nebo guest)
// dostane email s vlastními úkoly + termíny (tasks.meeting_id = tento zápis).
// Šéf (organizer) dostane přehled všech úkolů.
router.post('/meetings/:id/followup', requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  const cur = (await query(`
    SELECT m.*, t.name AS type_name, t.team_id, t.visibility, t.custom_users, t.organizer_id
    FROM meetings m JOIN meeting_types t ON t.id = m.type_id WHERE m.id = $1
  `, [id])).rows[0];
  if (!cur) return res.status(404).json({ error: 'not_found' });
  if (!await canAccessType(req.user.id, req.user.role, cur)) return res.status(403).json({ error: 'forbidden' });
  if (cur.organizer_id !== req.user.id && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'forbidden', message: 'Follow-up smí poslat jen organizátor nebo admin.' });
  }

  // Attendees kdo byli přítomni (present nebo late — jen missed vynecháme).
  // Backward-compat: staré záznamy s present: true.
  const attendees = Array.isArray(cur.attendees) ? cur.attendees.filter(a => {
    if (a.status) return a.status === 'present' || a.status === 'late';
    return a.present === true;
  }) : [];
  if (attendees.length === 0) return res.status(400).json({ error: 'no_attendees', message: 'Nikdo nebyl označen jako přítomný.' });

  // Úkoly propojené s tímto zápisem
  const tasksR = await query(`
    SELECT t.id, t.title, t.due_date, t.priority, t.assignee_id, u.name AS assignee_name
    FROM tasks t LEFT JOIN users u ON u.id = t.assignee_id
    WHERE t.meeting_id = $1
  `, [id]);
  const tasks = tasksR.rows;

  // Emails per attendee
  let sent = 0;
  const meetingUrl = `${process.env.CLIENT_URL || ''}/porady`;
  const dateStr = cur.meeting_date ? new Date(cur.meeting_date).toLocaleDateString('cs-CZ') : '';

  const respond = (email, ownTasks, isOrganizer) => {
    const listHtml = (isOrganizer ? tasks : ownTasks).map(t => `
      <li>
        <strong>${escapeMail(t.title)}</strong>
        ${t.due_date ? ` — termín ${new Date(t.due_date).toLocaleDateString('cs-CZ')}` : ''}
        ${isOrganizer && t.assignee_name ? ` <span style="color:#5b7177">(${escapeMail(t.assignee_name)})</span>` : ''}
      </li>`).join('') || '<li><em>Žádné úkoly nevzešly.</em></li>';
    const html = `<!DOCTYPE html><html><body style="font-family:sans-serif;padding:20px;color:#1f3a40">
      <div style="max-width:560px;margin:auto;background:white;border-radius:8px;padding:20px">
        <div style="color:#e72b78;font-weight:bold;font-size:11px;letter-spacing:0.15em">VITOM PORADY</div>
        <h2 style="margin:8px 0">Zápis: ${escapeMail(cur.title)}</h2>
        <div style="color:#5b7177;font-size:13px">${dateStr} · ${escapeMail(cur.type_name)}</div>
        <h3 style="margin-top:16px">${isOrganizer ? 'Všechny úkoly z porady' : 'Tvoje úkoly z porady'}</h3>
        <ul style="font-size:14px;line-height:1.6">${listHtml}</ul>
        <div style="margin-top:20px;padding-top:12px;border-top:1px solid #e2dcd3;font-size:12px;color:#5b7177">
          <a href="${meetingUrl}" style="color:#e72b78">Otevřít zápis v aplikaci →</a>
        </div>
      </div></body></html>`;
    return sendMail({ to: email, subject: `Porada ${dateStr}: ${cur.title}`, html })
      .then(() => sent++).catch(err => console.warn('[followup]', email, err.message));
  };

  const promises = [];
  for (const a of attendees) {
    if (a.user_id) {
      const uR = await query(`SELECT email, name FROM users WHERE id = $1`, [a.user_id]);
      if (uR.rows[0]?.email) {
        const isOrg = a.user_id === cur.organizer_id;
        const own = tasks.filter(t => t.assignee_id === a.user_id);
        promises.push(respond(uR.rows[0].email, own, isOrg));
      }
    } else if (a.guest_email) {
      // Guest: nemá tasks (user_id NULL), pošleme všechny úkoly jako informaci
      promises.push(respond(a.guest_email, [], false));
    }
  }
  await Promise.all(promises);

  await query(`UPDATE meetings SET followed_up_at = NOW() WHERE id = $1`, [id]);
  res.json({ ok: true, sent, total: attendees.length });
});

function escapeMail(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Audit log editací — poslední 20 změn.
router.get('/meetings/:id/edits', requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  const m = (await query(`
    SELECT t.team_id, t.visibility, t.custom_users, t.organizer_id
    FROM meetings mm JOIN meeting_types t ON t.id = mm.type_id WHERE mm.id = $1
  `, [id])).rows[0];
  if (!m) return res.status(404).json({ error: 'not_found' });
  if (!await canAccessType(req.user.id, req.user.role, m)) return res.status(403).json({ error: 'forbidden' });

  const r = await query(`
    SELECT e.id, e.change_type, e.before_value, e.after_value, e.edited_at,
           u.name AS editor_name
    FROM meeting_edits e LEFT JOIN users u ON u.id = e.editor_id
    WHERE e.meeting_id = $1
    ORDER BY e.edited_at DESC
    LIMIT 20
  `, [id]);
  res.json({ edits: r.rows });
});

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

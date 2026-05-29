// Poznámky – hierarchický strom (množina / podmnožina), team-scoped.
//
//   GET    /api/notes          – všechny poznámky current teamu (flat; FE staví strom)
//   POST   /api/notes          – nová poznámka { title?, content?, parent_id? }
//   PUT    /api/notes/:id      – edit { title?, content?, parent_id?, position? }
//   DELETE /api/notes/:id      – smazat (kaskáda na podpoznámky)
//
// Návrh pro budoucí AI agenta (Fáze 2): title + content jsou strukturovaný
// vstup, parent_id dává hierarchický kontext. AI bude umět načíst celý strom
// a vytvořit z něj úkoly do projektů/teamů s přiřazením a termíny.

import { Router } from 'express';
import multer from 'multer';
import { query } from '../db.js';
import { requireAuth } from '../auth.js';
import { askTeamAssistant, processNote, HAS_AI } from '../ai.js';

const router = Router();

// Audio z porady drží multer v RAM. Whisper má limit 25 MB na soubor.
const audioUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

// Přepis nahrávky porady přes OpenAI Whisper. Multipart pole 'audio'.
// Vrací { text }. Vyžaduje OPENAI_API_KEY (Anthropic speech-to-text nemá).
router.post('/transcribe', requireAuth, audioUpload.single('audio'), async (req, res) => {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return res.status(503).json({ error: 'no_openai_key', message: 'Přepis vyžaduje OPENAI_API_KEY v server/.env (Whisper). Anthropic speech-to-text nemá.' });
  if (!req.file) return res.status(400).json({ error: 'no_audio' });
  try {
    const form = new FormData();
    form.append('file', new Blob([req.file.buffer], { type: req.file.mimetype || 'audio/webm' }), 'porada.webm');
    form.append('model', 'whisper-1');
    form.append('language', 'cs');
    const r = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}` },
      body: form,
    });
    if (!r.ok) {
      const txt = await r.text();
      console.error('[notes/transcribe] whisper', r.status, txt.slice(0, 300));
      return res.status(502).json({ error: 'whisper_error', message: txt.slice(0, 300) });
    }
    const data = await r.json();
    res.json({ text: data.text || '' });
  } catch (err) {
    console.error('[notes/transcribe]', err);
    res.status(500).json({ error: 'server_error', message: err.message });
  }
});

// AI asistent – odpovídá na otázky nad poznámkami + daty týmu.
// Body: { question, history?: [{role, content}] }. Team scope z req.team_id.
router.post('/ai-ask', requireAuth, async (req, res) => {
  if (!req.team_id) return res.status(400).json({ error: 'no_team_context' });
  if (!HAS_AI) return res.status(503).json({ error: 'no_api_key', message: 'AI není nakonfigurované (ANTHROPIC_API_KEY).' });
  const { question, history } = req.body || {};
  try {
    const result = await askTeamAssistant({ question, history, teamId: req.team_id, userId: req.user.id });
    if (result.error) return res.status(result.error === 'api_error' ? 502 : 400).json(result);
    res.json(result);
  } catch (err) {
    console.error('[notes/ai-ask]', err);
    res.status(500).json({ error: 'server_error', message: err.message });
  }
});

// AI zpracování konkrétní poznámky. Body: { action: 'summarize'|'suggest_tasks' }.
// Vrací návrh (text) – nic nezakládá. Smí autor / čtenář poznámky.
router.post('/:id/ai-process', requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'invalid_id' });
  if (!HAS_AI) return res.status(503).json({ error: 'no_api_key', message: 'AI není nakonfigurované (ANTHROPIC_API_KEY).' });
  const action = req.body?.action === 'suggest_tasks' ? 'suggest_tasks' : 'summarize';

  const note = (await query(`SELECT id, title, content, team_id, user_id, visibility FROM notes WHERE id = $1`, [id])).rows[0];
  if (!note) return res.status(404).json({ error: 'not_found' });
  // Přístup: osobní → jen autor; jinak člen teamu poznámky nebo admin.
  const ok = note.visibility === 'personal'
    ? note.user_id === req.user.id
    : (req.user.role === 'admin' || note.team_id === req.team_id);
  if (!ok) return res.status(403).json({ error: 'forbidden' });

  try {
    const result = await processNote({
      noteTitle: note.title, noteContent: note.content, action, teamId: note.team_id,
    });
    if (result.error) return res.status(result.error === 'api_error' ? 502 : 400).json(result);
    res.json(result);
  } catch (err) {
    console.error('[notes/ai-process]', err);
    res.status(500).json({ error: 'server_error', message: err.message });
  }
});

// List – flat array (FE poskládá strom).
//
// ?scope=team|personal|shared:
//   - team (default):  visibility='team' – vidí všichni v teamu
//   - personal:        visibility='personal' AND user_id=me – jen moje soukromé
//   - shared:          poznámky sdílené se mnou přes note_shares (read-only;
//                      mohou být z jiných teamů). Ploché, bez hierarchie.
//
// Řazení: parent (NULLS first = top-level), pak position, pak created_at.
router.get('/', requireAuth, async (req, res) => {
  const scope = ['personal', 'shared'].includes(req.query.scope) ? req.query.scope : 'team';

  // Shared scope – nezávisí na team kontextu, vrací poznámky sdílené s uživatelem.
  if (scope === 'shared') {
    const r = await query(`
      SELECT n.id, n.team_id, n.parent_id, n.user_id, n.title, n.content,
             n.position, n.visibility, n.drawing, n.ai_processed_at, n.created_at, n.updated_at,
             u.name AS author_name, TRUE AS shared, ns.created_at AS shared_at
      FROM note_shares ns
      JOIN notes n ON n.id = ns.note_id
      LEFT JOIN users u ON u.id = n.user_id
      WHERE ns.shared_with_user_id = $1
      ORDER BY ns.created_at DESC
    `, [req.user.id]);
    return res.json({ notes: r.rows, scope });
  }

  if (!req.team_id) return res.json({ notes: [], scope });

  let where, params;
  if (scope === 'personal') {
    where = `n.team_id = $1 AND n.visibility = 'personal' AND n.user_id = $2`;
    params = [req.team_id, req.user.id];
  } else {
    where = `n.team_id = $1 AND n.visibility = 'team'`;
    params = [req.team_id];
  }

  const r = await query(`
    SELECT n.id, n.team_id, n.parent_id, n.user_id, n.title, n.content,
           n.position, n.visibility, n.drawing, n.ai_processed_at, n.created_at, n.updated_at,
           u.name AS author_name,
           FALSE AS shared,
           (SELECT COUNT(*) FROM note_shares ns WHERE ns.note_id = n.id)::int AS share_count
    FROM notes n
    LEFT JOIN users u ON u.id = n.user_id
    WHERE ${where}
    ORDER BY n.parent_id NULLS FIRST, n.position ASC, n.created_at ASC
  `, params);
  res.json({ notes: r.rows, scope });
});

// Sdílet poznámku s uživatelem. Smí jen autor poznámky.
// Body: { user_id }
router.post('/:id/share', requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  const targetUserId = Number(req.body?.user_id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'invalid_id' });
  if (!Number.isInteger(targetUserId) || targetUserId <= 0) return res.status(400).json({ error: 'invalid_user_id' });
  if (targetUserId === req.user.id) return res.status(400).json({ error: 'cannot_share_with_self' });

  const note = (await query(`SELECT id, user_id FROM notes WHERE id = $1`, [id])).rows[0];
  if (!note) return res.status(404).json({ error: 'not_found' });
  if (note.user_id !== req.user.id) return res.status(403).json({ error: 'only_author_can_share' });

  await query(`
    INSERT INTO note_shares (note_id, shared_with_user_id, shared_by)
    VALUES ($1, $2, $3)
    ON CONFLICT (note_id, shared_with_user_id) DO NOTHING
  `, [id, targetUserId, req.user.id]);
  res.json({ ok: true });
});

// Zrušit sdílení.
router.delete('/:id/share/:userId', requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  const targetUserId = Number(req.params.userId);
  const note = (await query(`SELECT user_id FROM notes WHERE id = $1`, [id])).rows[0];
  if (!note) return res.status(404).json({ error: 'not_found' });
  if (note.user_id !== req.user.id) return res.status(403).json({ error: 'only_author_can_share' });
  await query(`DELETE FROM note_shares WHERE note_id = $1 AND shared_with_user_id = $2`, [id, targetUserId]);
  res.json({ ok: true });
});

// Seznam uživatelů, se kterými je poznámka sdílená (pro share modal).
router.get('/:id/shares', requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  const note = (await query(`SELECT user_id FROM notes WHERE id = $1`, [id])).rows[0];
  if (!note) return res.status(404).json({ error: 'not_found' });
  if (note.user_id !== req.user.id) return res.status(403).json({ error: 'forbidden' });
  const r = await query(`
    SELECT ns.shared_with_user_id AS user_id, u.name, u.email, ns.created_at
    FROM note_shares ns JOIN users u ON u.id = ns.shared_with_user_id
    WHERE ns.note_id = $1 ORDER BY ns.created_at DESC
  `, [id]);
  res.json({ shares: r.rows });
});

// Create – v current teamu. parent_id volitelné (podpoznámka).
// visibility: 'team' (default) | 'personal'. Pokud má rodiče, DĚDÍ jeho
// visibility (strom je celý týmový nebo celý osobní – nemícháme).
router.post('/', requireAuth, async (req, res) => {
  if (!req.team_id) return res.status(400).json({ error: 'no_team_context' });
  const { title, content, parent_id } = req.body || {};
  let visibility = req.body.visibility === 'personal' ? 'personal' : 'team';

  // Validace parent_id – musí být poznámka ze stejného teamu; dědí visibility
  let parentId = null;
  if (parent_id) {
    const p = await query(
      `SELECT id, visibility, user_id FROM notes WHERE id = $1 AND team_id = $2`,
      [Number(parent_id), req.team_id]
    );
    if (!p.rows[0]) return res.status(400).json({ error: 'invalid_parent' });
    // Osobní strom smí rozšiřovat jen jeho autor
    if (p.rows[0].visibility === 'personal' && p.rows[0].user_id !== req.user.id) {
      return res.status(403).json({ error: 'forbidden' });
    }
    parentId = Number(parent_id);
    visibility = p.rows[0].visibility; // dědění
  }

  // position = max+1 mezi sourozenci
  const posR = await query(
    `SELECT COALESCE(MAX(position), -1) + 1 AS next_pos FROM notes
     WHERE team_id = $1 AND parent_id IS NOT DISTINCT FROM $2`,
    [req.team_id, parentId]
  );
  const position = posR.rows[0].next_pos;

  const r = await query(`
    INSERT INTO notes (team_id, parent_id, user_id, title, content, position, visibility)
    VALUES ($1, $2, $3, $4, $5, $6, $7)
    RETURNING *
  `, [req.team_id, parentId, req.user.id, (title || 'Nová poznámka').slice(0, 300), content || null, position, visibility]);
  res.json({ note: r.rows[0] });
});

// Edit – title / content / parent_id / position. Jen poznámka current teamu.
router.put('/:id', requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'invalid_id' });
  const cur = (await query(`SELECT * FROM notes WHERE id = $1`, [id])).rows[0];
  if (!cur) return res.status(404).json({ error: 'not_found' });
  if (!canTouchNote(req, cur)) return res.status(403).json({ error: 'forbidden' });

  // Reparent – validuj že nový rodič je ve stejném teamu a není to potomek (cyklus).
  let nextParent = cur.parent_id;
  if ('parent_id' in req.body) {
    const np = req.body.parent_id;
    if (np == null || np === '') {
      nextParent = null;
    } else {
      const npId = Number(np);
      if (npId === id) return res.status(400).json({ error: 'cannot_parent_self' });
      const p = await query(`SELECT id FROM notes WHERE id = $1 AND team_id = $2`, [npId, cur.team_id]);
      if (!p.rows[0]) return res.status(400).json({ error: 'invalid_parent' });
      // Cyklus check – nový rodič nesmí být potomek této poznámky
      const descendants = await collectDescendantIds(id);
      if (descendants.has(npId)) return res.status(400).json({ error: 'would_create_cycle' });
      nextParent = npId;
    }
  }

  const next = {
    title:    'title'    in req.body ? String(req.body.title || '').slice(0, 300) : cur.title,
    content:  'content'  in req.body ? (req.body.content ?? null) : cur.content,
    position: 'position' in req.body ? Number(req.body.position) || 0 : cur.position,
    parent_id: nextParent,
    // drawing = PNG data URL overlay kresby (nebo null pro smazání kresby)
    drawing:  'drawing'  in req.body ? (req.body.drawing ?? null) : cur.drawing,
  };

  const r = await query(`
    UPDATE notes SET title = $1, content = $2, position = $3, parent_id = $4, drawing = $5, updated_at = NOW()
    WHERE id = $6 RETURNING *
  `, [next.title, next.content, next.position, next.parent_id, next.drawing, id]);
  res.json({ note: r.rows[0] });
});

// Smazat – kaskáda na podpoznámky (FK ON DELETE CASCADE).
router.delete('/:id', requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  const cur = (await query(`SELECT team_id, visibility, user_id FROM notes WHERE id = $1`, [id])).rows[0];
  if (!cur) return res.status(404).json({ error: 'not_found' });
  if (!canTouchNote(req, cur)) return res.status(403).json({ error: 'forbidden' });
  await query(`DELETE FROM notes WHERE id = $1`, [id]);
  res.json({ ok: true });
});

// Oprávnění na poznámku:
//   - osobní poznámka: jen autor (ani admin nečte cizí soukromé)
//   - týmová poznámka: člen teamu (cur.team_id == req.team_id) nebo admin
function canTouchNote(req, note) {
  if (note.visibility === 'personal') {
    return note.user_id === req.user.id;
  }
  return req.user.role === 'admin' || note.team_id === req.team_id;
}

// Pomocná: vrátí Set všech ID potomků dané poznámky (rekurzivně) – pro cyklus check.
async function collectDescendantIds(rootId) {
  const set = new Set();
  let frontier = [rootId];
  while (frontier.length) {
    const r = await query(`SELECT id FROM notes WHERE parent_id = ANY($1::int[])`, [frontier]);
    frontier = [];
    for (const row of r.rows) {
      if (!set.has(row.id)) { set.add(row.id); frontier.push(row.id); }
    }
  }
  return set;
}

export default router;

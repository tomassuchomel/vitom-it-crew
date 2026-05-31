// Email agent — Phase 1: OAuth M365 + zobrazení posledních zpráv.
//
// Routes:
//   GET  /status              → { configured, connected, email }
//   GET  /connect             → redirect na MS authorize URL (CSRF state v session)
//   GET  /callback            → MS po loginu vrací sem (code + state). Uložíme tokeny → redirect /email
//   POST /disconnect          → smaž connection (auth)
//   GET  /messages            → posledních 20 z Inboxu (auth)

import express from 'express';
import { requireAuth } from '../auth.js';
import { query } from '../db.js';
import {
  isMsConfigured, msConfigStatus,
  authorizeUrl, consumeState, exchangeCodeForTokens, saveConnection,
  getValidAccessToken, fetchInbox, disconnect, getConnectionStatus,
} from '../msGraph.js';
import { classifyEmails, extractTasksFromEmail } from '../emailAi.js';

const router = express.Router();

router.get('/status', requireAuth, async (req, res) => {
  const conn = await getConnectionStatus(req.user.id);
  res.json({
    configured: isMsConfigured(),
    connected:  !!conn,
    email:      conn?.ms_email || null,
    connected_at: conn?.connected_at || null,
    last_sync_at: conn?.last_sync_at || null,
    config:     msConfigStatus(),
  });
});

router.get('/connect', requireAuth, (req, res) => {
  if (!isMsConfigured()) {
    return res.status(503).json({ error: 'not_configured', config: msConfigStatus() });
  }
  res.redirect(authorizeUrl(req.user.id));
});

// MS callback. Pozor: requireAuth musíme udělat trochu jinak — user může být
// odhlášený, ale state nese userId. Pro jednoduchost vyžadujeme i auth cookie
// (uživatel zůstává přihlášený během OAuth flow, redirect zpět do stejné session).
router.get('/callback', requireAuth, async (req, res) => {
  const { code, state, error: msError, error_description } = req.query;
  if (msError) {
    return res.status(400).send(`MS OAuth error: ${msError} — ${error_description || ''}`);
  }
  const userIdFromState = consumeState(String(state || ''));
  if (!userIdFromState || userIdFromState !== req.user.id) {
    return res.status(400).send('OAuth state mismatch — zkus „Propojit Outlook" znovu.');
  }
  try {
    const tokenData = await exchangeCodeForTokens(String(code));
    const { email } = await saveConnection(req.user.id, tokenData);
    // Redirect zpět do appky na /email
    res.redirect(`/email?connected=${encodeURIComponent(email)}`);
  } catch (err) {
    console.error('[email/callback]', err);
    res.status(500).send(`Připojení selhalo: ${err.message?.slice(0, 400) || err}`);
  }
});

router.post('/disconnect', requireAuth, async (req, res) => {
  await disconnect(req.user.id);
  res.json({ ok: true });
});

router.get('/messages', requireAuth, async (req, res) => {
  const token = await getValidAccessToken(req.user.id);
  if (!token) return res.status(401).json({ error: 'not_connected', message: 'Outlook není propojený nebo refresh selhal — připoj znovu.' });
  try {
    const top = Math.min(50, Number(req.query.top) || 20);
    const messages = await fetchInbox(token, { top });
    // K message připojíme existující klasifikaci (pokud je v DB).
    const ids = messages.map(m => m.id);
    let byId = {};
    if (ids.length > 0) {
      const r = await query(
        `SELECT message_id, category, summary, confidence, classified_at
         FROM email_classifications WHERE user_id = $1 AND message_id = ANY($2::text[])`,
        [req.user.id, ids]
      );
      byId = Object.fromEntries(r.rows.map(row => [row.message_id, row]));
    }
    const enriched = messages.map(m => ({ ...m, classification: byId[m.id] || null }));
    res.json({ messages: enriched });
  } catch (err) {
    console.error('[email/messages]', err);
    res.status(502).json({ error: 'graph_error', message: err.message?.slice(0, 300) });
  }
});

// AI klasifikace všech ne-klasifikovaných zpráv (jeden Claude batch call).
// Pošli `messages` = pole { id, subject, from, bodyPreview } z UI; uložíme klasifikace do DB.
router.post('/classify', requireAuth, async (req, res) => {
  const list = Array.isArray(req.body?.messages) ? req.body.messages : [];
  if (list.length === 0) return res.json({ classified: 0, results: [] });

  try {
    const results = await classifyEmails(list);
    if (results.error) return res.status(502).json(results);

    // Bulk insert (ON CONFLICT update).
    for (const r of results.items) {
      await query(
        `INSERT INTO email_classifications (user_id, message_id, category, summary, confidence)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (user_id, message_id) DO UPDATE
           SET category = EXCLUDED.category,
               summary = EXCLUDED.summary,
               confidence = EXCLUDED.confidence,
               classified_at = NOW()`,
        [req.user.id, r.message_id, r.category, r.summary || null, r.confidence || null]
      );
    }
    res.json({ classified: results.items.length, results: results.items });
  } catch (err) {
    console.error('[email/classify]', err);
    res.status(500).json({ error: 'server_error', message: err.message });
  }
});

// AI vytáhne úkoly z jednoho emailu. Vrátí strukturu kompatibilní se
// SuggestedTasksModal (available_projects, available_members, tasks).
router.post('/:msgId/extract-tasks', requireAuth, async (req, res) => {
  const token = await getValidAccessToken(req.user.id);
  if (!token) return res.status(401).json({ error: 'not_connected' });
  const msgId = String(req.params.msgId);

  // Stáhneme detail emailu (subject + body) z Graphu.
  let msg;
  try {
    const r = await fetch(`https://graph.microsoft.com/v1.0/me/messages/${encodeURIComponent(msgId)}?$select=id,subject,from,body,bodyPreview`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!r.ok) throw new Error(`Graph message ${r.status}: ${(await r.text()).slice(0, 300)}`);
    msg = await r.json();
  } catch (err) {
    return res.status(502).json({ error: 'graph_error', message: err.message?.slice(0, 300) });
  }

  try {
    const result = await extractTasksFromEmail(msg, { userId: req.user.id, teamId: req.team_id });
    if (result.error) return res.status(502).json(result);
    res.json(result);
  } catch (err) {
    console.error('[email/extract-tasks]', err);
    res.status(500).json({ error: 'server_error', message: err.message });
  }
});

export default router;

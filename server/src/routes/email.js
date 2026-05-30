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
import {
  isMsConfigured, msConfigStatus,
  authorizeUrl, consumeState, exchangeCodeForTokens, saveConnection,
  getValidAccessToken, fetchInbox, disconnect, getConnectionStatus,
} from '../msGraph.js';

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
    res.json({ messages });
  } catch (err) {
    console.error('[email/messages]', err);
    res.status(502).json({ error: 'graph_error', message: err.message?.slice(0, 300) });
  }
});

export default router;

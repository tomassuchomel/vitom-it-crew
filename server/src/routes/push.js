// Web Push subscriptions routes.
//
//   GET  /vapid-public-key   → vrátí veřejný klíč (anon, klient ho potřebuje k subscribe)
//   POST /subscribe          → uloží subscription do DB (auth)
//   POST /unsubscribe        → smaže subscription dle endpoint (auth)
//   POST /test               → pošle testovací push aktuálnímu userovi (auth)

import express from 'express';
import { requireAuth } from '../auth.js';
import { query } from '../db.js';
import { getVapidPublicKey, isPushConfigured, sendToUser } from '../push.js';

const router = express.Router();

router.get('/vapid-public-key', (req, res) => {
  const key = getVapidPublicKey();
  if (!key) return res.status(503).json({ error: 'push_not_configured' });
  res.json({ publicKey: key });
});

router.post('/subscribe', requireAuth, async (req, res) => {
  const { endpoint, keys } = req.body || {};
  if (!endpoint || !keys?.p256dh || !keys?.auth) {
    return res.status(400).json({ error: 'invalid_subscription' });
  }
  const ua = String(req.headers['user-agent'] || '').slice(0, 300);
  // ON CONFLICT (endpoint) — když user povolí push znovu na stejném zařízení,
  // přepíšeme p256dh/auth (mohou rotovat) a přepneme owner_id.
  await query(
    `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, user_agent)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (endpoint) DO UPDATE
       SET user_id = EXCLUDED.user_id,
           p256dh = EXCLUDED.p256dh,
           auth = EXCLUDED.auth,
           user_agent = EXCLUDED.user_agent`,
    [req.user.id, endpoint, keys.p256dh, keys.auth, ua]
  );
  res.json({ ok: true });
});

router.post('/unsubscribe', requireAuth, async (req, res) => {
  const { endpoint } = req.body || {};
  if (!endpoint) return res.status(400).json({ error: 'missing_endpoint' });
  await query(
    'DELETE FROM push_subscriptions WHERE user_id = $1 AND endpoint = $2',
    [req.user.id, endpoint]
  );
  res.json({ ok: true });
});

router.post('/test', requireAuth, async (req, res) => {
  if (!isPushConfigured()) return res.status(503).json({ error: 'push_not_configured' });
  const r = await sendToUser(req.user.id, {
    title: 'VITOM — test',
    body: 'Push notifikace fungují ✓',
    url: '/',
    tag: 'test',
  });
  res.json(r);
});

export default router;

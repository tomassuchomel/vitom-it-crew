// Web Push helper. Klient se subscribuje přes /api/push/subscribe, my pak
// posíláme notifikace na endpoint z push_subscriptions.
//
// VAPID klíče jsou v env (VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT).
// Když chybí, sendToUser je no-op (server běží dál, jen push tiše ne).
//
// Trvalé chyby (410 Gone, 404) → mažeme subscription. Ostatní (5xx) ignorujeme.

import webpush from 'web-push';
import { query } from './db.js';

const PUB = process.env.VAPID_PUBLIC_KEY?.trim();
const PRIV = process.env.VAPID_PRIVATE_KEY?.trim();
const SUBJECT = process.env.VAPID_SUBJECT?.trim() || 'mailto:admin@vitom.cz';

let configured = false;
if (PUB && PRIV) {
  webpush.setVapidDetails(SUBJECT, PUB, PRIV);
  configured = true;
} else {
  console.warn('[push] VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY chybí v env — push notifikace jsou vypnuté.');
}

export function isPushConfigured() {
  return configured;
}

export function getVapidPublicKey() {
  return PUB || null;
}

// Pošle notifikaci jednomu uživateli na všechny jeho zařízení (subscriptions).
// payload: { title, body, url?, tag?, icon? }
export async function sendToUser(userId, payload) {
  if (!configured) return { sent: 0, removed: 0 };
  const r = await query(
    'SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = $1',
    [userId]
  );
  if (r.rows.length === 0) return { sent: 0, removed: 0 };

  const body = JSON.stringify({
    title: payload.title || 'VITOM',
    body:  payload.body  || '',
    url:   payload.url   || '/',
    tag:   payload.tag   || undefined,
    icon:  payload.icon  || '/icon-192.png',
  });

  let sent = 0, removed = 0;
  await Promise.all(r.rows.map(async (sub) => {
    // Endpoint hostname pro identifikaci providera (apple/google/mozilla).
    const provider = (() => {
      try { return new URL(sub.endpoint).hostname; } catch { return 'unknown'; }
    })();
    try {
      const result = await webpush.sendNotification({
        endpoint: sub.endpoint,
        keys: { p256dh: sub.p256dh, auth: sub.auth },
      }, body);
      sent++;
      console.log(`[push] OK → ${provider} → user=${userId} status=${result.statusCode}`);
    } catch (err) {
      const status = err.statusCode;
      if (status === 404 || status === 410) {
        await query('DELETE FROM push_subscriptions WHERE id = $1', [sub.id]).catch(() => {});
        removed++;
        console.log(`[push] EXPIRED ${status} → ${provider} → smazáno`);
      } else {
        console.warn(`[push] FAILED → ${provider} → status=${status} → ${err.message?.slice(0, 200)}`);
      }
    }
  }));
  console.log(`[push] sendToUser(${userId}) done: sent=${sent} removed=${removed}`);
  return { sent, removed };
}

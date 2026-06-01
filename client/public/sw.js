// Service Worker — Vrstva 2 (installable + offline shell).
//
// Strategie:
//   - SHELL_ASSETS: cache-first (index.html, manifest, ikony) — appka se otevře offline.
//   - Vite assets/*: cache-first (jsou hash-named, immutable per build).
//   - /api/*: network-only (vždy fresh, offline = error). Nikdy necachujeme.
//   - HTML navigace: network-first s fallback na cached index.html (SPA shell).
//
// Pozn.: žádný offline data layer ve vrstvě 2 – appka offline ukáže shell, ale
// jakákoliv akce (load notes/tasks/...) selže. To je vědomě jednoduché.

const VERSION = 'vitom-it-crew-v5';
const SHELL = 'shell-' + VERSION;

const SHELL_ASSETS = [
  '/',
  '/index.html',
  '/manifest.webmanifest',
  '/icon.svg',
  '/icon-192.png',
  '/icon-512.png',
  '/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  // NEdeláme auto-skipWaiting — nová verze čeká v 'waiting' stavu, dokud
  // user nepotvrdí přes UpdatePrompt. Zabraňuje, aby se appka přepla pod rukama
  // uprostřed rozdělané práce.
  event.waitUntil(
    caches.open(SHELL).then((cache) => cache.addAll(SHELL_ASSETS))
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => !k.endsWith(VERSION)).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// Klient zavolá tohle, když user klikne „Aktualizovat" v UpdatePromptu.
// + diagnostika: GET_VERSION pro zobrazení v UI.
self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
  if (event.data?.type === 'GET_VERSION') {
    event.source?.postMessage({ type: 'VERSION', version: VERSION });
  }
});

// Broadcast helper — pošle všem otevřeným klientům zprávu o push události.
async function notifyAllClients(payload) {
  const clients = await self.clients.matchAll({ includeUncontrolled: true, type: 'window' });
  clients.forEach((c) => c.postMessage(payload));
}

// Web Push — server posílá JSON { title, body, url, tag, icon }.
// Diagnostika: console.log na všech krocích, aby user viděl v DevTools.
self.addEventListener('push', (event) => {
  console.log('[SW push] event received', { hasData: !!event.data });
  let data = {};
  try {
    const raw = event.data ? event.data.text() : '';
    console.log('[SW push] raw payload:', raw);
    data = raw ? JSON.parse(raw) : {};
  } catch (err) {
    console.warn('[SW push] parse error:', err.message);
    data = {};
  }
  const title = String(data.title || 'VITOM').trim() || 'VITOM';
  const body  = String(data.body  || 'Nová událost').trim() || 'Nová událost';
  const options = {
    body,
    icon: data.icon || '/icon-192.png',
    badge: '/icon-192.png',
    requireInteraction: true,
    data: { url: data.url || '/' },
  };
  if (data.tag) options.tag = String(data.tag);
  console.log('[SW push] showing notification:', title, body);
  event.waitUntil(
    self.registration.showNotification(title, options)
      .then(async () => {
        console.log('[SW push] notification shown OK');
        await notifyAllClients({ type: 'PUSH_RECEIVED', ok: true, title, body, at: Date.now() });
      })
      .catch(async (err) => {
        console.error('[SW push] showNotification FAILED:', err);
        await notifyAllClients({ type: 'PUSH_RECEIVED', ok: false, error: String(err), at: Date.now() });
      })
  );
});

// Klik na notifikaci → otevři appku na url (nebo focusni existující tab).
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = event.notification.data?.url || '/';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      // Pokud je appka už otevřená, zaměříme tab + navigujeme.
      for (const c of clientList) {
        if ('focus' in c) {
          c.navigate?.(targetUrl).catch(() => {});
          return c.focus();
        }
      }
      // Jinak otevři nový tab.
      if (self.clients.openWindow) return self.clients.openWindow(targetUrl);
    })
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // /api/* — vždy přímo na síť. Žádná cache. Offline → necháme padnout.
  if (url.pathname.startsWith('/api/')) return;

  // Jen GET cachujeme (POST/PUT/DELETE jsou vždy network).
  if (req.method !== 'GET') return;

  // Cross-origin (fonts.googleapis.com) — necháme browser default.
  if (url.origin !== self.location.origin) return;

  // HTML navigace → network-first s fallback na cached index.html (SPA shell).
  if (req.mode === 'navigate' || req.headers.get('accept')?.includes('text/html')) {
    event.respondWith(
      fetch(req).catch(() => caches.match('/index.html').then((r) => r || new Response('Offline', { status: 503 })))
    );
    return;
  }

  // Assets (hash-named, immutable) + shell → cache-first.
  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req).then((res) => {
        // Cachuj jen úspěšné same-origin GET (žádné opaque, žádné chyby).
        if (res.ok && res.type === 'basic') {
          const copy = res.clone();
          caches.open(SHELL).then((cache) => cache.put(req, copy));
        }
        return res;
      }).catch(() => new Response('Offline', { status: 503 }));
    })
  );
});

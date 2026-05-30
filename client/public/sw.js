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

const VERSION = 'vitom-it-crew-v2';
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
  event.waitUntil(
    caches.open(SHELL).then((cache) => cache.addAll(SHELL_ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => !k.endsWith(VERSION)).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
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

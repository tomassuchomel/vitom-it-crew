// PWA update prompt — když Service Worker najde novou verzi, čeká ve 'waiting'
// stavu. Tahle komponenta to detekuje a ukáže uživateli toast „Nová verze, aktualizovat?".
// Po kliknutí pošle SW zprávu SKIP_WAITING → SW se aktivuje → strana se reloadne.

import { useEffect, useState } from 'react';

export default function UpdatePrompt() {
  const [waitingSW, setWaitingSW] = useState(null);

  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;
    let mounted = true;

    navigator.serviceWorker.getRegistration().then((reg) => {
      if (!reg || !mounted) return;

      // 1) Případ: nová verze už čeká od minule (refresh nastal mezitím).
      if (reg.waiting) setWaitingSW(reg.waiting);

      // 2) Případ: právě teď se stahuje nová verze (updatefound → installed).
      reg.addEventListener('updatefound', () => {
        const newSW = reg.installing;
        if (!newSW) return;
        newSW.addEventListener('statechange', () => {
          if (newSW.state === 'installed' && navigator.serviceWorker.controller) {
            // 'installed' + controller existuje = je to upgrade, ne první install.
            if (mounted) setWaitingSW(newSW);
          }
        });
      });
    });

    // Po skipWaiting přijde controllerchange → tady reload.
    let reloaded = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (reloaded) return;
      reloaded = true;
      window.location.reload();
    });

    return () => { mounted = false; };
  }, []);

  if (!waitingSW) return null;

  const applyUpdate = () => waitingSW.postMessage({ type: 'SKIP_WAITING' });

  return (
    <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 bg-brand-500 text-cream-50 rounded-lg shadow-2xl px-4 py-3 flex items-center gap-3 max-w-[90vw]">
      <span className="text-sm">🔄 Nová verze aplikace je k dispozici.</span>
      <button
        onClick={applyUpdate}
        className="px-3 py-1 bg-accent-500 hover:bg-accent-600 text-white text-sm font-semibold rounded"
      >
        Aktualizovat
      </button>
      <button
        onClick={() => setWaitingSW(null)}
        className="text-cream-100/70 hover:text-cream-50 text-xs"
        title="Skrýt"
      >×</button>
    </div>
  );
}

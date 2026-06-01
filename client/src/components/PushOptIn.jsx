// Push notifikace — opt-in tlačítko pro profil.
//
// Flow:
//   1. uživatel klikne „Povolit notifikace"
//   2. fetchneme VAPID public key z backendu
//   3. zavoláme Notification.requestPermission()
//   4. registration.pushManager.subscribe() s VAPID klíčem
//   5. POST subscription na backend → uloží do DB
//
// Pozn.: iOS Safari 16.4+ podporuje Web Push JEN když je PWA nainstalovaná
// (Add to Home Screen). Detekujeme display-mode standalone.

import { useEffect, useState } from 'react';
import { push as pushApi } from '../api.js';

// VAPID public key je base64url-encoded. Service Worker očekává Uint8Array.
function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const b64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(b64);
  const arr = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
  return arr;
}

export default function PushOptIn() {
  const [supported, setSupported] = useState(false);
  const [permission, setPermission] = useState('default');
  const [subscribed, setSubscribed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  // Diagnostika
  const [swVersion, setSwVersion] = useState(null);
  const [lastPushAt, setLastPushAt] = useState(null);
  const [lastPushOk, setLastPushOk] = useState(null);
  const [lastPushError, setLastPushError] = useState(null);
  // iOS PWA install check: web push na iOS Safari funguje JEN ze standalone módu.
  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
  const isStandalone = window.matchMedia?.('(display-mode: standalone)')?.matches
    || window.navigator.standalone === true;
  const iosNeedsInstall = isIOS && !isStandalone;

  useEffect(() => {
    const ok = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
    setSupported(ok);
    if (!ok) return;
    setPermission(Notification.permission);
    navigator.serviceWorker.getRegistration().then((reg) => {
      reg?.pushManager.getSubscription().then((sub) => setSubscribed(!!sub));
    });
    // Diagnostika: dotaz SW na verzi + listener na PUSH_RECEIVED zprávy
    const onMessage = (e) => {
      const d = e.data;
      if (d?.type === 'VERSION') setSwVersion(d.version);
      if (d?.type === 'PUSH_RECEIVED') {
        setLastPushAt(d.at);
        setLastPushOk(!!d.ok);
        setLastPushError(d.error || null);
      }
    };
    navigator.serviceWorker.addEventListener('message', onMessage);
    navigator.serviceWorker.ready.then((reg) => {
      reg.active?.postMessage({ type: 'GET_VERSION' });
    });
    return () => navigator.serviceWorker.removeEventListener('message', onMessage);
  }, []);

  const enable = async () => {
    setBusy(true); setMsg(null);
    try {
      const { publicKey } = await pushApi.vapidKey();
      if (!publicKey) throw new Error('VAPID klíč není nakonfigurovaný na serveru.');

      const perm = await Notification.requestPermission();
      setPermission(perm);
      if (perm !== 'granted') {
        setMsg('Notifikace nebyly povoleny v prohlížeči.');
        return;
      }

      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey),
      });
      await pushApi.subscribe(sub.toJSON());
      setSubscribed(true);
      setMsg('Notifikace aktivní ✓');
    } catch (err) {
      console.error('[push] enable failed', err);
      setMsg(err.message || 'Nepodařilo se aktivovat notifikace.');
    } finally {
      setBusy(false);
    }
  };

  const disable = async () => {
    setBusy(true); setMsg(null);
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (sub) {
        await pushApi.unsubscribe(sub.endpoint).catch(() => {});
        await sub.unsubscribe();
      }
      setSubscribed(false);
      setMsg('Notifikace vypnuty.');
    } finally { setBusy(false); }
  };

  const test = async () => {
    setBusy(true); setMsg(null);
    // Vynulovat předchozí diagnostiku, ať jasně vidíme, jestli nový push došel
    setLastPushAt(null); setLastPushOk(null); setLastPushError(null);
    try {
      const r = await pushApi.test();
      setMsg(`Server odeslal push (${r.sent} zařízení). Čekám na SW…`);
    } catch (err) {
      setMsg(err.response?.data?.error || 'Test selhal na úrovni serveru.');
    } finally { setBusy(false); }
  };

  if (!supported) {
    return (
      <div className="text-xs text-ink-500 bg-cream-50 border border-cream-300 rounded p-3">
        🔕 Tento prohlížeč nepodporuje Web Push notifikace.
      </div>
    );
  }

  if (iosNeedsInstall) {
    return (
      <div className="text-xs text-ink-600 bg-amber-50 border border-amber-200 rounded p-3 space-y-1">
        <div className="font-semibold">📱 iOS: nejdřív přidat na plochu</div>
        <div>Web Push na iPhonu funguje jen z nainstalované PWA. V Safari klepni
        <strong> Sdílet</strong> → <strong>Přidat na plochu</strong>, otevři appku z ikony a tady to půjde aktivovat.</div>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 flex-wrap">
        {!subscribed ? (
          <button
            onClick={enable}
            disabled={busy || permission === 'denied'}
            className="px-3 py-1.5 bg-brand-500 text-white text-sm rounded hover:bg-brand-600 disabled:opacity-50"
          >
            🔔 Povolit notifikace
          </button>
        ) : (
          <>
            <span className="text-sm text-emerald-700 bg-emerald-50 border border-emerald-200 rounded px-2 py-1">
              🔔 Aktivní
            </span>
            <button onClick={test} disabled={busy}
              className="px-3 py-1.5 text-sm rounded border border-ink-300 hover:bg-cream-50">
              Test
            </button>
            <button onClick={disable} disabled={busy}
              className="px-3 py-1.5 text-sm rounded border border-ink-300 hover:bg-cream-50 text-ink-500">
              Vypnout
            </button>
          </>
        )}
      </div>
      {permission === 'denied' && (
        <div className="text-xs text-red-600">
          Notifikace jsi v prohlížeči zablokoval. Povol je v nastavení stránky.
        </div>
      )}
      {msg && <div className="text-xs text-ink-600">{msg}</div>}

      {/* Diagnostický panel — viditelný jen pro subscribed users */}
      {subscribed && (
        <div className="mt-3 text-xs bg-cream-50 border border-cream-300 rounded p-3 space-y-1.5 font-mono">
          <div className="font-sans font-semibold text-ink-700 text-[11px] uppercase tracking-wide mb-1">Diagnostika</div>
          <div className="flex justify-between">
            <span className="text-ink-500">SW verze:</span>
            <span className={swVersion ? 'text-emerald-700' : 'text-red-600'}>
              {swVersion || '?? (starý SW bez handler-u)'}
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-ink-500">SW dostal push:</span>
            <span className={
              lastPushAt === null ? 'text-ink-400' :
              lastPushOk ? 'text-emerald-700' : 'text-red-600'
            }>
              {lastPushAt === null
                ? '— (klikni Test)'
                : lastPushOk
                  ? `✓ před ${Math.round((Date.now() - lastPushAt) / 1000)}s`
                  : `✗ showNotification selhal`}
            </span>
          </div>
          {lastPushError && (
            <div className="text-red-600 break-all">{lastPushError}</div>
          )}
          <div className="font-sans text-[10px] text-ink-500 pt-1 border-t border-cream-300 mt-2">
            {lastPushAt && lastPushOk
              ? 'SW notifikaci ukázal. Pokud ji nevidíš → OS ji blokuje (Focus mode / Nerušit / Notification settings).'
              : lastPushAt && !lastPushOk
                ? 'SW se pokusil zobrazit, ale OS odmítl. Zkontroluj Notification settings prohlížeče.'
                : !swVersion
                  ? 'Pravděpodobně máš starou verzi SW. Cleanup: smaž PWA, smaž site data, reinstall.'
                  : 'SW běží správně. Klikni Test — pokud "SW dostal push" zůstane —, push se k SW vůbec nedostal (provider issue).'}
          </div>
        </div>
      )}
    </div>
  );
}

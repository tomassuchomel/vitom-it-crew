// Admin → Server sekce — provoz aplikace bez SSH.
// F1: read-only karty (Health / Environment / Errors). F2/F3 přidají edit + restart + deploy.

import { useEffect, useState } from 'react';
import { adminServer } from '../api.js';

const fmtBytes = (mb) => mb == null ? '—' : `${mb} MB`;
const fmtDuration = (s) => {
  if (s == null) return '—';
  if (s < 60)   return `${s} s`;
  if (s < 3600) return `${Math.floor(s/60)} min ${s%60} s`;
  const h = Math.floor(s/3600), m = Math.floor((s%3600)/60);
  return `${h} h ${m} min`;
};
const fmtDate = (iso) => iso ? new Date(iso).toLocaleString('cs-CZ') : '—';

export default function AdminServerSection() {
  const [health, setHealth] = useState(null);
  const [env, setEnv] = useState(null);
  const [errors, setErrors] = useState([]);
  const [refreshTick, setRefreshTick] = useState(0);

  const loadAll = async () => {
    try {
      const [h, e, er] = await Promise.all([
        adminServer.health(),
        adminServer.env(),
        adminServer.errors(50),
      ]);
      setHealth(h);
      setEnv(e);
      setErrors(er.errors || []);
    } catch (err) {
      // Chyby ignorujeme tiše — buď je server dole (což vidíme v UI) nebo malý blip
      console.warn('[AdminServer] load failed', err.message);
    }
  };

  useEffect(() => { loadAll(); }, [refreshTick]);

  // Auto-refresh každých 30 s
  useEffect(() => {
    const t = setInterval(() => setRefreshTick(x => x + 1), 30_000);
    return () => clearInterval(t);
  }, []);

  return (
    <div className="space-y-6 max-w-5xl">
      <div className="flex items-center gap-2">
        <h2 className="text-lg font-bold text-ink-800">🖥 Provoz serveru</h2>
        <button onClick={() => setRefreshTick(x => x + 1)}
          className="text-xs px-2 py-1 border border-ink-300 rounded hover:bg-cream-50">
          🔄 Aktualizovat
        </button>
        <span className="text-[11px] text-ink-400">automaticky každých 30 s</span>
      </div>

      <HealthCard health={health} />
      <EnvCard env={env} />
      <ErrorsCard errors={errors} onClear={async () => {
        if (!confirm('Vyčistit seznam chyb?')) return;
        await adminServer.clearErrors();
        setRefreshTick(x => x + 1);
      }} />
    </div>
  );
}

// ─── Health ────────────────────────────────────────────────────────────

function HealthCard({ health }) {
  const status = !health ? '⏳ Načítám…'
               : health.ok ? '🟢 OK'
               : '🔴 DB nedostupná';
  return (
    <section className="bg-white border border-cream-200 rounded-lg p-4">
      <div className="text-xs font-semibold text-ink-500 uppercase tracking-wide mb-3">
        Zdraví serveru — {status}
      </div>
      {!health ? <div className="text-sm text-ink-400">Načítám…</div> : (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
          <Field label="Uptime"      value={fmtDuration(health.uptimeSec)} />
          <Field label="Memory RSS"  value={fmtBytes(health.memory?.rssMb)} />
          <Field label="Memory heap" value={fmtBytes(health.memory?.heapMb)} />
          <Field label="Node"        value={health.node} />
          <Field label="PID"         value={health.pid} />
          <Field label="NODE_ENV"    value={health.nodeEnv} />
          <Field label="DB latency"  value={health.db?.latencyMs != null ? `${health.db.latencyMs} ms` : '—'} />
          <Field label="Čas serveru" value={fmtDate(health.now)} />
          {health.git && (
            <div className="col-span-2 md:col-span-4">
              <div className="text-[11px] uppercase tracking-wide text-ink-500">Git commit</div>
              <div className="text-sm text-ink-800">
                <code className="bg-cream-100 px-1.5 py-0.5 rounded">{health.git.commit}</code>
                <span className="text-ink-500 ml-2">{fmtDate(health.git.time)}</span>
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

// ─── Environment ────────────────────────────────────────────────────────

function EnvCard({ env }) {
  if (!env) return (
    <section className="bg-white border border-cream-200 rounded-lg p-4">
      <div className="text-sm text-ink-400">Načítám .env…</div>
    </section>
  );

  // Seskupit podle group
  const groups = {};
  for (const item of env.values) {
    if (!groups[item.group]) groups[item.group] = [];
    groups[item.group].push(item);
  }

  const missingRequired = env.values.filter(v => v.required && !v.set);

  return (
    <section className="bg-white border border-cream-200 rounded-lg p-4">
      <div className="flex items-start justify-between mb-3">
        <div>
          <div className="text-xs font-semibold text-ink-500 uppercase tracking-wide">
            Environment ({env.values.length} klíčů)
          </div>
          <div className="text-[11px] text-ink-500">
            Soubor: <code>{env.envFile}</code>
          </div>
        </div>
        {missingRequired.length > 0 && (
          <div className="text-xs bg-red-50 text-red-700 border border-red-200 rounded px-2 py-1">
            ⚠ Chybí {missingRequired.length} povinných
          </div>
        )}
      </div>
      <div className="space-y-4">
        {Object.entries(groups).map(([group, items]) => (
          <div key={group}>
            <div className="text-[11px] uppercase tracking-wide text-ink-500 mb-1">{group}</div>
            <div className="space-y-1">
              {items.map(item => (
                <div key={item.key} className="flex items-center gap-2 text-sm">
                  <span className={item.set ? 'text-emerald-600' : (item.required ? 'text-red-600' : 'text-ink-400')}>
                    {item.set ? '✅' : (item.required ? '❌' : '➖')}
                  </span>
                  <code className="text-xs bg-cream-50 border border-cream-200 rounded px-1.5 py-0.5 min-w-[220px]">
                    {item.key}
                  </code>
                  {item.set ? (
                    <span className={`text-xs ${item.secret ? 'text-ink-500 font-mono' : 'text-ink-800'}`}>
                      {item.value}
                    </span>
                  ) : (
                    <span className="text-xs text-ink-400 italic">
                      {item.required ? 'chybí (povinné)' : 'nenastaveno'}
                    </span>
                  )}
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
      <div className="mt-4 text-[11px] text-ink-500 italic">
        Editaci hodnot přidá F2 (příští krok). Zatím musí .env upravovat SSH.
      </div>
    </section>
  );
}

// ─── Errors ──────────────────────────────────────────────────────────────

function ErrorsCard({ errors, onClear }) {
  return (
    <section className="bg-white border border-cream-200 rounded-lg p-4">
      <div className="flex items-center justify-between mb-3">
        <div className="text-xs font-semibold text-ink-500 uppercase tracking-wide">
          Poslední chyby ({errors.length})
        </div>
        {errors.length > 0 && (
          <button onClick={onClear}
            className="text-xs px-2 py-1 border border-ink-300 rounded hover:bg-cream-50">
            Vyčistit
          </button>
        )}
      </div>
      {errors.length === 0 ? (
        <div className="text-sm text-emerald-700 bg-emerald-50 border border-emerald-200 rounded p-2">
          🎉 Žádné chyby v paměti serveru
        </div>
      ) : (
        <ul className="space-y-2 max-h-[400px] overflow-y-auto">
          {errors.map((e, i) => (
            <li key={i} className="text-xs border-l-2 border-red-300 pl-2 py-1">
              <div className="flex items-center gap-2 text-ink-500">
                <span>{fmtDate(e.ts)}</span>
                <span className="bg-slate-100 rounded px-1.5">{e.source}</span>
                {e.status && <span className="text-red-600">HTTP {e.status}</span>}
                {e.path && <code className="text-ink-700">{e.path}</code>}
              </div>
              <div className="text-ink-800 font-medium mt-0.5">{e.message}</div>
              {e.stack && (
                <details className="mt-1">
                  <summary className="text-[10px] text-ink-500 cursor-pointer hover:underline">
                    stack trace
                  </summary>
                  <pre className="text-[10px] bg-cream-50 border border-cream-200 rounded p-2 mt-1 overflow-x-auto whitespace-pre-wrap">
                    {e.stack}
                  </pre>
                </details>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

// ─── Helper Field ────────────────────────────────────────────────────────

function Field({ label, value }) {
  return (
    <div>
      <div className="text-[11px] uppercase tracking-wide text-ink-500">{label}</div>
      <div className="text-sm text-ink-800">{value ?? '—'}</div>
    </div>
  );
}

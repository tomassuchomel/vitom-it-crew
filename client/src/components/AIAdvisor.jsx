// Floating AI panel – vždy viditelný v pravém spodním rohu.
// Sbalený stav: kruhový badge se stavem (zelená/žlutá/červená).
// Rozbalený: stav + doporučení + chat input pro otázky.
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ai as aiApi } from '../api.js';
import { useAuth, can } from '../auth.jsx';

const STATUS_STYLE = {
  ok:      { dot: 'bg-emerald-500', label: 'V pohodě',     bg: 'bg-emerald-50',  text: 'text-emerald-800', border: 'border-emerald-200' },
  warning: { dot: 'bg-accent-500',  label: 'Pozor',         bg: 'bg-accent-50',   text: 'text-accent-800',  border: 'border-accent-200' },
  danger:  { dot: 'bg-red-500',     label: 'Riziko skluzu', bg: 'bg-red-50',      text: 'text-red-800',     border: 'border-red-200' },
};

export default function AIAdvisor() {
  const { user } = useAuth();
  const [enabled, setEnabled] = useState(false);
  const [open, setOpen] = useState(() => localStorage.getItem('ai.open') === '1');
  const [advice, setAdvice] = useState(null);
  const [adviceErr, setAdviceErr] = useState(null);
  const [adviceLoading, setAdviceLoading] = useState(false);
  const [chatLog, setChatLog] = useState([]); // [{role, content}]
  const [chatInput, setChatInput] = useState('');
  const [chatLoading, setChatLoading] = useState(false);
  const chatRef = useRef();

  // Zobrazujeme jen rolím, které vidí kompletní data (admin/manager)
  if (!can.seeAllHours(user)) return null;

  useEffect(() => {
    aiApi.status().then(d => setEnabled(d.enabled)).catch(() => setEnabled(false));
  }, []);

  // Auto-load advice při prvním rozbalení
  useEffect(() => {
    if (open && enabled && !advice && !adviceLoading) loadAdvice();
  }, [open, enabled]);

  // Persistentní open/close
  useEffect(() => {
    localStorage.setItem('ai.open', open ? '1' : '0');
  }, [open]);

  const loadAdvice = async () => {
    setAdviceLoading(true); setAdviceErr(null);
    try {
      const d = await aiApi.advice();
      if (d.error) setAdviceErr(d.message || d.error);
      else setAdvice(d.advice);
    } catch (e) {
      setAdviceErr(e.response?.data?.message || 'Chyba volání AI');
    } finally {
      setAdviceLoading(false);
    }
  };

  const sendChat = async (e) => {
    e?.preventDefault?.();
    if (!chatInput.trim() || chatLoading) return;
    const userMsg = { role: 'user', content: chatInput.trim() };
    const newLog = [...chatLog, userMsg];
    setChatLog(newLog);
    setChatInput('');
    setChatLoading(true);
    try {
      const d = await aiApi.chat(newLog);
      if (d.error) {
        setChatLog([...newLog, { role: 'assistant', content: `❌ ${d.message || d.error}` }]);
      } else {
        setChatLog([...newLog, { role: 'assistant', content: d.reply }]);
      }
    } catch (err) {
      setChatLog([...newLog, { role: 'assistant', content: `❌ Chyba: ${err.message}` }]);
    } finally {
      setChatLoading(false);
      // Scroll do konce
      setTimeout(() => chatRef.current?.scrollTo({ top: 1e9, behavior: 'smooth' }), 100);
    }
  };

  // ---- Sbalený badge ----
  if (!open) {
    const status = advice?.status || 'ok';
    const s = STATUS_STYLE[status] || STATUS_STYLE.ok;
    return (
      <button
        onClick={() => setOpen(true)}
        className="fixed bottom-24 right-4 sm:bottom-5 sm:right-5 z-40 flex items-center gap-2 bg-brand-500 hover:bg-brand-600 text-white shadow-lg rounded-full pl-3 pr-4 py-2.5 transition"
        title="Otevřít AI poradce"
      >
        <span className="text-xl">🤖</span>
        {advice && (
          <span className={`w-2 h-2 rounded-full ${s.dot}`} title={s.label} />
        )}
        <span className="text-sm font-medium">AI Coach</span>
      </button>
    );
  }

  // ---- Rozbalený panel ----
  const status = advice?.status || 'ok';
  const s = STATUS_STYLE[status] || STATUS_STYLE.ok;

  return (
    <div className="fixed bottom-2 right-2 left-2 sm:bottom-5 sm:right-5 sm:left-auto sm:w-[420px] z-40 bg-white rounded-2xl shadow-2xl border border-cream-200 flex flex-col" style={{ maxHeight: 'calc(100vh - 2.5rem)' }}>
      {/* Hlavička */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-cream-200 bg-brand-500 text-white rounded-t-2xl">
        <div className="flex items-center gap-2">
          <span className="text-lg">🤖</span>
          <div>
            <div className="font-semibold leading-tight">VITOM AI Coach</div>
            <div className="text-[10px] text-cream-100/70 leading-tight">projektový poradce</div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Link to="/ai" className="text-xs text-cream-100/80 hover:text-white underline" title="Plná stránka">↗</Link>
          <button onClick={() => setOpen(false)} className="text-cream-100/80 hover:text-white text-xl leading-none">×</button>
        </div>
      </div>

      {/* Tělo */}
      <div className="overflow-y-auto flex-1 p-4 space-y-3">
        {!enabled ? (
          <div className="text-sm text-ink-600">
            <div className="font-semibold mb-1">AI je vypnuté</div>
            <div className="text-xs text-ink-500">
              Pro zapnutí přidej <code className="bg-cream-100 px-1 rounded">ANTHROPIC_API_KEY</code> do <code className="bg-cream-100 px-1 rounded">server/.env</code> a restartuj server.
              Klíč získáš na <a href="https://console.anthropic.com/settings/keys" className="underline text-brand-500" target="_blank" rel="noopener">console.anthropic.com</a>.
            </div>
          </div>
        ) : adviceLoading && !advice ? (
          <div className="text-sm text-ink-500 text-center py-6">⏳ Analyzuji projekty…</div>
        ) : adviceErr ? (
          <div className="text-sm text-red-600">
            <div className="font-semibold">Chyba:</div>
            <div className="text-xs mt-1">{adviceErr}</div>
            <button onClick={loadAdvice} className="text-xs underline mt-2">Zkusit znovu</button>
          </div>
        ) : advice ? (
          <>
            {/* Status */}
            <div className={`p-3 rounded-lg border ${s.bg} ${s.border}`}>
              <div className="flex items-center gap-2 mb-1">
                <span className={`w-2.5 h-2.5 rounded-full ${s.dot}`} />
                <span className={`font-semibold text-sm ${s.text}`}>{s.label}</span>
              </div>
              {advice.headline && (
                <div className={`text-sm font-medium ${s.text} mb-1`}>{advice.headline}</div>
              )}
              {advice.summary && (
                <div className="text-xs text-ink-700 leading-relaxed">{advice.summary}</div>
              )}
            </div>

            {/* Projekty */}
            {advice.projects?.length > 0 && (
              <div>
                <div className="text-xs uppercase tracking-wide text-ink-500 font-semibold mb-1">Projekty</div>
                <ul className="space-y-1.5">
                  {advice.projects.map(p => {
                    const ps = STATUS_STYLE[p.status] || STATUS_STYLE.ok;
                    return (
                      <li key={p.id} className={`text-xs p-2 rounded border ${ps.bg} ${ps.border}`}>
                        <Link to={`/projects/${p.id}`} className="font-medium text-ink-800 hover:underline block">
                          {p.name}
                        </Link>
                        <div className="text-ink-600 mt-0.5">{p.note}</div>
                        <div className="flex gap-3 text-[10px] text-ink-500 mt-1">
                          <span>⏱ zbývá ~{p.estimated_remaining_h}h</span>
                          <span>📅 {p.days_to_deadline} dní</span>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </div>
            )}

            {/* Doporučení */}
            {advice.recommendations?.length > 0 && (
              <div>
                <div className="text-xs uppercase tracking-wide text-ink-500 font-semibold mb-1">Doporučení</div>
                <ul className="space-y-1.5 text-sm text-ink-800">
                  {advice.recommendations.map((r, i) => (
                    <li key={i} className="flex gap-2">
                      <span className="text-accent-500 font-bold">→</span>
                      <span>{r}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <button
              onClick={loadAdvice}
              disabled={adviceLoading}
              className="text-xs text-brand-500 hover:text-brand-600 underline"
            >{adviceLoading ? 'Aktualizuji…' : '↻ Aktualizovat analýzu'}</button>
          </>
        ) : null}

        {/* Chat */}
        {enabled && (
          <div className="border-t border-cream-200 pt-3">
            <div className="text-xs uppercase tracking-wide text-ink-500 font-semibold mb-2">Zeptej se</div>
            <div ref={chatRef} className="space-y-2 max-h-48 overflow-y-auto mb-2">
              {chatLog.map((m, i) => (
                <div key={i} className={`text-xs p-2 rounded ${m.role === 'user' ? 'bg-brand-50 text-ink-800' : 'bg-cream-100 text-ink-800'}`}>
                  <div className="font-semibold text-[10px] mb-0.5 text-ink-500">{m.role === 'user' ? 'Ty' : '🤖 Coach'}</div>
                  <div className="whitespace-pre-wrap">{m.content}</div>
                </div>
              ))}
              {chatLoading && <div className="text-xs text-ink-400">⏳ AI přemýšlí…</div>}
            </div>
            <form onSubmit={sendChat} className="flex gap-2">
              <input
                type="text"
                value={chatInput}
                onChange={(e) => setChatInput(e.target.value)}
                placeholder="Např. Co bychom měli urgentně řešit?"
                className="flex-1 border border-cream-300 rounded-lg px-3 py-1.5 text-sm focus:border-brand-500 focus:outline-none"
              />
              <button
                type="submit"
                disabled={chatLoading || !chatInput.trim()}
                className="px-3 py-1.5 bg-brand-500 text-white rounded-lg text-sm hover:bg-brand-600 disabled:opacity-50"
              >→</button>
            </form>
          </div>
        )}
      </div>
    </div>
  );
}

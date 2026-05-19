// Plná stránka AI poradce – detail analýzy + chat
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import PageHeader from '../components/PageHeader.jsx';
import Avatar from '../components/Avatar.jsx';
import { ai as aiApi } from '../api.js';

const STATUS_STYLE = {
  ok:      { dot: 'bg-emerald-500', label: 'V pohodě',     bg: 'bg-emerald-50',  text: 'text-emerald-800', border: 'border-emerald-200' },
  warning: { dot: 'bg-accent-500',  label: 'Pozor',         bg: 'bg-accent-50',   text: 'text-accent-800',  border: 'border-accent-200' },
  danger:  { dot: 'bg-red-500',     label: 'Riziko skluzu', bg: 'bg-red-50',      text: 'text-red-800',     border: 'border-red-200' },
};

export default function AIPage() {
  const [enabled, setEnabled] = useState(null);
  const [advice, setAdvice] = useState(null);
  const [accuracy, setAccuracy] = useState([]);
  const [err, setErr] = useState(null);
  const [loading, setLoading] = useState(false);
  const [chatLog, setChatLog] = useState([]);
  const [chatInput, setChatInput] = useState('');
  const [chatLoading, setChatLoading] = useState(false);
  const chatRef = useRef();

  useEffect(() => {
    // Accuracy je nezávislá na AI – načteme vždy, i bez API klíče
    aiApi.accuracy().then(d => setAccuracy(d.accuracy || [])).catch(() => {});
    aiApi.status().then(d => {
      setEnabled(d.enabled);
      if (d.enabled) loadAdvice();
    });
  }, []);

  const loadAdvice = async () => {
    setLoading(true); setErr(null);
    try {
      const d = await aiApi.advice();
      if (d.error) setErr(d.message || d.error);
      else setAdvice(d.advice);
    } catch (e) {
      setErr(e.response?.data?.message || 'Chyba volání AI');
    } finally {
      setLoading(false);
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
      const reply = d.error ? `❌ ${d.message || d.error}` : d.reply;
      setChatLog([...newLog, { role: 'assistant', content: reply }]);
    } finally {
      setChatLoading(false);
      setTimeout(() => chatRef.current?.scrollTo({ top: 1e9, behavior: 'smooth' }), 100);
    }
  };

  const status = advice?.status || 'ok';
  const s = STATUS_STYLE[status] || STATUS_STYLE.ok;

  return (
    <div>
      <PageHeader
        title="AI Coach"
        subtitle="Projektový poradce – tempo, rizika, doporučení"
        actions={enabled && (
          <button
            onClick={loadAdvice}
            disabled={loading}
            className="px-4 py-2 bg-brand-500 text-white rounded-lg hover:bg-brand-600 text-sm font-medium disabled:opacity-50"
          >{loading ? 'Aktualizuji…' : '↻ Aktualizovat'}</button>
        )}
      />

      <div className="p-8 max-w-5xl space-y-6">
        {accuracy.length > 0 && <AccuracyPanel rows={accuracy} />}

        {enabled === null ? (
          <div className="text-ink-500">Načítám…</div>
        ) : !enabled ? (
          <div className="bg-white rounded-xl border border-cream-200 p-6">
            <h2 className="text-lg font-bold mb-2">🔌 AI je vypnuté</h2>
            <p className="text-sm text-ink-600 mb-3">
              Pro zapnutí AI poradce přidej API klíč Anthropicu do <code className="bg-cream-100 px-1 rounded">server/.env</code>:
            </p>
            <pre className="bg-cream-100 rounded p-3 text-xs overflow-auto">
{`ANTHROPIC_API_KEY=sk-ant-...
ANTHROPIC_MODEL=claude-sonnet-4-5`}</pre>
            <p className="text-sm text-ink-600 mt-3">
              Klíč si vygeneruj na{' '}
              <a href="https://console.anthropic.com/settings/keys" className="text-brand-500 underline" target="_blank" rel="noopener">console.anthropic.com/settings/keys</a>.
              Po přidání restartuj server (<code className="bg-cream-100 px-1 rounded">npm run dev</code>).
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* Levý sloupec – analýza */}
            <div className="space-y-4">
              {loading && !advice ? (
                <div className="bg-white rounded-xl border border-cream-200 p-6 text-center text-ink-500">⏳ Analyzuji projekty a tempo týmu…</div>
              ) : err ? (
                <div className="bg-red-50 border border-red-200 rounded-xl p-4 text-sm text-red-700">
                  <div className="font-semibold mb-1">Chyba volání AI</div>
                  <div className="text-xs">{err}</div>
                  <button onClick={loadAdvice} className="text-xs underline mt-2">Zkusit znovu</button>
                </div>
              ) : advice ? (
                <>
                  <div className={`p-5 rounded-xl border ${s.bg} ${s.border}`}>
                    <div className="flex items-center gap-2 mb-2">
                      <span className={`w-3 h-3 rounded-full ${s.dot}`} />
                      <span className={`font-bold ${s.text}`}>{s.label}</span>
                    </div>
                    {advice.headline && (
                      <div className={`text-base font-semibold ${s.text} mb-2`}>{advice.headline}</div>
                    )}
                    {advice.summary && (
                      <p className="text-sm text-ink-700 leading-relaxed">{advice.summary}</p>
                    )}
                  </div>

                  {advice.projects?.length > 0 && (
                    <div className="bg-white rounded-xl border border-cream-200 p-5">
                      <h3 className="font-semibold text-ink-800 mb-3">Projekty</h3>
                      <ul className="space-y-2">
                        {advice.projects.map(p => {
                          const ps = STATUS_STYLE[p.status] || STATUS_STYLE.ok;
                          return (
                            <li key={p.id} className={`p-3 rounded-lg border ${ps.bg} ${ps.border}`}>
                              <Link to={`/projects/${p.id}`} className="font-semibold text-ink-800 hover:underline">
                                {p.name}
                              </Link>
                              <p className="text-sm text-ink-700 mt-1">{p.note}</p>
                              <div className="flex gap-4 text-xs text-ink-500 mt-2">
                                <span>⏱ zbývá ~{p.estimated_remaining_h}h</span>
                                <span>📅 {p.days_to_deadline} dní do deadlinu</span>
                                <span className={`font-semibold ${ps.text}`}>● {STATUS_STYLE[p.status]?.label}</span>
                              </div>
                            </li>
                          );
                        })}
                      </ul>
                    </div>
                  )}

                  {advice.recommendations?.length > 0 && (
                    <div className="bg-white rounded-xl border border-cream-200 p-5">
                      <h3 className="font-semibold text-ink-800 mb-3">💡 Doporučení</h3>
                      <ul className="space-y-2 text-sm text-ink-800">
                        {advice.recommendations.map((r, i) => (
                          <li key={i} className="flex gap-2">
                            <span className="text-accent-500 font-bold">→</span>
                            <span>{r}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </>
              ) : null}
            </div>

            {/* Pravý sloupec – chat */}
            <div className="bg-white rounded-xl border border-cream-200 p-5 flex flex-col" style={{ minHeight: 500 }}>
              <h3 className="font-semibold text-ink-800 mb-3">💬 Zeptej se AI</h3>
              <div ref={chatRef} className="flex-1 overflow-y-auto space-y-3 mb-3">
                {chatLog.length === 0 && (
                  <div className="text-sm text-ink-400 italic">
                    Zeptej se na cokoli ohledně tempa, projektů, prioritizace…
                    <div className="mt-3 space-y-1 not-italic">
                      <SuggestionButton onClick={(t) => setChatInput(t)} text="Co bychom měli tento týden urgentně řešit?" />
                      <SuggestionButton onClick={(t) => setChatInput(t)} text="Jak rozdělit práci, abychom stihli e-shop?" />
                      <SuggestionButton onClick={(t) => setChatInput(t)} text="Které úkoly můžeme zrychlit s AI?" />
                    </div>
                  </div>
                )}
                {chatLog.map((m, i) => (
                  <div key={i} className={`p-3 rounded-lg ${m.role === 'user' ? 'bg-brand-50 ml-8' : 'bg-cream-100 mr-8'}`}>
                    <div className="text-[10px] uppercase tracking-wide text-ink-500 font-semibold mb-1">
                      {m.role === 'user' ? 'Ty' : '🤖 Coach'}
                    </div>
                    <div className="text-sm text-ink-800 whitespace-pre-wrap">{m.content}</div>
                  </div>
                ))}
                {chatLoading && <div className="text-sm text-ink-400 italic">⏳ AI přemýšlí…</div>}
              </div>
              <form onSubmit={sendChat} className="flex gap-2">
                <input
                  type="text"
                  value={chatInput}
                  onChange={(e) => setChatInput(e.target.value)}
                  placeholder="Tvoje otázka…"
                  className="flex-1 border border-cream-300 rounded-lg px-3 py-2 text-sm focus:border-brand-500 focus:outline-none"
                />
                <button
                  type="submit"
                  disabled={chatLoading || !chatInput.trim()}
                  className="px-4 py-2 bg-brand-500 text-white rounded-lg text-sm font-medium hover:bg-brand-600 disabled:opacity-50"
                >Odeslat</button>
              </form>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function SuggestionButton({ onClick, text }) {
  return (
    <button
      onClick={() => onClick(text)}
      className="block text-left text-xs text-brand-500 hover:text-brand-600 hover:underline"
    >→ {text}</button>
  );
}

// ---------- Přesnost odhadů (per uživatel) ----------
function AccuracyPanel({ rows }) {
  // Hide users without completed tasks – they have no data to show
  const data = rows.filter(r => r.done_count > 0);
  if (data.length === 0) return null;

  return (
    <div className="bg-white rounded-xl border border-cream-200 p-5">
      <div className="flex items-baseline justify-between mb-3">
        <h3 className="font-semibold text-ink-800">📏 Přesnost odhadů</h3>
        <span className="text-xs text-ink-500">jen dokončené úkoly se zapsanou skutečnou dobou</span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-xs uppercase text-ink-500 tracking-wide border-b border-cream-200">
            <tr>
              <th className="text-left py-2 pr-3">Člen</th>
              <th className="text-right py-2 px-2" title="Počet dokončených úkolů se zaznamenanou skutečností">Úkolů</th>
              <th className="text-right py-2 px-2" title="Součet manuálních odhadů">⏱ manual</th>
              <th className="text-right py-2 px-2" title="Součet AI odhadů">🤖 AI</th>
              <th className="text-right py-2 px-2" title="Součet skutečně odpracovaných hodin">✅ realita</th>
              <th className="text-right py-2 px-2" title="Průměrný poměr realita/manuál – <0.75 rychlejší, ~1 přesný, >1.3 podcenil">vs manuál</th>
              <th className="text-right py-2 px-2" title="Průměrný poměr realita/AI">vs AI</th>
            </tr>
          </thead>
          <tbody>
            {data.map(r => (
              <tr key={r.id} className="border-b border-cream-100 last:border-0">
                <td className="py-2 pr-3">
                  <span className="inline-flex items-center gap-2">
                    <Avatar user={{ id: r.id, name: r.name }} size={24} />
                    <span className="font-medium text-ink-800">{r.name}</span>
                  </span>
                </td>
                <td className="py-2 px-2 text-right font-semibold">{r.done_count}</td>
                <td className="py-2 px-2 text-right text-ink-600">{Number(r.sum_manual).toFixed(1)} h</td>
                <td className="py-2 px-2 text-right text-ink-600">{Number(r.sum_ai).toFixed(1)} h</td>
                <td className="py-2 px-2 text-right text-ink-800 font-semibold">{Number(r.sum_actual).toFixed(1)} h</td>
                <td className="py-2 px-2 text-right"><RatioBadge ratio={r.ratio_manual} count={r.with_manual} /></td>
                <td className="py-2 px-2 text-right"><RatioBadge ratio={r.ratio_ai}     count={r.with_ai} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="text-[11px] text-ink-400 mt-3 leading-relaxed">
        Poměr realita/odhad: <span className="text-emerald-600 font-semibold">&lt;0.75</span> = rychlejší než odhad ·
        <span className="text-amber-600 font-semibold"> ~1</span> = přesné ·
        <span className="text-red-600 font-semibold"> &gt;1.3</span> = podcenil čas
      </div>
    </div>
  );
}

function RatioBadge({ ratio, count }) {
  if (!count || count === 0) return <span className="text-ink-300">—</span>;
  const r = Number(ratio);
  let cls = 'bg-amber-50 text-amber-700 border-amber-200';
  if (r < 0.75)  cls = 'bg-emerald-50 text-emerald-700 border-emerald-200';
  else if (r > 1.3) cls = 'bg-red-50 text-red-700 border-red-200';
  return (
    <span className={`inline-block text-xs px-2 py-0.5 rounded-full border font-semibold ${cls}`}>
      {r.toFixed(2)}×
    </span>
  );
}

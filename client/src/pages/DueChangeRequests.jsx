// Žádosti o změnu termínu úkolu.
//
// Dvě boxy:
//   - "Ke schválení" (inbox) — pending žádosti, kde jsem reviewer
//   - "Moje žádosti" (sent) — všechny mé žádosti, včetně vyřešených
//
// Reviewer může u pending žádosti:
//   - Schválit (s user's termínem NEBO s vlastním counter_due)
//   - Zamítnout (s poznámkou)
//
// Podobná struktura jako Questions/AnsweredQuestions.

import { useEffect, useState } from 'react';
import PageHeader from '../components/PageHeader.jsx';
import Modal from '../components/Modal.jsx';
import { dueChangeRequests as api } from '../api.js';

const fmt = (iso) => iso ? new Date(iso).toLocaleDateString('cs-CZ', { day: 'numeric', month: 'numeric', year: 'numeric' }) : '—';
const fmtDT = (iso) => iso ? new Date(iso).toLocaleString('cs-CZ', { day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';

export default function DueChangeRequests() {
  const [box, setBox] = useState('inbox');
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [action, setAction] = useState(null); // { req, mode: 'approve' | 'reject' }

  const load = (silent = false) => {
    if (!silent) setLoading(true);
    api.list(box)
      .then(d => setItems(d.requests || []))
      .catch(() => setItems([]))
      .finally(() => setLoading(false));
  };
  useEffect(() => { load(); }, [box]);

  // Když otevřu 'sent' box, označím vyřešené jako přečtené (badge zmizí).
  useEffect(() => {
    if (box === 'sent') api.markSeen().catch(() => {});
  }, [box]);

  return (
    <div>
      <PageHeader
        title="📅 Žádosti o změnu termínu"
        subtitle={
          loading ? 'Načítám…'
            : items.length === 0
              ? (box === 'inbox' ? 'Nic nečeká na tvé schválení.' : 'Nemáš žádnou žádost.')
              : `${items.length} žádost(í)`
        }
      />

      <div className="p-4 sm:p-6 space-y-4">
        {/* Box switcher */}
        <div className="flex gap-2">
          <button onClick={() => setBox('inbox')}
            className={`px-3 py-1.5 text-sm rounded-full border transition ${
              box === 'inbox' ? 'bg-brand-500 text-white border-brand-500'
                              : 'bg-white text-ink-600 border-cream-300 hover:bg-cream-50'
            }`}>Ke schválení</button>
          <button onClick={() => setBox('sent')}
            className={`px-3 py-1.5 text-sm rounded-full border transition ${
              box === 'sent'  ? 'bg-brand-500 text-white border-brand-500'
                              : 'bg-white text-ink-600 border-cream-300 hover:bg-cream-50'
            }`}>Moje žádosti</button>
        </div>

        {loading ? (
          <div className="text-ink-500 text-sm">Načítám…</div>
        ) : items.length === 0 ? (
          <div className="bg-white border border-cream-200 rounded-xl p-8 text-center text-ink-400 text-sm">
            {box === 'inbox' ? 'Žádné pending žádosti 🎉' : 'Zatím jsi neposlal(a) žádnou žádost.'}
          </div>
        ) : (
          <ul className="space-y-2">
            {items.map(r => (
              <RequestRow key={r.id} r={r} box={box} onAction={(mode) => setAction({ req: r, mode })} />
            ))}
          </ul>
        )}
      </div>

      {action && (
        <ActionDialog
          req={action.req}
          mode={action.mode}
          onClose={() => setAction(null)}
          onDone={() => { setAction(null); load(true); }}
        />
      )}
    </div>
  );
}

function RequestRow({ r, box, onAction }) {
  const statusCls = r.status === 'pending' ? 'bg-slate-100 text-slate-700 border-slate-300'
    : r.status === 'approved' ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
    : 'bg-red-50 text-red-700 border-red-200';
  const statusLabel = r.status === 'pending' ? 'čeká' : r.status === 'approved' ? 'schváleno' : 'zamítnuto';
  const finalDue = r.counter_due || r.requested_due;

  return (
    <li className="bg-white border border-cream-200 rounded-lg p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <div className="text-[11px] uppercase tracking-wide text-ink-500 mb-1">
            {box === 'inbox' ? <>Žádá <strong>{r.requester_name}</strong></> : <>Rozhoduje <strong>{r.reviewer_name}</strong></>}
            {' · '}<span>{r.project_name}{r.team_name && <span className="text-ink-400"> · {r.team_name}</span>}</span>
          </div>
          <div className="font-medium text-ink-800 truncate">{r.task_title}</div>
          <div className="text-xs text-ink-600 mt-1">
            Původní termín: <strong>{fmt(r.original_due)}</strong>
            {' → '}
            Navržený: <strong className="text-brand-600">{fmt(r.requested_due)}</strong>
            {r.counter_due && <> {' → '}Reviewer navrhl: <strong className="text-emerald-700">{fmt(r.counter_due)}</strong></>}
          </div>
          {r.requester_note && (
            <div className="mt-2 text-xs bg-cream-50 border border-cream-200 rounded p-2">
              <span className="text-ink-500">Poznámka žadatele:</span> {r.requester_note}
            </div>
          )}
          {r.reviewer_note && (
            <div className="mt-2 text-xs bg-cream-50 border border-cream-200 rounded p-2">
              <span className="text-ink-500">Poznámka reviewera:</span> {r.reviewer_note}
            </div>
          )}
          <div className="text-[10px] text-ink-400 mt-1">
            {fmtDT(r.created_at)}
            {r.resolved_at && ` · vyřešeno ${fmtDT(r.resolved_at)}`}
          </div>
        </div>
        <div className="flex flex-col items-end gap-2">
          <span className={`text-[11px] px-2 py-0.5 rounded border ${statusCls}`}>{statusLabel}</span>
          {r.status === 'approved' && <span className="text-xs text-emerald-700">Nový termín: {fmt(finalDue)}</span>}
          {box === 'inbox' && r.status === 'pending' && (
            <div className="flex gap-2">
              <button onClick={() => onAction('reject')}
                className="px-3 py-1 text-xs bg-white border border-red-300 text-red-600 rounded hover:bg-red-50">
                Zamítnout
              </button>
              <button onClick={() => onAction('approve')}
                className="px-3 py-1 text-xs bg-emerald-500 text-white rounded hover:bg-emerald-600">
                Schválit
              </button>
            </div>
          )}
        </div>
      </div>
    </li>
  );
}

function ActionDialog({ req, mode, onClose, onDone }) {
  const [counterDue, setCounterDue] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  const submit = async () => {
    setBusy(true); setErr(null);
    try {
      if (mode === 'approve') {
        await api.approve(req.id, counterDue || null, note.trim() || null);
      } else {
        if (!note.trim()) { setErr('Napiš prosím krátkou poznámku, proč zamítáš.'); setBusy(false); return; }
        await api.reject(req.id, note.trim());
      }
      onDone();
    } catch (e) {
      setErr(e.response?.data?.message || e.message);
    } finally { setBusy(false); }
  };

  const title = mode === 'approve' ? `Schválit žádost — ${req.task_title}` : `Zamítnout žádost — ${req.task_title}`;

  return (
    <Modal open={true} onClose={onClose} title={title}
      footer={<>
        <button onClick={onClose} className="px-3 py-1.5 text-sm rounded border border-ink-300">Zrušit</button>
        <button onClick={submit} disabled={busy}
          className={`px-3 py-1.5 text-sm rounded text-white disabled:opacity-50 ${
            mode === 'approve' ? 'bg-emerald-500 hover:bg-emerald-600' : 'bg-red-500 hover:bg-red-600'
          }`}>
          {busy ? 'Odesílám…' : mode === 'approve' ? 'Schválit' : 'Zamítnout'}
        </button>
      </>}>
      <div className="space-y-3 text-sm">
        <div className="text-ink-600">
          {req.requester_name} navrhuje termín <strong>{fmt(req.requested_due)}</strong>
          {' '}(původní {fmt(req.original_due)}).
        </div>
        {mode === 'approve' && (
          <label className="block">
            <span className="text-xs font-medium text-ink-600">
              Navrhnout jiný termín <span className="text-ink-400">(nechat prázdné = schválit user's termín)</span>
            </span>
            <input type="date" value={counterDue} onChange={e => setCounterDue(e.target.value)}
              className="mt-1 w-full border border-ink-300 rounded px-2 py-1.5" />
          </label>
        )}
        <label className="block">
          <span className="text-xs font-medium text-ink-600">
            Poznámka {mode === 'reject' && <span className="text-red-500">*</span>}
          </span>
          <textarea rows={3} value={note} onChange={e => setNote(e.target.value)}
            placeholder={mode === 'approve' ? 'Volitelná zpráva pro žadatele' : 'Proč zamítáš'}
            className="mt-1 w-full border border-ink-300 rounded px-2 py-1.5" />
        </label>
        {err && <div className="text-xs text-red-600 bg-red-50 border border-red-200 rounded p-2">{err}</div>}
      </div>
    </Modal>
  );
}

// Historie review rozhodnutí pro daný úkol.
// Programátor vidí, co manager vrátil a co napsal v komentáři –
// tipicky se hodí ve stavu 'needs_fix', ale dává smysl vidět i v 'done'.
import { useEffect, useState } from 'react';
import { reviews as reviewsApi } from '../api.js';

export default function ReviewHistory({ taskId }) {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    reviewsApi.history(taskId)
      .then(d => { if (!cancelled) setItems(d.reviews || []); })
      .catch(() => { /* swallow – endpoint může vrátit prázdno */ })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [taskId]);

  if (loading || items.length === 0) return null;

  return (
    <section>
      <h3 className="text-sm font-semibold text-ink-800 mb-2">Historie review</h3>
      <ul className="space-y-2">
        {items.map(r => <ReviewItem key={r.id} review={r} />)}
      </ul>
    </section>
  );
}

function ReviewItem({ review }) {
  const ts = new Date(review.created_at + (String(review.created_at).endsWith('Z') ? '' : 'Z'))
    .toLocaleString('cs-CZ', { day: 'numeric', month: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  const isApproved = review.verdict === 'approved';
  const tone = isApproved
    ? { border: 'border-emerald-400', bg: 'bg-emerald-50', text: 'text-emerald-700', icon: '✅', label: 'Schváleno' }
    : { border: 'border-orange-400', bg: 'bg-orange-50', text: 'text-orange-700', icon: '🔄', label: 'Vráceno k opravě' };

  return (
    <li className={`border-l-4 ${tone.border} ${tone.bg} pl-3 py-2 rounded-r`}>
      <div className="flex items-center justify-between text-xs">
        <span className={`font-semibold ${tone.text}`}>{tone.icon} {tone.label}</span>
        <span className="text-ink-500">{review.reviewer_name || 'Neznámý'} · {ts}</span>
      </div>
      {review.comment && (
        <div className="text-sm text-ink-700 mt-1 whitespace-pre-wrap">{review.comment}</div>
      )}
    </li>
  );
}

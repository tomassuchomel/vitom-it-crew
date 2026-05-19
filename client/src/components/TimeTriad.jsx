// Kompaktní zobrazení tří odhadů/skutečnosti pro úkol:
//   ⏱ manual · 🤖 AI · ✅ skutečně
// Skrýt celé, pokud žádná hodnota neexistuje.
// V "compact" módu se zobrazí jen čísla bez popisků.
export default function TimeTriad({ task, compact = false }) {
  const manual = task?.estimated_h;
  const ai     = task?.ai_estimated_h;
  const real   = task?.actual_h;

  // Žádná hodnota? Nezobrazuj nic.
  if (manual == null && ai == null && real == null) return null;

  const fmt = (n) => Number(n).toFixed(1).replace(/\.0$/, '');

  // Pokud máme realitu, můžeme zvýraznit srovnání:
  // - reality < estimate ~30% → emerald (přesně/rychle)
  // - reality > estimate ~30% → red (podcenil)
  // - jinak ink (přibližně)
  const accuracyClass = (est) => {
    if (real == null || est == null || est <= 0) return 'text-ink-700';
    const ratio = Number(real) / Number(est);
    if (ratio < 0.75) return 'text-emerald-600';
    if (ratio > 1.3)  return 'text-red-600';
    return 'text-amber-600';
  };

  const sep = <span className="text-ink-300">·</span>;

  return (
    <span className="inline-flex items-center gap-2 text-xs">
      {manual != null && (
        <span className="inline-flex items-center gap-1" title="Manuální odhad">
          <span>⏱</span>
          <span className={`font-semibold ${real != null ? accuracyClass(manual) : 'text-ink-700'}`}>{fmt(manual)} h</span>
          {!compact && <span className="text-ink-400">manual</span>}
        </span>
      )}
      {ai != null && (
        <>
          {manual != null && sep}
          <span className="inline-flex items-center gap-1" title="AI odhad">
            <span>🤖</span>
            <span className={`font-semibold ${real != null ? accuracyClass(ai) : 'text-ink-700'}`}>{fmt(ai)} h</span>
            {!compact && <span className="text-ink-400">AI</span>}
          </span>
        </>
      )}
      {real != null && (
        <>
          {(manual != null || ai != null) && sep}
          <span className="inline-flex items-center gap-1" title="Skutečný čas">
            <span>✅</span>
            <span className="font-semibold text-ink-800">{fmt(real)} h</span>
            {!compact && <span className="text-ink-400">realita</span>}
          </span>
        </>
      )}
    </span>
  );
}

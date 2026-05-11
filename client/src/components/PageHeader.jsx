export default function PageHeader({ title, subtitle, actions }) {
  return (
    <div className="flex items-center justify-between px-8 py-6 border-b border-cream-200 bg-white">
      <div>
        <h1 className="text-3xl font-bold text-brand-500 tracking-tight">{title}</h1>
        {subtitle && <p className="text-sm text-ink-500 mt-1">{subtitle}</p>}
      </div>
      <div className="flex items-center gap-2">{actions}</div>
    </div>
  );
}

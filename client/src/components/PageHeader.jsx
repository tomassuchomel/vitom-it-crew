export default function PageHeader({ title, subtitle, actions }) {
  return (
    <div className="flex flex-wrap items-start sm:items-center justify-between gap-3 px-4 sm:px-8 py-4 sm:py-6 border-b border-cream-200 bg-white">
      <div className="min-w-0 flex-1">
        <h1 className="text-2xl sm:text-3xl font-bold text-brand-500 tracking-tight">{title}</h1>
        {subtitle && <p className="text-xs sm:text-sm text-ink-500 mt-1">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

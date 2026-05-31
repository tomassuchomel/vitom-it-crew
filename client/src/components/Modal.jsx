export default function Modal({ open, onClose, title, children, footer }) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50 sm:p-4" onClick={onClose}>
      <div
        className="bg-white shadow-xl w-full flex flex-col
                   h-full sm:h-auto sm:max-h-[90vh] sm:max-w-lg sm:rounded-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-5 py-4 border-b border-slate-200 flex items-center justify-between flex-shrink-0">
          <h3 className="font-semibold text-slate-800">{title}</h3>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-700 text-2xl leading-none w-8 h-8 flex items-center justify-center">×</button>
        </div>
        <div className="p-5 overflow-auto flex-1">{children}</div>
        {footer && <div className="px-5 py-3 border-t border-slate-200 bg-slate-50 flex justify-end gap-2 flex-shrink-0">{footer}</div>}
      </div>
    </div>
  );
}

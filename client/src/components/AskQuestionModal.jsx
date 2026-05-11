// Sdílená komponenta – modal pro přidání dotazu k úkolu
import { useEffect, useState } from 'react';
import Modal from './Modal.jsx';
import { questions as questionsApi, users as usersApi } from '../api.js';

export default function AskQuestionModal({ open, onClose, taskId, taskTitle, defaultToUserId, onCreated }) {
  const [users, setUsers] = useState([]);
  const [toUserId, setToUserId] = useState(defaultToUserId || '');
  const [text, setText] = useState('');
  const [err, setErr] = useState(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) {
      usersApi.list().then(d => setUsers(d.users.filter(u => u.active)));
      setToUserId(defaultToUserId || '');
      setText('');
      setErr(null);
    }
  }, [open, defaultToUserId]);

  const submit = async (e) => {
    e.preventDefault();
    setErr(null); setSaving(true);
    try {
      await questionsApi.create({
        task_id: taskId,
        to_user_id: Number(toUserId),
        question: text,
      });
      onCreated?.();
      onClose();
    } catch (e) {
      setErr(e.response?.data?.error || 'Uložení selhalo');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="💬 Přidat dotaz"
      footer={<>
        <button onClick={onClose} className="px-3 py-1.5 text-sm rounded border border-slate-300">Zrušit</button>
        <button onClick={submit} disabled={saving || !toUserId || !text.trim()}
          className="px-3 py-1.5 text-sm rounded bg-brand-500 text-white disabled:opacity-50">
          {saving ? 'Odesílám…' : 'Odeslat dotaz'}
        </button>
      </>}>
      <form onSubmit={submit} className="space-y-3 text-sm">
        {taskTitle && (
          <div className="text-xs text-slate-500">
            Úkol: <span className="font-medium text-slate-700">{taskTitle}</span>
          </div>
        )}
        <label className="block">
          <span className="text-xs font-medium text-slate-600">Komu *</span>
          <select
            value={toUserId}
            onChange={(e) => setToUserId(e.target.value)}
            className="mt-1 w-full border border-slate-300 rounded px-2 py-1.5"
            required
          >
            <option value="">— vyber osobu —</option>
            {users.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}
          </select>
        </label>
        <label className="block">
          <span className="text-xs font-medium text-slate-600">Dotaz *</span>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={4}
            placeholder="Napiš svůj dotaz…"
            className="mt-1 w-full border border-slate-300 rounded px-2 py-1.5"
            required
          />
        </label>
        {err && <div className="text-red-600 text-xs">{err}</div>}
      </form>
    </Modal>
  );
}

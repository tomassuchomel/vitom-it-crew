// Quick Capture FAB — floating action button vpravo dole.
// Klik otevře QuickCaptureFlow: hlasovka → AI klasifikace → user potvrdí akci.
//
// Intenty:
//   - note      → vytvoří poznámku v aktuálním teamu
//   - task      → vytvoří dočasnou poznámku + spustí suggest_tasks → SuggestedTasksModal
//   - question  → AskQuestionModal s prefilled obsahem
//   - mail      → zatím není (Email agent C ještě neběží), fallback na note s upozorněním

import { useState } from 'react';
import { notes as notesApi } from '../api.js';
import VoiceMeetingModal from './VoiceMeetingModal.jsx';
import SuggestedTasksModal from './SuggestedTasksModal.jsx';
import AskQuestionModal from './AskQuestionModal.jsx';

const INTENT_LABELS = {
  task:     { emoji: '✅', label: 'Vytvořit úkol(y)' },
  note:     { emoji: '📝', label: 'Uložit jako poznámku' },
  question: { emoji: '💬', label: 'Položit jako dotaz' },
  mail:     { emoji: '📧', label: 'Email (zatím nedostupné)' },
};

export default function QuickCaptureFAB() {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        title="Rychlý hlasový záznam"
        className="fixed bottom-4 right-4 z-40 w-14 h-14 rounded-full bg-accent-500 hover:bg-accent-600 active:bg-accent-700 text-white shadow-2xl flex items-center justify-center text-2xl transition lg:bottom-6 lg:right-6"
        style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
      >
        🎙️
      </button>
      {open && <QuickCaptureFlow onClose={() => setOpen(false)} />}
    </>
  );
}

function QuickCaptureFlow({ onClose }) {
  // phases:
  //   'voice'        – VoiceMeetingModal nahrává
  //   'classifying'  – AI klasifikuje text
  //   'choose'       – user vidí návrh + může změnit
  //   'tasks'        – SuggestedTasksModal (intent=task)
  //   'question'     – AskQuestionModal (intent=question)
  const [phase, setPhase] = useState('voice');
  const [text, setText] = useState('');
  const [classification, setClassification] = useState(null);
  const [suggestion, setSuggestion] = useState(null);
  const [draftNoteId, setDraftNoteId] = useState(null); // pro suggest_tasks
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);

  const handleVoiceSubmit = async (cleanedText) => {
    if (!cleanedText?.trim()) { onClose(); return; }
    setText(cleanedText);
    setPhase('classifying');
    setErr(null);
    try {
      const c = await notesApi.classify(cleanedText);
      setClassification(c);
      setPhase('choose');
    } catch (e) {
      setErr(e.response?.data?.message || 'Klasifikace selhala — vyber akci ručně.');
      setClassification({ intent: 'note', summary: '', params: {} });
      setPhase('choose');
    }
  };

  const execute = async (intent) => {
    setBusy(true); setErr(null);
    try {
      if (intent === 'note' || intent === 'mail') {
        const title = classification?.params?.suggested_title
          || `Záznam ${new Date().toLocaleDateString('cs-CZ')}`;
        const content = `<p>${escapeHtml(text).replace(/\n+/g, '</p><p>')}</p>`;
        const r = await notesApi.create({ title, content, parent_id: null, visibility: 'team' });
        const msg = intent === 'mail'
          ? `📝 Uloženo jako poznámka „${r.note.title}" (Email agent zatím není zapojený)`
          : `📝 Poznámka „${r.note.title}" vytvořena`;
        alert(msg);
        onClose();
      } else if (intent === 'task') {
        // Dočasná poznámka, ze které AI vytáhne úkoly. Po vytvoření úkolů ji
        // nemažeme — slouží jako zdroj („Z hlasovky 30.5.").
        const title = classification?.params?.suggested_title
          || `Hlasovka ${new Date().toLocaleDateString('cs-CZ')}`;
        const content = `<p>${escapeHtml(text).replace(/\n+/g, '</p><p>')}</p>`;
        const r = await notesApi.create({ title, content, parent_id: null, visibility: 'team' });
        setDraftNoteId(r.note.id);
        const ai = await notesApi.aiProcess(r.note.id, 'suggest_tasks');
        if (!ai.suggestion?.tasks?.length) {
          alert('AI nenašla žádné akční úkoly v záznamu. Poznámka byla uložena.');
          onClose();
          return;
        }
        setSuggestion(ai.suggestion);
        setPhase('tasks');
      } else if (intent === 'question') {
        setPhase('question');
      }
    } catch (e) {
      setErr(e.response?.data?.message || 'Akce selhala.');
    } finally {
      setBusy(false);
    }
  };

  // ── Render fáze ──────────────────────────────────────────────────────

  if (phase === 'voice') {
    return (
      <VoiceMeetingModal
        submitLabel="Pokračovat →"
        onSubmit={handleVoiceSubmit}
        onClose={onClose}
      />
    );
  }

  if (phase === 'classifying') {
    return (
      <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" onClick={onClose}>
        <div className="bg-white rounded-xl p-6 text-center" onClick={(e) => e.stopPropagation()}>
          <div className="text-3xl mb-2 animate-pulse">🤖</div>
          <div className="text-sm text-ink-600">AI rozhoduje, co s tím…</div>
        </div>
      </div>
    );
  }

  if (phase === 'choose') {
    const recommended = classification?.intent || 'note';
    return (
      <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" onClick={onClose}>
        <div className="bg-white rounded-xl shadow-2xl max-w-lg w-full max-h-[90vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
          <div className="px-5 py-4 border-b border-cream-200 flex items-center justify-between">
            <div>
              <h2 className="text-lg font-bold text-ink-800">🤖 AI návrh</h2>
              <div className="text-xs text-ink-500">{classification?.summary || 'Vyber, co se má stát.'}</div>
            </div>
            <button onClick={onClose} className="text-ink-400 hover:text-ink-700 text-2xl leading-none">×</button>
          </div>
          <div className="p-5 space-y-3 overflow-y-auto flex-1">
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows={5}
              className="w-full border border-cream-300 rounded-lg p-2 text-sm"
            />
            {err && <div className="text-xs text-red-600 bg-red-50 border border-red-200 rounded p-2">{err}</div>}
            <div className="space-y-2">
              {['task', 'note', 'question', 'mail'].map((i) => {
                const meta = INTENT_LABELS[i];
                const isRecommended = i === recommended;
                return (
                  <button
                    key={i}
                    onClick={() => execute(i)}
                    disabled={busy}
                    className={`w-full text-left px-4 py-3 rounded-lg border-2 transition ${
                      isRecommended
                        ? 'border-accent-500 bg-accent-50 hover:bg-accent-100'
                        : 'border-cream-300 hover:bg-cream-50'
                    } disabled:opacity-50`}
                  >
                    <div className="flex items-center gap-2">
                      <span className="text-xl">{meta.emoji}</span>
                      <span className="font-medium text-ink-800">{meta.label}</span>
                      {isRecommended && (
                        <span className="ml-auto text-[10px] uppercase tracking-wide text-accent-600 font-bold">AI doporučuje</span>
                      )}
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
          <div className="px-5 py-3 border-t border-cream-200 flex justify-end">
            <button onClick={onClose} className="px-3 py-1.5 text-sm text-ink-500 hover:text-ink-700">Zahodit</button>
          </div>
        </div>
      </div>
    );
  }

  if (phase === 'tasks' && suggestion) {
    return (
      <SuggestedTasksModal
        suggestion={suggestion}
        sourceNote={draftNoteId ? { id: draftNoteId, title: classification?.params?.suggested_title || 'Hlasovka' } : null}
        sourceScope="team"
        onClose={onClose}
        onCreated={(count) => {
          alert(`✅ Vytvořeno ${count} úkol(ů) z hlasovky.`);
          onClose();
        }}
      />
    );
  }

  if (phase === 'question') {
    return (
      <AskQuestionModal
        open={true}
        onClose={onClose}
        taskId={null}
        taskTitle={null}
        defaultToUserId={classification?.params?.suggested_assignee_id || null}
        prefillQuestion={text}
        onCreated={() => {
          alert('💬 Dotaz odeslán.');
          onClose();
        }}
      />
    );
  }

  return null;
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

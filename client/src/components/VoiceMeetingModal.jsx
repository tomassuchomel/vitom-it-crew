// Hlasová porada – nahraje mikrofon přes MediaRecorder, po zastavení pošle
// audio na /api/notes/transcribe (Whisper) a vrátí přepis. Uživatel pak
// přepis vloží do nové poznámky (onCreateNote), kde už funguje AI
// (Sumarizovat / Navrhnout úkoly).
//
// Pozn.: Whisper má limit 25 MB. webm/opus ≈ 1 MB/min → ~25 min porady.
// Delší by chtělo chunking (zatím neřešeno).

import { useEffect, useRef, useState } from 'react';
import { notes as notesApi } from '../api.js';

const fmtTime = (s) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;

export default function VoiceMeetingModal({ onClose, onSubmit, submitLabel = 'Vložit přepis', onCreateNote }) {
  const [phase, setPhase] = useState('idle'); // idle | recording | transcribing | done | error
  const [seconds, setSeconds] = useState(0);
  const [transcript, setTranscript] = useState('');
  const [err, setErr] = useState(null);
  const mediaRef = useRef(null);     // MediaRecorder
  const streamRef = useRef(null);    // MediaStream (kvůli stop tracks)
  const chunksRef = useRef([]);
  const timerRef = useRef(null);

  // Úklid při zavření
  useEffect(() => () => {
    if (timerRef.current) clearInterval(timerRef.current);
    streamRef.current?.getTracks().forEach(t => t.stop());
  }, []);

  const start = async () => {
    setErr(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      chunksRef.current = [];
      const mr = new MediaRecorder(stream);
      mr.ondataavailable = (e) => { if (e.data.size > 0) chunksRef.current.push(e.data); };
      mr.onstop = () => upload();
      mediaRef.current = mr;
      mr.start();
      setPhase('recording');
      setSeconds(0);
      timerRef.current = setInterval(() => setSeconds(s => s + 1), 1000);
    } catch (e) {
      setErr('Nepodařilo se spustit mikrofon. Povol přístup k mikrofonu v prohlížeči.');
      setPhase('error');
    }
  };

  const stop = () => {
    if (timerRef.current) clearInterval(timerRef.current);
    streamRef.current?.getTracks().forEach(t => t.stop());
    if (mediaRef.current && mediaRef.current.state !== 'inactive') {
      mediaRef.current.stop(); // → onstop → upload()
    }
    setPhase('transcribing');
  };

  const upload = async () => {
    try {
      const blob = new Blob(chunksRef.current, { type: 'audio/webm' });
      if (blob.size === 0) { setErr('Nahrávka je prázdná.'); setPhase('error'); return; }
      if (blob.size > 25 * 1024 * 1024) {
        setErr('Nahrávka je větší než 25 MB (limit Whisper). Zkus kratší poradu.');
        setPhase('error'); return;
      }
      const d = await notesApi.transcribe(blob);
      setTranscript(d.text || '');
      setPhase('done');
    } catch (e) {
      setErr(e.response?.data?.message || e.response?.data?.error || 'Přepis selhal');
      setPhase('error');
    }
  };

  const submit = async () => {
    // Preferuj nový generický onSubmit(text). Fallback na starší onCreateNote(title, html).
    if (onSubmit) {
      await onSubmit(transcript);
    } else if (onCreateNote) {
      const title = `Porada ${new Date().toLocaleDateString('cs-CZ')}`;
      const html = transcript.split(/\n+/).map(p => `<p>${escapeHtml(p)}</p>`).join('') || '<p></p>';
      await onCreateNote(title, html);
    }
    onClose();
  };

  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white rounded-xl shadow-2xl max-w-lg w-full" onClick={(e) => e.stopPropagation()}>
        <div className="px-5 py-4 border-b border-cream-200 flex items-center justify-between">
          <h2 className="text-lg font-bold text-ink-800">🎙️ Hlasová porada</h2>
          <button onClick={onClose} className="text-ink-400 hover:text-ink-700 text-2xl leading-none">×</button>
        </div>

        <div className="p-6 text-center">
          {phase === 'idle' && (
            <>
              <div className="text-5xl mb-3">🎙️</div>
              <p className="text-sm text-ink-600 mb-4">
                Spusť nahrávání a mluv. Po zastavení poradu přepíšu (Whisper) a
                budeš moct vytvořit poznámku + nechat AI navrhnout úkoly.
              </p>
              <button onClick={start}
                className="px-5 py-2.5 bg-red-500 text-white rounded-full font-medium hover:bg-red-600">
                ● Začít nahrávat
              </button>
            </>
          )}

          {phase === 'recording' && (
            <>
              <div className="text-5xl mb-3 animate-pulse">🔴</div>
              <div className="text-3xl font-mono text-ink-800 mb-1">{fmtTime(seconds)}</div>
              <p className="text-xs text-ink-500 mb-4">Nahrávám… mluv normálně.</p>
              <button onClick={stop}
                className="px-5 py-2.5 bg-ink-800 text-white rounded-full font-medium hover:bg-ink-900">
                ■ Zastavit a přepsat
              </button>
            </>
          )}

          {phase === 'transcribing' && (
            <>
              <div className="text-5xl mb-3 animate-pulse">✍️</div>
              <p className="text-sm text-ink-600">Přepisuji nahrávku ({fmtTime(seconds)})… chvíli to potrvá.</p>
            </>
          )}

          {phase === 'done' && (
            <div className="text-left">
              <div className="text-xs font-semibold text-ink-500 uppercase tracking-wide mb-1">Přepis ({fmtTime(seconds)})</div>
              <textarea
                value={transcript}
                onChange={(e) => setTranscript(e.target.value)}
                rows={8}
                className="w-full border border-cream-300 rounded-lg p-3 text-sm leading-relaxed focus:outline-none focus:ring-2 focus:ring-brand-400"
              />
              <div className="text-[11px] text-ink-400 mt-1">Přepis si můžeš opravit před vytvořením poznámky.</div>
            </div>
          )}

          {phase === 'error' && (
            <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded p-3">{err}</div>
          )}
        </div>

        {(phase === 'done' || phase === 'error') && (
          <div className="px-5 py-3 border-t border-cream-200 flex justify-end gap-2">
            {phase === 'error' && (
              <button onClick={() => { setPhase('idle'); setErr(null); }}
                className="px-3 py-1.5 text-sm rounded border border-cream-300 hover:bg-cream-50">Zkusit znovu</button>
            )}
            {phase === 'done' && (
              <button onClick={submit} disabled={!transcript.trim()}
                className="px-4 py-1.5 text-sm rounded bg-brand-500 text-white hover:bg-brand-600 disabled:opacity-50">
                {onSubmit ? submitLabel : 'Vytvořit poznámku z přepisu'}
              </button>
            )}
            <button onClick={onClose} className="px-3 py-1.5 text-sm text-ink-500 hover:text-ink-700">Zavřít</button>
          </div>
        )}
      </div>
    </div>
  );
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

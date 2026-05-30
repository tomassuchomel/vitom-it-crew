// Hlasová porada s real-time přepisem (chunked Whisper + Claude cleanup).
//
// Flow:
//   1. start → MediaRecorder se restartuje každých 10s (každý chunk je validní WebM)
//   2. každý chunk → POST /api/notes/transcribe-chunk → text se připojí do liveText
//   3. každých 30s → POST /api/notes/transcript-cleanup → Claude opraví interpunkci,
//      sjednotí pojmy, převede do logických vět (nahradí liveText čistou verzí)
//   4. stop → final cleanup → editable cleanedText → Vložit/Vytvořit
//
// Pozn.: Anthropic speech-to-text nemá, proto Whisper (OpenAI) pro přepis +
// Claude (Anthropic) pro cleanup. Dva providery, vědomé rozhodnutí.

import { useEffect, useRef, useState } from 'react';
import { notes as notesApi } from '../api.js';

const CHUNK_MS = 10_000;      // restart MR každých 10s (= 1 chunk)
const CLEANUP_MS = 30_000;    // průběžný cleanup každých 30s
const MIN_LEN_FOR_CLEANUP = 100; // málo textu nemá smysl posílat na cleanup

const fmtTime = (s) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;

// iOS Safari nepodporuje WebM/Opus → produkuje audio/mp4 (AAC). Chrome/Firefox
// preferují WebM/Opus. Vrátíme první podporovaný MIME, nebo prázdný string
// (= browser default, MediaRecorder pak vybere sám). Whisper API bere obojí.
const pickAudioMime = () => {
  if (typeof MediaRecorder === 'undefined' || !MediaRecorder.isTypeSupported) return '';
  const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/mp4;codecs=mp4a.40.2'];
  for (const m of candidates) if (MediaRecorder.isTypeSupported(m)) return m;
  return '';
};

export default function VoiceMeetingModal({ onClose, onSubmit, submitLabel = 'Vložit přepis', onCreateNote }) {
  const [phase, setPhase] = useState('idle'); // idle | recording | cleaning | done | error
  const [secs, setSecs] = useState(0);
  const [liveText, setLiveText] = useState('');
  const [cleanedText, setCleanedText] = useState('');
  const [err, setErr] = useState(null);

  const streamRef = useRef(null);
  const mrRef = useRef(null);
  const restartTimerRef = useRef(null);
  const secsTimerRef = useRef(null);
  const cleanupTimerRef = useRef(null);
  const liveTextRef = useRef('');           // přístup k aktuální hodnotě v async callbacks
  const isStoppingRef = useRef(false);

  useEffect(() => { liveTextRef.current = liveText; }, [liveText]);
  useEffect(() => () => cleanup(), []);     // úklid na unmount

  const cleanup = () => {
    [restartTimerRef, secsTimerRef, cleanupTimerRef].forEach(r => {
      if (r.current) { clearInterval(r.current); r.current = null; }
    });
    streamRef.current?.getTracks().forEach(t => t.stop());
    streamRef.current = null;
    if (mrRef.current && mrRef.current.state !== 'inactive') {
      try { mrRef.current.stop(); } catch {}
    }
    mrRef.current = null;
  };

  const start = async () => {
    setErr(null);
    setLiveText(''); setCleanedText(''); setSecs(0);
    isStoppingRef.current = false;
    try {
      streamRef.current = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      setErr('Nepodařilo se spustit mikrofon. Povol přístup v prohlížeči.');
      setPhase('error'); return;
    }
    startNewMR();
    setPhase('recording');
    secsTimerRef.current = setInterval(() => setSecs(s => s + 1), 1000);
    restartTimerRef.current = setInterval(restartMR, CHUNK_MS);
    cleanupTimerRef.current = setInterval(liveCleanup, CLEANUP_MS);
  };

  const startNewMR = () => {
    if (!streamRef.current) return;
    const localChunks = [];
    // MIME se vybírá per-browser. iOS Safari = audio/mp4, Chrome = audio/webm.
    const mime = pickAudioMime();
    const mr = mime ? new MediaRecorder(streamRef.current, { mimeType: mime }) : new MediaRecorder(streamRef.current);
    const effectiveMime = mr.mimeType || mime || 'audio/webm';
    mr.ondataavailable = (e) => { if (e.data.size > 0) localChunks.push(e.data); };
    mr.onstop = async () => {
      if (localChunks.length === 0) return;
      const blob = new Blob(localChunks, { type: effectiveMime });
      if (blob.size < 1000) return; // chunk skoro prázdný (ticho/restart artefakt)
      try {
        const d = await notesApi.transcribeChunk(blob);
        const t = (d.text || '').trim();
        if (t) setLiveText(prev => (prev ? prev + ' ' + t : t).replace(/\s+/g, ' '));
      } catch { /* drop chunk; není kritické */ }
    };
    mr.start();
    mrRef.current = mr;
  };

  const restartMR = () => {
    const old = mrRef.current;
    if (old && old.state !== 'inactive') {
      try { old.stop(); } catch {}
    }
    // okamžitě nový MR – cca 50ms gap mezi chunky je akceptovatelný
    if (!isStoppingRef.current) startNewMR();
  };

  const liveCleanup = async () => {
    const t = liveTextRef.current;
    if (t.length < MIN_LEN_FOR_CLEANUP) return;
    try {
      const d = await notesApi.cleanupTranscript(t);
      if (d.cleaned && d.cleaned.trim().length > 0) setLiveText(d.cleaned);
    } catch { /* ignore – cleanup je volitelný */ }
  };

  const stop = async () => {
    isStoppingRef.current = true;
    [restartTimerRef, cleanupTimerRef, secsTimerRef].forEach(r => {
      if (r.current) { clearInterval(r.current); r.current = null; }
    });
    const mr = mrRef.current;
    if (mr && mr.state !== 'inactive') {
      try { mr.stop(); } catch {}
    }
    setPhase('cleaning');
    // chvíli počkej na zpracování posledního chunku
    await new Promise(r => setTimeout(r, 1500));
    try {
      const d = await notesApi.cleanupTranscript(liveTextRef.current);
      setCleanedText(d.cleaned || liveTextRef.current);
    } catch {
      setCleanedText(liveTextRef.current);
    }
    streamRef.current?.getTracks().forEach(t => t.stop());
    streamRef.current = null;
    setPhase('done');
  };

  const submit = async () => {
    if (onSubmit) {
      await onSubmit(cleanedText);
    } else if (onCreateNote) {
      const title = `Porada ${new Date().toLocaleDateString('cs-CZ')}`;
      const html = cleanedText.split(/\n+/).map(p => `<p>${escapeHtml(p)}</p>`).join('') || '<p></p>';
      await onCreateNote(title, html);
    }
    onClose();
  };

  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white rounded-xl shadow-2xl max-w-2xl w-full max-h-[90vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="px-5 py-4 border-b border-cream-200 flex items-center justify-between">
          <div>
            <h2 className="text-lg font-bold text-ink-800">🎙️ Hlasová porada</h2>
            <div className="text-xs text-ink-500">Real-time přepis (Whisper) s průběžnou úpravou (Claude).</div>
          </div>
          <button onClick={onClose} className="text-ink-400 hover:text-ink-700 text-2xl leading-none">×</button>
        </div>

        <div className="p-6 overflow-y-auto flex-1">
          {phase === 'idle' && (
            <div className="text-center">
              <div className="text-5xl mb-3">🎙️</div>
              <p className="text-sm text-ink-600 mb-4">
                Spusť a mluv. Přepis poběží naživo, AI ho průběžně upravuje do logických vět.
                Po zastavení jde ještě upravit a vložit.
              </p>
              <button onClick={start}
                className="px-5 py-2.5 bg-red-500 text-white rounded-full font-medium hover:bg-red-600">
                ● Začít nahrávat
              </button>
            </div>
          )}

          {phase === 'recording' && (
            <>
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2">
                  <span className="text-xl animate-pulse">🔴</span>
                  <span className="text-2xl font-mono text-ink-800">{fmtTime(secs)}</span>
                </div>
                <button onClick={stop}
                  className="px-4 py-2 bg-ink-800 text-white rounded-full text-sm font-medium hover:bg-ink-900">
                  ■ Zastavit
                </button>
              </div>
              <div className="text-[11px] uppercase tracking-wide text-ink-500 mb-1">Živý přepis</div>
              <div className="border border-cream-300 rounded-lg p-3 bg-cream-50 min-h-[200px] max-h-[40vh] overflow-y-auto text-sm whitespace-pre-wrap">
                {liveText || <span className="text-ink-400 italic">Přepis se objeví během několika sekund…</span>}
              </div>
              <div className="text-[10px] text-ink-400 mt-1">
                Přepis přichází po ~10s chunků. AI ho každých ~30s sjednotí (interpunkce, pojmy).
              </div>
            </>
          )}

          {phase === 'cleaning' && (
            <div className="text-center py-8">
              <div className="text-5xl mb-3 animate-pulse">✨</div>
              <p className="text-sm text-ink-600">Finalizuji přepis…</p>
            </div>
          )}

          {phase === 'done' && (
            <>
              <div className="text-[11px] uppercase tracking-wide text-ink-500 mb-1">Přepis ({fmtTime(secs)})</div>
              <textarea
                value={cleanedText}
                onChange={(e) => setCleanedText(e.target.value)}
                rows={12}
                className="w-full border border-cream-300 rounded-lg p-3 text-sm leading-relaxed focus:outline-none focus:ring-2 focus:ring-brand-400"
              />
              <div className="text-[11px] text-ink-400 mt-1">Před vložením můžeš upravit.</div>
            </>
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
              <button onClick={submit} disabled={!cleanedText.trim()}
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

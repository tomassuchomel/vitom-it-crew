// Komponenta pro správu příloh úkolu – upload zone + galerie + lightbox.
import { useEffect, useRef, useState } from 'react';
import { attachments as attApi } from '../api.js';

export default function Attachments({ taskId, canEdit = true, compact = false }) {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [err, setErr] = useState(null);
  const [lightboxIdx, setLightboxIdx] = useState(null);
  const fileRef = useRef();

  const load = () => {
    setLoading(true);
    attApi.list(taskId).then(d => setItems(d.attachments)).finally(() => setLoading(false));
  };
  useEffect(load, [taskId]);

  const handleFiles = async (files) => {
    if (!files?.length) return;
    setErr(null); setUploading(true);
    try {
      await attApi.upload(taskId, files);
      load();
    } catch (e) {
      setErr(e.response?.data?.message || 'Upload selhal');
    } finally {
      setUploading(false);
    }
  };

  const onPick = (e) => handleFiles(e.target.files);
  const onDrop = (e) => {
    e.preventDefault();
    handleFiles(e.dataTransfer.files);
  };
  const onDragOver = (e) => e.preventDefault();

  const handleDelete = async (a) => {
    if (!confirm(`Smazat ${a.original_name}?`)) return;
    await attApi.remove(a.id);
    load();
  };

  const galleryItems = items;
  const images = galleryItems.filter(a => a.kind === 'image');
  const videos = galleryItems.filter(a => a.kind === 'video');
  const others = galleryItems.filter(a => a.kind === 'other');

  return (
    <div>
      {canEdit && (
        <div
          onDrop={onDrop}
          onDragOver={onDragOver}
          className={`border-2 border-dashed rounded-lg p-3 text-center transition cursor-pointer ${
            uploading ? 'border-brand-500 bg-brand-50' : 'border-cream-300 hover:border-brand-500 hover:bg-cream-50'
          }`}
          onClick={() => fileRef.current?.click()}
        >
          <input
            ref={fileRef}
            type="file"
            accept="image/*,video/*"
            multiple
            className="hidden"
            onChange={onPick}
          />
          <div className="text-2xl">{uploading ? '⏳' : '📎'}</div>
          <div className="text-xs text-ink-600 mt-1">
            {uploading ? 'Nahrávám…' : compact ? 'Přidat foto/video' : 'Přetáhni sem nebo klikni'}
          </div>
          <div className="text-[10px] text-ink-400 mt-0.5">JPG, PNG, MP4, WEBM (max 25 MB)</div>
        </div>
      )}
      {err && <div className="text-xs text-red-600 mt-2">{err}</div>}

      {loading ? (
        <div className="text-xs text-ink-400 mt-3">Načítám přílohy…</div>
      ) : items.length === 0 && !canEdit ? null : items.length === 0 ? null : (
        <div className="mt-3 space-y-3">
          {/* Obrázky – grid */}
          {images.length > 0 && (
            <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 gap-2">
              {images.map((a, i) => (
                <Thumbnail
                  key={a.id}
                  attachment={a}
                  onClick={() => setLightboxIdx(galleryItems.indexOf(a))}
                  onDelete={canEdit ? () => handleDelete(a) : null}
                />
              ))}
            </div>
          )}
          {/* Videa – jednotlivě s preview */}
          {videos.length > 0 && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {videos.map(a => (
                <VideoCard
                  key={a.id}
                  attachment={a}
                  onClick={() => setLightboxIdx(galleryItems.indexOf(a))}
                  onDelete={canEdit ? () => handleDelete(a) : null}
                />
              ))}
            </div>
          )}
          {/* Ostatní – linky. Endpoint /api/attachments/:id/file streamuje data z DB. */}
          {others.length > 0 && (
            <ul className="text-xs text-ink-600">
              {others.map(a => (
                <li key={a.id} className="flex items-center gap-2">
                  <a href={attApi.url(a)} target="_blank" rel="noopener noreferrer" className="underline">{a.original_name}</a>
                  {canEdit && <button onClick={() => handleDelete(a)} className="text-ink-400 hover:text-red-600">🗑</button>}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {lightboxIdx !== null && (
        <Lightbox
          items={galleryItems}
          index={lightboxIdx}
          onClose={() => setLightboxIdx(null)}
          onPrev={() => setLightboxIdx(i => (i - 1 + galleryItems.length) % galleryItems.length)}
          onNext={() => setLightboxIdx(i => (i + 1) % galleryItems.length)}
        />
      )}
    </div>
  );
}

function Thumbnail({ attachment: a, onClick, onDelete }) {
  const [broken, setBroken] = useState(false);
  // Click je na CELÉM parent div — i kdyby obrázek nešel načíst (legacy
  // záznam s ephemerální disk pryč), klikatelná zóna stále funguje a
  // Lightbox se otevře s error stavem.
  return (
    <div
      onClick={onClick}
      className="relative group aspect-square overflow-hidden rounded-lg border border-cream-200 bg-cream-100 cursor-zoom-in"
    >
      {broken ? (
        <div className="w-full h-full flex flex-col items-center justify-center p-2 text-center bg-red-50">
          <div className="text-2xl">🖼</div>
          <div className="text-[10px] text-red-700 font-medium mt-1">Soubor chybí</div>
          <div className="text-[9px] text-red-600 truncate max-w-full mt-0.5">{a.original_name}</div>
        </div>
      ) : (
        <img
          src={attApi.url(a)}
          alt={a.original_name}
          className="w-full h-full object-cover"
          loading="lazy"
          onError={() => setBroken(true)}
        />
      )}
      {onDelete && (
        <button
          onClick={(e) => { e.stopPropagation(); onDelete(); }}
          className="absolute top-1 right-1 bg-black/60 text-white rounded w-6 h-6 text-xs opacity-0 group-hover:opacity-100 transition"
          title="Smazat"
        >×</button>
      )}
    </div>
  );
}

function VideoCard({ attachment: a, onClick, onDelete }) {
  const [broken, setBroken] = useState(false);
  return (
    <div className="relative group rounded-lg border border-cream-200 overflow-hidden bg-black">
      {broken ? (
        <div
          onClick={onClick}
          className="w-full h-32 flex flex-col items-center justify-center p-2 text-center bg-red-50 cursor-pointer"
        >
          <div className="text-2xl">🎬</div>
          <div className="text-xs text-red-700 font-medium mt-1">Video chybí</div>
          <div className="text-[10px] text-red-600 truncate max-w-full mt-0.5">{a.original_name}</div>
        </div>
      ) : (
        <video
          src={attApi.url(a)}
          className="w-full max-h-64 object-contain cursor-zoom-in"
          controls
          preload="metadata"
          onClick={onClick}
          onError={() => setBroken(true)}
        />
      )}
      <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/70 to-transparent text-white text-xs px-2 py-1 truncate pointer-events-none">
        🎬 {a.original_name}
      </div>
      {onDelete && (
        <button
          onClick={(e) => { e.stopPropagation(); onDelete(); }}
          className="absolute top-1 right-1 bg-black/60 text-white rounded w-6 h-6 text-xs opacity-0 group-hover:opacity-100 transition"
          title="Smazat"
        >×</button>
      )}
    </div>
  );
}

// Subkomponenta Lightboxu pro image s error fallbackem
function LightboxImage({ src, alt }) {
  const [broken, setBroken] = useState(false);
  if (broken) {
    return (
      <div className="text-white text-center p-8">
        <div className="text-6xl mb-3">🖼</div>
        <div className="text-lg font-medium">Soubor není dostupný</div>
        <div className="text-sm text-cream-200 mt-2">
          Soubor byl pravděpodobně ztracen při restartu serveru (Render free tier).
          <br />Stará verze app ukládala soubory na ephemerální disk; nově jdou rovnou do DB.
          <br />Pokud je tahle příloha důležitá, požádej autora o opětovné nahrání.
        </div>
      </div>
    );
  }
  return (
    <img src={src} alt={alt} className="max-w-full max-h-[90vh] object-contain"
         onError={() => setBroken(true)} />
  );
}

function Lightbox({ items, index, onClose, onPrev, onNext }) {
  const a = items[index];
  useEffect(() => {
    const handler = (e) => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'ArrowLeft') onPrev();
      if (e.key === 'ArrowRight') onNext();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose, onPrev, onNext]);

  return (
    <div className="fixed inset-0 bg-black/90 z-50 flex items-center justify-center" onClick={onClose}>
      <button
        onClick={onClose}
        className="absolute top-4 right-4 text-white text-3xl hover:text-accent-400"
        title="Zavřít (Esc)"
      >×</button>
      {items.length > 1 && (
        <>
          <button
            onClick={(e) => { e.stopPropagation(); onPrev(); }}
            className="absolute left-4 text-white text-4xl hover:text-accent-400 px-4"
          >‹</button>
          <button
            onClick={(e) => { e.stopPropagation(); onNext(); }}
            className="absolute right-4 text-white text-4xl hover:text-accent-400 px-4"
          >›</button>
        </>
      )}
      <div onClick={(e) => e.stopPropagation()} className="max-w-[90vw] max-h-[90vh]">
        {a.kind === 'image' ? (
          <LightboxImage src={attApi.url(a)} alt={a.original_name} />
        ) : a.kind === 'video' ? (
          <video src={attApi.url(a)} controls autoPlay className="max-w-full max-h-[90vh]" />
        ) : (
          <a href={attApi.url(a)} download className="text-white underline">{a.original_name}</a>
        )}
        <div className="text-cream-200 text-sm mt-2 text-center">{a.original_name}</div>
      </div>
    </div>
  );
}

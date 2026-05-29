// Kreslicí vrstva nad poznámkou. Canvas overlay přes editor; kreslí se
// kamkoli (přes text, obrázky). Ukládá se jako PNG data URL (prop value).
//
// Sizing: canvas se nastaví na rozměry rodiče při mountu. Při přepnutí
// poznámky se DrawingLayer remountuje (parent dává key), takže value se
// načte čerstvě. Klik mimo edit režim canvas nezachytává (pointerEvents none),
// takže text pod ním jde normálně editovat.

import { useEffect, useRef } from 'react';

export default function DrawingLayer({ value, editing, color, width, eraser, onChange }) {
  const ref = useRef(null);
  const drawing = useRef(false);
  const last = useRef(null);

  // Mount: nastav rozměry + vykresli uloženou kresbu (jen jednou; note switch = remount)
  useEffect(() => {
    const canvas = ref.current;
    const parent = canvas.parentElement;
    canvas.width = parent.clientWidth;
    canvas.height = parent.clientHeight;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (value) {
      const img = new Image();
      img.onload = () => ctx.drawImage(img, 0, 0);
      img.src = value;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const posOf = (e) => {
    const r = ref.current.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const down = (e) => {
    if (!editing) return;
    drawing.current = true;
    last.current = posOf(e);
    ref.current.setPointerCapture?.(e.pointerId);
  };
  const move = (e) => {
    if (!editing || !drawing.current) return;
    const ctx = ref.current.getContext('2d');
    const p = posOf(e);
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.globalCompositeOperation = eraser ? 'destination-out' : 'source-over';
    ctx.beginPath();
    ctx.moveTo(last.current.x, last.current.y);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
    last.current = p;
  };
  const up = () => {
    if (!editing || !drawing.current) return;
    drawing.current = false;
    onChange?.(ref.current.toDataURL('image/png'));
  };

  return (
    <canvas
      ref={ref}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerLeave={up}
      className="absolute inset-0 z-10 rounded-lg"
      style={{
        pointerEvents: editing ? 'auto' : 'none',
        touchAction: 'none',
        cursor: editing ? 'crosshair' : 'default',
      }}
    />
  );
}

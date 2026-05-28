// Bohatý textový editor pro poznámky. Postavený na contentEditable +
// document.execCommand (deprecated, ale univerzálně podporované, bez extra
// dependencies). Ukládá HTML do content pole poznámky.
//
// Funkce: H1/H2/H3, tučné, kurzíva, velikost písma, barva textu, odrážky,
// zaškrtávací seznam, tabulka, vložení obrázku (base64 inline).
//
// Pozn. k checkboxům: nativní toggle uvnitř contentEditable nemění `checked`
// ATRIBUT (jen property), takže by se stav neuložil. Po kliku synchronizujeme
// atribut a emitneme změnu.

import { useEffect, useRef } from 'react';

const FONT_SIZES = [
  { label: 'Malé', value: '2' },
  { label: 'Normální', value: '3' },
  { label: 'Větší', value: '5' },
  { label: 'Velké', value: '7' },
];
const COLORS = ['#0c363e', '#dc2626', '#ea580c', '#16a34a', '#2563eb', '#9333ea', '#db2777'];

export default function RichTextEditor({ value, onChange }) {
  const ref = useRef(null);

  // Inicializace / sync obsahu zvenčí (např. přepnutí poznámky). Necpeme to
  // při každém renderu, jen když se liší – jinak by skákal kurzor.
  useEffect(() => {
    if (ref.current && ref.current.innerHTML !== (value || '')) {
      ref.current.innerHTML = value || '';
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  const emit = () => onChange?.(ref.current?.innerHTML || '');
  const exec = (cmd, arg = null) => {
    ref.current?.focus();
    document.execCommand(cmd, false, arg);
    emit();
  };

  const insertChecklist = () => {
    exec('insertHTML',
      '<div class="rte-check"><input type="checkbox" contenteditable="false"><span>&nbsp;Položka</span></div>');
  };
  const insertTable = () => {
    let html = '<table class="rte-table"><tbody>';
    for (let r = 0; r < 2; r++) {
      html += '<tr>';
      for (let c = 0; c < 2; c++) html += '<td>&nbsp;</td>';
      html += '</tr>';
    }
    html += '</tbody></table><p><br></p>';
    exec('insertHTML', html);
  };
  const insertImage = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) return;
      if (file.size > 3 * 1024 * 1024) {
        alert('Obrázek je větší než 3 MB. Vkládá se přímo do poznámky, použij menší.');
        return;
      }
      const reader = new FileReader();
      reader.onload = () => exec('insertImage', reader.result);
      reader.readAsDataURL(file);
    };
    input.click();
  };

  // Klik na checkbox → po nativním toggle synchronizuj atribut a ulož
  const onClick = (e) => {
    const t = e.target;
    if (t.tagName === 'INPUT' && t.type === 'checkbox') {
      setTimeout(() => {
        if (t.checked) t.setAttribute('checked', 'checked');
        else t.removeAttribute('checked');
        emit();
      }, 0);
    }
  };

  return (
    <div className="border border-cream-200 rounded-lg overflow-hidden bg-white">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-1 px-2 py-1.5 border-b border-cream-200 bg-cream-50">
        <Btn onClick={() => exec('formatBlock', 'h1')} title="Nadpis 1">H1</Btn>
        <Btn onClick={() => exec('formatBlock', 'h2')} title="Nadpis 2">H2</Btn>
        <Btn onClick={() => exec('formatBlock', 'h3')} title="Nadpis 3">H3</Btn>
        <Btn onClick={() => exec('formatBlock', 'p')} title="Normální text">P</Btn>
        <Sep />
        <Btn onClick={() => exec('bold')} title="Tučné"><b>B</b></Btn>
        <Btn onClick={() => exec('italic')} title="Kurzíva"><i>I</i></Btn>
        <Btn onClick={() => exec('underline')} title="Podtržené"><u>U</u></Btn>
        <Sep />
        <select
          onChange={(e) => { if (e.target.value) { exec('fontSize', e.target.value); e.target.value = ''; } }}
          defaultValue=""
          title="Velikost písma"
          className="text-xs border border-cream-300 rounded px-1.5 py-1 bg-white"
        >
          <option value="" disabled>Velikost</option>
          {FONT_SIZES.map(f => <option key={f.value} value={f.value}>{f.label}</option>)}
        </select>
        <div className="flex items-center gap-0.5 ml-1" title="Barva textu">
          {COLORS.map(c => (
            <button key={c} type="button" onClick={() => exec('foreColor', c)}
              className="w-5 h-5 rounded-full border border-cream-300 hover:scale-110 transition"
              style={{ background: c }} aria-label={`Barva ${c}`} />
          ))}
        </div>
        <Sep />
        <Btn onClick={() => exec('insertUnorderedList')} title="Odrážky">•≣</Btn>
        <Btn onClick={insertChecklist} title="Zaškrtávací seznam">☑</Btn>
        <Btn onClick={insertTable} title="Vložit tabulku">▦</Btn>
        <Btn onClick={insertImage} title="Vložit obrázek">🖼</Btn>
      </div>

      {/* Editovatelná plocha */}
      <div
        ref={ref}
        contentEditable
        suppressContentEditableWarning
        onInput={emit}
        onBlur={emit}
        onClick={onClick}
        className="rte-content min-h-[320px] max-h-[60vh] overflow-y-auto p-4 text-sm text-ink-800 focus:outline-none leading-relaxed"
      />
    </div>
  );
}

function Btn({ onClick, title, children }) {
  return (
    <button
      type="button"
      onMouseDown={(e) => e.preventDefault()} /* nezruší selection v editoru */
      onClick={onClick}
      title={title}
      className="min-w-[28px] h-7 px-1.5 text-xs font-medium text-ink-700 bg-white border border-cream-300 rounded hover:bg-cream-100"
    >{children}</button>
  );
}
function Sep() {
  return <span className="w-px h-5 bg-cream-300 mx-0.5" />;
}

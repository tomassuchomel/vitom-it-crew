// Veřejný formulář Nápadníku — bez přihlášení.
// Fáze 5: Cloudflare Turnstile antispam.

import { useEffect, useRef, useState } from 'react';
import { ideas as ideasApi } from '../api.js';
import VitomLogo from '../components/VitomLogo.jsx';

// Field wrapper VNĚ komponenty — kdyby byl uvnitř NapadnikForm, každý
// re-render (typing) by vytvořil nový komponent typ → React unmountuje
// vnitřní <input> → ztráta focusu po 1 znaku (klasický bug).
function Field({ label, name, required, error, children }) {
  return (
    <label className="block">
      <span className="text-xs font-medium text-ink-600">
        {label} {required && <span className="text-accent-500">*</span>}
      </span>
      {children}
      {error && <span className="text-xs text-red-600 mt-1 block">{error}</span>}
    </label>
  );
}
const inputCls = (name, errors) => `mt-1 w-full border rounded px-2 py-1.5 text-sm ${
  errors[name] ? 'border-red-400 bg-red-50' : 'border-ink-300'
}`;

export default function NapadnikForm() {
  const [meta, setMeta] = useState({ departments: [], categories: [] });
  const [form, setForm] = useState({
    proposer_name: '', proposer_email: '', title: '',
    department: '', category: '',
    problem_description: '', solution_proposal: '',
    impact_scope: '', estimated_time_savings: '', external_link: '',
  });
  const [errors, setErrors] = useState({});
  const [busy, setBusy] = useState(false);
  const [success, setSuccess] = useState(false);
  const [globalErr, setGlobalErr] = useState(null);
  // Cloudflare Turnstile: token generovaný widgetem; siteKey z BE meta.
  // Když siteKey není nastaven, widget se nezobrazí a BE Turnstile skip-uje.
  const [turnstileToken, setTurnstileToken] = useState('');
  const [turnstileKey, setTurnstileKey] = useState(null); // null | 'no' | siteKeyStr
  const tsContainerRef = useRef(null);
  const tsWidgetId = useRef(null);

  useEffect(() => {
    ideasApi.meta().then(setMeta).catch(() => {});
    ideasApi.turnstileMeta()
      .then(d => setTurnstileKey(d.site_key || 'no'))
      .catch(() => setTurnstileKey('no'));
  }, []);

  // Načti Turnstile skript + vyrender widget, když je siteKey k dispozici.
  useEffect(() => {
    if (!turnstileKey || turnstileKey === 'no' || !tsContainerRef.current) return;
    const render = () => {
      if (!window.turnstile || tsWidgetId.current) return;
      tsWidgetId.current = window.turnstile.render(tsContainerRef.current, {
        sitekey: turnstileKey,
        callback: (t) => setTurnstileToken(t || ''),
        'expired-callback': () => setTurnstileToken(''),
        'error-callback': () => setTurnstileToken(''),
      });
    };
    if (window.turnstile) { render(); return; }
    // Skript ještě není nahraný — přidej ho a zavolej render až po loadu.
    if (!document.querySelector('script[data-turnstile]')) {
      const s = document.createElement('script');
      s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js';
      s.async = true; s.defer = true; s.dataset.turnstile = '1';
      s.onload = render;
      document.head.appendChild(s);
    } else {
      // Skript už načítá jiný place — poll na window.turnstile.
      const int = setInterval(() => {
        if (window.turnstile) { clearInterval(int); render(); }
      }, 200);
      return () => clearInterval(int);
    }
  }, [turnstileKey]);

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  const submit = async (e) => {
    e.preventDefault();
    if (turnstileKey && turnstileKey !== 'no' && !turnstileToken) {
      setGlobalErr('Prosím dokonči anti‑spam ověření (checkbox).');
      return;
    }
    setBusy(true); setErrors({}); setGlobalErr(null);
    try {
      await ideasApi.submitPublic({ ...form, turnstile_token: turnstileToken });
      setSuccess(true);
    } catch (err) {
      if (err.response?.data?.error === 'turnstile_failed') {
        setGlobalErr(err.response.data.message || 'Anti‑spam ověření selhalo.');
        window.turnstile?.reset(tsWidgetId.current);
        setTurnstileToken('');
      } else if (err.response?.status === 400 && err.response.data?.fields) {
        setErrors(err.response.data.fields);
        setGlobalErr('Vyplň prosím povinná pole.');
      } else {
        setGlobalErr('Odeslání selhalo. Zkus to prosím za chvíli znovu.');
      }
    } finally { setBusy(false); }
  };

  if (success) {
    return (
      <div className="min-h-full flex items-center justify-center p-6 bg-cream-100">
        <div className="bg-white rounded-2xl shadow-xl p-10 w-full max-w-md text-center border border-cream-200">
          <div className="text-brand-500 inline-flex mb-4">
            <VitomLogo size={64} />
          </div>
          <div className="text-6xl mb-3">🎉</div>
          <h1 className="text-2xl font-bold text-brand-500 mb-3">Díky za nápad!</h1>
          <p className="text-sm text-ink-600 mb-6">
            Zapsali jsme si tvůj návrh. Management se na něj podívá a případně se ti ozve na e‑mail,
            který jsi uvedl.
          </p>
          <button
            onClick={() => { setSuccess(false); setForm({
              proposer_name: '', proposer_email: '', title: '',
              department: '', category: '',
              problem_description: '', solution_proposal: '',
              impact_scope: '', estimated_time_savings: '', external_link: '',
            }); }}
            className="px-4 py-2 text-sm text-brand-500 border border-brand-500 rounded-lg hover:bg-brand-50"
          >
            Podat další nápad
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-full bg-cream-100 py-8 px-4">
      <div className="max-w-2xl mx-auto">
        <div className="text-center mb-6">
          <div className="text-brand-500 inline-flex mb-2"><VitomLogo size={56} /></div>
          <div className="text-2xl font-bold tracking-tight text-brand-500">Nápadník VITOM</div>
          <div className="text-sm text-ink-500 mt-1">
            Napadá tě zlepšení, automatizace, AI projekt? Řekni nám o něm.
          </div>
        </div>

        <form onSubmit={submit} className="bg-white rounded-2xl shadow-sm border border-cream-200 p-6 space-y-4">
          {globalErr && (
            <div className="bg-red-50 border border-red-200 text-red-700 text-sm rounded p-3">
              {globalErr}
            </div>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Field label="Jméno" name="proposer_name" required error={errors.proposer_name}>
              <input type="text" value={form.proposer_name}
                onChange={e => set('proposer_name', e.target.value)}
                className={inputCls('proposer_name', errors)} />
            </Field>
            <Field label="E‑mail" name="proposer_email" required error={errors.proposer_email}>
              <input type="email" value={form.proposer_email}
                onChange={e => set('proposer_email', e.target.value)}
                className={inputCls('proposer_email', errors)} />
            </Field>
          </div>

          <Field label="Název nápadu" name="title" required error={errors.title}>
            <input type="text" value={form.title}
              onChange={e => set('title', e.target.value)}
              className={inputCls('title', errors)} />
          </Field>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Field label="Oddělení" name="department" required error={errors.department}>
              <select value={form.department}
                onChange={e => set('department', e.target.value)}
                className={inputCls('department', errors)}>
                <option value="">— vyber —</option>
                {meta.departments.map(d => <option key={d} value={d}>{d}</option>)}
              </select>
            </Field>
            <Field label="Kategorie zlepšení" name="category" required error={errors.category}>
              <select value={form.category}
                onChange={e => set('category', e.target.value)}
                className={inputCls('category', errors)}>
                <option value="">— vyber —</option>
                {meta.categories.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            </Field>
          </div>

          <Field label="Popis problému" name="problem_description" required error={errors.problem_description}>
            <textarea rows={3} value={form.problem_description}
              onChange={e => set('problem_description', e.target.value)}
              placeholder="Co dnes nefunguje / komplikuje práci?"
              className={inputCls('problem_description', errors)} />
          </Field>

          <Field label="Návrh řešení" name="solution_proposal" required error={errors.solution_proposal}>
            <textarea rows={3} value={form.solution_proposal}
              onChange={e => set('solution_proposal', e.target.value)}
              placeholder="Jak by se to dalo řešit?"
              className={inputCls('solution_proposal', errors)} />
          </Field>

          <Field label="Dopad (počet lidí, frekvence)" name="impact_scope" error={errors.impact_scope}>
            <input type="text" value={form.impact_scope}
              onChange={e => set('impact_scope', e.target.value)}
              placeholder="např. 5 lidí, denně"
              className={inputCls('impact_scope', errors)} />
          </Field>

          <Field label="Odhad úspory času" name="estimated_time_savings" error={errors.estimated_time_savings}>
            <input type="text" value={form.estimated_time_savings}
              onChange={e => set('estimated_time_savings', e.target.value)}
              placeholder="např. 2 h týdně / osobu"
              className={inputCls('estimated_time_savings', errors)} />
          </Field>

          <Field label="Odkaz na materiál (volitelně)" name="external_link" error={errors.external_link}>
            <input type="url" value={form.external_link}
              onChange={e => set('external_link', e.target.value)}
              placeholder="https://…"
              className={inputCls('external_link', errors)} />
          </Field>

          {turnstileKey && turnstileKey !== 'no' && (
            <div className="pt-2">
              <div ref={tsContainerRef} />
            </div>
          )}

          <div className="pt-2 flex items-center justify-end gap-3">
            <button type="submit" disabled={busy}
              className="px-5 py-2 bg-brand-500 text-white rounded-lg font-medium hover:bg-brand-600 disabled:opacity-50">
              {busy ? 'Odesílám…' : 'Odeslat nápad'}
            </button>
          </div>
        </form>

        <div className="text-center text-xs text-ink-400 mt-4">
          Přílohu můžeš doplnit později — po podání ti pošleme e‑mail.
        </div>
      </div>
    </div>
  );
}

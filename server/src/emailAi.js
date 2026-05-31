// Email-specifická AI: klasifikace + extrakce úkolů.
// Sdílí Claude API logiku s ai.js, ale prompts jsou ladené na email kontext.

import { query } from './db.js';
import { processNote } from './ai.js';

const API_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-5';

function getKey() {
  const k = process.env.ANTHROPIC_API_KEY?.trim();
  if (!k) return null;
  for (let i = 0; i < k.length; i++) {
    if (k.charCodeAt(i) > 255) return null; // bad bytes (zkrácený paste)
  }
  return k;
}

// Batch klasifikátor — jeden Claude call pro 1-50 emailů, vrátí pole klasifikací.
// Vstup: list = [{ id, subject, from: {emailAddress: {name, address}}, bodyPreview }]
// Výstup: { items: [{ message_id, category, summary, confidence }] }
export async function classifyEmails(list) {
  const key = getKey();
  if (!key) return { error: 'no_api_key', message: 'ANTHROPIC_API_KEY není nastaven nebo je zkrácený.' };
  if (list.length === 0) return { items: [] };

  // Pomáhá Claudovi: jen ID + subject + sender + preview (žádné HTML, žádné dlouhé body).
  // Náklady ~100-300 input tokens per email + 50 output tokens.
  const compact = list.map(m => ({
    id: m.id,
    from: m.from?.emailAddress?.name || m.from?.emailAddress?.address || '(neznámý)',
    subject: m.subject || '',
    preview: (m.bodyPreview || '').slice(0, 300),
  }));

  const system = `Jsi asistent, který klasifikuje emaily v Outlook inboxu. Vrať POUZE validní JSON, žádný okolní text:
{ "items": [
    { "message_id": "<id>",
      "category": "task" | "question" | "answer_needed" | "fyi" | "spam" | "other",
      "summary": "1 věta shrnující o čem mail je (max 100 znaků)",
      "confidence": 0.0-1.0
    }, ...
] }

KATEGORIE:
- "task"          = něco mám udělat (klient žádá implementaci, kolega úkoluje, deadline na akci ode mě)
- "question"      = mail obsahuje otázku, na kterou se ode mě čeká odpověď
- "answer_needed" = mail explicitně čeká reakci/rozhodnutí, ne nutně přímou otázku
- "fyi"           = informativní, ke čtení, žádná akce ode mě
- "spam"          = marketing, newsletter, automatický bot, propagace
- "other"         = nic z výše uvedeného (potvrzení, faktura, kalendář, …)

PRAVIDLA:
- Vrať ZÁZNAM PRO KAŽDÝ vstupní email (stejný počet jako vstup).
- message_id MUSÍ být přesně to z vstupu.
- summary v češtině, výstižné, žádná fluff slova.
- confidence: jak jistá je klasifikace (0-1). Když nejsi sigl, dej < 0.6.`;

  const userMsg = `Klasifikuj těchto ${list.length} emailů:\n\n${JSON.stringify(compact, null, 2)}`;

  const res = await fetch(API_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: Math.min(8000, list.length * 200 + 500),
      system,
      messages: [{ role: 'user', content: userMsg }],
    }),
  });
  if (!res.ok) {
    return { error: 'classify_failed', status: res.status, message: (await res.text()).slice(0, 400) };
  }
  const data = await res.json();
  const raw = (data.content?.[0]?.text || '').replace(/^```(?:json)?\s*|\s*```$/g, '').trim();
  let parsed;
  try { parsed = JSON.parse(raw); }
  catch { return { error: 'parse_error', raw: raw.slice(0, 500) }; }

  const VALID = ['task', 'question', 'answer_needed', 'fyi', 'spam', 'other'];
  const items = (Array.isArray(parsed.items) ? parsed.items : [])
    .filter(it => it.message_id && VALID.includes(it.category))
    .map(it => ({
      message_id: String(it.message_id),
      category: it.category,
      summary: typeof it.summary === 'string' ? it.summary.slice(0, 200) : null,
      confidence: typeof it.confidence === 'number' ? Math.max(0, Math.min(1, it.confidence)) : null,
    }));
  return { items, usage: data.usage };
}

// Extrakce úkolů z jednoho emailu — reuse `processNote(suggest_tasks)` logiku,
// jen jí předhodíme email subject + body jako pseudo-note. Výstup má stejný tvar
// jako u poznámky, takže UI může použít SuggestedTasksModal beze změny.
export async function extractTasksFromEmail(msg, { userId, teamId }) {
  // Email body je v Outlooku HTML; processNote ho stripuje stejně jako u poznámek.
  const noteTitle = msg.subject || '(bez předmětu)';
  const fromLabel = msg.from?.emailAddress?.name || msg.from?.emailAddress?.address || '(neznámý odesílatel)';
  // Vlož "Z emailu od X" do obsahu — AI to pak může zmínit jako kontext.
  const noteContent = `Email od: ${fromLabel}\n\n${msg.body?.content || msg.bodyPreview || ''}`;
  return processNote({
    noteTitle,
    noteContent,
    action: 'suggest_tasks',
    teamId, userId,
  });
}

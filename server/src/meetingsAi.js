// Sdílené AI helpery pro porady — volatelné z routes/meetings.js i pushCron.js.

import { query } from './db.js';

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-5';

export function stripHtml(html) {
  return String(html || '').replace(/<style[^>]*>.*?<\/style>/gi, '')
    .replace(/<script[^>]*>.*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export async function callAI(systemPrompt, userMsg, maxTokens = 2000) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return { error: 'no_api_key', message: 'ANTHROPIC_API_KEY není nastaven.' };
  try {
    const res = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: ANTHROPIC_MODEL, max_tokens: maxTokens,
        system: systemPrompt,
        messages: [{ role: 'user', content: userMsg }],
      }),
    });
    if (!res.ok) {
      const t = await res.text();
      return { error: 'api_error', status: res.status, message: t.slice(0, 500) };
    }
    const data = await res.json();
    const text = data?.content?.[0]?.text || '';
    return { text };
  } catch (err) {
    return { error: 'fetch_failed', message: err.message };
  }
}

// Kontext pro AI: předchozí zápisy + úkoly propojené.
export async function collectPrevContext(typeId, currentMeetingId, limit = 5) {
  const prev = (await query(`
    SELECT id, title, meeting_date, content_json, agenda
    FROM meetings
    WHERE type_id = $1 AND id != $2
    ORDER BY meeting_date DESC NULLS LAST, created_at DESC
    LIMIT $3
  `, [typeId, currentMeetingId, limit])).rows;

  const meetingIds = prev.map(m => m.id);
  const tasks = meetingIds.length > 0 ? (await query(`
    SELECT t.id, t.title, t.status, t.due_date, t.completed_at, t.meeting_id,
           u.name AS assignee_name
    FROM tasks t LEFT JOIN users u ON u.id = t.assignee_id
    WHERE t.meeting_id = ANY($1::int[])
  `, [meetingIds])).rows : [];

  return { previousMeetings: prev, relatedTasks: tasks };
}

// Vygeneruje AI návrh agendy jako array of { text }. Používá se z endpoint
// (interaktivní tlačítko) i z cron (auto agenda 24h před porady).
export async function generateAgendaSuggestion(meeting, type) {
  const { previousMeetings, relatedTasks } = await collectPrevContext(type.id, meeting.id, 3);
  const template = Array.isArray(type.agenda_template) ? type.agenda_template.map(a => a.text).filter(Boolean) : [];
  const unfinishedTasks = relatedTasks.filter(t => t.status !== 'done').slice(0, 20);
  const lastNotes = previousMeetings.slice(0, 2).map(m => ({
    date: m.meeting_date,
    notes: stripHtml(typeof m.content_json === 'string' ? m.content_json : JSON.stringify(m.content_json)).slice(0, 800),
  }));

  const system = `Jsi asistent, který navrhne agendu porady. Vrátíš POUZE validní JSON:
{ "items": [{ "text": "krátký bod agendy" }, ...] }
Vrať 3-7 bodů. Píšeš česky, věcně.`;
  const userMsg = `Typ porady: "${type.name}"
Datum: ${meeting.meeting_date || '(neuvedeno)'}

KOSTRA (už je v agendě):
${template.length > 0 ? template.join('\n') : '(žádná)'}

NEDOKONČENÉ ÚKOLY z posledních porad (probrat status):
${JSON.stringify(unfinishedTasks.map(t => ({ title: t.title, assignee: t.assignee_name, due: t.due_date, status: t.status })), null, 2)}

POSLEDNÍ 2 ZÁPISY:
${JSON.stringify(lastNotes, null, 2)}

Navrhni další body agendy nad rámec kostry — akční, konkrétní, follow-up na nedokončené úkoly.`;

  const out = await callAI(system, userMsg, 1500);
  if (out.error) return { error: out };
  try {
    const parsed = JSON.parse(out.text.trim());
    const items = Array.isArray(parsed.items)
      ? parsed.items.filter(x => x && typeof x.text === 'string').map(x => ({ text: String(x.text).slice(0, 200) }))
      : [];
    return { items };
  } catch (err) {
    return { error: { error: 'parse_failed', message: err.message } };
  }
}

// AI projektový kouč – volá Anthropic Claude API.
// Bez ANTHROPIC_API_KEY vrátí srozumitelnou chybu.
import { query } from './db.js';

const API_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-5';
const HAS_AI = !!process.env.ANTHROPIC_API_KEY;
export { HAS_AI };

// Sběr kontextu z DB
export async function buildContext() {
  const projectsR = await query(`
    SELECT p.*,
      mu.name AS manager_name,
      (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id) AS task_count,
      (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id AND t.status = 'done') AS done_count,
      (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id AND t.status = 'in_progress') AS inprog_count,
      (SELECT COALESCE(SUM(t.estimated_h),0) FROM tasks t WHERE t.project_id = p.id) AS estimated_h_total,
      (SELECT COALESCE(SUM(t.estimated_h),0) FROM tasks t WHERE t.project_id = p.id AND t.status != 'done') AS estimated_h_remaining,
      (SELECT COALESCE(SUM(te.hours),0) FROM time_entries te WHERE te.project_id = p.id) AS hours_logged,
      (SELECT COALESCE(SUM(te.hours * u.hourly_rate),0)
         FROM time_entries te JOIN users u ON u.id = te.user_id
         WHERE te.project_id = p.id) AS cost_so_far
    FROM projects p
    LEFT JOIN users mu ON mu.id = p.manager_id
    WHERE p.status = 'active'
    ORDER BY p.due_date ASC
  `);
  const projects = projectsR.rows;

  for (const p of projects) {
    const tasksR = await query(`
      SELECT t.id, t.title, t.status, t.priority, t.estimated_h, t.due_date,
             u.name AS assignee_name
      FROM tasks t LEFT JOIN users u ON u.id = t.assignee_id
      WHERE t.project_id = $1
      ORDER BY t.id
    `, [p.id]);
    p.tasks = tasksR.rows;
  }

  const velocityR = await query(`
    SELECT u.id, u.name, u.role, u.hourly_rate,
           COALESCE(SUM(te.hours), 0) AS hours_14d
    FROM users u
    LEFT JOIN time_entries te ON te.user_id = u.id AND te.date >= CURRENT_DATE - INTERVAL '14 days'
    WHERE u.active = TRUE
    GROUP BY u.id
    ORDER BY hours_14d DESC
  `);

  return {
    today: new Date().toISOString().slice(0, 10),
    projects,
    velocity: velocityR.rows,
  };
}

const SYSTEM_PROMPT = `Jsi VITOM IT Crew Coach – AI projektový poradce malého vývojářského týmu (4 lidé).

KONTEXT TÝMU:
- Tým programuje moderním stylem s pomocí AI nástrojů (Claude, Cursor, Copilot) a "vibe coding" přístupem (rychlé iterace s AI).
- Díky AI nástrojům jsou mnoho kódovacích úkolů 2-5x rychlejší než klasické odhady. Jednoduché komponenty, CRUD endpointy, refaktoring, bugfixy = velmi rychlé. Komplexní integrace, architektonická rozhodnutí = i s AI normální tempo.
- Tým dělá také server práci (deploy, infra, monitoring, integrace) – to AI tolik neuspíší.
- Členové: Admin (řídí), Project Manager (plánuje, komunikuje s klienty), Senior programátor (architektura), Externí programátor (implementace, denně reportuje hodiny).

TVŮJ ÚKOL:
1. Posuď, zda tempo (hours_14d × tým) odpovídá zbývající práci a deadlinům.
2. U každého aktivního projektu odhadni reálnou pracnost zbývajících úkolů (s ohledem na AI urychlení) a porovnej s časem do deadlinu.
3. Identifikuj rizika (skluz, urgentní úkoly bez assignee, projekty bez aktivity).
4. Dej max 3-5 konkrétních akčních doporučení (např. "přesuňte X na Y", "spojte úkoly Z do batchu", "vyčleňte den jen na A").
5. Jednej prakticky a stručně. Žádný corporate buzz. Mluv česky.

FORMÁT ODPOVĚDI – výhradně validní JSON (nic dalšího okolo):
{
  "status": "ok" | "warning" | "danger",
  "headline": "jednovětný stav (max 80 znaků)",
  "summary": "2-3 věty o celkovém stavu týmu a tempa",
  "projects": [
    { "id": <projekt_id>, "name": "...", "status": "ok|warning|danger", "note": "1-2 věty proč", "estimated_remaining_h": <number>, "days_to_deadline": <number> }
  ],
  "recommendations": ["...", "..."]
}`;

export async function getAdvice() {
  if (!HAS_AI) {
    return { error: 'no_api_key', message: 'Anthropic API klíč není nastaven. Přidej ANTHROPIC_API_KEY do environment proměnných.' };
  }
  const ctx = await buildContext();
  const userMessage = `Aktuální datum: ${ctx.today}

PROJEKTY:
${JSON.stringify(ctx.projects, null, 2)}

TEMPO TÝMU (posledních 14 dní):
${JSON.stringify(ctx.velocity, null, 2)}

Posuď stav a vrať JSON podle formátu.`;

  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 2000,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userMessage }],
    }),
  });
  if (!res.ok) {
    const errText = await res.text();
    console.error('[ai] API error', res.status, errText);
    return { error: 'api_error', status: res.status, message: errText.slice(0, 500) };
  }
  const data = await res.json();
  const text = data.content?.[0]?.text || '';
  try {
    const cleaned = text.replace(/^```(?:json)?\s*|\s*```$/g, '').trim();
    return { advice: JSON.parse(cleaned), raw_tokens: data.usage };
  } catch (err) {
    return { error: 'parse_error', raw: text };
  }
}

export async function chat(messages) {
  if (!HAS_AI) {
    return { error: 'no_api_key', message: 'Anthropic API klíč není nastaven.' };
  }
  const ctx = await buildContext();
  const systemWithCtx = `${SYSTEM_PROMPT}

DATA, KE KTERÝM MŮŽEŠ ODKAZOVAT (nemůžeš měnit, jen analyzovat):
DATUM: ${ctx.today}
PROJEKTY: ${JSON.stringify(ctx.projects)}
TEMPO: ${JSON.stringify(ctx.velocity)}

V chatu odpovídej krátce a věcně, plain text (ne JSON).`;

  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 1200,
      system: systemWithCtx,
      messages,
    }),
  });
  if (!res.ok) {
    return { error: 'api_error', status: res.status, message: (await res.text()).slice(0, 500) };
  }
  const data = await res.json();
  return { reply: data.content?.[0]?.text || '', usage: data.usage };
}

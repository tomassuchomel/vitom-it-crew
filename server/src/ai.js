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

  const accuracy = await computeAccuracy();

  return {
    today: new Date().toISOString().slice(0, 10),
    projects,
    velocity: velocityR.rows,
    accuracy,
  };
}

// Per-uživatel agregace přesnosti odhadu. Bere v úvahu jen dokončené úkoly s actual_h.
// Vrací: count, sum_manual, sum_ai, sum_actual, ratio_manual (actual/manual), ratio_ai (actual/ai).
// ratio > 1 = pracoval déle než odhad (podcenil), < 1 = byl rychlejší (přecenil)
export async function computeAccuracy() {
  const r = await query(`
    SELECT
      u.id, u.name, u.role,
      COUNT(t.id)::int                                       AS done_count,
      COALESCE(SUM(t.estimated_h), 0)::float                 AS sum_manual,
      COALESCE(SUM(t.ai_estimated_h), 0)::float              AS sum_ai,
      COALESCE(SUM(t.actual_h), 0)::float                    AS sum_actual,
      COUNT(t.id) FILTER (WHERE t.estimated_h IS NOT NULL)::int    AS with_manual,
      COUNT(t.id) FILTER (WHERE t.ai_estimated_h IS NOT NULL)::int AS with_ai,
      COALESCE(AVG(t.actual_h / NULLIF(t.estimated_h, 0)), 0)::float    AS ratio_manual,
      COALESCE(AVG(t.actual_h / NULLIF(t.ai_estimated_h, 0)), 0)::float AS ratio_ai
    FROM users u
    LEFT JOIN tasks t
      ON t.completed_by = u.id
      AND t.status = 'done'
      AND t.actual_h IS NOT NULL
    WHERE u.active = TRUE
    GROUP BY u.id
    ORDER BY done_count DESC, u.name
  `);
  return r.rows;
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
4. **Vyhodnoť přesnost odhadů jednotlivých členů** podle dat v sekci ACCURACY:
   - ratio_manual = actual_h / estimated_h; ratio_ai = actual_h / ai_estimated_h
   - <0.75 = nadhodnocuje (je rychlejší než odhady) ; ~1 = trefuje se ; >1.3 = podhodnocuje (jeho odhady jsou krátké)
   - Z čísel poznáš, čí odhady použít jako kotvu při plánování a komu radit zaúčtovat víc rezervy.
5. Dej max 3-5 konkrétních akčních doporučení (např. "přesuňte X na Y", "spojte úkoly Z do batchu", "vyčleňte den jen na A").
6. Jednej prakticky a stručně. Žádný corporate buzz. Mluv česky.

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

ACCURACY (přesnost odhadů per uživatel, dokončené úkoly):
${JSON.stringify(ctx.accuracy, null, 2)}

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

// ----------- Odhad času úkolu (AI) -----------
// Reálná praxe v týmu VITOM: senior programátor používá Claude (Anthropic) a Lovable
// pro AI-assisted coding. Mnoho úkolů je 3-5× rychlejší než klasický odhad. Server
// práce (deploy, integrace, infra) zhruba normální tempo.
const TASK_ESTIMATE_SYSTEM = `Jsi expert na odhad času programátorských úkolů pro tým VITOM IT Crew.

KONTEXT:
- Tým: senior programátor používá Claude (Anthropic API + Claude Code) a Lovable.dev pro AI-assisted vývoj.
- Vibe coding přístup: rychlé iterace s AI, generování komponent, refaktoring, testů.
- Tempo s AI je 3-5× rychlejší pro většinu standardních kódovacích úkolů než tradiční manuální coding.

REFERENČNÍ TEMPO (s AI nástroji):
- Triviální (CRUD form, jednoduchá React komponenta, drobná oprava): 0.25 - 1.5 h
- Středně složité (API endpoint s validací, integrace 3rd party, refaktor modulu): 1 - 4 h
- Komplexní (architektonické změny, debug obtížné chyby, integrace více systémů, deployment, infra): 4 - 12 h
- Velké (nová funkcionalita napříč stackem, performance optimization, security audit): 8 - 24 h

POSTUP:
1. Přečti název a popis úkolu.
2. Posuď, zda jde o kódování (rychlejší s AI) nebo server práci (běžné tempo).
3. Odhadni hodiny v intervalu, kde je vyšší konec ~30% nad nižším.
4. Doporučení k rozdělení pokud > 8h.
5. Vrať čistý JSON.

VÝSTUP (jen JSON, nic okolo):
{
  "estimated_h": <number>,            // střední odhad, např. 3.5
  "category": "trivial" | "medium" | "complex" | "large",
  "note": "1-2 věty zdůvodnění s ohledem na AI urychlení"
}`;

export async function estimateTask(task) {
  if (!HAS_AI) {
    return { error: 'no_api_key' };
  }
  const userMsg = `Úkol:
Název: ${task.title}
Popis: ${task.description || '(prázdný popis)'}
Priorita: ${task.priority || 'normal'}

Odhadni čas v hodinách s ohledem na AI urychlení.`;

  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 400,
      system: TASK_ESTIMATE_SYSTEM,
      messages: [{ role: 'user', content: userMsg }],
    }),
  });
  if (!res.ok) {
    return { error: 'api_error', status: res.status, message: (await res.text()).slice(0, 500) };
  }
  const data = await res.json();
  const text = data.content?.[0]?.text || '';
  try {
    const cleaned = text.replace(/^```(?:json)?\s*|\s*```$/g, '').trim();
    const parsed = JSON.parse(cleaned);
    return {
      estimated_h: Number(parsed.estimated_h),
      category: parsed.category,
      note: parsed.note,
    };
  } catch (err) {
    return { error: 'parse_error', raw: text };
  }
}

// ----------- AI asistent týmu (poznámky + data) -----------
// Čte: týmové poznámky, osobní poznámky uživatele, aktivní + nedávno dokončené
// úkoly, projekty, členy teamu. Odpovídá na analytické otázky ("co tým dělal
// tento týden", "jaké jsou priority", "na čem se shodli").

async function buildTeamAssistantContext(teamId, userId) {
  const team = (await query(`SELECT id, name, slug, description FROM teams WHERE id = $1`, [teamId])).rows[0];

  const members = (await query(`
    SELECT u.name, tm.team_role
    FROM team_members tm JOIN users u ON u.id = tm.user_id
    WHERE tm.team_id = $1 AND u.active = TRUE
    ORDER BY u.name
  `, [teamId])).rows;

  const projects = (await query(`
    SELECT name, status, start_date, due_date, no_timeline
    FROM projects WHERE team_id = $1 ORDER BY due_date NULLS LAST
  `, [teamId])).rows;

  // Aktivní úkoly + dokončené za posledních 14 dní (kontext "co se dělo")
  const tasks = (await query(`
    SELECT t.title, t.status, t.priority, t.due_date, t.completed_at, t.estimated_h,
           u.name AS assignee, p.name AS project
    FROM tasks t
    JOIN projects p ON p.id = t.project_id
    LEFT JOIN users u ON u.id = t.assignee_id
    WHERE p.team_id = $1
      AND (t.status != 'done' OR t.completed_at >= NOW() - INTERVAL '14 days')
    ORDER BY
      CASE t.status WHEN 'in_progress' THEN 0 WHEN 'review' THEN 1 WHEN 'needs_fix' THEN 2 WHEN 'todo' THEN 3 ELSE 4 END,
      t.due_date NULLS LAST
    LIMIT 200
  `, [teamId])).rows;

  // Týmové poznámky (celý strom)
  const teamNotes = (await query(`
    SELECT id, parent_id, title, content, position
    FROM notes WHERE team_id = $1 AND visibility = 'team'
    ORDER BY parent_id NULLS FIRST, position
  `, [teamId])).rows;

  // Osobní poznámky uživatele
  const personalNotes = (await query(`
    SELECT id, parent_id, title, content, position
    FROM notes WHERE team_id = $1 AND visibility = 'personal' AND user_id = $2
    ORDER BY parent_id NULLS FIRST, position
  `, [teamId, userId])).rows;

  return { team, members, projects, tasks, teamNotes, personalNotes };
}

export async function askTeamAssistant({ question, history = [], teamId, userId }) {
  if (!HAS_AI) {
    return { error: 'no_api_key', message: 'Anthropic API klíč není nastaven (ANTHROPIC_API_KEY).' };
  }
  if (!question || !String(question).trim()) {
    return { error: 'empty_question' };
  }
  const ctx = await buildTeamAssistantContext(teamId, userId);
  const today = new Date().toISOString().slice(0, 10);

  const system = `Jsi AI asistent týmu „${ctx.team?.name}". Pomáháš členům týmu zorientovat se v tom,
co se v týmu děje – na čem se pracuje, co se dokončilo, jaké jsou priority, co je v poznámkách.

Odpovídáš česky, věcně a stručně. Když se tě někdo zeptá "co jsme tento týden dělali",
shrň dokončené i rozpracované úkoly. Když se ptá na priority, koukni na urgentní/vysoké úkoly
a blížící se termíny. Když odkazuje na poznámky, vyhledej v nich.

Máš k dispozici DATA NÍŽE. Nemůžeš je měnit, jen z nich čerpat. Když odpověď v datech není,
řekni to – nevymýšlej si. Datum dnes: ${today}.

ČLENOVÉ TÝMU:
${JSON.stringify(ctx.members)}

PROJEKTY:
${JSON.stringify(ctx.projects)}

ÚKOLY (aktivní + dokončené za 14 dní):
${JSON.stringify(ctx.tasks)}

TÝMOVÉ POZNÁMKY (strom; parent_id udává hierarchii):
${JSON.stringify(ctx.teamNotes)}

OSOBNÍ POZNÁMKY UŽIVATELE (vidí jen on):
${JSON.stringify(ctx.personalNotes)}

Odpovídej plain textem (ne JSON), klidně s odrážkami. Buď konkrétní – jména, projekty, termíny.`;

  // Sestavení konverzace: historie + nová otázka
  const safeHistory = Array.isArray(history)
    ? history.filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string').slice(-10)
    : [];
  const messages = [...safeHistory, { role: 'user', content: String(question).slice(0, 4000) }];

  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({ model: MODEL, max_tokens: 1500, system, messages }),
  });
  if (!res.ok) {
    return { error: 'api_error', status: res.status, message: (await res.text()).slice(0, 500) };
  }
  const data = await res.json();
  return { reply: data.content?.[0]?.text || '', usage: data.usage };
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
ACCURACY: ${JSON.stringify(ctx.accuracy)}

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

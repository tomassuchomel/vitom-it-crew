// AI projektový kouč – volá Anthropic Claude API.
// Bez ANTHROPIC_API_KEY vrátí srozumitelnou chybu.
import { query } from './db.js';

const API_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-5';
const HAS_AI = !!process.env.ANTHROPIC_API_KEY;
export { HAS_AI };

// Validace API klíče. HTTP hlavičky musí být Latin1 (kódy ≤ 255). Když uživatel
// omylem vloží zkrácenou/maskovanou verzi klíče (UI často zobrazuje "sk-ant-…"),
// klíč obsahuje znak „…" (U+2026 = 8230) a fetch hodí kryptické
// "Cannot convert argument to a ByteString". Tady to odchytíme a vrátíme
// srozumitelnou hlášku. Taky ořízneme whitespace z paste.
function validateApiKey() {
  const raw = process.env.ANTHROPIC_API_KEY;
  if (!raw) return { ok: false, reason: 'no_api_key', message: 'ANTHROPIC_API_KEY není nastaven.' };
  const key = raw.trim();
  for (let i = 0; i < key.length; i++) {
    if (key.charCodeAt(i) > 255) {
      return {
        ok: false,
        reason: 'bad_api_key',
        message: `ANTHROPIC_API_KEY obsahuje neplatný znak na pozici ${i} (kód ${key.charCodeAt(i)}, např. „…"). `
          + `Vypadá to, že byl zkopírován zkrácený/maskovaný klíč. V Render → Environment vlož CELÝ klíč `
          + `(začíná sk-ant-… a má ~100 znaků) znovu, ne tu zkrácenou verzi s výpustkou.`,
      };
    }
  }
  return { ok: true, key };
}

// Sběr kontextu z DB
// scope: 'team' (default) – filtruj na teamId; 'all' – napříč všemi týmy (executive coach).
// Když scope='team' a teamId není, vrátíme prázdný kontext (žádný team = nic neukazujeme).
export async function buildContext({ teamId, scope = 'team', userId } = {}) {
  const filterAll = scope === 'all';
  if (!filterAll && !teamId) {
    return { today: new Date().toISOString().slice(0, 10), projects: [], velocity: [], accuracy: [] };
  }

  // projects + team join (pro coach 'all' chceme i názvy týmů)
  const projectsR = await query(`
    SELECT p.*,
      mu.name AS manager_name,
      tm.name AS team_name,
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
    LEFT JOIN teams tm ON tm.id = p.team_id
    WHERE p.status = 'active'
      ${filterAll ? '' : 'AND p.team_id = $1'}
    ORDER BY p.due_date ASC
  `, filterAll ? [] : [teamId]);
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

  // velocity: členové daného teamu (resp. všichni active při scope='all')
  const velocityR = await query(`
    SELECT u.id, u.name, u.role, u.hourly_rate,
           COALESCE(SUM(te.hours), 0) AS hours_14d
    FROM users u
    ${filterAll ? '' : 'JOIN team_members tmem ON tmem.user_id = u.id AND tmem.team_id = $1'}
    LEFT JOIN time_entries te ON te.user_id = u.id AND te.date >= CURRENT_DATE - INTERVAL '14 days'
    WHERE u.active = TRUE
    GROUP BY u.id
    ORDER BY hours_14d DESC
  `, filterAll ? [] : [teamId]);

  const accuracy = await computeAccuracy();

  // Poznámky pro AI Coach kontext — admin/scope=all napříč všemi týmy,
  // ostatní jen jejich current team (visibility='team' + 'personal' = user.id).
  // userId je potřeba pro personal scope filter.
  const notes = userId
    ? await loadNotesForCoach({ scope, teamId, userId })
    : [];

  return {
    today: new Date().toISOString().slice(0, 10),
    scope,
    projects,
    velocity: velocityR.rows,
    accuracy,
    notes,
  };
}

// Načte poznámky pro AI Coach. Per scope:
//   - 'team': team-visible + uživatelovy personal v current teamu
//   - 'all':  všechny týmy, kde je user členem (admin globálně)
// Limit 50 nejnovějších poznámek, content stripped, max 800 chars per body.
async function loadNotesForCoach({ scope, teamId, userId }) {
  const filterAll = scope === 'all';
  // Zjisti, jestli je admin (může vidět všechno) nebo "jen člen".
  const adminR = await query(`SELECT role FROM users WHERE id = $1`, [userId]);
  const isAdmin = adminR.rows[0]?.role === 'admin';

  let sql, params;
  if (filterAll) {
    if (isAdmin) {
      // Admin: úplně všechny team-visible poznámky napříč týmy + svoje personal
      sql = `
        SELECT n.id, n.title, n.content, n.team_id, n.visibility, n.updated_at,
               t.name AS team_name, u.name AS author_name
        FROM notes n
        LEFT JOIN teams t ON t.id = n.team_id
        LEFT JOIN users u ON u.id = n.user_id
        WHERE (n.visibility = 'team' OR (n.visibility = 'personal' AND n.user_id = $1))
        ORDER BY n.updated_at DESC
        LIMIT 50
      `;
      params = [userId];
    } else {
      // Cross-team pro non-admin: poznámky z týmů, kde je user členem
      sql = `
        SELECT n.id, n.title, n.content, n.team_id, n.visibility, n.updated_at,
               t.name AS team_name, u.name AS author_name
        FROM notes n
        LEFT JOIN teams t ON t.id = n.team_id
        LEFT JOIN users u ON u.id = n.user_id
        WHERE n.team_id IN (SELECT team_id FROM team_members WHERE user_id = $1)
          AND (n.visibility = 'team' OR (n.visibility = 'personal' AND n.user_id = $1))
        ORDER BY n.updated_at DESC
        LIMIT 50
      `;
      params = [userId];
    }
  } else {
    // 'team' scope: current team
    if (!teamId) return [];
    sql = `
      SELECT n.id, n.title, n.content, n.team_id, n.visibility, n.updated_at,
             t.name AS team_name, u.name AS author_name
      FROM notes n
      LEFT JOIN teams t ON t.id = n.team_id
      LEFT JOIN users u ON u.id = n.user_id
      WHERE n.team_id = $1
        AND (n.visibility = 'team' OR (n.visibility = 'personal' AND n.user_id = $2))
      ORDER BY n.updated_at DESC
      LIMIT 50
    `;
    params = [teamId, userId];
  }

  const r = await query(sql, params);
  // Strip HTML + omez délku, ať se prompt vejde
  return r.rows.map(n => ({
    id: n.id,
    title: n.title || '(bez názvu)',
    team_name: n.team_name,
    author_name: n.author_name,
    visibility: n.visibility,
    updated_at: n.updated_at,
    content: stripHtml(n.content || '').slice(0, 800),
  }));
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

⚠️ KRITICKÉ PRAVIDLO PRO ČÍSLA HODIN:
- Každý projekt má v datech PŘESNÁ pole: estimated_h_total (součet VŠECH úkolů),
  estimated_h_remaining (součet NEDOKONČENÝCH úkolů) a hours_logged (odpracováno).
- Když mluvíš o "kolik práce zbývá", POUŽIJ DOSLOVA hodnotu estimated_h_remaining.
  Když mluvíš o celkové velikosti projektu, použij estimated_h_total.
- NIKDY tyto hodiny nepřepočítávej, nesčítej ručně ani nezaokrouhluj. Vždy cituj
  číslo z dat přesně tak, jak je (např. když estimated_h_remaining=153, napiš 153 h,
  ne 155 h). Pole estimated_remaining_h v JSON výstupu MUSÍ být přesně rovno
  estimated_h_remaining z dat daného projektu.

TVŮJ ÚKOL:
1. Posuď, zda tempo (hours_14d × tým) odpovídá zbývající práci (estimated_h_remaining) a deadlinům.
2. U každého aktivního projektu vezmi estimated_h_remaining z dat a porovnej s časem do deadlinu (pozor na AI urychlení jen ve slovním komentáři, čísla neměň).
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

export async function getAdvice({ teamId, scope = 'team', userId } = {}) {
  const keyCheck = validateApiKey();
  if (!keyCheck.ok) return { error: keyCheck.reason, message: keyCheck.message };
  const ctx = await buildContext({ teamId, scope, userId });
  if (ctx.projects.length === 0) {
    return {
      status: 'ok',
      headline: scope === 'all' ? 'Žádné aktivní projekty napříč týmy.' : 'Tento tým nemá aktivní projekty.',
      summary: 'Není co analyzovat — zatím tu nejsou žádné aktivní projekty.',
      projects: [],
      recommendations: [],
    };
  }
  const scopeNote = scope === 'all'
    ? 'EXECUTIVE VIEW: analyzuješ projekty NAPŘÍČ VŠEMI TÝMY firmy. U každého projektu je pole team_name — v komentářích zmiňuj, ze kterého týmu projekt je.'
    : 'TEAM VIEW: analyzuješ projekty JEDNOHO konkrétního týmu.';
  const userMessage = `Aktuální datum: ${ctx.today}
${scopeNote}

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
      'x-api-key': keyCheck.key,
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
  const keyCheck = validateApiKey();
  if (!keyCheck.ok) return { error: keyCheck.reason, message: keyCheck.message };
  const userMsg = `Úkol:
Název: ${task.title}
Popis: ${task.description || '(prázdný popis)'}
Priorita: ${task.priority || 'normal'}

Odhadni čas v hodinách s ohledem na AI urychlení.`;

  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': keyCheck.key,
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
  const keyCheck = validateApiKey();
  if (!keyCheck.ok) return { error: keyCheck.reason, message: keyCheck.message };
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
      'x-api-key': keyCheck.key,
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

// ----------- AI zpracování konkrétní poznámky -----------
// action: 'summarize' (krátké shrnutí) | 'suggest_tasks' (návrh úkolů z textu).
// U suggest_tasks dáme Claude projekty + členy teamu, ať umí navrhnout
// realistické přiřazení. Vrací plain text (návrh k přečtení, nic nezakládá).
function stripHtml(html) {
  return String(html || '')
    .replace(/<\/(p|div|li|h[1-3]|tr)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export async function processNote({ noteTitle, noteContent, action, teamId, userId }) {
  const keyCheck = validateApiKey();
  if (!keyCheck.ok) return { error: keyCheck.reason, message: keyCheck.message };

  const text = stripHtml(noteContent);
  if (!text && !noteTitle) return { error: 'empty_note' };

  // ── suggest_tasks: strukturovaný JSON výstup → namapujeme na reálné ID ──
  // (frontend pak zobrazí editovatelný seznam a založí úkoly přes POST /api/tasks)
  if (action === 'suggest_tasks') {
    // Cross-team: AI nabízí projekty + členy ze VŠECH týmů, kde je user členem.
    // Bez userId fallback na origin team poznámky (legacy).
    const projects = userId ? (await query(`
      SELECT p.id, p.name, t.name AS team_name, p.team_id
      FROM projects p JOIN teams t ON t.id = p.team_id
      JOIN team_members tm ON tm.team_id = p.team_id
      WHERE tm.user_id = $1 AND p.status = 'active'
      ORDER BY t.name, p.name
    `, [userId])).rows : (await query(
      `SELECT p.id, p.name, t.name AS team_name, p.team_id
       FROM projects p JOIN teams t ON t.id = p.team_id
       WHERE p.team_id = $1 AND p.status = 'active' ORDER BY p.name`, [teamId]
    )).rows;

    const members = userId ? (await query(`
      SELECT DISTINCT u.id, u.name
      FROM team_members tm JOIN users u ON u.id = tm.user_id
      WHERE u.active = TRUE
        AND tm.team_id IN (SELECT team_id FROM team_members WHERE user_id = $1)
      ORDER BY u.name
    `, [userId])).rows : (await query(
      `SELECT u.id, u.name FROM team_members tm JOIN users u ON u.id = tm.user_id
       WHERE tm.team_id = $1 AND u.active = TRUE ORDER BY u.name`, [teamId]
    )).rows;
    const today = new Date().toISOString().slice(0, 10);
    const system = `Jsi asistent, který z poznámky vytáhne konkrétní akční úkoly.
Vrať POUZE validní JSON (nic okolo, žádné \`\`\`), v tomto formátu:
{
  "tasks": [
    { "title": "stručný akční název",
      "description": "1–2 věty kontextu PROČ úkol existuje (ne odkud) nebo prázdné",
      "assignee_name": "<přesné jméno člena týmu nebo null>",
      "project_name": "<přesný název projektu z nabídky NEBO null pro každý úkol zvlášť>",
      "priority": "low" | "normal" | "high" | "urgent",
      "due_date": "YYYY-MM-DD nebo null" }
  ]
}

PRAVIDLA:
- assignee_name MUSÍ být PŘESNĚ jedno ze jmen členů, jinak null.
- project_name MUSÍ být PŘESNĚ název z nabídky, jinak null.
  KAŽDÝ úkol může patřit do JINÉHO projektu – posuď podle kontextu úkolu.
  Pokud z poznámky vyplývá projekt jen pro některé úkoly, ostatní nech null.
- due_date je DŮLEŽITÉ – odhadni i z náznaků (dnes je ${today}):
  • „dnes" → ${today}
  • „zítra" → +1 den; „pozítří" → +2
  • „příští týden" → +7 dní; „za týden" → +7
  • „začátkem příštího týdne" → +pondělí příštího týdne
  • „do měsíce", „příští měsíc" → +30 dní
  • „brzy", „rychle", „urgentně" → +3 dny
  • „příští porada", „další kontrola" → +7 dní
  • konkrétní datum v textu → použij ho.
  Jen pokud opravdu žádný náznak není, nech null.
- Když poznámka nemá nic akčního, vrať {"tasks": []}.

DOSTUPNÍ ČLENOVÉ (napříč všemi týmy uživatele): ${JSON.stringify(members.map(m => m.name))}
DOSTUPNÉ PROJEKTY (s týmem): ${JSON.stringify(projects.map(p => ({ project: p.name, team: p.team_name })))}

POZN. K TÝMŮM: úkol můžeš zařadit do JAKÉHOKOLI projektu z nabídky, i z jiného týmu, pokud z poznámky vyplývá, že tam logicky patří (např. „dáme to designerům" → projekt v týmu Design). project_name posuď podle obsahu úkolu, ne podle origin team poznámky.`;
    const userMsg = `Poznámka „${noteTitle || ''}":\n\n${text}`;

    // Timeout: Anthropic může trvat 10-30 s, ale nechceme viset věčně.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 60_000);
    let res;
    try {
      res = await fetch(API_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': keyCheck.key, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: MODEL, max_tokens: 1500, system, messages: [{ role: 'user', content: userMsg }] }),
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      const timedOut = err.name === 'AbortError';
      console.warn('[ai/suggest_tasks] fetch error', { name: err.name, message: err.message });
      return {
        error: timedOut ? 'ai_timeout' : 'ai_fetch_failed',
        message: timedOut
          ? 'AI neodpověděla do 60 sekund. Zkus to znovu za chvíli.'
          : `Nepodařilo se zavolat AI: ${err.message}`,
      };
    }
    clearTimeout(timer);
    if (!res.ok) {
      const body = await res.text();
      console.warn('[ai/suggest_tasks] api_error', res.status, body.slice(0, 300));
      return { error: 'api_error', status: res.status, message: `Anthropic API ${res.status}: ${body.slice(0, 300)}` };
    }
    const data = await res.json();
    const raw = data.content?.[0]?.text || '';
    // Robustní extrakce: nejdřív zkus sundat ```json ... ``` fence,
    // pak fallback na první { … poslední } (přežije jakýkoli text okolo).
    let parsed;
    try {
      const trimmed = raw.trim();
      const fenceMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```\s*$/i);
      let jsonStr = fenceMatch ? fenceMatch[1] : trimmed;
      if (!jsonStr.trim().startsWith('{')) {
        const first = jsonStr.indexOf('{');
        const last = jsonStr.lastIndexOf('}');
        if (first >= 0 && last > first) jsonStr = jsonStr.slice(first, last + 1);
      }
      parsed = JSON.parse(jsonStr);
    } catch (err) {
      console.warn('[ai/suggest_tasks] parse_error:', err.message, 'raw:', raw.slice(0, 300));
      return { error: 'parse_error', message: `AI vrátila neplatný JSON: ${err.message}`, raw: raw.slice(0, 500) };
    }
    // Mapování jmen → ID (case-insensitive, trim)
    const findMember = (name) => {
      if (!name) return null;
      const n = String(name).trim().toLowerCase();
      return members.find(m => m.name.toLowerCase() === n) || null;
    };
    const findProject = (name) => {
      if (!name) return null;
      const n = String(name).trim().toLowerCase();
      return projects.find(p => p.name.toLowerCase() === n) || null;
    };
    const VALID_PRIO = ['low', 'normal', 'high', 'urgent'];
    const tasks = (Array.isArray(parsed.tasks) ? parsed.tasks : []).map(t => {
      const m = findMember(t.assignee_name);
      const p = findProject(t.project_name);
      const due = /^\d{4}-\d{2}-\d{2}$/.test(t.due_date || '') ? t.due_date : null;
      return {
        title: String(t.title || '').slice(0, 200),
        description: t.description ? String(t.description).slice(0, 1000) : '',
        assignee_id: m?.id || null,
        assignee_name: m?.name || null,
        project_id: p?.id || null,
        project_name: p?.name || null,
        team_id: p?.team_id || null,
        team_name: p?.team_name || null,
        priority: VALID_PRIO.includes(t.priority) ? t.priority : 'normal',
        due_date: due,
      };
    }).filter(t => t.title);
    return {
      tasks,
      // Cross-team katalog pro frontend dropdowny (modal nemusí sám fetch).
      available_projects: projects.map(p => ({ id: p.id, name: p.name, team_id: p.team_id, team_name: p.team_name })),
      available_members:  members.map(m => ({ id: m.id, name: m.name })),
      usage: data.usage,
    };
  }

  // ── summarize: prostý text ──
  const system = `Jsi asistent, který stručně shrne poznámku. Vytáhni hlavní body a závěry.
Odpověz česky, max 5 odrážek nebo 3 věty. Buď věcný, nevymýšlej nic, co v poznámce není.`;
  const userMsg = `Shrň tuto poznámku „${noteTitle || ''}":\n\n${text}`;

  const res = await fetch(API_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': keyCheck.key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: MODEL, max_tokens: 1200, system, messages: [{ role: 'user', content: userMsg }] }),
  });
  if (!res.ok) return { error: 'api_error', status: res.status, message: (await res.text()).slice(0, 500) };
  const data = await res.json();
  return { reply: data.content?.[0]?.text || '', usage: data.usage };
}

export async function chat(messages, { teamId, scope = 'team', userId } = {}) {
  const keyCheck = validateApiKey();
  if (!keyCheck.ok) return { error: keyCheck.reason, message: keyCheck.message };
  const ctx = await buildContext({ teamId, scope, userId });
  const scopeNote = scope === 'all'
    ? 'KONTEXT: vidíš data ZE VŠECH TÝMŮ. U projektů i poznámek je team_name.'
    : 'KONTEXT: vidíš data JEDNOHO konkrétního týmu.';
  // Poznámky jako oddělená sekce — title + zkrácený text + meta.
  // Když je hodně poznámek, držíme limit z buildContext (50, 800 chars each).
  const notesSection = ctx.notes?.length > 0
    ? `\nPOZNÁMKY (může jich být víc, autoritativní zdroj):\n${JSON.stringify(ctx.notes)}`
    : '\nPOZNÁMKY: (žádné nejsou v dostupném scope)';

  const systemWithCtx = `${SYSTEM_PROMPT}

${scopeNote}
DATA, KE KTERÝM MŮŽEŠ ODKAZOVAT (nemůžeš měnit, jen analyzovat):
DATUM: ${ctx.today}
PROJEKTY: ${JSON.stringify(ctx.projects)}
TEMPO: ${JSON.stringify(ctx.velocity)}
ACCURACY: ${JSON.stringify(ctx.accuracy)}${notesSection}

Pokud se user ptá na obsah poznámek, čerpej z POZNÁMKY sekce. Cituj
konkrétní titulky („V poznámce „X" píše se …"), nevymýšlej. Když odpověď
v poznámkách není, řekni to.

V chatu odpovídej krátce a věcně, plain text (ne JSON).`;

  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': keyCheck.key,
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

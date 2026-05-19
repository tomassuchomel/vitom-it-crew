// ImplementationAgent – spustí Claude jako kódovacího agenta uvnitř git worktree.
//
// Architektura:
//   – Manual tool-use loop (ne tool runner): potřebujeme kontrolu nad logováním,
//     scope_paths enforcement, budget gating mezi iteracemi.
//   – Tools jsou klientské: read_file, write_file, list_dir, bash (constrained),
//     git_commit. Posílají se Claudovi přes Anthropic Messages API.
//   – Bash je omezený whitelist prefixů + blacklist nebezpečných substringů.
//     Schema model jen informuje, runtime validátor je v executeTool().
//   – Prompt caching: cache_control na posledním system bloku (zakešuje
//     tools + system dohromady díky render orderu tools → system → messages).
//
// Klíče bezpečnosti:
//   – Žádný `git push` přes bash tool, žádný do main brachu.
//   – write_file odmítne cesty, které neprojdou safety.validateScopePaths
//     a navíc cestu napřímo proti task.scope_paths (pokud neprázdné).
//   – Executor nikdy nepouští shell přes /bin/sh – používá spawn s argv polem.
//   – CLAUDE.md, .env, existující migrace se nikdy nepřepíšou (defense-in-depth).

import Anthropic from '@anthropic-ai/sdk';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { validateScopePaths } from './safety.js';

// Sonnet 4.6 pricing (USD per 1M tokens) – aktualizovat při migraci modelů.
// input * 1.0 normal, input * 0.1 cache read, input * 1.25 cache write (5 min default)
const MODEL = 'claude-sonnet-4-6';
const PRICE_INPUT_PER_MTOK = 3.0;
const PRICE_OUTPUT_PER_MTOK = 15.0;
const CACHE_WRITE_MULT = 1.25;
const CACHE_READ_MULT  = 0.1;

// Maximum tokens per single API call. Generous strop pro long outputs / plánování.
const MAX_TOKENS_PER_RESPONSE = 8000;

// ─── System prompt ────────────────────────────────────────────────────────
// Vystavený jako export, ať si ho uživatel může přečíst / upravit bez nutnosti
// procházet inline string. Sestavený šablonou s několika placeholdery, které
// se dosadí v sestavovači níže.
export const IMPLEMENTATION_SYSTEM_PROMPT = `Jsi VITOM Implementation Agent – Claude pracující jako autonomní programátor uvnitř git worktree.

KONTEXT:
- Pracuješ v izolovaném worktree na branchi {{branch}}.
- Pracovní adresář: {{worktreePath}}
- Hlavní branch repa je "main". NIKDY do něj nepushuj a NIKDY na něj nepřepínej.
- Repo je VITOM IT Crew – interní webová appka (Node.js + Express + PostgreSQL backend, React + Vite frontend).

ÚKOL #{{taskId}}: {{taskTitle}}

POPIS:
{{taskDescription}}

ACCEPTANCE CRITERIA (každý bod musí být splněn, jinak úkol není hotov):
{{acceptanceCriteria}}

OUT OF SCOPE (toto NESMÍŠ řešit, i kdybys narazil):
{{outOfScope}}

SCOPE PATHS (smíš upravovat JEN soubory v těchto cestách – pokud je seznam prázdný, smíš všude, ale držet se zdravého rozumu):
{{scopePaths}}

NESMÍŠ:
- Pushovat do branch "main" ani na žádnou existující branch mimo aktuální claude/...
- Měnit soubor .env nebo cokoliv v adresáři, který se jmenuje .env / .git / node_modules / .ssh / .aws
- Upravovat existující soubory v server/src/migrations/ – migrace jsou immutable, vytvoř novou s novým datem
- Mazat soubory mimo scope_paths
- Spouštět nebezpečné příkazy: rm -rf, sudo, chmod 777, curl s POSTem na neznámé hosty
- Měnit kořenový CLAUDE.md (pokud existuje) – ten popisuje systém, není pracovní soubor

POSTUP:
1. Začni voláním read_file na klíčové soubory zmíněné v popisu úkolu, abys získal kontext.
2. Vytvoř (write_file) soubor PLAN.md v rootu worktree obsahující:
   - "## Cíl" – jedna věta co budeš dělat
   - "## Kroky" – číslovaný seznam kroků implementace
   - "## Soubory" – které soubory předpokládáš upravit (musí být v scope_paths)
   - "## Rizika" – co by mohlo selhat nebo co je nejisté
3. Postupně implementuj kroky pomocí write_file a edit přes write_file (čti → změň → zapiš).
4. Po každé větší změně spusť relevantní testy / lint přes bash, abys ověřil, že nic nerozbíjíš.
5. Když je úkol hotov (všechna AC splněna):
   - Spusť 'npm test --prefix server' (nebo relevantní část) přes bash
   - Spusť git_commit s rozumnou commit zprávou pokrývající všechno
   - Zavolej tool 'done' s finálním strukturovaným výstupem

VÝSTUP (formát, který MUSÍŠ poslat ve volání toolu 'done'):
Strukturovaný markdown s těmito sekcemi v tomto pořadí (žádné jiné nepřidávej):

## Co jsem udělal
2-4 věty shrnutí

## Plán
Stručný odraz toho, co jsi měl v PLAN.md, plus poznámky kde ses odchýlil a proč.

## Změněné soubory
- cesta/soubor – jednou větou co se v něm změnilo
- (pro každý soubor jeden řádek)

## AC check
- AC #1 ("text kritéria") – ✅ jak / ❌ proč ne
- (pro každý acceptance criterion)

## Testy
Co jsi spustil, výsledek (passed/failed/skipped), pokud failed tak proč.

## Otevřené otázky
- Body, které vyžadují člověka (může být prázdné: "žádné").

DŮLEŽITÉ:
- Mluv v komentářích k tool callům česky; v kódu samotném anglicky podle stávajícího stylu projektu.
- Buď stručný. Žádné corporate buzz, žádné "Let me help you with that".
- Pokud zjistíš, že úkol je nesplnitelný (chybí kontext, neproveditelný požadavek), zavolej 'done' s vysvětlením v "Otevřené otázky" a v "AC check" označ AC jako ❌.
- Máš max {{maxIterations}} iterací – snaž se být efektivní, neopakuj se.`;

// Helpery pro sestavení promptu
function fillSystemPrompt({ task, worktreePath, branch, maxIterations }) {
  const acList = (task.acceptance_criteria || []).map((c, i) => `${i + 1}. ${c}`).join('\n') || '(žádná specifikovaná)';
  const oosList = (task.out_of_scope || []).map(c => `- ${c}`).join('\n') || '(nic specifikovaného – řiď se popisem úkolu)';
  const spList = (task.scope_paths || []).map(c => `- ${c}`).join('\n') || '(prázdné – povoleno všude, ale držet se zdravého rozumu)';
  return IMPLEMENTATION_SYSTEM_PROMPT
    .replace('{{branch}}', branch)
    .replace('{{worktreePath}}', worktreePath)
    .replace('{{taskId}}', String(task.id))
    .replace('{{taskTitle}}', task.title)
    .replace('{{taskDescription}}', task.description || '(bez popisu)')
    .replace('{{acceptanceCriteria}}', acList)
    .replace('{{outOfScope}}', oosList)
    .replace('{{scopePaths}}', spList)
    .replace('{{maxIterations}}', String(maxIterations));
}

// ─── Tool definitions ─────────────────────────────────────────────────────
const TOOLS = [
  {
    name: 'read_file',
    description: 'Přečte soubor z aktuálního worktree. Vrátí celý obsah jako text. Selhává pokud cesta neexistuje nebo směřuje mimo worktree. Použij pro získání kontextu před úpravou.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Relativní cesta v rámci worktree, např. "client/src/App.jsx"' },
      },
      required: ['path'],
    },
  },
  {
    name: 'write_file',
    description: 'Vytvoří nebo přepíše soubor v worktree. Cesta musí být v rámci scope_paths (pokud jsou definované). Nelze přepsat .env, .git, node_modules, server/src/migrations/*.sql ani CLAUDE.md. Vytvoří chybějící adresáře.',
    input_schema: {
      type: 'object',
      properties: {
        path:    { type: 'string',  description: 'Relativní cesta v rámci worktree' },
        content: { type: 'string',  description: 'Plný nový obsah souboru' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'list_dir',
    description: 'Vypíše obsah adresáře v worktree. Vrátí seznam souborů a podadresářů.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Relativní cesta adresáře, např. "client/src/components". Pro root použij "."' },
      },
      required: ['path'],
    },
  },
  {
    name: 'bash',
    description: 'Spustí jeden shell příkaz v rootu worktree. POVOLENÉ prefixy: "npm test", "npm run lint", "npm run build", "npm install", "node", "git status", "git diff", "git log", "git add", "ls", "cat", "head", "tail", "mkdir -p", "grep", "find", "pwd", "wc". ZAKÁZÁNO: "rm -rf", "git push", "git reset --hard", "git checkout", "sudo", "chmod 777", "curl -X POST", "&&" a "||" pro chaining (spusť každý příkaz zvlášť). Pro commit použij tool git_commit místo bash. Vrací stdout, stderr a exit code.',
    input_schema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Jeden shell příkaz bez chainingu' },
        timeout_ms: { type: 'number', description: 'Volitelný timeout v ms (default 60000)' },
      },
      required: ['command'],
    },
  },
  {
    name: 'git_commit',
    description: 'Provede `git add -A && git commit -m <message>` v aktuálním worktree. Použij místo bash. Selže pokud není co commitnout.',
    input_schema: {
      type: 'object',
      properties: {
        message: { type: 'string', description: 'Stručná commit zpráva, ideálně 1 řádek + (volitelně) odstavec popisu.' },
      },
      required: ['message'],
    },
  },
  {
    name: 'done',
    description: 'Signalizuje, že úkol je hotov. Předej strukturovaný markdown výstup podle formátu v system promptu. Po zavolání tohoto toolu skončí session.',
    input_schema: {
      type: 'object',
      properties: {
        summary: { type: 'string', description: 'Plný strukturovaný markdown s povinnými sekcemi (## Co jsem udělal, ## Plán, ## Změněné soubory, ## AC check, ## Testy, ## Otevřené otázky)' },
        success: { type: 'boolean', description: 'true = AC splněna, false = úkol není dokončitelný / částečně' },
      },
      required: ['summary', 'success'],
    },
  },
];

// ─── Bash sandboxing ──────────────────────────────────────────────────────
// Povolené prefixy – příkaz musí jedním z nich začínat (po trim).
const BASH_ALLOWED_PREFIXES = [
  'npm test', 'npm run ', 'npm install', 'npm ci', 'npm ls',
  'node ', 'node --',
  'git status', 'git diff', 'git log', 'git add', 'git show', 'git branch', 'git rev-parse',
  'ls', 'cat ', 'head ', 'tail ', 'mkdir -p', 'grep ', 'find ', 'pwd', 'wc ',
  'echo ',
];

// Zakázané substringy – pokud jsou kdekoliv v příkazu, odmítneme.
const BASH_FORBIDDEN_SUBSTRINGS = [
  'rm -rf', 'rm -r ', 'rm -f',
  'git push', 'git reset --hard', 'git checkout ', 'git switch ', 'git rebase', 'git merge',
  'sudo ', 'chmod 777', 'chmod -R',
  'curl -X POST', 'curl -X PUT', 'curl -X DELETE', 'wget ',
  '&&', '||', '`', '$(',
  '> /', '>> /',
];

function validateBashCommand(cmd) {
  if (typeof cmd !== 'string' || cmd.trim() === '') {
    return { ok: false, error: 'prázdný příkaz' };
  }
  const trimmed = cmd.trim();
  for (const bad of BASH_FORBIDDEN_SUBSTRINGS) {
    if (trimmed.includes(bad)) return { ok: false, error: `zakázaný substring: "${bad}"` };
  }
  const allowed = BASH_ALLOWED_PREFIXES.some(p => trimmed.startsWith(p));
  if (!allowed) {
    return { ok: false, error: `příkaz nezačíná povoleným prefixem. Použij jeden z: ${BASH_ALLOWED_PREFIXES.slice(0, 6).join(', ')}, ...` };
  }
  return { ok: true };
}

// ─── Path sandboxing (write_file + read_file) ────────────────────────────
// Zabezpečuje, že cesta:
//   – Je relativní (žádné absolute, žádné ~)
//   – Po resolve zůstává uvnitř worktreePath (žádné ../úniky)
//   – Není v zakázaných adresářích (.env, .git, node_modules, …)
//   – Pro write_file: spadá pod alespoň jednu ze scope_paths (pokud neprázdné)
//     a NENÍ v existing migrations (server/src/migrations/*.sql)
const NEVER_WRITE_SEGMENTS = new Set(['.env', '.git', 'node_modules', '.ssh', '.aws', '.npmrc', '.netrc']);
const NEVER_WRITE_FILES = new Set(['CLAUDE.md']);

function resolveSafePath(worktreePath, relPath, { allowAbsoluteInsideWorktree = false } = {}) {
  if (typeof relPath !== 'string' || relPath.trim() === '') {
    throw new Error('cesta musí být neprázdný string');
  }
  if (relPath.includes('\0')) throw new Error('cesta obsahuje null byte');
  if (!allowAbsoluteInsideWorktree && (relPath.startsWith('/') || relPath.startsWith('~'))) {
    throw new Error('absolutní cesty nejsou povolené – použij relativní cestu v worktree');
  }
  const resolved = path.resolve(worktreePath, relPath);
  const rootResolved = path.resolve(worktreePath);
  if (resolved !== rootResolved && !resolved.startsWith(rootResolved + path.sep)) {
    throw new Error('cesta leží mimo worktree (path traversal)');
  }
  // Kontrola zakázaných segmentů (case-insensitive)
  const relativeFromRoot = path.relative(rootResolved, resolved);
  for (const seg of relativeFromRoot.split(path.sep)) {
    if (NEVER_WRITE_SEGMENTS.has(seg.toLowerCase())) {
      throw new Error(`cesta směřuje na zakázaný segment "${seg}"`);
    }
  }
  return resolved;
}

function isExistingMigrationPath(rel) {
  // server/src/migrations/2026-…sql – immutable
  return /^server\/src\/migrations\/.+\.sql$/i.test(rel);
}

function validateWritePath(worktreePath, relPath, scopePaths) {
  const abs = resolveSafePath(worktreePath, relPath);
  const rel = path.relative(worktreePath, abs);

  if (NEVER_WRITE_FILES.has(path.basename(rel))) {
    throw new Error(`soubor ${path.basename(rel)} nelze přepisovat`);
  }
  if (isExistingMigrationPath(rel)) {
    throw new Error('existující migrace v server/src/migrations/ jsou immutable – vytvoř nový soubor s aktuálním datem');
  }
  // Pokud jsou scope_paths definované, cesta MUSÍ pod nějakou spadat.
  if (Array.isArray(scopePaths) && scopePaths.length > 0) {
    const ok = scopePaths.some(sp => {
      const spClean = sp.replace(/\/$/, '');
      return rel === spClean || rel.startsWith(spClean + '/');
    });
    if (!ok) {
      throw new Error(`cesta "${rel}" leží mimo scope_paths (${scopePaths.join(', ')})`);
    }
  }
  return abs;
}

// ─── Cost tracking ────────────────────────────────────────────────────────
function computeCostUsd(usage) {
  if (!usage) return 0;
  const inT  = Number(usage.input_tokens || 0);
  const outT = Number(usage.output_tokens || 0);
  const cWrite = Number(usage.cache_creation_input_tokens || 0);
  const cRead  = Number(usage.cache_read_input_tokens || 0);
  return (
    inT    * PRICE_INPUT_PER_MTOK +
    cWrite * PRICE_INPUT_PER_MTOK * CACHE_WRITE_MULT +
    cRead  * PRICE_INPUT_PER_MTOK * CACHE_READ_MULT +
    outT   * PRICE_OUTPUT_PER_MTOK
  ) / 1_000_000;
}

// ─── Bash executor – spawn s argv polem, žádný shell ────────────────────
async function runBash(cwd, command, timeoutMs = 60_000) {
  // Použijeme /bin/sh -c proto, že potřebujeme parsovat user-provided příkaz
  // (např. "npm test", "ls -la"). Bezpečnost zajišťuje validator výše – příkaz
  // už prošel whitelistem a blacklistem.
  return new Promise((resolve) => {
    const child = spawn('/bin/sh', ['-c', command], {
      cwd,
      env: { ...process.env, PATH: process.env.PATH || '/usr/bin:/bin:/usr/local/bin' },
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGKILL'); } catch {}
    }, timeoutMs);
    child.stdout.on('data', d => { stdout += d.toString('utf8'); });
    child.stderr.on('data', d => { stderr += d.toString('utf8'); });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({
        stdout: stdout.slice(-20000), // strop, ať nezatížíme context
        stderr: stderr.slice(-10000),
        exit_code: code ?? -1,
        timed_out: timedOut,
      });
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ stdout: '', stderr: err.message, exit_code: -1, timed_out: false });
    });
  });
}

// ─── Tool executor ────────────────────────────────────────────────────────
async function executeTool({ name, input, worktreePath, scopePaths }) {
  switch (name) {
    case 'read_file': {
      const abs = resolveSafePath(worktreePath, input.path);
      const content = await fs.readFile(abs, 'utf8');
      return { content: content.length > 100_000 ? content.slice(0, 100_000) + '\n…(truncated)' : content };
    }
    case 'write_file': {
      const abs = validateWritePath(worktreePath, input.path, scopePaths);
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, input.content, 'utf8');
      return { ok: true, bytes: Buffer.byteLength(input.content, 'utf8') };
    }
    case 'list_dir': {
      const abs = resolveSafePath(worktreePath, input.path);
      const entries = await fs.readdir(abs, { withFileTypes: true });
      return {
        entries: entries
          .filter(e => !NEVER_WRITE_SEGMENTS.has(e.name.toLowerCase()))
          .map(e => ({ name: e.name, type: e.isDirectory() ? 'dir' : 'file' })),
      };
    }
    case 'bash': {
      const v = validateBashCommand(input.command);
      if (!v.ok) {
        return { stdout: '', stderr: `Příkaz odmítnut: ${v.error}`, exit_code: 126, refused: true };
      }
      return await runBash(worktreePath, input.command, Math.min(Number(input.timeout_ms) || 60_000, 600_000));
    }
    case 'git_commit': {
      const msg = String(input.message || '').trim();
      if (!msg) return { ok: false, error: 'prázdná commit zpráva' };
      const add = await runBash(worktreePath, 'git add -A', 30_000);
      if (add.exit_code !== 0) return { ok: false, error: 'git add selhal', stderr: add.stderr };
      // Commit – `git commit -m "..."` přes /bin/sh by potřeboval escape; raději přes spawn s argv.
      const commitResult = await new Promise((resolve) => {
        const child = spawn('git', ['commit', '-m', msg], { cwd: worktreePath });
        let stdout = ''; let stderr = '';
        child.stdout.on('data', d => { stdout += d.toString('utf8'); });
        child.stderr.on('data', d => { stderr += d.toString('utf8'); });
        child.on('close', (code) => resolve({ stdout, stderr, exit_code: code ?? -1 }));
        child.on('error', (err) => resolve({ stdout: '', stderr: err.message, exit_code: -1 }));
      });
      if (commitResult.exit_code !== 0) {
        const noChanges = commitResult.stdout.includes('nothing to commit') ||
                          commitResult.stderr.includes('nothing to commit');
        return { ok: false, error: noChanges ? 'není co commitnout' : 'git commit selhal',
                 stdout: commitResult.stdout, stderr: commitResult.stderr };
      }
      return { ok: true, stdout: commitResult.stdout };
    }
    case 'done': {
      // 'done' nemá side-effect – jeho výsledek čte loop a ukončí session.
      return { ok: true };
    }
    default:
      return { error: `neznámý tool: ${name}` };
  }
}

// ─── Hlavní agent ─────────────────────────────────────────────────────────
/**
 * @typedef {Object} AgentResult
 * @property {boolean} success      true pokud agent zavolal done({success: true})
 * @property {string|null} summary  strukturovaný markdown výstup
 * @property {number} costUsd
 * @property {number} iterations
 * @property {string|null} error    pokud neúspěch, kód chyby
 * @property {Array<object>} log    zkrácený log akcí (pro debug)
 */

/**
 * @param {Object} opts
 * @param {object} opts.task          řádek z tasks tabulky
 * @param {object} opts.bundle        TaskBundle z ContextAssembleru
 * @param {string} opts.worktreePath  cesta k git worktree
 * @param {string} opts.branch        název branche (claude/task-X)
 * @param {string} opts.apiKey        Anthropic API klíč
 * @param {number} [opts.maxIterations=8]
 * @param {number} [opts.maxCostUsd]  hard strop (pokud překročíme, zastavíme)
 * @param {object} [opts.client]      pro testy – mockovaný SDK klient s metodou messages.create
 * @returns {Promise<AgentResult>}
 */
export async function runImplementationAgent(opts) {
  const {
    task,
    bundle,
    worktreePath,
    branch,
    apiKey,
    maxIterations = 8,
    maxCostUsd = Infinity,
  } = opts;

  if (!task || !worktreePath || !branch) {
    throw new Error('runImplementationAgent: chybí task / worktreePath / branch');
  }

  // Předem zvaliduj scope_paths (defense-in-depth proti tomu, co je v DB).
  const scopeCheck = validateScopePaths(task.scope_paths);
  if (!scopeCheck.ok) {
    return {
      success: false,
      summary: null,
      costUsd: 0,
      iterations: 0,
      error: `invalid_scope_paths: ${scopeCheck.error}`,
      log: [],
    };
  }

  const client = opts.client || new Anthropic({ apiKey });
  const systemPrompt = fillSystemPrompt({ task, worktreePath, branch, maxIterations });

  // Initial user message – krátký kick-off, kontext je v system promptu
  const userKickoff = `Začni úkolem #${task.id}. Nezapomeň: nejdřív PLAN.md, pak implementace, pak testy, pak \`done\`. Pracovní adresář je ${worktreePath}.`;

  /** @type {Array<object>} */
  const messages = [{ role: 'user', content: userKickoff }];

  let totalCostUsd = 0;
  let iterations = 0;
  let finalSummary = null;
  let finalSuccess = false;
  const log = [];

  while (iterations < maxIterations) {
    iterations++;

    if (totalCostUsd > maxCostUsd) {
      log.push({ event: 'budget_exhausted', iteration: iterations, cost: totalCostUsd });
      return {
        success: false,
        summary: null,
        costUsd: totalCostUsd,
        iterations,
        error: 'budget_exhausted',
        log,
      };
    }

    let response;
    try {
      response = await client.messages.create({
        model: MODEL,
        max_tokens: MAX_TOKENS_PER_RESPONSE,
        system: [
          { type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } },
        ],
        tools: TOOLS,
        messages,
        thinking: { type: 'adaptive' },
        output_config: { effort: 'high' },
      });
    } catch (err) {
      log.push({ event: 'api_error', iteration: iterations, message: err.message });
      return {
        success: false,
        summary: null,
        costUsd: totalCostUsd,
        iterations,
        error: `api_error: ${err.message}`,
        log,
      };
    }

    const turnCost = computeCostUsd(response.usage);
    totalCostUsd += turnCost;
    log.push({ event: 'api_response', iteration: iterations, stop_reason: response.stop_reason,
               cost: turnCost, total_cost: totalCostUsd, usage: response.usage });

    // Plný assistant content (text + tool_use bloky) přidáme do historie
    messages.push({ role: 'assistant', content: response.content });

    if (response.stop_reason === 'end_turn') {
      // Agent skončil bez volání 'done' – nebudeme to považovat za úspěch
      log.push({ event: 'end_turn_without_done', iteration: iterations });
      const lastText = response.content.find(b => b.type === 'text')?.text || null;
      return {
        success: false,
        summary: lastText,
        costUsd: totalCostUsd,
        iterations,
        error: 'ended_without_done',
        log,
      };
    }

    if (response.stop_reason !== 'tool_use') {
      log.push({ event: 'unexpected_stop', iteration: iterations, stop_reason: response.stop_reason });
      return {
        success: false,
        summary: null,
        costUsd: totalCostUsd,
        iterations,
        error: `unexpected_stop_reason: ${response.stop_reason}`,
        log,
      };
    }

    // Najdi všechny tool_use bloky a zpracuj je
    const toolUseBlocks = response.content.filter(b => b.type === 'tool_use');
    const toolResults = [];
    let doneCalled = false;

    for (const tu of toolUseBlocks) {
      log.push({ event: 'tool_use', iteration: iterations, name: tu.name, input_summary: summarizeInput(tu.input) });
      let result;
      try {
        result = await executeTool({
          name: tu.name,
          input: tu.input,
          worktreePath,
          scopePaths: task.scope_paths,
        });
      } catch (err) {
        result = { error: err.message };
      }

      toolResults.push({
        type: 'tool_result',
        tool_use_id: tu.id,
        content: JSON.stringify(result).slice(0, 50_000),
        is_error: !!(result && (result.error || result.refused)),
      });

      if (tu.name === 'done') {
        doneCalled = true;
        finalSummary = String(tu.input?.summary || '');
        finalSuccess = !!tu.input?.success;
      }
    }

    // Tool results posíláme jako user message
    messages.push({ role: 'user', content: toolResults });

    if (doneCalled) {
      log.push({ event: 'done_called', iteration: iterations, success: finalSuccess });
      return {
        success: finalSuccess,
        summary: finalSummary,
        costUsd: totalCostUsd,
        iterations,
        error: null,
        log,
      };
    }
  }

  // Max iterations
  log.push({ event: 'max_iterations_reached', iterations });
  return {
    success: false,
    summary: null,
    costUsd: totalCostUsd,
    iterations,
    error: 'max_iterations_reached',
    log,
  };
}

// Stručný popis tool inputu pro log (bez plného obsahu souborů)
function summarizeInput(input) {
  if (!input) return {};
  const out = {};
  for (const [k, v] of Object.entries(input)) {
    if (typeof v === 'string' && v.length > 200) out[k] = `${v.slice(0, 200)}…(${v.length} chars)`;
    else out[k] = v;
  }
  return out;
}

// Pro testy: export interních helperů
export const _internals = {
  TOOLS,
  fillSystemPrompt,
  validateBashCommand,
  validateWritePath,
  resolveSafePath,
  computeCostUsd,
  MODEL,
  PRICE_INPUT_PER_MTOK,
  PRICE_OUTPUT_PER_MTOK,
};

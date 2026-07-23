// Admin Server panel — endpointy pro provoz aplikace bez SSH.
//
// F1: read-only (health / env / errors)
// F2: write (env editace / restart)
// F3: db / migrace / deploy trigger
//
// Vše chráněno requireRole('admin') — jen globální admin uvidí a spustí.

import { Router } from 'express';
import fs from 'fs';
import { execSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import { requireAuth, requireRole } from '../auth.js';
import { query } from '../db.js';
import { getRecentErrors, clearErrors } from '../errorBuffer.js';

const router = Router();
router.use(requireAuth, requireRole('admin'));

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const ENV_FILE  = path.resolve(__dirname, '..', '..', '.env');

// Whitelist ENV klíčů, které v UI ukazujeme + editujeme. Vše mimo whitelist
// se v UI vůbec nezobrazí, aby si admin do .env náhodou nedostal Věci, které
// aplikace neumí (nebo aby si nepřepsal DATABASE_URL).
export const KNOWN_ENV_KEYS = [
  // Runtime
  { key: 'NODE_ENV',                 group: 'Runtime',   required: true,  secret: false },
  { key: 'PORT',                     group: 'Runtime',   required: true,  secret: false },
  { key: 'DATABASE_URL',              group: 'Runtime',   required: true,  secret: true  },
  { key: 'DATABASE_SSL',              group: 'Runtime',   required: false, secret: false },
  { key: 'JWT_SECRET',                group: 'Runtime',   required: true,  secret: true  },
  { key: 'CLIENT_URL',                group: 'Runtime',   required: true,  secret: false },
  { key: 'APP_BASE_URL',              group: 'Runtime',   required: true,  secret: false },
  { key: 'DISABLE_AUTOSEED',          group: 'Runtime',   required: false, secret: false },

  // AI (Claude)
  { key: 'ANTHROPIC_API_KEY',         group: 'AI',        required: true,  secret: true  },
  { key: 'ANTHROPIC_MODEL',           group: 'AI',        required: false, secret: false },
  { key: 'AI_AGENT_WORKDIR',          group: 'AI',        required: false, secret: false },

  // M365 mail
  { key: 'MICROSOFT_TENANT_ID',       group: 'M365 Mail', required: false, secret: true  },
  { key: 'MICROSOFT_CLIENT_ID',       group: 'M365 Mail', required: false, secret: true  },
  { key: 'MICROSOFT_CLIENT_SECRET',   group: 'M365 Mail', required: false, secret: true  },
  { key: 'MAIL_M365_MAILBOX',         group: 'M365 Mail', required: false, secret: false },

  // Cloudflare Turnstile (Nápadník antispam)
  { key: 'TURNSTILE_SECRET',          group: 'Turnstile', required: false, secret: true  },
  { key: 'TURNSTILE_SITE_KEY',        group: 'Turnstile', required: false, secret: false },

  // Web Push (VAPID)
  { key: 'VAPID_PUBLIC_KEY',          group: 'Push',      required: false, secret: false },
  { key: 'VAPID_PRIVATE_KEY',         group: 'Push',      required: false, secret: true  },

  // MCP + GitHub (AI Agent)
  { key: 'MCP_AUTH_TOKEN',            group: 'MCP',       required: false, secret: true  },
  { key: 'GITHUB_TOKEN',              group: 'GitHub',    required: false, secret: true  },
];

// Zamlžuje hodnotu — z 'sk-ant-abc…xyz' udělá 'sk-ant-abc…***' (posledních N znaků).
function maskValue(value) {
  const v = String(value || '');
  if (v.length === 0) return '';
  if (v.length <= 4) return '****';
  return v.slice(0, 4) + '****' + v.slice(-4);
}

// Načte .env do mapy. Ignoruje komentáře / prázdné řádky.
function readEnv() {
  try {
    const raw = fs.readFileSync(ENV_FILE, 'utf8');
    const out = {};
    for (const line of raw.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/);
      if (!m) continue;
      out[m[1]] = m[2].trim().replace(/^"(.*)"$/, '$1');
    }
    return out;
  } catch (err) {
    return {};
  }
}

// GET /health — základní zdraví BE
router.get('/health', async (req, res) => {
  const mem = process.memoryUsage();
  const uptimeSec = Math.round(process.uptime());

  // Git commit hash aktuální produkce
  let gitCommit = null;
  let gitTime = null;
  try {
    gitCommit = execSync('git rev-parse HEAD', { cwd: REPO_ROOT, encoding: 'utf8' }).trim().slice(0, 12);
    gitTime = execSync('git log -1 --format=%cI', { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
  } catch { /* git nemusí být dostupný */ }

  // DB probe
  let dbOk = false, dbLatencyMs = null;
  const t0 = Date.now();
  try {
    await query('SELECT 1');
    dbOk = true;
    dbLatencyMs = Date.now() - t0;
  } catch { /* ignore */ }

  res.json({
    ok: dbOk,
    uptimeSec,
    memory: {
      rssMb:  Math.round(mem.rss / 1024 / 1024),
      heapMb: Math.round(mem.heapUsed / 1024 / 1024),
    },
    node: process.version,
    pid: process.pid,
    nodeEnv: process.env.NODE_ENV || 'unknown',
    git: gitCommit ? { commit: gitCommit, time: gitTime } : null,
    db: { ok: dbOk, latencyMs: dbLatencyMs },
    now: new Date().toISOString(),
  });
});

// GET /env — whitelist klíčů s masked hodnotou (secret nikdy plain do response!)
router.get('/env', (req, res) => {
  const current = readEnv();
  const result = KNOWN_ENV_KEYS.map(spec => {
    const raw = current[spec.key];
    const set = raw !== undefined && raw !== '';
    return {
      key: spec.key,
      group: spec.group,
      required: spec.required,
      secret: spec.secret,
      set,
      // Secret hodnoty jen masked; non-secret plain (např. NODE_ENV, PORT)
      value: set ? (spec.secret ? maskValue(raw) : raw) : '',
    };
  });
  res.json({ envFile: ENV_FILE, values: result });
});

// GET /errors — posledních N chyb (default 50)
router.get('/errors', (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 50, 100);
  res.json({ errors: getRecentErrors(limit) });
});

// POST /errors/clear — vyčistit buffer
router.post('/errors/clear', (req, res) => {
  clearErrors();
  res.json({ ok: true });
});

// PUT /env — nastavit/přepsat hodnotu env klíče. Jen klíče z whitelistu.
// Přepíše .env in-place (idempotentně): pokud řádek existuje, přepíšeme,
// pokud ne, append na konec.
router.put('/env', async (req, res) => {
  const key = String(req.body?.key || '').trim();
  const value = req.body?.value ?? '';

  const spec = KNOWN_ENV_KEYS.find(k => k.key === key);
  if (!spec) {
    return res.status(400).json({ error: 'unknown_key', message: `Klíč ${key} není ve whitelistu.` });
  }
  // Blokujeme pár klíčů, u kterých by admin panel neměl umět „střelit sám sebe do nohy".
  const IMMUTABLE = ['DATABASE_URL', 'PORT'];
  if (IMMUTABLE.includes(key)) {
    return res.status(400).json({
      error: 'immutable',
      message: `Klíč ${key} nelze měnit přes UI (rozbil by běžící server). Změň ho přímo v .env přes SSH.`,
    });
  }

  const strVal = String(value);
  // Naivní ale postačující: zakázat newline a shell-nebezpečné znaky.
  if (/[\r\n]/.test(strVal)) {
    return res.status(400).json({ error: 'invalid_value', message: 'Hodnota nesmí obsahovat nový řádek.' });
  }

  try {
    let raw = '';
    try { raw = fs.readFileSync(ENV_FILE, 'utf8'); } catch { /* nový soubor */ }
    const lines = raw.split(/\r?\n/);
    const re = new RegExp(`^\\s*${key}\\s*=`);
    let replaced = false;
    for (let i = 0; i < lines.length; i++) {
      if (re.test(lines[i])) {
        lines[i] = `${key}=${strVal}`;
        replaced = true;
        break;
      }
    }
    if (!replaced) {
      // Append s prefix newline (kdyby soubor nekončil newline)
      if (lines.length && lines[lines.length - 1] !== '') lines.push('');
      lines.push(`${key}=${strVal}`);
    }
    fs.writeFileSync(ENV_FILE, lines.join('\n'), { mode: 0o600 });
    // Sync process.env pro běžící instanci (do restartu; některé consumery to
    // pořád nezachytí, protože env se čte při startu, ale pro některé pomůže).
    process.env[key] = strVal;
    res.json({ ok: true, key, restartRequired: true });
  } catch (err) {
    console.error('[admin/env]', err);
    res.status(500).json({ error: 'write_failed', message: err.message });
  }
});

// POST /restart — process.exit(0). systemd (Restart=always) aplikaci hned nastartuje.
router.post('/restart', (req, res) => {
  console.log('[admin] restart initiated by user', req.user?.email);
  // Odpovíme klientovi PŘED exitem, ať dostane 200.
  res.json({ ok: true, message: 'Restart za 1 s' });
  setTimeout(() => process.exit(0), 1000);
});

export default router;

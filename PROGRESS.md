# Progress

Živý přehled stavu projektu — co je hotové, co rozpracované, co dál.
Aktualizováno průběžně. Pro detailní historii viz [CHANGELOG.md](CHANGELOG.md).

_Poslední aktualizace: 2026-07-24_

## ⚠️ NUTNÁ AKCE: OPENAI_API_KEY pro přepis porad

Hlasová porada (přepis řeči) jede přes **OpenAI Whisper** — Anthropic
speech-to-text nemá. Aby tlačítko „🎙️ Porada" fungovalo, je potřeba
přidat `OPENAI_API_KEY` do ENV (přes Admin panel → 🖥 Server →
Environment + lokálně `server/.env`).
Bez něj endpoint vrátí 503 se srozumitelnou hláškou. Cena ~$0,006/min.

## Aktuální stav

Aplikace běží na `https://it.realitniekosystem.cz` (vlastní VPS + lokální
PostgreSQL 17, migrace z Neonu už proběhla). Auto-deploy: push do `main` →
GitHub webhook → deploy skript na VPS (git pull + build + systemctl restart).
Migrace schématu se spouští automaticky při startu serveru.

**Hotové oblasti:** multi-team, projekty/úkoly/podúkoly, review workflow,
AI agent (Claude) + reviewer, AI Coach, poznámky (bohatý editor s
checklisty/tabulkami/obrázky/kreslením, osobní/týmové/sdílené, AI asistent
+ AI nad poznámkou, hlasová porada s přepisem), scoreboard, dotazy,
time tracking, reporty, admin (týmy + uživatelé + 🖥 Server panel:
health / env editor / error log / restart), login (heslo + Google + dev).

## Provozní poznámky

- **Worker AI agenta** běží jako samostatný proces vedle web serveru.
  Lokálně: `cd server && npm run ai-worker`. Na VPS je to samostatný
  systemd unit `vitom-ai-worker.service` (viz [DEPLOY.md](DEPLOY.md)).
- **Env klíče** (whitelist v `admin-server.js` → `KNOWN_ENV_KEYS`):
  `DATABASE_URL`, `JWT_SECRET`, `CLIENT_URL`, `APP_BASE_URL`,
  `AI_AGENT_ENABLED`, `ANTHROPIC_API_KEY`, `GITHUB_TOKEN`,
  `GITHUB_WEBHOOK_SECRET`, `AI_AGENT_WORKDIR`, `MICROSOFT_*`,
  `TURNSTILE_*`, `VAPID_*`, `MCP_AUTH_TOKEN`, cost limity.
  Startup log serveru tiskne ✅/❌ pro každý AI klíč, nikdy hodnoty.
- **Deploy skript bezpečnost:** `/home/vitom/deploy.sh` je vlastněný
  uživatelem `vitom` (příležitostné utužení: přesunout do
  `/usr/local/sbin/vitom-deploy.sh` root-owned — viz DEPLOY.md TODO).
- ⚠️ **Bezpečnost:** v minulosti se v chatu/screenshotu objevily produkční
  `DATABASE_URL` a fragment API klíče. Doporučeno rotovat (nový DB
  password, nový Anthropic klíč) při příležitosti.

## Otevřené / rozpracované

- **Timeline linka 3 — dvojí počítání parent+subtask.** Při ověřování
  čísel se ukázalo, že jeden parent úkol má vlastní odhad i odhad na
  subtascích (153 h vše-not-done vs 152 h jen-leaf). Marginální (1 h),
  ale do budoucna: počítat odhady jen z leaf úkolů, ať se parent +
  subtask nesčítají dvakrát. ZATÍM NEOPRAVENO.
- **Admin Server F3 — DB counts + migrace status + deploy trigger v UI.**
  BE endpoint POST /api/admin/server/deploy (child_process spawn deploy.sh)
  a UI tlačítko. Task #100 pending. Doplňkově k webhooku pro
  „nasadit teď z UI".

## Co dál (backlog nápadů)

- Utužení deploy skriptu (přesun do `/usr/local/sbin`, root-owned).
- Export reportů (Excel/PDF).
- Notifikace e-mailem — dále rozvíjet obsah (nezapsané hodiny, deadlines).
- Mobilní layout doladit (drobnosti).

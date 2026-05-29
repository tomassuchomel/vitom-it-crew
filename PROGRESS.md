# Progress

Živý přehled stavu projektu — co je hotové, co rozpracované, co dál.
Aktualizováno průběžně. Pro detailní historii viz [CHANGELOG.md](CHANGELOG.md).

_Poslední aktualizace: 2026-05-29_

## ⚠️ NUTNÁ AKCE: OPENAI_API_KEY pro přepis porad

Hlasová porada (přepis řeči) jede přes **OpenAI Whisper** — Anthropic
speech-to-text nemá. Aby tlačítko „🎙️ Porada" fungovalo, je potřeba
přidat `OPENAI_API_KEY` do ENV (Render web service + lokální `server/.env`).
Bez něj endpoint vrátí 503 se srozumitelnou hláškou. Cena ~$0,006/min.

## Aktuální stav

Aplikace běží na `https://it.realitniekosystem.cz` (Render + Neon PostgreSQL).
Auto-deploy z větve `main`. Migrace běží automaticky při startu serveru.

**Hotové oblasti:** multi-team, projekty/úkoly/podúkoly, review workflow,
AI agent (Claude) + reviewer, AI Coach, poznámky (bohatý editor s
checklisty/tabulkami/obrázky/kreslením, osobní/týmové/sdílené, AI asistent
+ AI nad poznámkou, hlasová porada s přepisem), scoreboard, dotazy,
time tracking, reporty, admin (týmy + uživatelé), login (heslo + Google + dev).

## Provozní poznámky

- **Worker AI agenta** musí běžet jako samostatný proces. Lokálně:
  `cd server && npm run ai-worker`. Na Renderu zatím NENÍ (web service
  pouští jen `npm start`). Pro produkční běh agenta je potřeba Render
  Background Worker, nebo cron, nebo lokální worker proti Neon DB.
- **Render ENV** (web service): `DATABASE_URL`, `JWT_SECRET`, `CLIENT_URL`,
  `AI_AGENT_ENABLED`, `ANTHROPIC_API_KEY`, `GITHUB_TOKEN`, `AI_AGENT_WORKDIR`,
  cost limity. Startup log serveru tiskne ✅/❌ pro každý AI klíč.
- ⚠️ **Bezpečnost:** v minulosti se v chatu/screenshotu objevily produkční
  `DATABASE_URL` a fragment API klíče. Doporučeno rotovat (Neon reset
  password, nový Anthropic klíč) při příležitosti.

## Otevřené / rozpracované

- **Timeline linka 3 — dvojí počítání parent+subtask.** Při ověřování
  čísel se ukázalo, že jeden parent úkol má vlastní odhad i odhad na
  subtascích (153 h vše-not-done vs 152 h jen-leaf). Marginální (1 h),
  ale do budoucna: počítat odhady jen z leaf úkolů, ať se parent +
  subtask nesčítají dvakrát. ZATÍM NEOPRAVENO.
- **AI → úkoly z poznámek (Fáze 2).** AI asistent zatím jen čte a
  odpovídá. Další krok: z poznámky navrhnout strukturované úkoly (projekt,
  přiřazení, termín, priorita) → odsouhlasení → založení.

## Co dál (backlog nápadů)

- Render Background Worker pro AI agenta (24/7 běh).
- Export reportů (Excel/PDF).
- Notifikace e-mailem (nezapsané hodiny, vrácený úkol, …).
- Mobilní layout.

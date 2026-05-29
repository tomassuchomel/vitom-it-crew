# VITOM IT Crew

Interní webová aplikace pro správu projektů, úkolů, času, poznámek a AI
asistence napříč více týmy firmy VITOM. Nasazená na `https://it.realitniekosystem.cz`.

> Související dokumenty: [CHANGELOG.md](CHANGELOG.md) (historie změn),
> [PROGRESS.md](PROGRESS.md) (aktuální stav + co dál), [DEPLOY.md](DEPLOY.md)
> (nasazení), [ZADANI.md](ZADANI.md) (původní specifikace),
> [CLAUDE.md](CLAUDE.md) (pravidla pro práci s kódem).

## Co aplikace umí

- **Více týmů** – jedna instalace slouží více týmům (IT, Management, …).
  Přepínač týmů v sidebaru; každý projekt patří jednomu týmu. Uživatel může
  být ve více týmech s různou rolí. Per-team feature flags zapínají/vypínají
  funkce (AI agent, review, scoreboard, timeline forecast).
- **Timeline** – Gantt časová osa projektů s čárou „dnes", linkou odhadu
  (celkem) a forecast linkou (zbývá od dnes → overcommit detekce, jen IT).
  Sekce „kdo na čem pracuje".
- **Projekty** – deadliny, rozpočet, GitHub repo (pro AI agenta), přepínače
  „bez časového ohraničení" a „skrýt v Timeline".
- **Úkoly + podúkoly** – přiřazení, priorita, odhad, AI odhad času,
  acceptance criteria, scope paths.
- **Review workflow** – programátor předá k review → manager schválí
  (`done`) nebo vrátí k opravě (`needs_fix`) s komentářem a fotem. Fronty
  „Review k dokončení" (manager) a „Vrácené k opravě" (autor).
- **AI agent (Claude)** – autonomní vykonání úkolu: naklonuje repo, píše
  kód v git worktree, otevře PR. Druhý agent (reviewer) verdiktem schválí
  nebo vrátí. Worker běží jako samostatný proces (`npm run ai-worker`).
- **AI Coach** – projektový poradce (tempo vs deadliny, rizika, přesnost
  odhadů per uživatel).
- **Poznámky** – hierarchický blok (množina/podmnožina, Apple Notes layout),
  bohatý editor (nadpisy, formátování, barvy, tabulky, checklisty, obrázky),
  osobní / týmové / sdílené, AI asistent nad poznámkami a daty týmu.
- **Scoreboard** (Management) – žebříček úspěšnosti plnění úkolů v termínu.
- **Dotazy** – otázky mezi členy týmu k úkolům, inline detail úkolu.
- **Time tracking** – denní zápis hodin, reporty (hodiny/náklady po
  projektech / osobách / dnech / týdnech / měsících).
- **Tým / Admin** – správa uživatelů, týmů a členství. Avatary, hesla.
- **Login** – heslo (bcrypt) + Google OAuth (volitelný) + dev login.

## Stack

- **Backend**: Node.js 22+ (ESM), Express 4, PostgreSQL (`pg`), JWT,
  Passport (Google OAuth), `@anthropic-ai/sdk`
- **Frontend**: React 18, Vite 5, React Router 6, Axios, Recharts, Tailwind 3
- **DB**: PostgreSQL (Neon v produkci). Migrace: inline schéma v `db.js` +
  idempotentní SQL soubory v `server/src/migrations/`
- **AI**: Claude přes Anthropic API (estimace, Coach, asistent, agent)

## Rychlý start (lokálně)

Potřebuješ **Node.js 22+** a přístup k PostgreSQL databázi (lokální nebo Neon).

```bash
# 1) Instalace
npm run install:all

# 2) Nastav server/.env (zkopíruj z .env.example) – minimálně:
#    DATABASE_URL=postgresql://user:pass@host/db?sslmode=require
#    JWT_SECRET=nahodny-retezec
#    (volitelně ANTHROPIC_API_KEY, GITHUB_TOKEN, GOOGLE_CLIENT_ID/SECRET)

# 3) Spuštění (migrace + seed proběhnou automaticky při startu)
npm run dev
```

Frontend: http://localhost:5173 · Backend: http://localhost:4000

### AI agent worker (volitelné)

AI agent (Claude vykonává úkoly) běží jako **samostatný proces** vedle webu:

```bash
cd server && npm run ai-worker
```

Vyžaduje v `.env`: `AI_AGENT_ENABLED=true`, `ANTHROPIC_API_KEY`,
`GITHUB_TOKEN`, `AI_AGENT_WORKDIR`. Viz [PROGRESS.md](PROGRESS.md).

## Role a oprávnění

Globální role (`users.role`): **Admin / Project Manager / Senior Dev /
External Dev**. Navíc každý uživatel má **týmovou roli** v každém týmu, kde
je členem (např. v Managementu: ředitel / manager).

| Akce | Admin | PM | Senior | External |
|---|:-:|:-:|:-:|:-:|
| Projekty (CRUD) | ✅ | ✅ | ❌ | ❌ |
| Úkoly (CRUD) | ✅ | ✅ | ✅ | ❌ |
| Stav vlastního úkolu | ✅ | ✅ | ✅ | ✅ |
| Schválit/vrátit review | ✅¹ | ✅¹ | ❌ | ❌ |
| Hodiny ostatních + náklady | ✅ | ✅ | ❌ | ❌ |
| Spravovat uživatele/týmy | ✅ | ❌ | ❌ | ❌ |

¹ Review smí jen vedoucí daného projektu nebo admin.

## Struktura projektu

```
vitom-it-crew/
├── server/                      # Express backend + PostgreSQL
│   └── src/
│       ├── index.js             # entrypoint, mount routes, migrace
│       ├── db.js                # pg pool, schéma, runFileMigrations
│       ├── ai.js                # Claude: Coach, estimace, asistent
│       ├── auth.js              # JWT + Google OAuth + team kontext
│       ├── migrations/          # idempotentní SQL (časově řazené)
│       ├── aiAgent/             # worker, reviewer, gitManager, githubApi…
│       └── routes/              # auth, users, teams, projects, tasks,
│                                # reviews, notes, time, reports, questions,
│                                # attachments, ai, aiAgent, scoreboard
└── client/                      # React frontend (Vite)
    └── src/
        ├── App.jsx              # routing
        ├── api.js               # axios klient (X-Team-Id interceptor)
        ├── auth.jsx, teams.jsx  # auth + team context
        ├── components/          # Layout, modaly, RichTextEditor, …
        └── pages/               # Timeline, Projects, MyTasks, Review,
                                  # NeedsFix, Notes, Scoreboard, Admin, …
```

## Užitečné příkazy

```bash
npm run dev            # web (server + client)
npm run build          # produkční build frontendu
cd server && npm test  # backend testy (node:test)
cd server && npm run ai-worker   # AI agent worker (samostatný proces)
```

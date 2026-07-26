# CLAUDE.md

Tradeoff: Tato pravidla preferují opatrnost před rychlostí. U triviálních úkolů použij selský rozum.

---

# Část A — O projektu

VITOM IT Crew: interní webová appka pro správu projektů, úkolů, času, poznámek a AI
asistence napříč více týmy. Produkce: `https://it.realitniekosystem.cz` (vlastní VPS
+ lokální PostgreSQL 17, auto-deploy z `main` přes GitHub webhook → systemd restart).

Doplňkové dokumenty: [README.md](README.md) (co appka umí + role), [PROGRESS.md](PROGRESS.md)
(aktuální stav + co dál), [CHANGELOG.md](CHANGELOG.md) (historie), [DEPLOY.md](DEPLOY.md)
(nasazení), [ZADANI.md](ZADANI.md) (původní specifikace).

## Stack

* **Backend**: Node.js 22+ (ESM, žádný TypeScript), Express 4, PostgreSQL přes `pg`,
  JWT v cookie, Passport (Google OAuth volitelný), `@anthropic-ai/sdk`.
* **Frontend**: React 18, Vite 5, React Router 6, Axios, Recharts, Tailwind 3.
* **AI**: Claude přes Anthropic API (estimace, Coach, asistent, autonomní agent + reviewer).
  Přepis řeči jede přes OpenAI Whisper (Anthropic speech-to-text nemá).

## Příkazy

```bash
npm run install:all          # instalace root + server + client
npm run dev                  # server (:4000) + client (:5173) přes concurrently
npm run dev:server           # jen backend (node --watch)
npm run dev:client           # jen frontend (Vite)
npm run build                # produkční build klienta
cd server && npm test        # backend testy (node:test)
cd server && npm run ai-worker   # AI agent worker (SAMOSTATNÝ proces vedle webu)
cd server && npm run seed    # seed ukázkových dat
```

Testy běží přes `node --test` (node:test). Testy umísťuj do `src/<oblast>/__tests__/*.test.js`
— shell glob v `npm test` (`src/**/__tests__`) se rozbaluje jako `src/*/__tests__`, takže
soubor přímo v `src/__tests__/` (bez mezilehlé složky) se NEspustí a tiše chybí v pokrytí.
DB/route logiku testuj přes `src/testing/testDb.js` (embedded-postgres).
Žádný ESLint ani Prettier v repu není; drž se stylu okolního kódu.

## Architektura

```
server/src/
├── index.js          # entrypoint: env → migrace → seed → mount routes → listen
├── env.js            # MUSÍ být první import (nastaví process.env před db/auth/ai)
├── db.js             # pg pool, query(text,params), migrate(), runFileMigrations()
├── auth.js           # requireAuth, requireRole, can.*, signToken, team kontext
├── ai.js             # Claude: Coach, estimace, asistent nad poznámkami
├── mailer.js         # M365 Graph — sendMail, getNotificationPrefs, build*Html
├── migrations/       # idempotentní SQL, prefix RRRR-MM-DD-*.sql
├── aiAgent/          # worker, reviewer, gitManager, githubApi, stateMachine, safety…
└── routes/           # auth, users, teams, projects, tasks, reviews, notes, time,
                      # reports, questions, attachments, ai, aiAgent, scoreboard,
                      # ideas, email, push, notifications

client/src/
├── App.jsx           # routing
├── api.js            # axios klient, X-Team-Id interceptor, doménové export objekty
├── auth.jsx          # auth context
├── teams.jsx         # TeamContext (current team, setCurrentTeam)
├── components/       # Layout, Modal, RichTextEditor, TaskDetailModal, dialogy…
└── pages/            # Timeline, ProjectsList, MyTasks, Review, NeedsFix, Notes,
                      # Scoreboard, Admin, Napadnik, Email, Reports…
```

## Konvence (dodržuj je)

* **ESM všude**, žádný CommonJS. Komentáře píšeme **česky**, věcně, u „proč", ne u „co".
* **SQL vždy parametrizované** (`$1, $2 …`), nikdy string-konkatenace uživatelských dat.
  Helper: `import { query } from '../db.js'` → `query('SELECT … WHERE id = $1', [id])`.
* **Každý route** = `express.Router()` + `requireAuth` (kromě veřejných endpointů,
  které jsou explicitně označené komentářem `// Public endpoint`).
* **Vstupy validuj defenzivně** i když je posílá vlastní FE — vzor viz `routes/ideas.js`
  (`trim`, kontrola enumů, `res.status(400).json({ error: 'validation', fields })`).
* **Chybové odpovědi**: `res.status(4xx).json({ error: 'kod', message?: '…' })`.
  Kódy jsou strojové (`not_found`, `forbidden`, `validation`), message je pro člověka.
* **Notifikace jsou fire-and-forget**: pošli odpověď klientovi (`res.json`), teprve pak
  spusť `.then(...).catch(err => console.warn('[mail/…]', err.message))`. Nikdy neblokuj
  request kvůli e-mailu.
* **Pořadí mountů v `index.js` je citlivé**: routy se statickou cestou (např.
  `/tasks/review-queue`, `/tasks/:id/enqueue`) musí být mountnuté PŘED `tasksRoutes`,
  jinak je pohltí `/:id`. Komentáře u mountů to vysvětlují — neměň pořadí bez důvodu.
* **`client/src/api.js`**: každá doména má svůj export objekt (`projects`, `tasks`,
  `ideas`…), endpointy vrací `r.data`. Nový endpoint přidej sem, ne axios volání ve stránce.

## Databáze & migrace

Dvě vrstvy, obě **idempotentní**, běží automaticky při startu serveru (`index.js` → `start()`):

1. **Inline schéma** v `db.js` → `migrate()`. Nové tabulky jako `CREATE TABLE IF NOT EXISTS`,
   změny sloupců jako guardované `ALTER TABLE` (DO blok, který kontroluje existenci sloupce).
2. **Souborové migrace** v `server/src/migrations/RRRR-MM-DD-nazev.sql`, běží přes
   `runFileMigrations()` PO inline schématu — takže smí jen rozšiřovat existující tabulky.
   Musí být idempotentní (`IF NOT EXISTS`, `ON CONFLICT`, guardy).

Nikdy needituj starou migraci, která už mohla proběhnout v produkci — přidej novou.
Preferuj souborovou migraci pro nová pole; inline schéma drž pro core tabulky.

## Bezpečnost & multi-team

* **Multi-team izolace**: klient posílá `X-Team-Id` header (z localStorage), `requireAuth`
  ho ověří proti členství a naplní `req.team_id` + `req.team_role`. Dotazy nad týmovými
  daty **musí** filtrovat podle `req.team_id`, jinak hrozí únik mezi týmy.
* **Role**: globální `users.role` = `admin | manager | senior_dev | external_dev`; navíc
  týmová role v každém týmu. Autorizaci řeš přes `requireRole(...)` / `can.*` z `auth.js`,
  ne ad-hoc kontrolami. Review smí jen manager projektu nebo admin.
* **Secrets nikdy do gitu, logu ani chatu**: `DATABASE_URL`, `ANTHROPIC_API_KEY`,
  `JWT_SECRET`, `GITHUB_TOKEN`, M365 klíče. Startup log tiskne jen ✅/❌, nikdy hodnoty.
* AI agent běží v izolovaném git worktree; bezpečnostní guardy jsou v `aiAgent/safety.js`.
* **Přílohy**: čtení souboru (`GET /attachments/:id/file`) musí ověřit oprávnění na
  záznam (člen týmu projektu / assignee / manager / admin), ne jen `requireAuth` —
  jinak IDOR přes uhádnuté `id`. Cizí přílohu vrať jako `404`. User-uploady servíruj
  s `Content-Disposition: attachment` + `X-Content-Type-Options: nosniff`;
  `image/svg+xml` neber jako bezpečný obrázek (inline render = stored XSS).

---

# Část B — Jak pracovat s kódem

## 1. Nejdřív přemýšlej, pak piš kód
Nepředpokládej. Neskrývej zmatek. Pojmenuj tradeoffy.

Před implementací:

* Své předpoklady řekni nahlas. Pokud si nejsi jistý, zeptej se.
* Pokud existuje víc možných výkladů, ukaž je — nevybírej potichu.
* Pokud existuje jednodušší cesta, řekni to. Když to dává smysl, oponuj.
* Pokud je něco nejasné, zastav se. Pojmenuj, co tě mate. Zeptej se.

## 2. Nejdřív jednoduchost
Minimum kódu, který řeší daný problém. Nic spekulativního.

* Žádné featury navíc, které nebyly zadány.
* Žádné abstrakce pro kód použitý jen jednou.
* Žádná „flexibilita" nebo „konfigurovatelnost", o kterou nikdo nepožádal.
* Žádné ošetření chyb pro scénáře, které nemůžou nastat.
* Pokud jsi napsal 200 řádek a šlo to na 50, přepiš to.

Zeptej se sám sebe: „Řekl by senior engineer, že je to zbytečně složité?" Pokud ano, zjednoduš.

## 3. Zásahy, opravy a updaty
Sahej jen na to, na co musíš. Uklízej jen po sobě.

Když upravuješ existující kód:

* „Nevylepšuj" sousední kód, komentáře ani formátování.
* Nerefaktoruj věci, které nejsou rozbité.
* Drž se stávajícího stylu, i kdybys to dělal jinak.
* Pokud si všimneš nesouvisejícího mrtvého kódu, zmiň ho — nemaž ho.

Když tvé změny vytvoří „osiřelý" kód:

* Smaž importy / proměnné / funkce, které tvé změny udělaly nepoužívanými.
* Nemaž mrtvý kód, který tu byl už předtím, pokud o to nikdo nepožádá.

Test: Každý změněný řádek by měl jít přímo dohledat k požadavku uživatele.

## 4. Exekuce podle cíle
Definuj kritéria úspěchu. Cyklicky ověřuj, dokud nesedí.

Z úkolů udělej ověřitelné cíle:

* „Přidej validaci" → „Napiš testy pro neplatné vstupy a pak je doveď k zelené."
* „Oprav ten bug" → „Napiš test, který bug reprodukuje, a pak ho doveď k zelené."
* „Zrefaktoruj X" → „Zkontroluj, že testy projdou před i po."

U vícekrokových úkolů sepiš krátký plán:

```
1. [Krok] → ověření: [kontrola]
2. [Krok] → ověření: [kontrola]
3. [Krok] → ověření: [kontrola]
```

Silná kritéria úspěchu ti umožní pracovat samostatně v cyklu. Slabá kritéria („udělej to, ať to funguje") vyžadují neustálé doptávání.

---

Tato pravidla fungují, když: v diffech je méně zbytečných změn, méně přepisování kvůli překomplikování, a doptávání přichází před implementací, ne až po chybách.

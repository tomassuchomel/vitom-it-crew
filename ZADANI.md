# Zadání: VITOM IT Crew

Interní webová aplikace pro správu projektů, úkolů, času, nákladů, dotazů a AI poradenství malého vývojářského týmu firmy **VITOM realitní ekosystém**. Tento dokument je úplnou specifikací – z něj musí být možné aplikaci postavit od nuly.

---

## 1. Cíl a kontext

Firma VITOM (realitní ekosystém, www.garantovanynajem.cz) provozuje interní vývojářský tým o **4 lidech**. Tým pracuje moderním stylem s pomocí AI nástrojů (Claude, Cursor) – tzv. *vibe coding*. Pracuje současně na více projektech pro firemní i externí klienty.

Aplikace musí pokrýt:
- přehled aktivních projektů a deadlinů (časová osa)
- úkoly s přiřazením, prioritou, podúkoly, stavem, deadline a odhadem
- denní reportování odpracovaných hodin (zejména externími lidmi)
- výpočet nákladů a sledování rozpočtů projektů
- týmovou komunikaci formou dotazů k úkolům
- přílohy (foto/video) k úkolům
- AI poradce, který hodnotí tempo a doporučuje akce

Cíl aplikace = každý člen týmu otevře aplikaci a hned vidí: *kde jsme, na čem pracujeme, co je v ohrožení, co mám dnes dělat*.

---

## 2. Cílový uživatel a role

Aplikace má 4 role s odstupňovanými oprávněními:

| Role | Popis |
|------|-------|
| `admin` | Vlastník firmy (Tomáš Suchomel). Vidí a může vše. |
| `manager` | Project Manager. Plánuje, spravuje projekty, vidí náklady a hodiny celého týmu. |
| `senior_dev` | Hlavní programátor. Vytváří/edituje úkoly, vidí jen svoje hodiny a sazbu. |
| `external_dev` | Externí programátor. Pracuje na úkolech, denně reportuje hodiny, dotazy. |

### Matice oprávnění

| Akce | admin | manager | senior_dev | external_dev |
|------|:-:|:-:|:-:|:-:|
| Vytvořit / upravit / smazat projekt | ✅ | ✅ | ❌ | ❌ |
| Vytvořit / upravit úkoly a podúkoly | ✅ | ✅ | ✅ | ❌ |
| Měnit stav úkolu, který má přiřazený | ✅ | ✅ | ✅ | ✅ |
| Zapsat svoje odpracované hodiny | ✅ | ✅ | ✅ | ✅ |
| Vidět hodiny ostatních | ✅ | ✅ | ❌ | ❌ |
| Vidět náklady, sazby, rozpočty | ✅ | ✅ | ❌ | ❌ |
| Vidět AI Coach panel a stránku | ✅ | ✅ | ❌ | ❌ |
| Spravovat uživatele (CRUD, sazby) | ✅ | ❌ | ❌ | ❌ |
| Nahrát/smazat přílohu k úkolu | ✅ | ✅ | ✅ | ✅ (jen vlastní) |
| Vytvořit dotaz k úkolu | ✅ | ✅ | ✅ | ✅ |

---

## 3. Technický stack

### Bez kompromisu (mandatory)

- **Node.js v22.5+** (vestavěný `node:sqlite`, žádná native kompilace)
- **Backend**: Express 4, ESM moduly (`"type": "module"`), JWT v httpOnly cookie
- **Frontend**: React 18 + **Vite 5**, React Router 6, Axios, **Tailwind CSS 3**
- **DB**: vestavěný `node:sqlite` (DatabaseSync), žádný `better-sqlite3`
- **Soubor DB**: `server/data/teamflow.db` (gitignored)
- **Dev server**: `npm run dev` z root spouští backend (port 4000) i frontend (port 5173) přes `concurrently`. Vite proxy směruje `/api/*` a `/uploads/*` na backend.

### Knihovny

- `passport`, `passport-google-oauth20` – autentizace
- `jsonwebtoken` – JWT tokeny
- `cookie-parser`, `cors`
- `multer` – upload souborů
- `dotenv` – načtení `.env`
- `recharts` – grafy v reportech
- (žádný state-management lib jako Redux – vystačí React Context)

### Node 24 BigInt poznámka

`node:sqlite` může vracet `lastInsertRowid` jako **BigInt**. Vždy obal `Number(info.lastInsertRowid)` před uložením a před předáním do dalšího `.run()`/`.get()`.

---

## 4. Datový model (SQLite schéma)

```sql
CREATE TABLE users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  email         TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('admin','manager','senior_dev','external_dev')),
  hourly_rate   REAL NOT NULL DEFAULT 0,    -- Kč/hod
  google_id     TEXT UNIQUE,                -- po prvním Google loginu
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE projects (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL,
  description   TEXT,
  client        TEXT,
  start_date    TEXT NOT NULL,              -- YYYY-MM-DD
  due_date      TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'active'
                CHECK (status IN ('active','done','cancelled')),
  manager_id    INTEGER REFERENCES users(id),
  budget        REAL,                       -- volitelný strop nákladů
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE tasks (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id    INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  parent_id     INTEGER REFERENCES tasks(id) ON DELETE CASCADE,  -- podúkol
  title         TEXT NOT NULL,
  description   TEXT,
  assignee_id   INTEGER REFERENCES users(id),
  status        TEXT NOT NULL DEFAULT 'todo'
                CHECK (status IN ('todo','in_progress','review','done')),
  priority      TEXT NOT NULL DEFAULT 'normal'
                CHECK (priority IN ('low','normal','high','urgent')),
  estimated_h   REAL,
  due_date      TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE time_entries (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER NOT NULL REFERENCES users(id),
  project_id    INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  task_id       INTEGER REFERENCES tasks(id) ON DELETE SET NULL,
  date          TEXT NOT NULL,              -- YYYY-MM-DD
  hours         REAL NOT NULL CHECK (hours > 0 AND hours <= 24),
  description   TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE questions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id       INTEGER REFERENCES tasks(id) ON DELETE CASCADE,
  project_id    INTEGER REFERENCES projects(id) ON DELETE CASCADE,
  from_user_id  INTEGER NOT NULL REFERENCES users(id),
  to_user_id    INTEGER NOT NULL REFERENCES users(id),
  question      TEXT NOT NULL,
  answer        TEXT,
  status        TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending','answered')),
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  answered_at   TEXT
);

CREATE TABLE attachments (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id       INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  uploader_id   INTEGER NOT NULL REFERENCES users(id),
  filename      TEXT NOT NULL,              -- UUID + ext, na disku
  original_name TEXT NOT NULL,              -- pro zobrazení
  mime_type     TEXT NOT NULL,
  size          INTEGER NOT NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('image','video','other')),
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Indexy
CREATE INDEX idx_tasks_project ON tasks(project_id);
CREATE INDEX idx_tasks_parent  ON tasks(parent_id);
CREATE INDEX idx_te_user_date  ON time_entries(user_id, date);
CREATE INDEX idx_te_project    ON time_entries(project_id);
CREATE INDEX idx_q_to_status   ON questions(to_user_id, status);
CREATE INDEX idx_q_from        ON questions(from_user_id);
CREATE INDEX idx_q_task        ON questions(task_id);
CREATE INDEX idx_att_task      ON attachments(task_id);
```

Schéma se vytvoří v `db.js` přes `CREATE TABLE IF NOT EXISTS`. PRAGMA: `journal_mode = WAL`, `foreign_keys = ON`.

---

## 5. Autentizace

### Dva způsoby přihlášení

**a) Dev login** (rychlý start, vždy zapnutý)
- Endpoint `GET /api/auth/dev-users` vrátí seznam aktivních uživatelů
- Endpoint `POST /api/auth/dev-login` se `{ userId }` vystaví JWT v `tf_token` httpOnly cookie

**b) Google OAuth** (volitelné, přes Passport)
- Aktivní pokud jsou v `.env` proměnné `GOOGLE_CLIENT_ID` a `GOOGLE_CLIENT_SECRET`
- Endpoint `GET /api/auth/google` zahájí flow, `/api/auth/google/callback` ho dokončí
- Uživatel se musí v DB nacházet se shodným emailem; po prvním loginu se uloží `google_id`

### Kontrolní endpointy

- `GET /api/auth/config` → `{ googleEnabled: bool }`
- `GET /api/auth/me` → vrátí přihlášeného uživatele
- `POST /api/auth/logout` → smaže cookie

JWT TTL: **14 dní**. Cookie: `httpOnly`, `sameSite: 'lax'`. V produkci `secure: true` (HTTPS).

---

## 6. Backend API – kompletní seznam endpointů

Všechny endpointy chráněné `requireAuth`, pokud není uvedeno jinak.

### Users `/api/users`
- `GET /` – seznam uživatelů (sazby vidí jen `seeCosts`)
- `POST /` – vytvořit (jen admin)
- `PUT /:id` – upravit (jen admin)

### Projects `/api/projects`
- `GET /` – seznam s agregacemi (počet úkolů, hodiny, náklady, manager)
- `GET /:id` – detail + úkoly (s počty dotazů a příloh per úkol)
- `POST /` – vytvořit (admin/manager)
- `PUT /:id` – upravit (admin/manager)
- `DELETE /:id` – smazat (admin/manager)

### Tasks `/api/tasks`
- `GET /mine?status=&userId=` – moje úkoly (s počty dotazů)
- `POST /` – vytvořit (admin/manager/senior_dev)
- `PUT /:id` – upravit (external_dev smí jen měnit `status` na svém úkolu)
- `DELETE /:id` – smazat (admin/manager/senior_dev)

### Time entries `/api/time`
- `GET /?userId=&projectId=&from=&to=` – záznamy (cizí jen admin/manager)
- `POST /` – vytvořit záznam za přihlášeného uživatele
- `PUT /:id` – upravit svůj záznam (admin/manager smí cizí)
- `DELETE /:id` – smazat svůj záznam

### Reports `/api/reports`
- `GET /summary?from=&to=&groupBy=user|project|day|week|month` – agregát hodin/nákladů
- `GET /projects-cost` – náklady na projekty + rozpočet (jen `seeCosts`)
- `GET /who-works-on-what` – aktivní úkoly seskupené po lidech
- `GET /who-completed-what?days=14` – nedávno hotové úkoly seskupené po lidech

### Questions `/api/questions`
- `GET /?box=mine|inbox|sent|all&status=pending|answered` – seznam (default `mine`)
- `GET /counts` – počty pro badge: `{ inboxPending, sentPending, inboxTotal, sentTotal, mineTotal }`
- `POST /` – vytvořit dotaz `{ task_id, to_user_id, question }`
- `POST /:id/answer` – odpovědět `{ answer }` (jen příjemce)
- `POST /:id/reopen` – znovu otevřít
- `DELETE /:id` – smazat (jen autor / admin)

### Attachments `/api/attachments`
- `GET /by-task/:taskId` – seznam příloh úkolu
- `POST /by-task/:taskId` – upload (multipart, pole `files`, max 10 souborů)
- `DELETE /:id` – smazat (vlastník nebo admin/manager)
- Limit: **25 MB / soubor**, MIME: `image/*` nebo `video/*`
- Soubory uloženy v `server/data/uploads/`, název = UUID + extenze
- Statické servírování: `GET /uploads/<filename>` (Express static)

### AI Coach `/api/ai`
- `GET /status` – `{ enabled: bool }` (zapnuto když je `ANTHROPIC_API_KEY`)
- `GET /advice` – analýza (jen admin/manager) → JSON `{ status, headline, summary, projects[], recommendations[] }`
- `POST /chat` – `{ messages: [{role, content}, ...] }` → `{ reply: string }`

---

## 7. Frontend – stránky a UX

Aplikace má **levý sidebar** (jednou) a hlavní obsah. Sidebar obsahuje brand (logo + "VITOM / IT Crew"), navigační položky a v zápatí jméno přihlášeného uživatele s tlačítkem Odhlásit. Vždy v pravém spodním rohu je **floating AI Coach panel** (jen admin/manager).

### 7.1 Login `/login`

- Vystředěná karta na krémovém pozadí
- VITOM logo (spirála) + "VITOM" + "IT CREW" + decorative linka v Cerise + claim "Pěstujeme nový svět nemovitostí"
- Pokud je zapnuto Google OAuth → tlačítko "Přihlásit se přes Google"
- Sekce "Dev login" – seznam aktivních uživatelů jako tlačítka (název + role)
- Při chybě backendu zobrazí diagnostický blok s návodem

### 7.2 Timeline `/` (Dashboard)

**Horní část: Gantt-style časová osa**
- Sloupec vlevo: název projektu, klient, **odpočet do deadlinu** (zbývá X d Y h / po termínu o X d Y h, barevně: zelená > 7 dní, oranžová ≤ 7, červená ≤ 3 nebo overdue)
- Vpravo časové pruhy projektů s progress overlayem (kolik z času uplynulo)
- **Vertikální červená čára "Dnes"** přes celou tabulku
- Měsíční značky v hlavičce
- Klik na projekt = navigace do detailu

**Spodní část: Kdo na čem pracuje**
- Karty per člen týmu s aktivními úkoly (in_progress / review / todo)
- Avatar (iniciály), role badge, max 5 úkolů s odkazem do projektu

**Pod tím: Kdo má co hotovo**
- Stejné karty, ale dokončené úkoly za posledních 14 dní (s emerald rámečkem, line-through na názvech)

### 7.3 Projekty `/projects`

Mřížka karet projektů. Každá karta:
- Název, klient, status badge
- Termín, počet hotových/celkem úkolů, odpracované hodiny
- (jen pro admin/manager) **náklady doteď**
- Progress bar dle podílu hotových úkolů
- Tlačítko "+ Nový projekt" (jen admin/manager) → modální okno

### 7.4 Detail projektu `/projects/:id`

**Hlavní sloupec (2/3):**
- Sekce "Úkoly" se seznamem úkolů včetně podúkolů (zanořené)
- Každý řádek úkolu obsahuje:
  - Checkbox pro rychlé "hotovo"
  - Název s line-through pokud done
  - Status badge (Čeká/V práci/Review/Hotovo)
  - Priorita (🔥 urgent, ⬆ vysoká, ⬇ nízká)
  - **Indikátor dotazů** – `💬 X čeká na odpověď` (oranžový) nebo `💬 X zodpovězeno` (zelený)
  - Meta: 👤 assignee, 📅 termín, ⏱ odhad, 📎 počet příloh
  - **Inline náhled příloh** (thumbnaily, lightbox po kliknutí)
  - Akční tlačítka:
    - **▶ Začít pracovat** (todo→in_progress)
    - **✓ Hotovo** (→done)
    - **↩ Vrátit** (done→todo)
    - **💬** (otevře modal "Přidat dotaz")
    - **+ pod** (přidat podúkol – jen admin/manager/senior)
    - **✎** edit
    - **🗑** smazat

- Sekce "Popis projektu" (pokud není prázdný)

**Pravý sloupec (1/3):**
- Detaily: stav, manager, začátek, termín, rozpočet (pokud `seeCosts`)

**Modály:**
- Vytvoření/edit úkolu (název, popis, assignee, priorita, stav, termín, odhad)
- Po uložení existujícího úkolu se zobrazí **sekce Přílohy** (drag & drop upload)
- Modal "Přidat dotaz" – výběr příjemce (default = assignee), text, odeslat

### 7.5 Moje úkoly `/my-tasks`

- Přepínač **☰ Seznam / ▦ Pipeline** v hlavičce, volba se ukládá do localStorage
- **Seznam**: filtry stavů (Vše / Čeká / V práci / Review / Hotovo) + řádky úkolů s rychlými tlačítky (stejnými jako v Detailu projektu)
- **Pipeline**: 4 sloupce (Čeká, V práci, Review, Hotovo) s **drag & drop** kartami (HTML5 native)
  - Karta zobrazuje: prioritu (pokud != normal), název, projekt, termín, odhad, dotazy badge, akční tlačítka
- Indikátor dotazů: 💬 X pro mě (red), X čeká (amber), X ✓ (emerald)

### 7.6 Dotazy `/questions`

- Záložky **Vše moje** (default) / Příchozí / Odeslané / Všechny (jen admin/manager) – s počty
- Filtr stavu: Vše / Čekající / Zodpovězené
- URL parametry `?box=&status=` (sdílení odkazů funguje)
- Karta dotazu: směr (↗ Odeslal jsem / ↘ Pro mě), odesílatel → příjemce, datum, status (⏳ Čeká / ✅ Zodpovězeno), odkaz na úkol/projekt, text dotazu, text odpovědi (zeleně)
- Pokud jsem příjemce a dotaz je pending → tlačítko "Odpovědět" rozbalí textarea
- Akce vpravo dole: ↩ Znovu otevřít, 🗑 Smazat
- Prázdný stav má kontextovou nápovědu (např. ukáže link na "Odeslané" pokud tam něco je)
- V menu badge "počet pending na mě"

### 7.7 Hodiny `/time`

- **Formulář pro rychlý zápis** – datum (default dnes), projekt, hodiny (krok 0.25), popis
- 3 souhrnné karty: hodiny v období, náklady (jen seeCosts), počet záznamů
- Filtry: od/do, uživatel (jen admin/manager – jinak default = já)
- Tabulka záznamů: datum, osoba, projekt, popis, hodiny, cena (jen seeCosts), 🗑

### 7.8 Reporty `/reports` (jen admin/manager)

- Filtry: od/do, groupBy (Projekt / Osoba / Den / Týden / Měsíc), presety (7/30/90 dní)
- 3 souhrnné karty: hodiny celkem, náklady celkem, počet skupin
- **Hlavní graf**: Bar (pro project/user) nebo Line (pro day/week/month) přes Recharts
- **Pie graf** podílu skupin
- Tabulka detailů
- Sekce **Celkové náklady na projekty**: tabulka projekt | klient | hodiny | náklady | rozpočet | zbývá (zeleně/červeně)

### 7.9 AI Coach `/ai` (jen admin/manager)

- Levý sloupec: výsledek analýzy (status karta, projekty s odhady, doporučení)
- Pravý sloupec: chat s AI – preset suggestion buttons na první otázku
- Pokud `enabled === false`: ukáže návod jak nastavit `ANTHROPIC_API_KEY`

### 7.10 Tým `/team`

- Tabulka uživatelů: jméno, email, role badge, sazba (jen seeCosts), aktivní stav
- Tlačítko "+ Přidat člena" (jen admin)
- Modal pro vytvoření/edit – email (disabled při editu), jméno, role, hodinová sazba, aktivní

---

## 8. AI Coach – chování a prompty

### Floating panel (ve všech stránkách, pravý spodní roh)

Sbalený stav:
- Kruhové tlačítko Midnight Green s 🤖 a barevnou tečkou stavu
- Stav perzistentní v localStorage (`ai.open` = '0'/'1')

Rozbalený panel:
- Hlavička: VITOM AI Coach + tlačítka ↗ (otevře `/ai`) a × (zavřít)
- Status karta s barvou + headline + summary
- Seznam projektů (každý se svým status barvami)
- 3-5 doporučení s šipkami →
- Chat input dole

### System prompt

```
Jsi VITOM IT Crew Coach – AI projektový poradce malého vývojářského týmu (4 lidé).

KONTEXT TÝMU:
- Tým programuje moderním stylem s pomocí AI nástrojů (Claude, Cursor, Copilot)
  a "vibe coding" přístupem (rychlé iterace s AI).
- Díky AI nástrojům jsou mnoho kódovacích úkolů 2-5x rychlejší než klasické odhady.
  Jednoduché komponenty, CRUD endpointy, refaktoring, bugfixy = velmi rychlé.
  Komplexní integrace, architektonická rozhodnutí = i s AI normální tempo.
- Tým dělá také server práci (deploy, infra, monitoring, integrace) – to AI tolik
  neuspíší.
- Členové: Admin (řídí), Project Manager (plánuje, komunikuje s klienty),
  Senior programátor (architektura), Externí programátor (implementace,
  denně reportuje hodiny).

TVŮJ ÚKOL:
1. Posuď, zda tempo (hours_14d × tým) odpovídá zbývající práci a deadlinům.
2. U každého aktivního projektu odhadni reálnou pracnost zbývajících úkolů
   (s ohledem na AI urychlení) a porovnej s časem do deadlinu.
3. Identifikuj rizika (skluz, urgentní úkoly bez assignee, projekty bez aktivity).
4. Dej max 3-5 konkrétních akčních doporučení.
5. Jednej prakticky a stručně. Žádný corporate buzz. Mluv česky.

FORMÁT ODPOVĚDI – výhradně validní JSON (nic dalšího okolo):
{
  "status": "ok" | "warning" | "danger",
  "headline": "jednovětný stav (max 80 znaků)",
  "summary": "2-3 věty o celkovém stavu",
  "projects": [
    { "id": <id>, "name": "...", "status": "ok|warning|danger",
      "note": "1-2 věty proč",
      "estimated_remaining_h": <number>,
      "days_to_deadline": <number> }
  ],
  "recommendations": ["...", "..."]
}
```

### Kontext do user message

```js
buildContext() = {
  today: 'YYYY-MM-DD',
  projects: [{ ...projekt, tasks: [...] }],   // všechny aktivní s detailními úkoly
  velocity: [{ user_id, name, role, hours_14d, hourly_rate }]
}
```

Zásilá se jako JSON do user message s instrukcí "vrať JSON podle formátu".

### Chat endpoint

Stejný system prompt + DATA bloky (JSON), ale s instrukcí "odpovídej krátce a věcně, plain text".

### Model a parametry

- Model: `claude-sonnet-4-5` (z `ANTHROPIC_MODEL` env, default tento)
- `max_tokens: 2000` pro analýzu, `1200` pro chat
- API: `POST https://api.anthropic.com/v1/messages` přes nativní `fetch`
- Headers: `x-api-key`, `anthropic-version: 2023-06-01`, `content-type: application/json`

---

## 9. Brand & Design System

### Barvy (z oficiálního brand manuálu VITOM 2024)

Tři primární barvy + doplňková paleta:

| Token | Hex | Pantone | Použití |
|-------|-----|---------|---------|
| `brand-500` (Midnight Green) | `#0C363E` | 7477 C | sidebar, primární tlačítka, nadpisy |
| `cream-100` (Linen 60 %) | `#EEE9E4` | 7528 C | pozadí celé aplikace |
| `accent-500` (Cerise) | `#E72B78` | 213 C | akcent, CTA, badge "čeká na odpověď" |

Tailwind paleta (rozšiřuje `theme.extend.colors`):

```js
brand: {
  50: '#e8eef0', 100: '#c4d3d6', 200: '#9bb3b8', 300: '#6e8f96',
  400: '#1f4d56', 500: '#0c363e', 600: '#0a2c33', 700: '#082327',
  800: '#061b1f', 900: '#04181c'
},
accent: {
  50: '#fde6ef', 100: '#fac1d6', 200: '#f48bb1', 300: '#ee5a92',
  400: '#eb3f81', 500: '#e72b78', 600: '#cc1d65', 700: '#a51851',
  800: '#7e123e', 900: '#570c2b'
},
cream: {
  50: '#f9f6f1', 100: '#eee9e4', 200: '#e2dcd3', 300: '#d2c9bb', 400: '#bbb0a0'
},
ink: {
  300: '#bac6c9', 400: '#8a9b9f', 500: '#5b7177', 600: '#365156',
  700: '#1f3a40', 800: '#13292e', 900: '#0c1f23'
}
```

### Typografie

- **Source Sans 3** (Google Fonts), váhy 300/400/600/700
- Manuál uvádí jako primární *Rustica* (placené) – v kódu používáme SSP jako sekundární písmo z manuálu
- Body: 400 weight, nadpisy: 700, letter-spacing -0.01em na nadpisech

### Symbol / Logo

- Stylizovaná **logaritmická spirála (nautilus)** – odkaz na zlatý řez ze symboliky brandu
- Vlastní SVG komponenta `<VitomLogo size={N} />` (kruh s otevřenou spirálou). Nesmí kopírovat oficiální logo VITOM.

### UI Patterns

- Karty: `bg-white rounded-xl border border-cream-200 shadow-sm`
- Tlačítka primární: `bg-brand-500 text-white hover:bg-brand-600`
- Tlačítka sekundární: `border border-cream-300 text-ink-700 hover:bg-cream-50`
- Modální okna: středění, overlay `bg-black/30`, max-w-lg
- Status barvy: pending = amber, in_progress = blue, review = accent, done = emerald
- Důsledně používat krémové pozadí `bg-cream-100` pro celou plochu, bílé `bg-white` pro karty

---

## 10. Klíčové UX detaily (must have)

1. **Hot reload** v dev režimu (Vite + `node --watch`)
2. **Timeline odpočet** musí být vždy viditelný a barevně odlišený
3. **Pipeline drag & drop** native HTML5 (žádná knihovna), s vizuální zpětnou vazbou (cílový sloupec `border-brand-500`)
4. **Indikátor dotazů na úkolu** – uživatel musí ihned poznat, že se na něco ptal a zda už je odpovězeno
5. **AI panel** musí být viditelný, ale nesmí překážet (sbalený = ne větší než 140 px šířka)
6. **Lightbox** příloh navigovatelný klávesnicí (← → Esc)
7. **Responsivita** alespoň pro tablet (md breakpoint)
8. **Persist** voleb v localStorage: `myTasks.view`, `ai.open`
9. **Diagnostické hlášky** – pokud backend není dostupný, login musí jasně říct co dělat

---

## 11. Struktura projektu

```
todo-app/
├── package.json                # root, scripts: install:all, dev, seed, build
├── README.md
├── ZADANI.md                   # tento dokument
├── server/
│   ├── package.json
│   ├── .env.example
│   ├── data/                   # gitignored
│   │   ├── teamflow.db
│   │   └── uploads/
│   └── src/
│       ├── index.js            # Express entrypoint
│       ├── db.js               # SQLite + schéma
│       ├── seed.js             # ukázková data (4 uživatelé, 3 projekty, úkoly, hodiny)
│       ├── auth.js             # JWT, Passport, can() helpery
│       ├── ai.js               # Claude API integrace
│       └── routes/
│           ├── auth.js
│           ├── users.js
│           ├── projects.js
│           ├── tasks.js
│           ├── time.js
│           ├── reports.js
│           ├── questions.js
│           ├── attachments.js
│           └── ai.js
└── client/
    ├── package.json
    ├── index.html
    ├── vite.config.js          # proxy /api a /uploads na :4000
    ├── tailwind.config.js      # paleta z brand manuálu
    ├── postcss.config.js
    └── src/
        ├── main.jsx
        ├── App.jsx             # routing
        ├── index.css           # tailwind + body font/color
        ├── api.js              # axios klient
        ├── auth.jsx            # AuthProvider, can() helpery, ROLE_LABELS
        ├── components/
        │   ├── Layout.jsx      # sidebar + main + AIAdvisor
        │   ├── PageHeader.jsx
        │   ├── Modal.jsx
        │   ├── VitomLogo.jsx
        │   ├── AskQuestionModal.jsx
        │   ├── Attachments.jsx
        │   └── AIAdvisor.jsx   # floating panel
        └── pages/
            ├── Login.jsx
            ├── Timeline.jsx
            ├── ProjectsList.jsx
            ├── ProjectDetail.jsx
            ├── MyTasks.jsx     # List + Pipeline
            ├── Questions.jsx
            ├── TimeTracking.jsx
            ├── Reports.jsx
            ├── AIPage.jsx
            └── Team.jsx
```

---

## 12. Skripty a spuštění

Root `package.json`:
```json
{
  "scripts": {
    "install:all": "npm install && npm install --prefix server && npm install --prefix client",
    "dev":         "concurrently -k -n server,client -c blue,magenta \"npm run dev --prefix server\" \"npm run dev --prefix client\"",
    "seed":        "npm run seed --prefix server",
    "build":       "npm run build --prefix client"
  }
}
```

Server scripts:
```json
{ "dev": "node --watch src/index.js", "seed": "node src/seed.js", "start": "node src/index.js" }
```

Client scripts: standardní `vite` / `vite build` / `vite preview`.

### Workflow uživatele po prvním klonu

```bash
npm run install:all
npm run seed                # naplní 4 uživatele, 3 projekty, ~10 úkolů, ~10 time entries
# (volitelně) cp server/.env.example server/.env  + vyplnit klíče
npm run dev                 # frontend na :5173, backend na :4000
```

---

## 13. Seed data

Vytvoř 4 uživatele:
1. Admin (Tomáš Suchomel, `tomas.suchomel@vitom.cz`, sazba 1500 Kč/h)
2. Project Manager (sazba 1200)
3. Senior programátor (sazba 1300)
4. Externí programátor (sazba 700)

Vytvoř 3 projekty:
- E-shop pro klienta A – běžící (start −20d, due +25d, rozpočet 250 000 Kč)
- Interní CRM – běžící (start −10d, due +40d, rozpočet 180 000 Kč)
- Mobilní aplikace klient B – připravovaný (start +5d, due +90d, rozpočet 420 000 Kč)

Pro každý projekt 2-5 úkolů, u prvního projektu **alespoň 2 podúkoly** (parent_id), různé priority včetně urgent. Přiřaď napříč týmem.

10 ukázkových `time_entries` zpětně 1-7 dní, různí lidé, různé projekty.

---

## 14. Akceptační kritéria

Aplikace je hotová, když:

1. ✅ `npm run install:all && npm run seed && npm run dev` rozjede aplikaci bez ručních kroků (kromě `.env` pokud chce Google/AI)
2. ✅ Login funguje přes dev login i Google OAuth (s vyplněnými klíči)
3. ✅ Timeline ukazuje všechny aktivní projekty s odpočtem a vertikální čárou Dnes
4. ✅ Lze vytvořit projekt, úkol, podúkol, zapsat hodiny – napříč rolemi s respektováním oprávnění
5. ✅ Pipeline view v Mých úkolech podporuje drag & drop a okamžitý update stavu
6. ✅ Lze přidat dotaz k úkolu, příjemce vidí ⏳ na badge a může odpovědět
7. ✅ Lze nahrát foto/video k úkolu, zobrazí se inline thumbnail a v lightboxu
8. ✅ AI Coach panel je viditelný pro admin/manager, vrátí JSON s analýzou + funguje chat
9. ✅ Reporty správně počítají hodiny × sazbu = náklady, porovnají s rozpočtem
10. ✅ Aplikace používá přesně barvy z brand manuálu, Source Sans 3 z Google Fonts
11. ✅ Žádné varování v konzoli, žádné `npm warn deprecated` blokující instalaci
12. ✅ Uloženy volby uživatele (Pipeline/List, AI panel open) v localStorage

---

## 15. Co aplikace **nemusí** mít (mimo scope)

- Realtime updaty (WebSocket) – stačí refresh po akci
- Mobilní nativní app
- Multi-tenant (víc firem v jedné instanci)
- Komentáře a aktivita feed u úkolů
- Notifikace přes email
- Export reportů do Excelu/PDF (možno přidat později)
- Gantt drag & drop na časové ose (jen vizuální zobrazení)
- Time tracking pomocí timeru (start/stop)
- Detailní audit log
- 2FA, password authentikace (jen Google OAuth + dev login)

---

## 16. Bezpečnost a produkce (poznámky)

- Před nasazením: `JWT_SECRET` na náhodný řetězec, `secure: true` na cookies, HTTPS
- `ANTHROPIC_API_KEY` nikdy nedávat do gitu nebo do frontendu
- Limit uploadu 25 MB, MIME whitelist, soubory mimo web root
- CORS jen pro `CLIENT_URL`, `credentials: true`
- Heslo přihlašování není podporováno – jen Google OAuth (produkce) nebo dev login (vývoj)
- DB SQLite je single-file, snadná záloha = `cp server/data/teamflow.db ...`

---

## 17. Reference

- Brand manuál: `VRE-brandmanual-aktualizace2024.pdf` (firma VITOM, 2024)
- Web firmy: https://www.garantovanynajem.cz
- Anthropic API: https://docs.anthropic.com
- node:sqlite: https://nodejs.org/api/sqlite.html

---

*Konec zadání. Z tohoto dokumentu lze postavit aplikaci znova kompletně bez dalšího kontextu.*

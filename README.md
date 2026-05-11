# VITOM IT Crew

Interní webová aplikace pro správu projektů, úkolů, času a nákladů vývojářského týmu VITOM.

## Co aplikace umí

- **Timeline** – Gantt-style časová osa projektů s vertikální čárou „dnes" a sekcí „kdo na čem pracuje"
- **Projekty** s deadliny, klientem, rozpočtem
- **Úkoly + podúkoly** – přiřazení k osobě, priorita, stav (čeká / v práci / review / hotovo), odhad
- **Time tracking** – denní zápis hodin (datum, projekt, hodiny, popis)
- **Reporty** – hodiny a náklady (sazba × čas) seskupené po projektech / osobách / dnech / týdnech / měsících, grafy (bar / line / pie)
- **Tým** – správa lidí včetně hodinových sazeb (jen admin)
- **Role**: Admin / Project Manager / Senior Dev / External Dev (každý má jiná oprávnění)
- **Login**: Google OAuth (volitelný) + dev login (rychlý start)

---

## Co potřebuješ na svém počítači

1. **Node.js v22.5 nebo novější** – stáhni z https://nodejs.org (zvol „LTS" nebo „Current").
   Po instalaci ověř v terminálu: `node --version`
2. **Terminál** – na macOS „Terminal", ve Windows „PowerShell" nebo „Příkazový řádek"

Nic dalšího – databáze (SQLite) je vestavěná v Node.js, žádná native kompilace.

---

## Rychlý start (3 kroky)

Otevři terminál a přejdi do složky s projektem:

```bash
cd cesta/k/todo-app
```

### 1) Instalace závislostí (jednou)

```bash
npm run install:all
```

Stáhne všechny knihovny pro frontend i backend (může trvat 1–2 minuty).

### 2) Naplnění ukázkovými daty (jednou)

```bash
npm run seed
```

Vytvoří databázi `server/data/teamflow.db` a naplní:
- 4 ukázkové uživatele (admin = ty, manager, senior dev, external dev)
- 3 ukázkové projekty s úkoly a podúkoly
- Pár záznamů odpracovaných hodin

### 3) Spuštění aplikace

```bash
npm run dev
```

V terminálu uvidíš:
```
🚀 TeamFlow server running on http://localhost:4000
   Vite dev server running on http://localhost:5173
```

**Otevři v prohlížeči: http://localhost:5173**

> **Hot reload:** jakmile cokoli upravím nebo upravíš v kódu, prohlížeč se sám aktualizuje. Žádný refresh není potřeba.

---

## Login

### Dev login (rychle, bez konfigurace)
Na přihlašovací obrazovce klikni na jednoho z předpřipravených uživatelů. Hned tě to pustí dál a budeš vidět rozhraní.

### Google OAuth (produkční přihlášení)
1. Jdi na https://console.cloud.google.com/ → vytvoř projekt (libovolný název)
2. Navigace **APIs & Services → Credentials → Create Credentials → OAuth Client ID**
3. Pokud tě požádá o nastavení OAuth consent screen, vyber „External" a vyplň základní údaje
4. Application type: **Web application**
5. Authorized redirect URI: `http://localhost:4000/api/auth/google/callback`
6. Po vytvoření zkopíruj **Client ID** a **Client Secret**
7. Ve složce `server/` vytvoř soubor `.env` (zkopíruj `.env.example`) a vlož:
   ```
   GOOGLE_CLIENT_ID=tvuj-client-id
   GOOGLE_CLIENT_SECRET=tvuj-client-secret
   ```
8. Restartuj `npm run dev`

> Aby se uživatel mohl přihlásit přes Google, musí být **předem v DB** se stejným emailem. Přidej ho v sekci **Tým**.

---

## Role a oprávnění

| Akce | Admin | PM | Senior Dev | External Dev |
|---|:-:|:-:|:-:|:-:|
| Vytvořit / upravit / smazat projekt | ✅ | ✅ | ❌ | ❌ |
| Vytvořit / upravit úkoly | ✅ | ✅ | ✅ | ❌ |
| Změnit stav vlastního úkolu | ✅ | ✅ | ✅ | ✅ |
| Zapsat svoje hodiny | ✅ | ✅ | ✅ | ✅ |
| Vidět hodiny ostatních | ✅ | ✅ | ❌ | ❌ |
| Vidět náklady a sazby | ✅ | ✅ | ❌ | ❌ |
| Spravovat uživatele | ✅ | ❌ | ❌ | ❌ |

---

## Struktura projektu

```
todo-app/
├── package.json          # root – npm run dev pouští server i klient
├── README.md             # tento soubor
├── server/               # Express backend + SQLite
│   ├── src/
│   │   ├── index.js      # entrypoint serveru
│   │   ├── db.js         # SQLite + schéma
│   │   ├── seed.js       # ukázková data
│   │   ├── auth.js       # JWT + Google OAuth + middleware
│   │   └── routes/       # API endpointy
│   │       ├── auth.js
│   │       ├── users.js
│   │       ├── projects.js
│   │       ├── tasks.js
│   │       ├── time.js
│   │       └── reports.js
│   └── data/             # SQLite soubor (vytvoří se automaticky, gitignored)
└── client/               # React frontend (Vite)
    └── src/
        ├── main.jsx      # React entrypoint
        ├── App.jsx       # routing
        ├── api.js        # axios klient
        ├── auth.jsx      # auth context + can() helpery
        ├── components/   # Layout, Modal, PageHeader
        └── pages/        # Login, Timeline, ProjectsList, ProjectDetail,
                          # TimeTracking, Reports, Team
```

---

## Stack

- **Backend**: Node.js, Express 4, node:sqlite (vestavěný), Passport (Google OAuth), JWT
- **Frontend**: React 18, Vite 5, React Router 6, Axios, Recharts, Tailwind CSS 3
- **DB**: SQLite – vestavěný v Node.js 22.5+, nic se nekompiluje

---

## Užitečné příkazy

```bash
# zastavit dev server
Ctrl+C v terminálu

# znovu načíst seed (smaže a vytvoří ukázková data)
npm run seed

# postavit produkční verzi frontendu
npm run build

# jen backend
npm run dev:server

# jen frontend
npm run dev:client
```

## Troubleshooting

**Problém: Vite hlásí port 5173 obsazený**
Zavři ostatní instance nebo si v `client/vite.config.js` změň `port: 5173` na něco jiného.

**Problém: Po seed nevidím data**
Zkontroluj, že soubor `server/data/teamflow.db` existuje. Pokud ne, znovu spusť `npm run seed`.

**Problém: Chci úplně nasadit reset**
Smaž `server/data/teamflow.db` a spusť `npm run seed` znovu.

---

## Co dál (možné rozšíření)

- Notifikace přes email (např. když ext. dev nezapsal hodiny daný den)
- Export reportů do Excelu / PDF
- Komentáře a aktivita u úkolů
- Drag & drop přesun úkolů mezi sloupci (Kanban)
- Mobilní layout
- Multi-tenant podpora (více firem)

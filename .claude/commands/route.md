---
description: Vygeneruje kostru nového Express routu podle vzoru projektu a zaregistruje ho
argument-hint: <nazev-domeny> (např. reminders)
allowed-tools: Read, Edit, Write, Grep
---

Založ nový backend route modul pro doménu `$ARGUMENTS` ve VITOM IT Crew.

Nejdřív si přečti `server/src/routes/ideas.js` jako referenční vzor a
`server/src/index.js` kvůli mount pořadí. Pak:

1. Vytvoř `server/src/routes/$ARGUMENTS.js`:
   - `import express` → `const router = express.Router()` → `export default router`.
   - Endpointy mají `requireAuth` (veřejné explicitně komentářem `// Public endpoint`).
   - Dotazy parametrizované (`query('… WHERE id = $1', [id])`), týmová data filtrovaná
     podle `req.team_id`.
   - Vstupy validuj defenzivně, chyby jako `res.status(4xx).json({ error, message? })`.
   - Komentáře česky.
2. Zaregistruj router v `server/src/index.js` (import + `app.use('/api/$ARGUMENTS', …)`).
   POZOR na pořadí mountů: statické cesty musí být před `/:id` routami.
3. Přidej doménový objekt do `client/src/api.js` (vzor podle ostatních — vrací `r.data`).

Než začneš, řekni mi, jaké endpointy plánuješ (metoda + cesta + co dělá), a nech si to
odsouhlasit. Nedělej featury navíc — jen to, co zadám.

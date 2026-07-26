---
description: Založí nový idempotentní SQL migrační soubor podle konvence projektu
argument-hint: <nazev-migrace> (např. tasks-priority-index)
allowed-tools: Bash(date:*), Bash(ls:*), Read, Write
---

Založ novou souborovou migraci pro VITOM IT Crew.

Postup:
1. Zjisti dnešní datum: `date +%F`.
2. Vytvoř soubor `server/src/migrations/<YYYY-MM-DD>-$ARGUMENTS.sql`
   (pokud `$ARGUMENTS` chybí, zeptej se na název).
3. Napiš idempotentní SQL — dodrž konvence z CLAUDE.md a existující migrace:
   - `ALTER TABLE` zabal do guardu (DO blok kontrolující existenci sloupce)
     nebo použij `ADD COLUMN IF NOT EXISTS`.
   - `CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`.
   - Souborová migrace jen ROZŠIŘUJE existující tabulky (běží po inline schématu).
   - Musí přežít opakované spuštění (běží při každém startu serveru).
4. Než začneš psát SQL, řekni mi, co přesně migrace udělá, a nech si to odsouhlasit.
5. Připomeň, jestli je potřeba doplnit i inline schéma v `db.js` (u core tabulek).

Nikdy needituj existující migraci, která už mohla proběhnout v produkci.

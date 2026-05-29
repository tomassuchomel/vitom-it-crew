# Changelog

Chronologický přehled vývoje VITOM IT Crew. Rekonstruováno z git historie.
Novější nahoře.

## 2026-05-29
- **Timeline + AI Coach: konzistentní čísla hodin.** Linka „celkem" ukazuje
  total vč. hotových (`164 h · hotovo 11 h`), linka „zbývá od dnes" jen
  nedokončené (`153 h`). AI Coach donucen citovat přesné hodnoty z dat
  (dříve halucinoval 155 h).
- **AI asistent (Poznámky): minimalizace okna** do plovoucího proužku
  vpravo dole — konverzace přežije.

## 2026-05-28
- **Poznámky: bohatý editor** (H1–H3, tučné/kurzíva/podtržené, velikost,
  barva, odrážky, zaškrtávací seznam, tabulka, vložení obrázku) +
  **sdílení poznámek** s jednotlivými uživateli (read-only u příjemce).
- **AI: srozumitelná chyba při zkráceném API klíči** — detekce non-ASCII
  znaku (`…`) v `ANTHROPIC_API_KEY` místo kryptického ByteString erroru.
- **Poznámky: Apple Notes 3-sloupcový layout** (Hlavní | Podpoznámky |
  Editor) + `[+]` ikony v hlavičkách sloupců.
- **Poznámky: osobní vs týmové** (toggle 👥/🔒) + **AI asistent** nad
  poznámkami a daty týmu (chat — „co tým dělal, priority…").
- **Poznámky Fáze 1:** hierarchický blok (množina/podmnožina), CRUD, menu.

## 2026-05-27
- **Attachments persistence:** přílohy se ukládají jako BYTEA do DB místo
  ephemerálního Render disku (přežijí redeploy).

## 2026-05-26
- **Per-team role enum:** Management povoluje jen role ředitel/manager.
  Validace na backendu + dropdown na frontendu.
- **Team-scope všech endpointů:** reports, questions, time — už neukazují
  data napříč týmy.
- **Projekty:** přepínače „bez časového ohraničení OD–DO" a „nezobrazovat
  v Timeline".
- **Sekce „Vrácené k opravě"** pro autora úkolu (symetrie k Review fronте).

## 2026-05-25
- **Multi-team (Fáze 1):** tabulky `teams` + `team_members`, `projects.team_id`,
  team switcher, per-team feature flags. Bootstrap IT + Management týmu.
- **Admin sekce:** správa týmů a uživatelů (jediný zdroj pravdy).
- **Review workflow:** programátor → review → manager schválí/vrátí (s foto).
- **Questions inline detail** (klik na úkol otevře modal),
  **Scoreboard** (žebříček úspěšnosti v Managementu),
  **Timeline forecast linka** (overcommit detekce v IT).
- Server startup loguje stav AI agent configu (jen booleany).

## 2026-05-19 – 2026-05-21 (AI agent)
- **Datový model + UI** pro přiřazení úkolu Claudovi (acceptance criteria,
  scope paths, execution mode).
- **AI worker:** state machine, git worktree, fronta, skutečné volání
  Claude přes Anthropic SDK, push + draft PR.
- **AI reviewer agent** s verdict-driven re-run cyklem.
- **Bezpečnostní audit fixes:** bash hardening, sanitizace secrets, stuck
  task recovery, DB trigger na validaci přechodů.
- **Preflight + auto-enqueue + `repo_url`** + UI feedback „co brání spuštění".
- **AI Coach:** přesnost odhadů per uživatel, skutečný čas dokončení.

## 2026-05-14 – 2026-05-15
- Edit projektu + audit log, nová Timeline s časovou osou.
- AI odhad času úkolu (přepracované UX stavů).
- Heslo, profil s avatarem, „Moje úkoly" workspace, mazání entit.
- Volitelný termín projektu (auto-odvození z aktivního úkolu).

## 2026-05-11
- Initial commit. Auto-seed při prvním startu. Nasazení Render + Neon.

# Domain knowledge — VITOM IT Crew

Doménový slovník: entity, vztahy, business pravidla, workflow. Zdroj pravdy pro
plannera, implementera i reviewera vedle [CLAUDE.md](../CLAUDE.md) (stack +
konvence), [README.md](../README.md) (co appka umí) a [ZADANI.md](../ZADANI.md)
(původní specifikace).

_Živý dokument — když změna zavede nový pojem/pravidlo, doplň sem._

## Co appka je

Interní nástroj pro správu projektů, úkolů, času, poznámek a AI asistence napříč
**více týmy**. Jen tým IT reálně programuje; ostatní (Management, Design,
Marketing, Obchod…) jsou neIT. Cokoli obecného musí fungovat pro všechny týmy.

## Multi-team model (klíčové)

- **teams** — tým má `slug` (`it`, `management`, …) a `features` (JSONB feature
  flags: `ai_agent`, `review_workflow`, `success_metrics`, timeline forecast…).
- **team_members** — členství uživatele v týmu + **týmová role** (`team_role`:
  `reditel`, `manager`, `lead`, `dev`, `member`) — nezávislá na globální roli.
- **Projekt patří přesně jednomu týmu** (`projects.team_id`). Data se izolují
  podle týmu: klient posílá `X-Team-Id`, server naplní `req.team_id`.

## Role a oprávnění

- **Globální** (`users.role`): `admin`, `manager`, `senior_dev`, `external_dev`.
- **admin / ředitel** — vidí a spravuje vše napříč týmy.
- **manager** — vedoucí projektu; schvaluje review, vidí hodiny a náklady svého
  týmu. „Management" = reálné vedení firmy (řídí lidi a týmy), tým se `slug='management'`.
- Autorizace přes `requireRole(...)` / `can.*` z `auth.js`, vynucená na serveru.

## Entity

- **projects** — název, popis, `start_date`, volitelný `due_date`, `status`
  (`active`/`done`/`cancelled`), `manager_id`, `responsible_id`, `budget`,
  `team_id`, flagy `no_timeline` / skrytí v Timeline, volitelně GitHub repo.
- **tasks** — patří projektu, mohou mít `parent_id` (podúkoly). `status`:
  `todo` → `in_progress` → `review` → `done`, plus `needs_fix`. `priority`
  (`low`/`normal`/`high`/`urgent`), `estimated_h`, `ai_estimated_h`, `actual_h`,
  `due_date`, `completed_at`, `assignee_id`, `source_note_id`, `parent_hidden`.
- **time_entries** — denní zápis hodin (`hours` 0–24) na projekt/úkol.
- **questions** — dotazy mezi členy k úkolům (`pending` → `answered`, `answer_read`).
- **task_reviews** — historie review rozhodnutí (`verdict`: `approved`/`rejected`).
- **attachments** — přílohy úkolů (binárka v `data` BYTEA). Čtení souboru MUSÍ
  ověřit oprávnění na záznam (člen týmu projektu / assignee / manager / admin),
  ne jen `requireAuth`. Servíruj jako download (`Content-Disposition: attachment`
  + `nosniff`); `image/svg+xml` = potenciální stored XSS, nepovažuj za bezpečný.
- **notes** — hierarchické poznámky (osobní/týmové/sdílené), bohatý editor.
- **ideas** (Nápadník) — návrhy + analýza + events (viz workflow níže).
- **user_notification_prefs** — per-user předvolby e-mail/push notifikací + rozvrh.

## Workflow: Review úkolu

`in_progress` → **review** (programátor předá) → `done` (manager schválí) nebo
**needs_fix** (manager vrátí s komentářem/fotem) → zpět `in_progress`.
Review smí jen **manager daného projektu** nebo **admin**.

## Workflow: Nápadník (ideas)

Stavy: `zadano` → `ke_schvaleni` → `schvaleno_ceka_na_analyzu` →
`ke_schvaleni_analyzy` → `schvalena_analyza` → `rozpracovano` → `hotovo`
(vedlejší: `zamitnuto`, `odlozeno`). Přechody řídí **Management** (schvaluje) a
**garant** (připravuje). Ze schválené analýzy vzniká reálný projekt.
Veřejný formulář zakládá nápad bez přihlášení (`// Public endpoint`).

## AI v appce

- **Coach** (poradce), **estimace** času, **asistent** nad poznámkami.
- **Autonomní agent + reviewer** (`aiAgent/`) — vykoná úkol, píše kód v git
  worktree, otevře PR. **Jen tým IT** (feature flag). Worker běží samostatně.
- Přepis řeči přes OpenAI Whisper (Anthropic speech-to-text nemá).
- Proaktivní vrstva (rozpracováno): detektory v `server/src/proactive/`
  (skluz, deadline, bez pohybu, nezapsané hodiny, odhad vs realita) → viz
  [AI-ASISTENT.md](../AI-ASISTENT.md).

## Integrace

- **M365 Graph** (`mailer.js`) — odchozí e-maily, notifikace.
- **Web push** (`push.js`, `pushCron.js`) — připomínky (18:00 deadliny,
  08:00 denní souhrn) + per-user rozvrh.
- **Anthropic API** (AI), **OpenAI Whisper** (přepis), **GitHub** (AI agent).

## Slovník

- **Garant** — člověk zodpovědný za nápad v Nápadníku.
- **needs_fix** — úkol vrácený z review k opravě.
- **Timeline forecast** — odhad zbývající práce od dneška (overcommit detekce, IT).
- **Scoreboard / Skóre** — žebříček plnění úkolů v termínu (feature `success_metrics`).

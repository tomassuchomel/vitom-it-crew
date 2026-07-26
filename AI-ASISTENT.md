# AI asistent managementu — plán

Směr a architektura proaktivní AI vrstvy. Cíl: AI, která **radí, hlídá,
připomíná a sleduje efektivitu** napříč všemi týmy a projekty — ne jen IT.

_Poslední aktualizace: 2026-07-03_

## Cíl

Dnes je AI v appce **request-response**: Coach poradí, když ho otevřeš; asistent
odpoví, když se zeptáš. Vize je posun k **proaktivní** AI, která sama sleduje stav
a ozve se první: „tohle hoří", „tady je skluz", „nezapsané hodiny", „tenhle úkol
stojí 5 dní". Musí fungovat pro **libovolný tým, projekt a úkol** — programátorský
je jen IT tým, ostatní jsou neIT. Proto vrstva **nesmí** být navázaná na kód/GitHub.

## Klíčové rozhodnutí: cron vs. worker

Dvě běhová prostředí, nepleť si je:

* **`pushCron` uvnitř web service** (`startPushCron` v `index.js`, `setInterval` po 5 min).
  Už dnes běží v produkci a posílá push + AI denní souhrny. **Sem patří celá
  proaktivní management vrstva** — je team-agnostic a nepotřebuje nic navíc.
* **`ai-worker`** (`aiAgent/cli.js` → `runWorker`, samostatný proces). Fronta pro
  autonomní **kódovací** agent. **Zůstává IT-only.** Management vrstva ho nepotřebuje.

Závěr: pro proaktivní AsAsistenta **nestavíme nový worker**. Rozšíříme stávající cron.

### Reálný bloker: free plan na Renderu usíná

Free web service se po nečinnosti uspí → `setInterval` cron nepoběží spolehlivě.
To je skutečná překážka proaktivních notifikací, ne „chybějící worker". Možnosti
(od nejlevnější):

1. **Externí trigger** — Render Cron Job (nebo jiný scheduler) volá každých ~5 min
   chráněný endpoint `POST /api/cron/tick` (auth přes sdílený secret v hlavičce).
   Cron logiku přesuneme z `setInterval` do tohoto endpointu. Levné, spolehlivé.
2. Placený Render plán (web service neusíná) — cron zůstane jak je.
3. Keep-alive ping — křehké, nedoporučeno.

Doporučení: **varianta 1** — oddělí „kdy to tikne" (infra) od „co se stane" (kód)
a funguje i na free planu.

## Architektura proaktivní vrstvy

Tři oddělené fáze, každá testovatelná zvlášť:

```
1. DETEKTORY (rule-based, levné, deterministické)
   → SQL dotazy nad úkoly/projekty/hodinami vrátí "signály":
     skluz proti deadlinu, overcommit, úkol bez pohybu N dní,
     nezapsané hodiny, odhad vs. realita, blížící se termín.
   → Žádná AI, žádná cena, snadno otestovatelné.

2. AI INTERPRETACE (Claude, jen když jsou signály)
   → Dostane strukturované signály + kontext (projekt, tým, historie)
     a napíše lidský, prioritizovaný souhrn: co, proč to hoří, co s tím.
   → Grounding: rada MUSÍ odkazovat na konkrétní úkoly/čísla ze signálů,
     ne vymýšlet. Bez signálů = AI se nevolá (šetří cenu i halucinace).

3. DORUČENÍ (existující kanály)
   → push (push.js), e-mail (mailer.js, respektuj notification prefs),
     in-app feed. Per-user / per-team dle rolí.
```

Proč rozdělené: detektory jdou pokrýt testy bez AI; AI vrstvu lze měnit bez zásahu
do detekce; doručení už v appce existuje. Drží to CLAUDE.md pravidlo „nejdřív
jednoduchost".

## První featura: ranní management brief

Nejrychlejší způsob, jak vizi vidět v akci. Team-agnostic.

* **Kdy:** ráno (např. 07:30 Prague), přes cron tick.
* **Komu:** manager/ředitel každého týmu (dle rolí), scoped na jejich tým.
* **Co:** detektory seberou signály za daný tým → AI napíše 5–8 řádků:
  co se za noc pohnulo, co dnes hoří, kde je skluz, kde chybí data.
* **Kanál:** e-mail (respektuj prefs) + in-app.
* **Ověření:** seed testovací data se skluzem → brief je zmíní a odkáže na
  konkrétní úkoly; při čistém stavu se pošle „vše v pořádku" nebo nic.

Až brief funguje, stejné detektory pohání i průběžné upozornění během dne.

## Předpoklad: datová kvalita

AI je jen tak dobrá jako data. Když se nevyplňují hodiny a odhady, nemá z čeho
radit. Proto první „hlídač" hlídá i **vyplňování dat** (nezapsané hodiny, úkoly
bez odhadu). Bez toho jsou rady o efektivitě nespolehlivé.

## Zpětná vazba na AI

Aby se kvalita rad zlepšovala a lidi AI věřili: u každé proaktivní zprávy lehká
zpětná vazba (užitečné / ne, zohledněno / ne). Cost tracking agenta už existuje;
tohle měří užitečnost, ne cenu.

## Sekvence

```
1. Cron tick endpoint → ověření: externí trigger zavolá, joby proběhnou i na free planu.
2. Detektory + testy      → ověření: unit testy nad seed daty vrací správné signály.
3. Ranní brief (AI nad signály) → ověření: brief odkazuje na konkrétní úkoly, ne halucinuje.
4. Doručení + prefs       → ověření: dorazí správným lidem, respektuje notification prefs.
5. Datová kvalita jako signál → ověření: nezapsané hodiny / chybějící odhad se objeví v briefu.
6. Feedback loop          → ověření: zpětná vazba se uloží a jde reportovat.
```

## Co k tomu potřebuju od tebe

* **Test DB** — connection na Neon test branch nebo lokální Postgres, ať detektory
  i migrace reálně ověřím (souvisí s chybějícím test harnessem, viz CLAUDE.md).
* **Rozhodnutí o cronu** — externí trigger (varianta 1) vs. placený plán.
* **Definice roa­lí pro brief** — kdo přesně je „management" per tým (admin +
  týmová role? viz `isManagement` v `routes/ideas.js`, dnes vázané na slug='management').

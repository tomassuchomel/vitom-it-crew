# Task bundle — šablona

Jednotný formát jednoho implementačního tasku. Jeden task = jedna změna =
ideálně jeden PR. Planner podle téhle šablony vypisuje tasky, implementer podle
ní pracuje. Vyplň jen relevantní pole; co nedává smysl, vynech.

---

## Task: «krátký název v imperativu»

**Cíl / proč**
Jedna až dvě věty: co má být výsledek a proč ho chceme (z pohledu uživatele).

**Rozsah (konkrétně)**
- Co přesně udělat — obrazovky, endpointy, pole, akce. Buď konkrétní
  („tlačítko Smazat u každého řádku", ne „umožni mazání").

**Dotčené soubory / oblasti**
- `server/src/routes/…`, `client/src/pages/…`, `client/src/api.js`, migrace…
  (odhad, ne závazek — implementer si ověří.)

**Mantinely (co snadno opomenout)**
- Multi-team izolace: dotazy filtruj podle `req.team_id`.
- Auth/role: `requireAuth` + `requireRole`/`can.*`, ověř oprávnění na serveru.
- Secrets nikdy do kódu/logu.
- Migrace idempotentní + cold-boot (tvořící migrace před svými modifikátory).
- Notifikace fire-and-forget (odpověď klientovi první, e-mail/push potom).
- Peníze/hodiny: pozor na float zaokrouhlení.

**Kritéria hotovo (ověřitelná)**
- [ ] … (formuluj jako kontrolu, ne přání — viz CLAUDE.md pravidlo 4)
- [ ] Testy zelené (`cd server && npm test`), build klienta prochází.

**Testy (co pokrýt)**
- Happy path + okrajové případy (prázdno, cizí tým, chybějící oprávnění…).
  DB/route logika → přes `server/src/testing/testDb.js`.

**Mimo rozsah**
- Co záměrně NEdělat (ať se práce neroztéká).

**Závislosti**
- Musí být hotové dřív: task #… / nic.

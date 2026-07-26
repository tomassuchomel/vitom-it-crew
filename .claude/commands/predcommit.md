---
description: Kontrola před commitem — diff, testy, review
allowed-tools: Task, Bash(git status:*), Bash(git diff:*), Bash(cd server && npm test:*), Bash(npm test:*)
---

Proveď rychlou kontrolu před commitem:

1. `git status --short` a `git diff --stat` — ukaž mi, co se chystám commitnout.
2. Pokud se mění cokoli v `server/`, spusť `cd server && npm test` a nahlas výsledek.
3. Deleguj review rozpracovaných změn na subagenta `review` (Task tool).
4. Shrň: co se mění, jestli testy prošly, a verdikt review.
5. Pokud je vše ✅, navrhni výstižnou commit message (česky, jednořádkovou v duchu
   stávající git historie), ale NEcommituj — jen ji navrhni.

Neopravuj nic sám bez mého souhlasu.

---
description: Spustí review agenta na rozpracované změny (git diff)
allowed-tools: Task, Bash(git status:*), Bash(git diff:*)
---

Zkontroluj aktuální rozpracované změny v repu. Deleguj kompletní review na
subagenta `review` (Task tool, subagent_type: "review").

Pokud uživatel za příkazem něco dopsal, ber to jako zaměření review: $ARGUMENTS

Až agent vrátí verdikt, shrň mi ho stručně a u blokujících nálezů se zeptej,
jestli je mám rovnou opravit.

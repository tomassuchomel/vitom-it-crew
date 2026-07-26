# Nasazení VITOM IT Crew (vlastní VPS)

Produkce běží na vlastním VPS pod `https://it.realitniekosystem.cz`.
Aplikace je Node.js proces spravovaný systemd, staticky reverzně proxy-ovaný
přes nginx s Let's Encrypt certifikátem. Auto-deploy jede přes GitHub push
webhook, který na serveru spustí deploy skript.

> Konkrétní adresář, jméno DB uživatele a další VPS detaily doplní Tom
> (jsou popsány placeholdery `<…>`).

## Architektura provozu

```
GitHub main push
   │
   ▼
POST https://it.realitniekosystem.cz/api/deploy/github-webhook
   │  (HMAC-SHA256 přes GITHUB_WEBHOOK_SECRET)
   ▼
Node handler → spawn `sudo /home/vitom/deploy.sh`
   │
   ▼
deploy skript: git pull → npm install → client build → systemctl restart vitom
   │
   ▼
systemd (Restart=always) znovu nastartuje `vitom.service`
```

## Komponenty na VPS

| Komponenta | Kde je / jak jmenuje | Poznámka |
|---|---|---|
| OS | Debian 13 (trixie) | |
| Node runtime | Node 22 (LTS+) | `node --version` |
| App user | `vitom` | non-root, čte/píše jen do `/home/vitom/app` |
| App path | `/home/vitom/app` | git working tree |
| Systemd unit (web) | `vitom.service` | `npm start` → port 4000 |
| Systemd unit (AI worker) | `vitom-ai-worker.service` | `npm run ai-worker` (samostatný proces) |
| Nginx | `/etc/nginx/sites-available/vitom` | reverse proxy `:4000` → `443` |
| TLS | Let's Encrypt přes certbot | auto-renew via systemd timer |
| Deploy skript | `/home/vitom/deploy.sh` | ⚠ TODO: přesunout do `/usr/local/sbin/vitom-deploy.sh` (root-owned, viz Bezpečnost níže) |
| Databáze | PostgreSQL 17, běžící lokálně na tomto VPS | dřív Neon; datové schéma se aplikuje samo při startu (idempotentní migrace) |

## Start / stop / logy

```bash
# Stav
sudo systemctl status vitom vitom-ai-worker

# Restart (např. po ruční změně .env)
sudo systemctl restart vitom

# Logy
sudo journalctl -u vitom -f
sudo journalctl -u vitom-ai-worker -f
```

Aplikace jde restartovat i z Admin panelu (🖥 Server → 🔄 Restart aplikace) —
Node udělá `process.exit(0)` a systemd (`Restart=always`) proces hned nastartuje.

## Environment (`.env`)

Cesta: `/home/vitom/app/server/.env` (mode 0600, uživatel `vitom`).
`.env` je gitignored — deploy ho nepřepíše.

Klíče se dají číst i editovat z Admin panelu (🖥 Server → Environment):
- Whitelist v `server/src/routes/admin-server.js` (`KNOWN_ENV_KEYS`).
- `DATABASE_URL` a `PORT` jsou označené jako immutable v UI (jejich
  editace přes UI je zablokovaná).
- Změny přes UI se zapíšou přímo do `.env` a projeví se po restartu.
- Na VPS jsou přetrvávající — přežijí redeploy. (Na Renderu/Heroku by se
  ztratily s ephemerálním FS — proto varování v UI.)

Povinné klíče: `NODE_ENV=production`, `PORT=4000`, `DATABASE_URL`,
`DATABASE_SSL=false` (lokální DB nemá TLS), `JWT_SECRET`, `CLIENT_URL`,
`APP_BASE_URL`, `ANTHROPIC_API_KEY`.

Volitelné: `MICROSOFT_*` (M365 mail), `VAPID_*` (Web Push),
`TURNSTILE_*` (Cloudflare antispam), `MCP_AUTH_TOKEN` (MCP server),
`GITHUB_TOKEN` (AI agent), `GITHUB_WEBHOOK_SECRET` (auto-deploy webhook).

## Auto-deploy: GitHub webhook

### Nastavení (jednorázově)

1) **Sudoers rule** na VPS, aby node mohl spustit deploy skript bez hesla:
   ```bash
   echo 'vitom ALL=(root) NOPASSWD: /home/vitom/deploy.sh' \
     | sudo tee /etc/sudoers.d/vitom-deploy
   sudo chmod 440 /etc/sudoers.d/vitom-deploy
   ```

2) **Secret** (silný random hex):
   ```bash
   openssl rand -hex 32
   ```

3) **`GITHUB_WEBHOOK_SECRET`** v Admin panelu → 🖥 Server → Environment →
   „nastavit" → paste secret → Enter → 🔄 Restart aplikace.

4) **GitHub repo** → *Settings → Webhooks → Add webhook*:
   - Payload URL: `https://it.realitniekosystem.cz/api/deploy/github-webhook`
   - Content type: `application/json`
   - Secret: (stejný hex jako v Admin panelu)
   - Which events: **Just the push event**
   - Active: ✅

Po **Add webhook** GitHub pošle *ping* — v tabu *Recent Deliveries* má být
zeleně ✓ s response `{"ok":true,"pong":true}`.

### Jak to jede

- `POST /api/deploy/github-webhook` ověří HMAC-SHA256 přes
  `X-Hub-Signature-256`. Špatný podpis → 401, jen `console.warn` (ne do error bufferu — internetový šum od botů by ho jinak zaplavil).
- Bez `GITHUB_WEBHOOK_SECRET` → 503 (fail-closed).
- `event=ping` → `{ok, pong: true}`. Ostatní eventy se ignorují.
- Jen `ref=refs/heads/main` → `res.json({deploying:true, commit})` a **fire-and-forget** spawn `sudo /home/vitom/deploy.sh` (odpověď hned, deploy poté — jinak by nás `systemctl restart` odstřihl před 200).
- Souběžný request (dva rychlé pushe za sebou) druhý ignoruje.

### Bezpečnost deploy skriptu (TODO doporučení)

Skript teď leží v `/home/vitom/deploy.sh` — což znamená, že user `vitom` (pod kterým běží aplikace) může do skriptu **zapisovat**. Kdyby útočník získal RCE v Node procesu, může skript přepsat a přes existující sudoers rule spustit **cokoli jako root**.

Doporučené utužení:
1) Přesunout skript do `/usr/local/sbin/vitom-deploy.sh` s ownership `root:root` a modem `0755` (čitelný pro vitom, ne zapisovatelný).
2) Aktualizovat sudoers rule na novou cestu.
3) V handleru `server/src/routes/deploy.js` opravit spawn path.

Zatím to jede se známým rizikem — konsolidovat pak v samostatném commitu.

## Ruční nasazení (bez webhooku)

Pokud webhook selže nebo chceš deploy vynutit z terminálu:

```bash
# jako root nebo uživatel s právem spustit skript
sudo /home/vitom/deploy.sh
```

Skript dělá: `git pull origin main` → `npm run install:all` → `client && npm run build` → `systemctl restart vitom` → tichý restart AI workeru.

## Databáze

Lokální PostgreSQL 17 na tomto VPS. Připojení přes `DATABASE_URL` v `.env`.
Backup/restore doplní Tom (`<postup>`). Migrace se aplikují **automaticky při
startu** aplikace — inline schéma (`server/src/db.js`) + souborové migrace
(`server/src/migrations/*.sql`), obě idempotentní.

## DNS a TLS

- Doména `it.realitniekosystem.cz` má A záznam mířící na VPS.
- TLS: Let's Encrypt přes certbot; auto-renew přes systemd timer
  (`sudo systemctl status certbot.timer`).

## Historie: dřívější nasazení na Renderu

Aplikace původně běžela na Rentder Free tier + Neon PostgreSQL. Migrace
proběhla na vlastní VPS (viz commit history a CHANGELOG). Konfigurační
soubor `render.yaml.legacy` v repu je jen historický artefakt — aktivně
se nepoužívá.

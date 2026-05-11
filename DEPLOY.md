# Nasazení VITOM IT Crew na Render + Neon

Tento průvodce tě provede nasazením aplikace **bez terminálu** – jen klikáním v prohlížeči. Po dokončení poběží aplikace na `https://it.realitniekosystem.cz`.

**Časový odhad:** 20–30 minut.

---

## Co budeme dělat

1. **Neon** – založíme zdarma PostgreSQL databázi
2. **GitHub** – kód aplikace tam pushnu já (přes GitHub MCP)
3. **Render** – připojí se na GitHub a postaví aplikaci
4. **DNS** – nasměrujeme tvoji subdoménu na Render

---

## Krok 1: Neon (databáze) – 5 minut

1. Otevři **https://neon.tech**
2. Klikni **„Sign up"** → vyber **„Continue with Google"** → přihlas se tvým Google účtem
3. Po přihlášení tě Neon provede vytvořením prvního projektu:
   - **Project name:** `vitom-it-crew`
   - **Postgres version:** ponech default (16)
   - **Region:** **Europe (Frankfurt)** ← důležité, ať je rychlejší
   - Klikni **Create project**
4. Po vytvoření uvidíš obrazovku s **Connection string**. Vypadá takto:
   ```
   postgres://neondb_owner:abc123XYZ@ep-cool-mouse-12345.eu-central-1.aws.neon.tech/neondb?sslmode=require
   ```
5. **Zkopíruj si ho** (ikonka kopírování vedle stringu) – budeme ho potřebovat v Renderu

> **Free tier:** 0.5 GB storage, auto-suspend při neaktivitě (~5 minut), neomezeně dotazů. Pro malý tým zdarma stačí.

---

## Krok 2: GitHub repo (já udělám)

Až mě v chatu pustíš, **autorizuji se v GitHubu** (jednou klikneš „Authorize") a:
- vytvořím nový repo `vitom-it-crew`
- pushnu tam kompletní kód
- pošlu ti URL repa

Z tvé strany to bude jen **jedno tlačítko** v autorizačním dialogu.

---

## Krok 3: Render – 10 minut

1. Otevři **https://render.com**
2. Klikni **„Get Started"** → **„Sign up with GitHub"** → autorizuj (vidí jen veřejná data, deploy si zvlášť povolíme)
3. Po přihlášení v levém horním rohu klikni **„+ New"** → **„Web Service"**
4. Připoj repo:
   - Klikni **„Build and deploy from a Git repository"** → **„Next"**
   - Vyber repo **`vitom-it-crew`** (možná budeš muset kliknout „Configure account" a povolit Render přístup k tomu repu)
5. Vyplň formulář:
   - **Name:** `vitom-it-crew`
   - **Region:** **Frankfurt (EU Central)** ← stejně jako Neon
   - **Branch:** `main`
   - **Root Directory:** prázdné (necháme root repa)
   - **Runtime:** `Node`
   - **Build Command:** `npm run build:render`
   - **Start Command:** `npm run start:render`
   - **Instance Type:** **Free**
6. Sekci **„Environment Variables"** rozbal a přidej **DATABASE_URL**:
   - **Key:** `DATABASE_URL`
   - **Value:** *vlož ten connection string z Neonu*
7. (Volitelné) Pokud chceš AI Coach hned funkční, přidej i:
   - **Key:** `ANTHROPIC_API_KEY`
   - **Value:** *tvůj klíč z https://console.anthropic.com/settings/keys*
8. Klikni **„Create Web Service"** úplně dole
9. Render zahájí build. Sleduj log – **trvá 3–5 minut**. Měl bys vidět:
   ```
   ==> Build successful 🎉
   ==> Deploying...
   🚀 VITOM IT Crew server běží na portu 10000
   ==> Your service is live 🎉
   ```
10. **První spuštění naplň databázi**. V Render dashboardu klikni v levém menu **„Shell"** a do něj zadej:
    ```
    npm run seed:render
    ```
    Po pár sekundách uvidíš `✅ Seed hotový`. (To je jediný „terminálový" krok – jen jedno tlačítko a jeden command, **tohle stačí jednou.**)

V tuhle chvíli aplikace běží na `https://vitom-it-crew.onrender.com` (URL si zkopíruj z horního pravého rohu).

---

## Krok 4: DNS – nastavení `it.realitniekosystem.cz` – 5 minut

1. V Render dashboardu klikni vlevo na **„Settings"** → scrolluj na **„Custom Domains"** → **„Add Custom Domain"**
2. Zadej: **`it.realitniekosystem.cz`** → **„Save"**
3. Render zobrazí **DNS instrukce** – ukáže ti, jaký záznam přidat. Bude to buď:
   - **CNAME** záznam `it` → `vitom-it-crew.onrender.com`
   - nebo **A** záznam `it` → některá z Render IP

4. Otevři **admin panel registrátora**, kde máš `realitniekosystem.cz`. Najdi sekci **DNS** nebo **DNS záznamy** a klikni **Přidat záznam**:

   | Typ | Název | Hodnota | TTL |
   |---|---|---|---|
   | `CNAME` | `it` | `vitom-it-crew.onrender.com` | 3600 |

   Pole **Název** vyplň jen `it` (ne `it.realitniekosystem.cz` ani `it.`). Některé panely zobrazí celou doménu automaticky.

5. **Ulož**. Vrať se do Renderu a klikni **„Verify"**. Render musí potvrdit, že DNS sedí (může chvíli trvat).

6. Render automaticky vyřídí **HTTPS certifikát** přes Let's Encrypt do ~5 minut.

7. Po úspěšném ověření otevři **https://it.realitniekosystem.cz** – aplikace běží!

### Pokud registrátor nepovolí CNAME

Některé registrátory neumí CNAME pro subdomény, použij **A záznam**:
- Render ti ukáže IP adresy (obvykle 3–4)
- Přidej pro každou jeden záznam typu **A**, název `it`, hodnota = IP

---

## Krok 5: Workflow do budoucna – jak fungujeme dál

Od teď:
1. **Já v Cowork režimu napíšu/upravím kód** (jako doteď)
2. **Já udělám git commit + push na GitHub** (přes GitHub MCP)
3. **Render to automaticky detekuje**, postaví novou verzi (~2 minuty) a nasadí
4. **Ty refreshneš `it.realitniekosystem.cz`** v prohlížeči a vidíš změny

Ve své app sleduj **„Logs"** v Render dashboardu, kdyby něco padlo – tam uvidíš případné chyby.

---

## Důležité poznámky

### Cold start (free tier)
Render free tier **uspí aplikaci po 15 minutách neaktivity**. První otevření pak trvá ~30 sekund (probouzí se). Pro denní práci týmu je to zanedbatelné – po prvním načtení dne to už běží svižně.

**Řešení:** Pokud chceš permanentně běžící bez cold startů, upgrade na Render **Starter $7/měsíc**. Klik v Render dashboard → Settings → Instance Type.

### Persistent disk (free tier)
Free tier **nemá persistentní disk** – nahrané fotky/videa se při deployi smažou. Pro produkční přílohy budeme potřebovat:
- buď upgrade na Render Starter ($7) s diskem
- nebo přesun na S3/Cloudflare R2 (zdarma 10GB, velmi snadné)

Pro start to nevadí – databáze (projekty, úkoly, hodiny, dotazy) je na Neonu a ta je perzistentní.

### Aktualizace seedu
Pokud chceš znovu naplnit databázi ukázkovými daty (smaže existující!), v Render Shell zadej:
```
npm run seed:render
```

### Google OAuth
Pokud chceš zapnout Google login:
1. V https://console.cloud.google.com/ uprav OAuth credentials
2. Authorized redirect URI: `https://it.realitniekosystem.cz/api/auth/google/callback`
3. V Render env variables nastav `GOOGLE_CLIENT_ID` a `GOOGLE_CLIENT_SECRET`
4. Render se sám restartuje

---

## Když něco nefunguje

- **Build padá v Render Logs** → zkopíruj mi posledních 20 řádků logu, opravím
- **DNS se nepropaguje** → na https://dnschecker.org zadej `it.realitniekosystem.cz` a podívej se, zda už záznam vidí všechny servery (může trvat až 2 hodiny)
- **Aplikace běží, ale prázdná stránka** → v Console (F12 v Chrome) podívej se na chyby a pošli mi screenshot
- **Cokoliv jiného** → screenshot stránky + posledních 20 řádků z Render Logs → já to vyřeším

---

*Konec průvodce. Pojďme na to!*

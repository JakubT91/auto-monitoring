# 🚀 Auto monitoring — DEPLOY CHECKLIST

**Reálný čas: 5–7 minut**, pokud máš účty (GitHub, Supabase, Cloudflare, Resend) zřízené.

> 💡 **Před začátkem:** otevři si 4 záložky v prohlížeči — github.com, supabase.com/dashboard, dash.cloudflare.com, resend.com/api-keys

---

## ① SUPABASE (≈ 90 s)

1. **Nový projekt:** https://supabase.com/dashboard → **New Project**
   - Name: `auto-monitoring`
   - DB heslo: nech vygenerovat, ulož si ho
   - Region: `Frankfurt (eu-central-1)` (nejblíž)
   - Klikni **Create**

2. **SQL schéma:** Po vytvoření → levý panel **SQL Editor** → **New query** → otevři soubor `supabase/schema.sql`, **zkopíruj celý obsah, vlož a klikni Run** (vpravo nahoře).
   - Mělo by ukázat „Success. No rows returned."

3. **Zkopíruj si 3 hodnoty:** levý panel **Settings → API**
   - **URL** (např. `https://xxxxx.supabase.co`) → ulož
   - **anon public** klíč → ulož
   - **service_role** klíč (klikni „Reveal") → ulož **(POZOR — neukazovat veřejně, jen pro Worker)**

✅ **Hotovo: Supabase běží + máš 3 klíče v poznámkách.**

---

## ② RESEND (≈ 60 s)

1. https://resend.com → Sign Up nebo Login
2. **API Keys** → **Create API Key** → název `auto-monitoring`, scope: **Full access**
3. Zkopíruj klíč `re_xxx` → ulož

> 📨 Bez vlastní domény použij **`onboarding@resend.dev`** jako odesilatele (limit 100 mailů/den, na test bohatě stačí). Vlastní doménu si pak nastav přes Resend → Domains.

✅ **Hotovo: máš RESEND_API_KEY.**

---

## ③ GITHUB (≈ 60 s)

1. **Vytvoř prázdné repo:** https://github.com/new
   - Repository name: `auto-monitoring`
   - Privát/public — jak chceš
   - **NIC nezaškrtávej** (žádné README, .gitignore, license — máme připraveno)
   - Klikni **Create repository**

2. **Skopíruj URL** repa (třeba `https://github.com/USER/auto-monitoring.git`).

3. **V terminálu:**
   ```bash
   cd /cesta/k/deploy
   bash deploy.sh https://github.com/USER/auto-monitoring.git
   ```

   Script tě může jednou požádat o GitHub credentials (HTTPS) nebo PAT — to je normální.

✅ **Hotovo: kód je na GitHubu.**

---

## ④ CLOUDFLARE PAGES (≈ 90 s)

1. https://dash.cloudflare.com → **Workers & Pages** → **Create application** → **Pages** → **Connect to Git**

2. Autorizuj GitHub (jednou). Vyber `auto-monitoring`. Klikni **Begin setup**.

3. **Build settings:**
   - Framework preset: **Vite**
   - Build command: `npm run build`
   - Build output: `dist`
   - Root directory: nech prázdné

4. **Environment variables** (klikni **Add variable**, dvakrát):
   - `VITE_SUPABASE_URL` = (URL ze ① Supabase)
   - `VITE_SUPABASE_ANON_KEY` = (anon public klíč)

5. Klikni **Save and Deploy**. Build zabere ~1-2 min.

6. Až je zelený ✓ — **zkopíruj URL** (např. `https://auto-monitoring.pages.dev`).

✅ **Hotovo: aplikace běží na webu. Klikni na URL, registruj se a zkus uložit cestu.**

---

## ⑤ CLOUDFLARE WORKER (notifikace, ≈ 90 s)

1. **V terminálu:**
   ```bash
   cd worker
   bash deploy-worker.sh
   ```

2. Script tě interaktivně provede:
   - Login do Cloudflare (otevře browser, klikneš Allow)
   - Postupně se zeptá na 6 secrets — vlepuj a Enter:
     - `SUPABASE_URL` = (z ① Supabase)
     - `SUPABASE_SERVICE_ROLE_KEY` = (service_role z ① Supabase)
     - `RESEND_API_KEY` = (z ② Resend)
     - `FROM_EMAIL` = `Auto monitoring <onboarding@resend.dev>`
     - `APP_URL` = (URL ze ④ Cloudflare Pages)
     - `MANUAL_TRIGGER_KEY` = libovolný náhodný řetězec (např. `openssl rand -hex 16`)

3. Po deployi script vypíše URL Workeru. **Test ručního spuštění:**
   ```bash
   curl 'https://auto-monitoring-notifications.<TVUJ_ACCT>.workers.dev/run?key=<MANUAL_TRIGGER_KEY>'
   ```

✅ **Hotovo: cron běží každý den ráno (7:00 UTC = 8:00 zima / 9:00 léto CZ).**

---

# 🎉 KONEC

Aplikace je live na `https://auto-monitoring.pages.dev`.

Notifikace ti budou chodit na e-mail z Resend (zkontroluj spam) — pokud máš doklad blížící se k expiraci v rámci nastavených dnů (default: 30 a 7 dní).

## Troubleshooting

- **Pages build fail** → koukni do Cloudflare → **Pages → Deployments → Build log**. Nejčastěji chybí env var.
- **Magic link nedorazí** → Supabase → **Authentication → URL Configuration** → ujisti se, že máš **Site URL** = URL z Cloudflare Pages.
- **Worker neposílá maily** → otevři `/run?key=...` v prohlížeči, vrátí JSON; zkontroluj `wrangler tail` pro live logy.

## Co kde upravit, kdyby se ti něco nelíbilo

| Co | Kde |
|----|-----|
| Hodiny notifikací | `worker/wrangler.toml` → `crons = ["0 7 * * *"]` |
| Defaulty notifikací (dny předem) | `src/App.jsx` → konstanty `DEFAULT_NOTIFICATION_SETTINGS` |
| Vzhled emailu | `worker/src/notifier.js` → fce `buildHtmlEmail` |

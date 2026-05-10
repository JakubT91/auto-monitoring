# 🚗 Auto monitoring — deploy guide

Mobilní web aplikace pro:
- **Kalkulátor cest** (úseky + mezitankování, plná → plná, automatický výpočet spotřeby)
- **Přehled** (filtry, KPI dashboard, grafy, CSV export)
- **Vozidla** (STK, pojištění, dálniční známky)

Postaveno: **React 18 + Vite + Tailwind + Recharts + Supabase**.

---

## 📋 Co tě čeká

Tři kroky, dohromady cca **20–30 minut**:

1. ✅ [Supabase](#1-supabase-databáze--auth) — DB + autentizace
2. ✅ [GitHub](#2-github-zdrojový-kód) — repo s kódem
3. ✅ [Cloudflare Pages](#3-cloudflare-pages-publikace) — deploy + auto-deploy při každém push

**Volitelně** (~15 min):

4. 🔔 [Notifikační e-maily](#4-notifikace-na-stk--volitelné) — Cloudflare Worker pošle připomínku 30 a 7 dní před vypršením STK / pojištění / dálničky

---

## 1. Supabase (databáze + auth)

### 1.1 Vytvoření projektu
1. Jdi na [supabase.com](https://supabase.com) → **Start your project** → přihlas se GitHubem
2. **New project**:
   - **Name**: `cestak` (nebo jakkoliv)
   - **Database Password**: vygeneruj a ulož na bezpečné místo (do password manageru)
   - **Region**: `Frankfurt (eu-central-1)` (nejblíž ČR)
3. Klikni **Create** a počkej ~2 min, než se projekt vytvoří

### 1.2 Vytvoření tabulek
Po nastartování projektu jdi na **SQL Editor → New query**, vlož obsah souboru `supabase/schema.sql` (najdeš ho v repu) a stiskni **Run**.

Toto vytvoří jednu tabulku `user_data` (key/value úložiště) s **Row Level Security** — každý uživatel uvidí pouze svoje řádky.

### 1.3 Nastavení autentizace
**Authentication → Providers → Email**:
- **Enable** ✓
- Pro hladší testování si vypni `Confirm email` (Authentication → Settings → User signups), jinak musí každý nový uživatel kliknout potvrzovací link v e-mailu

### 1.4 Získání API klíčů
**Project Settings → API**:
- Zkopíruj `Project URL` (např. `https://xxxxx.supabase.co`)
- Zkopíruj `anon` / `public` klíč (`eyJh…`)

> ⚠️ **NEPOUŽÍVEJ** `service_role` klíč v klientovi! Ten umí všechno bez RLS — jen pro server side. Tady stačí `anon`, RLS politiky chrání data.

---

## 2. GitHub (zdrojový kód)

### 2.1 Vytvoř repo
[github.com/new](https://github.com/new) → název např. `cestak` → **Create repository**.

### 2.2 Push kódu
Z extrahovaného `cestak-deploy.zip`:

```bash
cd cestak
git init
git add .
git commit -m "init: cestak app"
git branch -M main
git remote add origin https://github.com/<USERNAME>/cestak.git
git push -u origin main
```

> **Soubory `.env` a `node_modules` se nepushují** (jsou v `.gitignore`). Tvoje Supabase klíče zadáš v Cloudflare dashboardu, kód je tedy bezpečně public.

### 2.3 Lokální dev (volitelné)
```bash
cp .env.example .env
# Otevři .env a vyplň Supabase URL + anon klíč
npm install
npm run dev
# Otevře se na http://localhost:5173
```

---

## 3. Cloudflare Pages (publikace)

### 3.1 Připoj GitHub
1. [dash.cloudflare.com](https://dash.cloudflare.com) → **Workers & Pages** → **Create** → **Pages → Connect to Git**
2. Authorizuj Cloudflare pro tvůj GitHub účet → vyber repo `cestak`

### 3.2 Build nastavení
| Pole | Hodnota |
|---|---|
| **Project name** | `cestak` (bude pak `cestak.pages.dev`) |
| **Production branch** | `main` |
| **Framework preset** | `Vite` |
| **Build command** | `npm run build` |
| **Build output directory** | `dist` |
| **Root directory** | `/` (default) |

### 3.3 Environment variables
**Klíčový krok!** Klikni na **Variables and Secrets** a přidej:

| Název | Hodnota |
|---|---|
| `VITE_SUPABASE_URL` | tvoje URL ze Supabase (kroku 1.4) |
| `VITE_SUPABASE_ANON_KEY` | tvůj anon key |

Zaškrtni je pro **Production** (a klidně i Preview).

### 3.4 Save and Deploy
Cloudflare začne stavět. Po ~2 min uvidíš **Success** a aplikace běží na:

```
https://cestak.pages.dev
```

### 3.5 Auto-deploy ✅
Od teď každý `git push` na `main` automaticky vyvolá rebuild a redeploy. Žádné GitHub Actions netřeba.

### 3.6 Vlastní doména (volitelné)
**Custom domains → Set up a custom domain** → zadej třeba `cesta.tvojedomena.cz`. Cloudflare ti řekne, jaký DNS záznam přidat.

Pokud doména **už používá Cloudflare** jako DNS, je to jeden klik. SSL certifikát (HTTPS) se nastaví automaticky.

---

## 4. Notifikace na STK (volitelné)

Aplikace umí každý den projít termíny všech uživatelů a poslat e-mailovou
připomínku **30 dní** a **7 dní** před vypršením STK / pojištění / dálničky.

Implementováno jako separátní **Cloudflare Worker** s denním cron triggerem,
e-maily se posílají přes **Resend** (zdarma 3000 mailů/měsíc).

📂 **Detailní setup:** [`worker/README.md`](worker/README.md)

Stručně:
1. Vytvoř Resend účet → získej API klíč
2. V Supabase si vezmi **service_role** klíč (Settings → API)
3. `cd worker && npm install && npx wrangler login`
4. Nastav 6 secrets přes `npx wrangler secret put …`
5. `npx wrangler deploy`

Worker poběží denně v 7:00 UTC (8 / 9 hod CZ).

---

## 🔐 Autentizace — 3 způsoby

Aplikace ti dává v login obrazovce na výběr:

| Mode | Jak funguje | Kdy použít |
|---|---|---|
| **Přihlášení** | E-mail + heslo | Standardní login s vlastním heslem |
| **Registrace** | E-mail + heslo (nový účet) | Při prvním přihlášení |
| **E-mail link** | Pošle ti odkaz e-mailem, klikneš = jsi přihlášen | Bez hesla, nejjednodušší UX |

**Doporučeno:** *E-mail link* — bezheslový přístup. Po prvním kliknutí na link
se tvoje session uloží a další otevření aplikace už login nevyžaduje.

> ⚠️ Magic link i potvrzovací e-maily posílá Supabase z vlastního SMTP, který je
> rate-limitovaný (~3 maily/hod ve free tieru). Pro produkci doporučuju nakonfigurovat
> vlastní SMTP přes Resend: **Supabase → Settings → Authentication → SMTP Settings**.

---

## ⚙️ Správa vozového parku

Po prvním přihlášení máš **prázdný park** — žádná defaultní vozidla.
Vytvoříš si je sám/sama tam, kde je potřebuješ.

### 🚗 Z Kalkulátoru (cesty s palivem)
1. Otevři záložku **Kalkulátor** → klikni na **„Vytvoř první vozidlo"** (nebo „+ Přidat vozidlo" nahoře)
2. Vyplň: **název**, **počáteční stav tachometru** (použije se jako výchozí *km Před* u prvního úseku), **palivo** (Benzín / Nafta)
3. Vozidlo se ti automaticky objeví **i v Vozidlech** (s prázdnými termíny — doplníš později)

### 🛠️ Z Vozidel (jen tracking termínů)
V záložce **Vozidla** máš dvě tlačítka:
- **„+ Přidat vozidlo"** — pro auta, která chceš jen sledovat (STK / pojistka / dálnička), ne v kalkulátoru
  - Pole: název, palivo, dálnička (toggle), STK platnost (2 / 4 roky), počáteční datumy
- **„+ Přidat vozík"** — vozíky bez paliva a bez dálničky
  - Pole: název, STK platnost (2 / 4 roky), počáteční datumy STK + pojištění

> **Klíčové:** Vozidlo přidané v Kalkulátoru se objeví i ve Vozidlech. Vozidlo přidané ve Vozidlech (jen tracking) se v kalkulátoru **neobjeví** — je čistě pro hlídání termínů.

### 🗑️ Smazání vozidla
V kartě vozidla v záložce Vozidla klikni na červenou ikonu koše. Smaže se i s termíny.

---

## 🔔 Notifikační nastavení

V záložce **Vozidla** máš nahoře sbalený panel **„Notifikace"**. Klepnutím rozbalíš:

| Pole | Význam |
|---|---|
| **Master switch** | Zapnout / vypnout všechny notifikace |
| **Kam posílat** | E-mail, na který chodí notifikace (prázdné = přihlašovací) |
| **Kolik dní předem** | Multi-select: 60 / 30 / 14 / 7 / 3 / 1 dní (default 30+7) |
| **Sledované doklady** | Toggle per typ: STK / Pojištění / Dálniční známka |

Worker při denním běhu načte tato nastavení **per uživatel** a posílá e-maily
podle preferencí. Adresa z `Kam posílat` má prioritu před auth e-mailem.

---

## 🔧 Jak to celé funguje

```
┌─────────────────┐
│  Tvůj browser   │
└────────┬────────┘
         │ HTTPS
         ▼
┌─────────────────┐         ┌──────────────┐
│ Cloudflare Pages│         │   Supabase   │
│   (statický     │◀───────▶│  Auth + DB   │
│    React build) │  REST   │   + RLS      │
└────────┬────────┘         └──────────────┘
         ▲
         │ git push
         │
┌────────┴────────┐
│     GitHub      │
└─────────────────┘
```

- **Cloudflare Pages** servíruje statický React build z CDN edge serverů (rychlé pro celý svět)
- **Supabase** drží data + autentizaci, přístup přes JS klient
- **Row Level Security** zajistí, že každý uvidí jen svoje data
- **GitHub** je single source of truth — push spustí auto-deploy

---

## 🛠️ Troubleshooting

**„Bílá obrazovka po deploy"**
Otevři DevTools → Console. Většinou problém je `VITE_SUPABASE_URL` nebo `VITE_SUPABASE_ANON_KEY` špatně zadané v Cloudflare. **Po změně env proměnných musíš redeploynout** (Pages → Deployments → Retry deployment).

**„Login nefunguje, vidím chybu"**
- Ověř, že **Email** provider je v Supabase **enabled**.
- Pokud máš zapnuté `Confirm email`, podívej se do schránky a klikni potvrzovací link.

**„Vidím cizí data" / „Nevidím svá data"**
RLS je špatně nastavené. Spusť `supabase/schema.sql` znovu — politiky by se měly dropnout a vytvořit znovu.

**„Po nové cestě se nic neuloží"**
- DevTools → Network → filtruj `supabase`. Hledej 401/403 → uživatel není přihlášený nebo RLS odmítá.
- DevTools → Application → Storage → ověř, že `sb-...-auth-token` cookie / localStorage existuje.

**„Chci zálohu DB"**
Supabase: Settings → Database → **Backups**. Free tier má daily backups (7 dní) automaticky.

---

## 📂 Struktura projektu

```
cestak/
├─ src/
│  ├─ App.jsx          ← celá aplikace (~2700 řádek)
│  ├─ supabase.js      ← klient + storage wrapper s Supabase + fallback
│  ├─ main.jsx         ← React entry
│  └─ index.css        ← Tailwind direktivy
├─ supabase/
│  └─ schema.sql       ← spustit jednou v Supabase SQL Editoru
├─ worker/             ← VOLITELNÉ — notifikační worker
│  ├─ src/
│  │  ├─ index.js      ← cron + manual trigger endpoint
│  │  └─ notifier.js   ← logika hledání expirací + odesílání mailů
│  ├─ wrangler.toml    ← cron schedule + bindings
│  ├─ package.json
│  └─ README.md        ← samostatný setup guide pro worker
├─ index.html
├─ package.json
├─ vite.config.js
├─ tailwind.config.js
├─ postcss.config.js
├─ .env.example        ← šablona env vars
├─ .env                ← (gitignored) lokální dev
└─ README.md           ← tenhle soubor
```

---

## 💸 Náklady

Pro osobní použití **vše zdarma**:
- **Supabase Free**: 500 MB databáze, 50 000 měsíčních autentizací, 2 GB egress/měsíc
- **Cloudflare Pages Free**: 500 buildů/měsíc, neomezeně requestů, neomezený bandwidth
- **GitHub Free**: privátní + veřejné repos zdarma

Pokud bys aplikaci dal stovkám lidí, narazíš na Supabase free tier limit a budeš platit ~$25/měsíc za Pro.

---

## 🚀 Co dál

- **PWA** (offline, instalovatelná na home screen): přidej `vite-plugin-pwa`
- **OAuth** (Google, Apple, GitHub login): Supabase má hotové, stačí enable v providers
- **Real-time sync mezi zařízeními**: Supabase Realtime — kdykoli změníš cestu na PC, mobilu se aktualizuje sám
- **Sdílení cest**: přidat sloupec `shared = true` a public read policy

Hodně štěstí! 🚗

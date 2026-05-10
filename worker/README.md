# Auto monitoring — Notifications Worker

Cloudflare Worker, který každý den projde data všech uživatelů a pošle e-mail
těm, kterým **STK / pojištění / dálniční známka** vyprší **za měsíc** nebo **za týden**.

```
Denně 7:00 UTC (8 / 9 CZ)
        ↓
Cron Trigger spustí Worker
        ↓
Načte všechna user_data (vehicles-data) ze Supabase
        ↓
Pro každého uživatele najde vozidla s expirujícími doklady
        ↓
Vyřadí ty, co už byly poslané (notifications_sent)
        ↓
Pošle souhrnný e-mail přes Resend
        ↓
Zaloguje do notifications_sent
```

---

## 🚀 Deploy (jednou)

### 1. Resend (e-mailový provider)

1. Sign up na **[resend.com](https://resend.com)** (zdarma 3000 mailů/měs)
2. **API Keys → Create API Key** → zkopíruj `re_...`
3. Pro **testování** stačí `from: "Auto monitoring <onboarding@resend.dev>"` (limit 100/den)
4. Pro **produkci**: **Domains → Add Domain** → ověř DNS záznamy podle instrukcí (TXT pro DKIM, SPF). Pak můžeš použít `noreply@tvojedomena.cz`

### 2. Supabase service-role klíč

1. **Supabase Project → Settings → API**
2. Najdi `service_role` (`secret` — má nálepku „This key has the ability to bypass RLS")
3. Zkopíruj — **NESDÍLEJ NIKDE veřejně**, jen jako secret v Cloudflare!

### 3. Tabulka `notifications_sent`

Pokud jsi spustil `supabase/schema.sql` (z hlavního deploye), je už hotová.
Jinak v Supabase SQL editoru spusť to schéma znovu (je idempotentní).

### 4. Wrangler login

```bash
cd worker
npm install
npx wrangler login        # otevře prohlížeč na cloudflare auth
```

### 5. Nastavení secrets

```bash
npx wrangler secret put SUPABASE_URL
# → vlož: https://xxxxxxxxxxxx.supabase.co

npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY
# → vlož: service_role klíč ze Supabase

npx wrangler secret put RESEND_API_KEY
# → vlož: re_...

npx wrangler secret put FROM_EMAIL
# → vlož:  Auto monitoring <onboarding@resend.dev>
#   (nebo Auto monitoring <noreply@tvojedomena.cz> pokud máš ověřenou doménu)

npx wrangler secret put APP_URL
# → vlož: https://cestak.pages.dev (nebo tvoje doména)

npx wrangler secret put MANUAL_TRIGGER_KEY
# → vlož: random string, např: openssl rand -hex 32
```

### 6. Deploy

```bash
npx wrangler deploy
```

Worker je publikován na: **`https://cestak-notifications.<TVŮJ-USER>.workers.dev`**

Cron trigger se aktivuje automaticky.

---

## 🧪 Test

### Manuální spuštění

```bash
curl "https://cestak-notifications.<USER>.workers.dev/run?key=<MANUAL_TRIGGER_KEY>"
```

Vrátí JSON shrnutí:

```json
{
  "timestamp": "2026-05-09T07:00:00.000Z",
  "users_scanned": 3,
  "notifications_due": 2,
  "emails_sent": 2,
  "errors": []
}
```

### Lokální test cronu

```bash
npm run test:cron
# pak v jiném terminálu:
curl "http://localhost:8787/__scheduled?cron=0+7+*+*+*"
```

### Live logy

```bash
npx wrangler tail
```

Uvidíš v reálném čase, co worker dělá při každém spuštění.

---

## ⚙️ Konfigurace

### Změna rozvrhu

Uprav `wrangler.toml`, sekce `[triggers]`:

```toml
crons = ["0 7 * * *"]   # každý den 7:00 UTC
crons = ["0 7,19 * * *"] # 2× denně, 7:00 a 19:00
crons = ["0 7 * * 1"]   # každé pondělí
```

Po úpravě **`npx wrangler deploy`**.

### Změna upozornění (kolik dní předem)

V `src/notifier.js`:

```js
const NOTIFICATION_DAYS = [
  { days: 30, type: 'month', label: 'měsíc' },
  { days: 7,  type: 'week',  label: '7 dní' },
  // přidej třeba: { days: 1, type: 'day', label: 'zítra' },
];
```

Po úpravě deploy.

### Přidání vozidla

Pokud v `App.jsx` přidáš nové vozidlo do `VEHICLES`, uprav i list v `src/notifier.js` —
worker potřebuje znát názvy vozidel, aby je v e-mailu pojmenoval správně.

---

## 🐛 Troubleshooting

### „Worker neběží"
- **Cloudflare → Workers & Pages → cestak-notifications → Triggers** — měl by být zelený `Active`
- Logs v dashboardu: kliki na worker → Logs → real-time

### „Email se neodeslal"
- `wrangler tail` zobrazí Resend chybové hlášky
- Resend dashboard → **Logs** — vidíš historii pokusů o odeslání
- Pokud máš `onboarding@resend.dev`, jdou e-maily jen na adresu, kterou jsi si v Resend zaregistroval(a). Pro libovolného příjemce ověř doménu.

### „Stejný e-mail přijde 2×"
- Tabulka `notifications_sent` neexistuje nebo nemá unique index
- Spusť `supabase/schema.sql` znovu

### „Worker nevidí žádné uživatele"
- `SUPABASE_SERVICE_ROLE_KEY` není správně nastavený
- Jdi do Cloudflare → Workers → cestak-notifications → Settings → Variables a zkontroluj přítomnost všech secrets (hodnoty nebudou vidět, jen názvy)

### „Chci hned otestovat, ale nikdo nemá za 30 dní expiraci"
Změň dočasně v `src/notifier.js`:

```js
const NOTIFICATION_DAYS = [
  { days: 30, type: 'month', label: 'měsíc' },
  { days: 7,  type: 'week',  label: '7 dní' },
  { days: 999, type: 'test', label: 'test' }, // ← přidat dočasně
];
```

Pak v aplikaci nastav nějakému dokladu datum expirace `today + 999 dní` a spusť `/run`.

---

## 💰 Cena

- **Cloudflare Workers Free**: 100 000 requestů/den + cron triggers zdarma
- **Resend Free**: 3 000 mailů/měsíc s ověřenou doménou (nebo 100/den z `onboarding@resend.dev`)
- **Supabase Free**: stejně jako pro hlavní app

Pro běžné rodinné/firemní použití (≤10 uživatelů, ≤30 mailů/měsíc) **0 Kč**.

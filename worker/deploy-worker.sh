#!/usr/bin/env bash
# ============================================================
# Auto monitoring — Cloudflare Worker (notifikace) deploy
# Použití:
#   cd worker && bash deploy-worker.sh
# Pak script tě interaktivně provede:
#   1) login do Cloudflare (jednorazově)
#   2) nastavení 6 secrets
#   3) deploy + cron
# ============================================================

set -e

if [ ! -f "wrangler.toml" ]; then
  echo "❌ Spusť tento script ze složky worker/ (kde je wrangler.toml)."
  exit 1
fi

# 1) Instalace dependencies
if [ ! -d "node_modules" ]; then
  echo "📦 npm install …"
  npm install
fi

WRANGLER="npx wrangler"

# 2) Login (idempotent — pokud už jsi přihlášen, hned přeskočí)
echo "🔐 Cloudflare login (otevře se prohlížeč pokud nejsi přihlášen) …"
$WRANGLER login || true

# 3) Secrets — jeden po druhém
echo ""
echo "🔑 Nastavím 6 secrets pro Worker."
echo "    Hodnoty si připrav do schránky a vlepuj postupně."
echo ""

set_secret() {
  local KEY=$1
  local DESC=$2
  echo "▶️  $KEY  ($DESC)"
  echo "    (Worker se na tuto hodnotu ZEPTÁ; vlep ji a stiskni Enter.)"
  $WRANGLER secret put "$KEY"
  echo ""
}

set_secret SUPABASE_URL          "https://xxxxx.supabase.co (z Supabase Settings → API)"
set_secret SUPABASE_SERVICE_ROLE_KEY "service_role klíč (Supabase Settings → API → service_role, NE anon!)"
set_secret RESEND_API_KEY        "re_xxx (z resend.com → API Keys)"
set_secret FROM_EMAIL            "Auto monitoring <onboarding@resend.dev> (na test ok)"
set_secret APP_URL               "https://auto-monitoring.pages.dev (URL po Cloudflare Pages deployi)"
set_secret MANUAL_TRIGGER_KEY    "libovolný silný klíč (pro ruční spuštění přes /run?key=...)"

# 4) Deploy
echo "🚀 Deploy Worker + cron …"
$WRANGLER deploy

echo ""
echo "✅ HOTOVO. Worker běží."
echo ""
echo "Test ručního spuštění:"
echo "    curl 'https://auto-monitoring-notifications.<acct>.workers.dev/run?key=<MANUAL_TRIGGER_KEY>'"
echo ""
echo "Cron běží každý den v 7:00 UTC (8:00 zima / 9:00 léto CZ)."

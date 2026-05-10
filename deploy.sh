#!/usr/bin/env bash
# ============================================================
# Auto monitoring — deploy.sh
# Jednorazové nahrání kódu na GitHub + příprava pro Cloudflare Pages.
# Použití:
#   bash deploy.sh https://github.com/USER/auto-monitoring.git
# ============================================================

set -e

REPO_URL="${1:-}"

if [ -z "$REPO_URL" ]; then
  echo ""
  echo "❌ Chybí URL repa."
  echo ""
  echo "Použití:"
  echo "  bash deploy.sh https://github.com/USER/auto-monitoring.git"
  echo ""
  echo "Nejdřív vytvoř prázdné repo na: https://github.com/new"
  echo "(NEpřidávej README, .gitignore ani license — vše máme připravené)"
  echo ""
  exit 1
fi

# Sanity check — jsme v deploy/?
if [ ! -f "package.json" ] || [ ! -f "src/App.jsx" ]; then
  echo "❌ Spusť tento script z deploy/ složky (kde je package.json a src/App.jsx)."
  exit 1
fi

# 1) Git init
if [ ! -d ".git" ]; then
  echo "🔧 git init …"
  git init -q
  git branch -M main
fi

# 2) .gitignore (jen pro jistotu)
if [ ! -f ".gitignore" ]; then
  cat > .gitignore <<'EOF'
node_modules
dist
.env
.env.*
.wrangler
EOF
fi

# 3) Add + commit
echo "📦 staging soubory …"
git add -A

if git diff --cached --quiet 2>/dev/null; then
  echo "ℹ️  Není co commitnout (žádné změny)."
else
  git commit -q -m "Initial commit — Auto monitoring"
  echo "✓ Commit vytvořen"
fi

# 4) Remote
if git remote get-url origin >/dev/null 2>&1; then
  CURRENT=$(git remote get-url origin)
  if [ "$CURRENT" != "$REPO_URL" ]; then
    echo "🔁 Měním remote z $CURRENT na $REPO_URL"
    git remote set-url origin "$REPO_URL"
  fi
else
  git remote add origin "$REPO_URL"
fi

# 5) Push
echo "🚀 push na $REPO_URL …"
echo "    (můžeš být dotázán/a na GitHub credentials nebo PAT)"
git push -u origin main

echo ""
echo "✅ HOTOVO. Kód je na GitHubu."
echo ""
echo "▶️  Další krok: Supabase + Cloudflare Pages — viz CHECKLIST.md"

# CLAUDE.md — Auto Monitoring

> For Claude Code: auto-loaded at session start. Read before touching code.

## 1) Project at a glance
Multi-tenant web app for personal vehicle fleet management — trip cost calculator, document expiration tracker (STK/insurance/vignette), automated email reminders.
**Current state:** LIVE in production (deployed May 2026, working end-to-end).
**Owner:** Jakub Tichy (JakubT91). Not a heavy coder — prefers concise practical guidance. Communicates in Czech. On Windows PowerShell (no native bash).

## 2) Live URLs
- Production app: https://auto-monitoring.pages.dev
- GitHub: https://github.com/JakubT91/auto-monitoring (auto-deploys on push to main)
- Supabase: https://supabase.com/dashboard/project/jilqfxldrzmwihnujtop
- Cloudflare: https://dash.cloudflare.com
- Resend: https://resend.com/emails
- Worker manual trigger: https://auto-monitoring-notifications.jakubtichy91.workers.dev/run?key=<MANUAL_TRIGGER_KEY>

## 3) Tech stack
- Frontend: React 18 + Vite + TailwindCSS 3 + Recharts + Lucide React + @supabase/supabase-js
- Backend: Supabase Postgres + Auth + RLS, key-value pattern in single table user_data
- Infra: Cloudflare Pages (frontend, auto-deploy), Cloudflare Workers (cron notifications), Resend (email)

## 4) Structure
- src/App.jsx        # ENTIRE SPA in one file (~3500 lines) - INTENTIONAL, do not split
- src/supabase.js    # Supabase client + storage abstraction
- src/main.jsx       # ReactDOM bootstrap
- src/index.css      # Tailwind directives
- supabase/schema.sql # DB schema + RLS (already deployed)
- worker/src/index.js     # Worker entry: cron + /run endpoint
- worker/src/notifier.js  # Notification logic (already deployed)
- worker/wrangler.toml    # Worker config + cron trigger

## 5) Local dev
Prereqs: Node 18+, npm, .env (gitignored) with:
  VITE_SUPABASE_URL=https://jilqfxldrzmwihnujtop.supabase.co
  VITE_SUPABASE_ANON_KEY=<publishable_key>
Commands:
  npm install      # one-time
  npm run dev      # http://localhost:5173
  npm run build    # production build -> dist/
  npm run preview

## 6) Critical conventions - DO NOT BREAK
- UI language is CZECH. Do not translate unless asked. Comments can be English.
- src/App.jsx is intentionally a SINGLE FILE (~3500 lines). Do not refactor into multiple files unless asked.
- NO arbitrary Tailwind values (never h-[400px], bg-[#hex], max-h-[90vh]). Only core classes. Arbitrary values break artifact preview.
- NO <form> in modals. Three modals use <div> + <button onClick={submit}>. Sandboxed iframes block form submit silently.
- Multi-tenant via RLS: all queries auto-filtered by auth.uid() = user_id. Publishable key in browser; service-role key ONLY in Worker secrets, never in frontend/git.
- vehicles-list (array of metadata) and vehicles-data (object keyed by id, holds doc dates) are SEPARATE keys. Update both together when adding/deleting vehicle.
- Always store document "from" (issue date), never "to". Expiration is CALCULATED: STK car +2y or +4y (user picks in the add-car modal), STK trailer +2y (ALWAYS — fixed, no choice; enforced in yearsFor + worker by vehicle.type==='trailer'), insurance +1y, vignette +1y. Frontend helper calcExpiration, worker helper calcExpiry must stay in sync.
- Dates stored as YYYY-MM-DD strings. Worker: daysLeft = round((expiry - today)/86400000) in UTC. Threshold matching uses +/-1 day tolerance for timezone edge cases.

## 7) Deployment
Frontend (automatic): git add -A && git commit -m "..." && git push  -> Cloudflare rebuilds in ~1min.
Worker (manual): cd worker && npx wrangler deploy
DB changes: apply SQL via Supabase Dashboard SQL Editor, also update supabase/schema.sql.

## 8) Testing
Frontend: npm run dev, or push to main and test live (owner is only user, safe).
Worker live logs: cd worker && npx wrangler tail  (Ctrl+C to stop)
Manual trigger: open /run?key=auto-monitoring-test-2026-XYZ-789 -> returns JSON summary.
Force a notification: set a vehicle STK "from" so expiry is exactly 7 or 30 days from today, then trigger.
Reset dedup to re-test: DELETE FROM notifications_sent WHERE user_id = ''<uuid>'';

## 9) Common tasks
- New UI feature: edit src/App.jsx (components VehiclesView, TripView, StatsView). Persist new state via storage.set(key, value). Match neighboring Tailwind patterns.
- New doc type: sync changes in App.jsx (DOC_TYPES, calcExpiration, edit modal, VehicleCard rows) AND worker/src/notifier.js (docType loop, DOC_LABELS, DEFAULT_YEARS). Deploy both.
- Change notif thresholds: per-user in app NOTIFIKACE panel; global default in DEFAULT_NOTIFICATION_SETTINGS.daysBefore in worker.
- Change cron: worker/wrangler.toml crons = ["0 7 * * *"], then npx wrangler deploy. Current = daily 07:00 UTC.
- Update Worker secret: cd worker && npx wrangler secret put NAME
- Update Pages env var: CF Dashboard -> Pages -> Settings -> Variables (Production), then retry deployment.

## 10) Database
Tables:
  user_data (user_id UUID, key TEXT, value JSONB, updated_at)
  notifications_sent (id, user_id, vehicle_id, doc_type, expiration_date, notification_type, sent_at)
    -- worker dedup: unique (user_id, vehicle_id, doc_type, expiration_date, notification_type);
    --   notification_type = den-práh jako text ("30", "7", …). Worker zapisuje po každém odeslání.
RLS on user_data: auth.uid() = user_id.
user_data keys: vehicles-list, vehicles-data, notification-settings, current-trip, saved-trips, eur-rate-cache.

## 11) Known gotchas
- npx wrangler "out of date" warning -> ignore, v3.x works fine.
- Resend emails may land in Gmail Promotions/Spam (shared onboarding@resend.dev). For production set up real domain.
- Mermaid diagrams in README render only when repo is Public.
- npm install shows deprecation warnings + "4 vulnerabilities" -> do NOT run npm audit fix --force (breaks deps).
- First Worker deploy: answer Y to "create Worker with that name".
- Owner on Windows PowerShell - no bash. Use plain git/npx/npm. bash deploy.sh wont work.

## 12) Anti-patterns
- Do NOT store calculated expiry dates. Recompute from "from" + years.
- Do NOT bypass RLS from frontend.
- Do NOT put secrets in source files.
- Do NOT add arbitrary Tailwind values.
- Do NOT add <form> to modals.
- Do NOT translate Czech UI without ask.
- Do NOT fragment App.jsx.
- Do NOT npm audit fix --force.

## 13) Roadmap (not done)
- Service interval reminders (oil change per km)
- Receipt photo attachments (Supabase Storage)
- Multi-driver / shared fleet
- PWA offline support
- Custom domain + branded sender email
- Mobile push notifications
- English UI (i18n)
- In-app admin view

## 14) First steps each session
1. Read this file
2. git status (uncommitted changes?)
3. git log --oneline -10 (recent history)
4. Skim README.md for architecture diagrams
5. Confirm with owner before: refactoring App.jsx, adding deps, changing schema, modifying secrets, pushing to main (= deploys to PRODUCTION)

## 15) Quick commands
  npm run dev
  npm run build && npm run preview
  git add -A && git commit -m "..." && git push     # deploy frontend
  cd worker && npx wrangler deploy                   # deploy worker
  cd worker && npx wrangler tail                     # watch worker logs
  cd worker && npx wrangler secret put NAME
  # DB admin: https://supabase.com/dashboard/project/jilqfxldrzmwihnujtop

## 16) Context
Owner: Jakub Tichy (JakubT91), jakubtichy91@gmail.com
User-base: ~1 (owner) at handover, designed to scale to family/friends.
Cost: $0/month (all free tier).

Last updated: June 2026 (re-created on new PC after clone).

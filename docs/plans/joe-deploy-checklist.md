# Joe's dashboard — deploy checklist

Everything the code needs is built (`CLAUDE.md` §13, TRACK.md 2026-09-24). This is the operator's
runbook; `<PLACEHOLDER>` marks values not known yet. Do the steps in order — step 1 must be live
before Joe's campaigns start, because his accounts are already visible to Nadia's worker.

## 0. Values

| item | value |
|---|---|
| Joe's Supabase project | `glrxjjnaogkuahhafgth`, region ap-south-1 (Mumbai) — migrated to **048** |
| `DATABASE_URL` (Joe) | in `backend/.env.joe` (gitignored) |
| `NEXT_PUBLIC_SUPABASE_URL` | `https://glrxjjnaogkuahhafgth.supabase.co` |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | the `sb_publishable_…` key (in `backend/.env.joe`) |
| Joe's API URL (Render) | `<JOE_API_URL>` |
| Joe's dashboard URL (Vercel) | `<JOE_VERCEL_URL>` |
| Joe's login email | `<JOE_EMAIL>` |
| Nadia's login email | `<NADIA_EMAIL>` (her usual) |
| Hostinger access for ads.txt | `<PENDING — Nadia checking with Joe>` |

## 1. Nadia's worker — protect her dashboard (do first)

Render → `nadia-worker` → Environment, add:

```
TENANT_ACCOUNT_EXCLUDE=^SBH_rev_|Revlogic Media
TENANT_IA_AFFILIATE_INCLUDE=^ssm\.
```

Redeploy the worker (and the API — `048_app_settings` is already applied, so the build's migrate
step is a no-op). Then, from this repo:

```bash
cd backend && TENANT_ACCOUNT_EXCLUDE='^SBH_rev_|Revlogic Media' npm run sync:once -- tenant-prune --apply
```

which deletes the 11 empty Joe accounts from her `ad_accounts` (dry-run first without `--apply`).
Check: Render logs show `cron: tenant rules for this deployment` with the exclude, and her account
dropdown no longer lists `SBH_rev_*` / `Revlogic Media`.

## 2. Joe's Render services (region: **Singapore**)

Create two services from the same repo, `rootDir: backend`, Node:

**API** — build `npm install && npm run build && npm run migrate:prod`, start `npm run start:api`.
**Worker** — build `npm install && npm run build`, start `npm run start:worker`.

Environment (both services unless noted):

```
NODE_ENV=production
LOG_LEVEL=info
DATABASE_URL=<from backend/.env.joe>
ENABLED_SOURCES=taboola,outbrain,image_advantage
TENANT_ACCOUNT_INCLUDE=^SBH_rev_|Revlogic Media
TENANT_IA_AFFILIATE_EXCLUDE=^ssm\.
TABOOLA_ACCOUNT_ID=revlogicmedia4945-network
TABOOLA_CLIENT_ID=<same as Nadia's>
TABOOLA_CLIENT_SECRET=<same as Nadia's>
OUTBRAIN_USERNAME=<same as Nadia's>
OUTBRAIN_PASSWORD=<same as Nadia's>
IMAGE_ADVANTAGE_EMAIL=<same as Nadia's>
IMAGE_ADVANTAGE_PASSWORD=<same as Nadia's>
IMAGE_ADVANTAGE_ACCOUNT_ID=398
CORS_ORIGIN=<JOE_VERCEL_URL>            # API only
ENABLE_CRON=false                       # API
ENABLE_CRON=true                        # worker
```

Not needed (source disabled): `CODEFUEL_*`, `DDC_*`, `RESEND_*`, `REPORT_EMAIL_*`.

**Outbrain login limit:** the shared credential allows 2 logins/hour. The token now lives in each
deployment's DB, so Joe's worker logs in **once** on its first boot and then reuses the token
(~30 days). Avoid deploying Joe's worker and Nadia's worker within the same hour the first time;
after that it does not matter.

First run after deploy, from this repo against Joe's DB (or wait for the 03:00 backfill):

```bash
cd backend && env $(grep -v '^#' .env.joe | xargs) ENABLED_SOURCES=taboola,outbrain,image_advantage \
  TENANT_ACCOUNT_INCLUDE='^SBH_rev_|Revlogic Media' TENANT_IA_AFFILIATE_EXCLUDE='^ssm\.' \
  TABOOLA_ACCOUNT_ID=revlogicmedia4945-network npm run sync:once -- daily-backfill
```

## 3. Joe's Vercel project

Root directory `frontend`. Environment:

```
NEXT_PUBLIC_API_BASE=<JOE_API_URL>
NEXT_PUBLIC_SUPABASE_URL=https://glrxjjnaogkuahhafgth.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=<sb_publishable_… key>
NEXT_PUBLIC_APP_NAME=Revlogic Media
NEXT_PUBLIC_EXPORT_PREFIX=revlogic
NEXT_PUBLIC_DEFAULT_ACCOUNT=
```

Functions region: `sin1` (matches Render Singapore).

## 4. Supabase Auth (Joe's project)

Authentication → Providers → Email: enabled, magic link on. URL configuration: Site URL
`<JOE_VERCEL_URL>`, redirect `<JOE_VERCEL_URL>/auth/callback`. Then invite `<JOE_EMAIL>` and
`<NADIA_EMAIL>`; after each has signed in once:

```sql
UPDATE app_users SET role = 'admin' WHERE email IN ('<JOE_EMAIL>', '<NADIA_EMAIL>');
```

(`app_users.role` exists from migration 003; the app does not enforce roles yet, so this is
bookkeeping for when it does.)

## 5. Verify before telling Nadia

- Joe's `/api/filters/options` lists only `SBH_rev_01..05` and the six `Revlogic Media_4945` accounts.
- Nadia's lists none of them.
- Joe's `sync_runs` shows taboola/outbrain/image_advantage `ok`; no codefuel/ddc rows.
- Once traffic runs: Campaign == Ads on spend **and** revenue for a 7-day window on Joe's API.
- ads.txt: `curl -I https://<domain>/ads.txt` → 200 on all five (needs Hostinger access first).

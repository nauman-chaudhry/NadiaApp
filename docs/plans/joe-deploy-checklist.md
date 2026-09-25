# Joe's dashboard — deploy checklist

Operator's runbook. `<PLACEHOLDER>` marks values not known yet. Do the steps in order — step 1
protects Nadia's dashboard and must be live before Joe's campaigns start.

**What is built and verified (2026-09-25):** tenancy filters (account + IA affiliate, by name or
id; production refuses to run without them), `ENABLED_SOURCES`, default partner tagging,
`tenant-check`/`tenant-prune`/`tenant-tag`, Flux affiliate discovery, DB-backed Outbrain token,
API authentication, browser-role DB access revoked, orphan revenue kept without a tagged account
(MV 050), tabs keep filters, honest Hourly, per-source freshness. Joe's Supabase project is
migrated to **050**. **What is NOT verified:** any Joe figure against IA/Outbrain/Taboola — his
database is empty until his campaigns run. Step 6 below is the acceptance gate.

## 0. Values

| item | value |
|---|---|
| Joe's Supabase project | `glrxjjnaogkuahhafgth`, region ap-south-1 (Mumbai) — migrated to **050** |
| `DATABASE_URL` (Joe) | in `backend/.env.joe` (gitignored) |
| `NEXT_PUBLIC_SUPABASE_URL` / `SUPABASE_URL` | `https://glrxjjnaogkuahhafgth.supabase.co` |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` / `SUPABASE_ANON_KEY` | the `sb_publishable_…` key (in `backend/.env.joe`) |
| Joe's API URL (Render) | `<JOE_API_URL>` |
| Joe's dashboard URL (Vercel) | `<JOE_VERCEL_URL>` |
| Joe's login email | `<JOE_EMAIL>` |
| Nadia's login email | `<NADIA_EMAIL>` (her usual) |
| ads.txt | uploaded 2026-09-24 under the wrong name — Joe must rename each to `ads.txt`; then verify all five return 200 |

## 1. Nadia's services — protect her dashboard and enable API auth (do first)

Render → **`nadia-worker`** → Environment, add:

```
TENANT_ACCOUNT_EXCLUDE=^SBH_rev_|Revlogic Media
TENANT_IA_AFFILIATE_INCLUDE=^ssm\.
```

Render → **`nadia-api`** → Environment, add (the API now refuses to start in production without
them):

```
SUPABASE_URL=<Nadia's project URL, same as the frontend's NEXT_PUBLIC_SUPABASE_URL>
SUPABASE_ANON_KEY=<Nadia's anon/publishable key>
```

Deploy worker, API and frontend (Vercel) together — the frontend now sends the session token and the
API requires it, so deploying one without the other breaks the dashboard until both are live.
Migrations 048–050 are already applied, so the API build's migrate step is a no-op.

**Check in the browser:** log in, Campaign tab loads, "Data last synced" shows a time, switching
tabs keeps the date/account filters. Then from this repo:

```bash
cd backend && TENANT_ACCOUNT_EXCLUDE='^SBH_rev_|Revlogic Media' npm run sync:once -- tenant-prune --apply
```

(removes the 11 empty Joe accounts from her `ad_accounts`; dry-run first without `--apply`).
Render worker logs should show `cron: tenant rules for this deployment` with the exclude.

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
TENANT_DEFAULT_PARTNER=image_advantage
TABOOLA_ACCOUNT_ID=revlogicmedia4945-network
TABOOLA_CLIENT_ID=<same as Nadia's>
TABOOLA_CLIENT_SECRET=<same as Nadia's>
OUTBRAIN_USERNAME=<same as Nadia's>
OUTBRAIN_PASSWORD=<same as Nadia's>
IMAGE_ADVANTAGE_EMAIL=<same as Nadia's>
IMAGE_ADVANTAGE_PASSWORD=<same as Nadia's>
IMAGE_ADVANTAGE_ACCOUNT_ID=398
SUPABASE_URL=https://glrxjjnaogkuahhafgth.supabase.co          # API
SUPABASE_ANON_KEY=<sb_publishable_… key>                         # API
CORS_ORIGIN=<JOE_VERCEL_URL>                                     # API
ENABLE_CRON=false                                                # API
ENABLE_CRON=true                                                 # worker
```

Not needed (source disabled): `CODEFUEL_*`, `DDC_*`, `RESEND_*`, `REPORT_EMAIL_*`.

**Outbrain login limit:** the shared credential allows 2 logins/hour. The token lives in each
deployment's DB, so Joe's worker logs in **once** on first boot and reuses it (~30 days). Avoid
deploying both workers within the same hour the first time; after that it does not matter.

First run after deploy (or wait for the 03:00 backfill), from this repo:

```bash
cd backend && ENV_FILE=.env.joe npm run sync:once -- daily-backfill
```

`.env.joe` already carries the full Joe configuration; `ENV_FILE` makes it the only file read.

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

Authentication → Providers → Email: enabled, magic link on; **disable "Allow new users to sign up"**
(the login form already sends `shouldCreateUser: false`; this closes the hosted side too). URL
configuration: Site URL `<JOE_VERCEL_URL>`, redirect `<JOE_VERCEL_URL>/auth/callback`. Invite
`<JOE_EMAIL>` and `<NADIA_EMAIL>`; after each has signed in once:

```sql
UPDATE app_users SET role = 'admin' WHERE email IN ('<JOE_EMAIL>', '<NADIA_EMAIL>');
```

(`app_users.role` exists from migration 003; the app enforces "exists in app_users", not roles.)

## 5. Verify the deployment

- Joe's `/api/filters/options` (logged in) lists only `SBH_rev_01..05` and the six
  `Revlogic Media_4945` accounts, all badged **IA**; Nadia's lists none of them.
- `curl <JOE_API_URL>/api/sync-status` without a token → 401.
- Joe's `sync_runs` shows taboola/outbrain/image_advantage `ok`; no codefuel/ddc rows.
- ads.txt: `curl -I https://<domain>/ads.txt` → 200 on all five.

## 6. Acceptance gate — after Joe's first trading days, before handover

Not optional: two empty reports agreeing proves nothing. Against independent partner totals:

- Yahoo revenue **and** Flux revenue per day == IA's own reporting for Joe's affiliates.
- Outbrain spend per day == Outbrain's campaigns report for SBH_rev_01..05; Taboola spend ==
  Taboola's report for the Revlogic network.
- Campaign == Ads on **both spend and revenue**, per account, all feeds, with and without status.
- Nothing from Joe in Nadia's tables and vice versa (`tenant-check` on each; a
  `SELECT` for the other tenant's account names on each DB returns 0 rows).

## 7. Open decision

Rotate the shared Outbrain password. Before migration 049 the stored token was readable through
Supabase REST with the public key; a new login does not invalidate an old token, only a password
change does. Rotation needs the new password on both workers' env; the DB token store then
re-logs-in once per deployment.

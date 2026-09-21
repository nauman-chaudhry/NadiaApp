# Runbook — Nadia Dashboard

Operational guide for day-to-day use, incident response, and maintenance.

---

## Architecture at a glance

```
Taboola API ──► backend worker ──► ad_stats_hourly ──┐
                                                       ├─► joined_stats_hourly (MV) ──► API ──► Frontend
Codefuel API ──► backend worker ──► partner_stats_hourly ──┘
```

- **Supabase** — PostgreSQL database (`knrxaouomqcqpwqqjxqr`)
- **Render API** (`nadia-api`) — Express server, answers `/api/*` requests
- **Render Worker** (`nadia-worker`) — Cron jobs, no HTTP
- **Vercel** — Next.js frontend, server-side rendered

---

## Cron schedule (worker)

| Time (UTC) | Job |
|---|---|
| `:05` every hour | Taboola hourly stats → refresh MV |
| `:15` every hour | Codefuel hourly stats → refresh MV |
| Every 6 hours | Taboola metadata (accounts, campaigns, ads) |
| 03:00 daily | Rolling 3-day backfill for both sources |

---

## Checking sync health

**In Supabase SQL editor:**

```sql
-- Last 10 sync runs
SELECT source, job_type, window_start, window_end,
       status, rows_written, error, finished_at
FROM sync_runs
ORDER BY finished_at DESC
LIMIT 10;

-- Any errors in the last 24 hours
SELECT * FROM sync_runs
WHERE status = 'error'
  AND finished_at > NOW() - INTERVAL '24 hours';
```

**In Render logs:**
- API: `nadia-api` → Logs
- Worker: `nadia-worker` → Logs

---

## Manual sync (run from Render shell or local terminal)

```bash
cd backend

# Pull new metadata (accounts, campaigns, ad items)
npm run sync:once -- taboola-metadata

# Pull missing hourly window
npm run sync:once -- taboola-hourly 2026-05-20 2026-05-22
npm run sync:once -- codefuel-hourly 2026-05-20 2026-05-22

# Pull historical daily window (Codefuel only; Taboola hourly only goes back 14 days)
npm run sync:once -- codefuel-daily 2026-04-01 2026-05-08

# Refresh the materialized view manually
npm run sync:once -- refresh-view

# Full backfill from a given start date (runs all steps)
npm run sync:once -- backfill-full 2026-04-01
```

---

## Data freshness

| Source | Lag | Notes |
|---|---|---|
| Taboola spend | ~1 hour | Available at HH:05 each hour |
| Codefuel revenue | ~1 hour | Available at HH:15 each hour |
| MV refresh | After each sync | `REFRESH MATERIALIZED VIEW joined_stats_hourly` |

The "data updated" timestamp in the top-right of the dashboard reflects the last successful sync run.

---

## Adding a new user

1. In **Supabase → Authentication → Users**, click **Invite user** and enter their email.
2. They receive a magic-link email. After clicking it they land on `/dashboard/campaign`.
3. Their record is auto-created in `app_users` via the DB trigger (`003b_auth_trigger.sql`).

No code changes required for new users.

---

## Updating CORS after redeploying the frontend

If Vercel gives you a new URL (e.g. after renaming the project):

1. Render → `nadia-api` → Environment → set `CORS_ORIGIN=https://new-url.vercel.app`
2. Render auto-redeploys. No code change needed.

---

## Applying new DB migrations

```bash
# Locally (targets the Supabase DB via DATABASE_URL in backend/.env)
cd backend && npm run migrate

# On Render — the build command includes this automatically:
# npm install && npm run build && npm run migrate:prod
```

Migrations are idempotent: the `_migrations` table tracks which files have been applied.

---

## Taboola data limitation

Taboola's reporting API only returns **campaign-level** hourly stats — no item/site/country/device breakdown at hourly granularity. That is why:

- The **Site** tab shows a "not available" message (intended)
- The **Device** and **Country** tabs show Codefuel-side breakdown only (no Taboola spend per device/country)
- The **Ads** tab shows Codefuel revenue per ad creative, with total campaign spend joined in

---

## Codefuel hourly window

Codefuel's hourly endpoint only covers the **last 14 days**. For older data the daily endpoint is used (rows stored with `hour_utc = midnight`). The daily backfill cron at 03:00 UTC keeps the last 3 days reconciled.

---

## Common issues

| Symptom | Likely cause | Fix |
|---|---|---|
| All tabs show 0 rows | MV is empty | Run `npm run sync:once -- refresh-view` |
| Campaign names missing | Metadata not synced | Run `npm run sync:once -- taboola-metadata` |
| Revenue shows but spend = 0 | Taboola hourly window expired | Data beyond 14 days shows revenue-only; expected |
| Worker crashing on startup | `ENABLE_CRON` not set to `true` | Set `ENABLE_CRON=true` on the Render worker service |
| 401 on API | `CORS_ORIGIN` mismatch or Supabase key wrong | Check env vars on Render |
| Magic link not arriving | Supabase redirect URL not configured | Add your Vercel URL to Supabase → Auth → URL Configuration |

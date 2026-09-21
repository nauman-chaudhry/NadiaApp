# Nadia Solutions — Advertising Dashboard

Custom dashboard connecting **advertising platforms** (Taboola, Outbrain, Facebook, Google Ads)
with **client partner APIs** (Codefuel/Perion, Image Advantage, Media.net, Brightsync) at the
campaign / keyword / ad level.

## Phase 1 scope (this build)

- **Ad platforms**: Taboola, Outbrain
- **Client API**: Codefuel/Perion
- **Account group**: TDG - Seven Sphere Media_4433
- **Refresh**: hourly
- **Views**: Campaign, Device, Site, Country, Ads, Daily, Hourly (mirrors current Power BI)

## The join

Cost (Taboola/Outbrain) ↔ Revenue (Codefuel) joins via two URL parameters:

| Ad platform URL  | Codefuel API field |
| ---------------- | ------------------ |
| `gd=AP1008549`   | `Asset GID`        |
| `r=4268019316`   | `Channel`          |

Plus `date`, `hour`, `country`, `device` for slicing.

## Stack

| Layer        | Choice                                         |
| ------------ | ---------------------------------------------- |
| Frontend     | Next.js 14 (App Router) + Tailwind + shadcn/ui |
| Tables       | TanStack Table                                 |
| Charts       | Recharts                                       |
| Backend API  | Node.js + Express                              |
| Sync workers | Separate Node process w/ node-cron             |
| Database     | Supabase (Postgres)  (nadiadatabase121)        |
| Auth         | Supabase Auth (magic link)                     |
| Hosting      | Vercel (frontend) + Render (backend + worker)  |

## Repo layout

```
nadia-dashboard/
├── backend/     # Express API + sync workers
├── frontend/    # Next.js dashboard
├── db/          # SQL schema + migrations
└── docs/        # API notes, architecture, env vars
```

## Build phases

1. **Foundation** — repo, Supabase, schema, Taboola + Codefuel auth (days 1–2)
2. **Sync layer** — hourly cron, join logic, materialized view (days 3–4)
3. **Dashboard UI** — tabs, filters, tables, charts (days 5–6)
4. **Outbrain + auth + deploy** (day 7)

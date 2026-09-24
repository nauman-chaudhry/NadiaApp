# Second dashboard ("Joe") — plan

**Status (2026-09-24):** tenant filter + `ENABLED_SOURCES` **built and verified** (see TRACK.md);
Joe's Supabase project **migrated to 047**; Render/Vercel not yet created; waiting on Nadia for IA
affiliate names, a second Outbrain user (optional) and Joe's email. Launch: as soon as it's ready.
**Client answers (2026-09-17):** same Outbrain/IA credentials as Nadia's → filter required from the
start. Image Advantage only, no other partners for now *(re-confirmed 2026-09-24)*.

**Correction to §2 below (found while building):** filtering at discovery is sufficient for
Taboola but NOT for Outbrain — every Outbrain cost/breakdown job calls `listMarketers()` itself, so
the rule is applied inside `tenantMarketers()` in `sync/outbrain.ts`, on every listing. IA rows are
filtered by affiliate (`TENANT_IA_AFFILIATE_*`). Details: `CLAUDE.md` §13.

---

## 1. Shape

**One repo, deployed twice, with a separate database per entity.** Not a copied directory.

| | Nadia (existing) | Joe (new) |
|---|---|---|
| Frontend | nadia-dashboard-two.vercel.app | joe-dashboard-two.vercel.app |
| API | nadia-api.onrender.com | new Render service |
| Worker | nadia-worker | new Render service |
| Database | existing Supabase | **new Supabase project** |
| Code | same repo, same branch | same repo, same branch |

**Why separate databases, not a tenant column.** The current system has no tenancy concept at all —
no tenant/entity/owner column anywhere — and partner identity is hardcoded in **32 places in
`server.ts` and 10 in the MV**. Retrofitting multi-tenancy means touching the materialized view and
every one of those call sites while Nadia is checking her dashboard each morning, days after a week
of attribution fixes. A separate database gives stronger isolation for less risk.

It also closes a hole that matters here: **the API has no authentication** — only CORS, which is a
browser-only restriction. `curl https://nadia-api.onrender.com/api/filters/options` returns her full
account list with no credentials. Two frontends over one API would give no isolation at all; two
databases make the boundary real.

**Why not a copied directory.** Identical isolation, but two codebases that diverge immediately.
**12 fixes shipped in the last 10 days** (inert GD filter, pair ownership, same-day Outbrain cost,
the GD+campaign 500). Each would need porting by hand, forever. One repo → each fix lands once.

---

## 2. The filter — the actual work

Credentials are shared, and **no sync has any allowlist today**; each takes whatever the credential
returns:
- `listMarketers()` → every Outbrain marketer (12 today)
- `listAllowedAccounts()` → all 19 Taboola sub-accounts
- IA y-metrics endpoints are called **deliberately unfiltered** so new affiliates auto-appear (a
  hardcoded list once lost $46–101/day)

So without a filter, Joe's worker pulls **Nadia's** accounts into Joe's database, and Nadia's worker
pulls Joe's into hers. Duplication does not avoid this; the filter is needed either way.

**Design:** one symmetric, config-driven rule applied at **ingestion only** — the API, MV and
frontend stay untouched, which keeps the change to Nadia's live system small.

```
TENANT_ACCOUNT_INCLUDE   regex — sync only accounts whose name matches
TENANT_ACCOUNT_EXCLUDE   regex — skip accounts whose name matches
```

- Nadia's worker: `TENANT_ACCOUNT_EXCLUDE=^SBH_rev_`
- Joe's worker:   `TENANT_ACCOUNT_INCLUDE=^SBH_rev_`

Applied in `syncOutbrainCampaigns` (marketer registration) and `syncTaboolaMetadata` (account
discovery). Everything downstream keys off `ad_accounts` / `outbrain_campaigns`, so filtering at
discovery is sufficient for cost.

**Per-source toggles.** `ENABLE_CRON` is all-or-nothing today. Joe runs Taboola + Outbrain + IA
only, so this needs an env-driven source list (`ENABLED_SOURCES=taboola,outbrain,image_advantage`)
rather than code changes per deployment.

---

## 3. Open items — cannot be finalised yet

1. **Taboola account naming for Joe.** *(Answered 2026-09-22: his accounts are `TDG - Revlogic
   Media_4945 - Adv N - SC` under a separate network `revlogicmedia4945-network` (2106794). Joe's
   worker needs that as `TABOOLA_ACCOUNT_ID`; Nadia's exclude rule is `^SBH_rev_|Revlogic Media`.
   All 11 accounts are already auto-registered, empty, in Nadia's DB.)* `SBH_rev_` is an **Outbrain marketer** convention. Taboola
   accounts are named `TDG - Seven Sphere Media_4433 - …` and contain no `SBH_` at all, so the
   prefix rule does not transfer. Need the naming (or explicit account ids) for Joe's Taboola side.
2. **IA affiliate mapping.** IA revenue attaches via `campaign_ext_id` to campaigns, and affiliates
   are not mapped to `ad_accounts`. If Joe's DB holds only Joe's campaigns, Nadia's IA revenue does
   not vanish — it lands in Joe's **unattributed** bucket. So IA needs its own affiliate-level
   filter, and the affiliate names are not known yet ("tags not ready").
3. **Outbrain `/login` is rate-limited to 2 req/hour**, token cached to local disk. Two workers =
   two caches; on Render's ephemeral disk a restart forces a fresh login, so both redeploying
   together can 429. Mitigation: stagger deploys, or share the cached token.

Items 1 and 2 block only the filter's *values*, not the mechanism — everything else can proceed.

---

## 4. Sequence

**A. Can start now**
1. `TENANT_ACCOUNT_INCLUDE` / `EXCLUDE` + `ENABLED_SOURCES` in `config/env.ts`, applied in the two
   discovery syncs. Ship to Nadia's worker first with `EXCLUDE=^SBH_rev_` — protects her dashboard
   *before* the accounts go live, which is the time-sensitive part.
2. Provision: new Supabase project, Render API + worker, Vercel project. *(Operator — I don't deploy.)*
3. Run migrations `001…047` against the new database; it starts empty.

**B. Needs Nadia's answers**
4. IA affiliate filter once the tags exist.
5. Taboola account rule for Joe.

**C. Verification before handover** — the same checks used on Nadia's dashboard:
Campaign == Ads on **both spend and revenue**, no account from the other entity present in either
database, and every filter non-inert.

---

## 5. Risk to Nadia's dashboard

Only step A1 touches her system: two env vars and a filter at account discovery. It cannot alter
attribution, the MV, or any existing row — it only stops *new* `SBH_rev_` accounts being registered.
Worst case it excludes too much, which shows up immediately as a missing account and is reverted by
clearing one env var.

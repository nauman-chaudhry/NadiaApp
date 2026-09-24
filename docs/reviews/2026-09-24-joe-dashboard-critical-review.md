# Joe dashboard — critical review

Date: 2026-09-24. Code reviewed: `b0db255` and its tenancy predecessors.

**Verdict: the deployment architecture is sensible, but Joe is not ready for client handover.**
The build adds a second configured instance of the existing reporting product: separate database,
API, worker, authentication project and frontend, with shared source credentials. That avoids a
risky rewrite of Nadia's attribution logic and avoids maintaining two copies of the application.
However, there are confirmed security exposures, an incomplete Flux ingestion path, and a missing
partner-onboarding step. The new database being successfully migrated does not establish that its
reports will reconcile.

## Scope and verification

Reviewed CLAUDE.md, TRACK.md, Joe's plan/checklist, historical reviews and performance findings;
the frontend routes/components/auth/data flow; tenancy, worker and source/sync paths; the current
materialized view and relevant schema migrations; and repository-wide configuration and diagnostic
script inventory. Historical migration copies and one-off scripts were used as supporting context,
not treated as alternate production entry points. This is a code/configuration and targeted live
security review, not a visual acceptance test or a new reconciliation of every historical figure.

Performed:

- Backend TypeScript: `tsc --noEmit -p tsconfig.json` — passed.
- Frontend TypeScript: `tsc --noEmit --incremental false -p tsconfig.json` — passed.
- Actual IA HTTP-client module evaluated with mocked HTTP, then filtered through the actual Joe
  tenant-rule module: nine requested affiliates, all `ssm.*`; zero rows accepted for Joe.
- Actual Joe affiliate-rule checks: `ssm.*` rejected; a Joe-like affiliate, an unrelated third-client
  affiliate and a blank affiliate all accepted.
- Installed Zod behavior checked: `z.coerce.boolean().parse('false')` returns `true`.
- SQL transactions explicitly `READ ONLY` on both databases: table permissions, RLS flags,
  migration version and setup counts only.
- Public Supabase REST requests using the application's public keys and no user session: selected
  only a setting **name** or account **ID**, never the token value or financial data.

Live state at review time: both databases have migration `048`; Joe has **0 accounts, 0 tagged
accounts and 0 partner-stat rows**. Nadia has 45 accounts, 19 tagged accounts and 346,558 partner-stat
rows. Joe's empty database cannot validate spend/revenue reconciliation, even if two empty reports
agree. Render/Vercel deployment settings and an authenticated Joe browser session were not verified.
No sync, migration, email, deployment, token retrieval or production write was performed.

## Findings, in priority order

### 1. Critical — public database access includes the new Outbrain token store

**Confirmed live on both projects.** `app_settings`, `app_users`, `ad_accounts` and
`partner_stats_hourly` have RLS disabled and grant `anon` SELECT and UPDATE. The materialized view
also grants anonymous SELECT. Supabase REST returned HTTP 200 for anonymous reads of
`app_settings` and `ad_accounts` on both projects; Nadia returned one existing row from each,
while Joe's tables were empty.

Migration `048_app_settings.sql:19` creates a table in the public schema without grants/revokes or
RLS protection. `sync/outbrain.ts:23` persists the Outbrain bearer token as its JSON value. The
existing database permission model therefore turns the durable cache into a public credential
store once populated. The shared credential makes this relevant to both clients.

Anonymous write privileges were verified in PostgreSQL metadata, **not exercised**. The review did
not fetch the token value. There is no evidence here of prior third-party access, but the exposure
is established and should be treated as urgent on Nadia's existing system too.

**Required:** restrict browser-role access to backend-only tables and the materialized view; keep
runtime credentials in a private schema or otherwise inaccessible to public/authenticated client
roles; apply appropriate policies to any deliberately exposed tables; secure default privileges for
future migrations. After closing access, invalidate/rotate the exposed Outbrain token through a
controlled process that accounts for the shared login limit. RLS alone is not the solution for a
materialized view: revoke its public access explicitly.

References: `backend/db/048_app_settings.sql:19`, `backend/src/sync/outbrain.ts:23`;
[Supabase API security](https://supabase.com/docs/guides/api/securing-your-api),
[Supabase RLS guidance](https://supabase.com/docs/guides/database/postgres/row-level-security).

### 2. High — the Express reporting API bypasses the dashboard login

`backend/src/api/server.ts:8` installs CORS and JSON parsing, then exposes all reporting routes
without authentication or authorization. `frontend/lib/api.ts:53` sends no user credential. The
Next.js middleware protects frontend navigation, but it cannot protect a separate Express service.
Separate databases prevent accidental shared-query mixing; they do not prevent someone reading
either public API directly.

The role field is also bookkeeping only. `frontend/middleware.ts:25` checks whether a user exists,
not whether that user is approved or an admin. `frontend/app/login/page.tsx:20` does not set
`shouldCreateUser: false`; if signups are enabled in Supabase, the magic-link form can create users.
The review did not verify the hosted signup setting, so arbitrary self-registration is a
configuration-dependent risk, unlike the confirmed missing Express authorization.

**Required:** authorize each reporting request against the correct Supabase project and approved
membership, or use a protected server-side gateway with authenticated backend access. If access is
invite-only, enforce that policy in both hosted auth settings and application authorization. Do not
describe the current role assignment as a working admin feature.

Reference: [Supabase passwordless signup behavior](https://supabase.com/docs/guides/auth/auth-email-passwordless).

### 3. High — Joe's Flux revenue is never requested

`sources/imageadvantage/client.ts:33` hardcodes nine affiliates, all Nadia's `ssm.*` names.
`fetchIAXByUsertag` at line 222 requests only those affiliates. Joe's sync then applies
`TENANT_IA_AFFILIATE_EXCLUDE=^ssm\.` and discards every returned row.

The mocked execution of the real modules confirmed **9 requests → 9 sample rows → 0 rows for Joe**.
`sync/imageadvantage.ts:295` records this empty result as `ok`. New Joe affiliates cannot enter this
path without changing the list. This is especially relevant to the planned `flux.<domain>` sites
mentioned in TRACK.md. It is a definite ingestion gap; its monetary impact remains unmeasured
because Joe has no stored trading data yet.

**Required:** discover or explicitly configure Joe's x-metrics affiliates, apply ownership before
requests where possible, and reconcile actual Joe Flux totals against IA. The existing
`tenant-check` samples yesterday's Yahoo feed only; it does not verify Flux coverage.

### 4. High — account-to-partner setup is missing, and that can lose revenue

Both discovery paths insert accounts without `client_partner_id`; only named Codefuel accounts get
automatic Taboola tagging. Joe's checklist never tags his accounts as `image_advantage`. Replaying
old migrations on an empty database does not replace that onboarding step.

Consequences:

- Joe's accounts remain under **Untagged**, with no Image Advantage project group or IA badge.
- The Yahoo/Flux selector is hidden unless the IA group or an existing feed filter is active.
- More seriously, `047_mv_ia_orphan_deterministic_account.sql:173` uses an **inner** lateral join
  requiring an IA-tagged account. With none, unmatched Taboola/NULL-platform IA revenue disappears
  from the Campaign/Daily materialized view instead of appearing as unattributed.

This does not mean all IA revenue requires tagging: successfully resolved campaign revenue has a
different path. The loss applies to the orphan path, which matters during first-time tracking setup.
Even after tagging, the fallback chooses the lowest account ID, not a proven owner of each orphan;
that preserves totals but does not establish account-level attribution accuracy.

**Required:** explicitly map Joe's advertiser accounts to IA and verify those mappings before
reconciliation. Preserve unmatched revenue even when no owning account exists, and make the
uncertainty visible instead of assigning it to an arbitrary real account.

References: `backend/src/sync/taboola.ts:54`, `backend/src/sync/outbrain.ts:143`,
`frontend/components/FilterBar.tsx:527`, `docs/plans/joe-deploy-checklist.md`.

### 5. High — tenant safety depends on names and permissive defaults

`config/tenant.ts:35` treats missing/blank rules as no restriction. Joe's IA rule means
**anything not called ssm**, not **known to belong to Joe**. The real predicate accepts an empty
affiliate and an unrelated third client's affiliate. The account rules similarly depend on mutable
display names, and Nadia's exclusion accepts any future account that does not match Joe's names.

Changing a rule does not remove already ingested revenue. Attributed IA rows also discard their
original affiliate, making a later ownership cleanup harder. Taboola's item/geo consumers and
Outbrain promoted-link discovery operate over existing DB rows without rechecking current ownership;
the discovery-only protection therefore assumes an uncontaminated database. `tenant-prune` only
removes selected empty account rows, not a contaminated tenant's history.

**Required:** use positive ownership mappings, preferably stable platform account IDs and explicit
affiliate ownership; reject incomplete production configuration; quarantine unknown affiliates; and
preflight destination database identity plus ownership coverage before ingestion. Existing clean
deployments can keep the separate-database design.

### 6. Medium — manual recovery bypasses ENABLED_SOURCES

Cron scheduling and `runDailyBackfill` honor the new source switches. Several documented manual
commands do not: `refresh-all`, `sync-day`, `backfill-full`, and direct source commands call disabled
syncs unconditionally (`workers/run-once.ts:355`, `:392`, `:429`).

Joe's prescribed local setup overlays `.env.joe` while `dotenv/config` still loads missing values
from the default `.env`. If an operator uses a familiar recovery command, Nadia's available
Codefuel credentials can therefore be used against Joe's destination DB despite Codefuel being
disabled. Without those credentials the command can fail partway through. DDC direct commands
have the same absence of a source guard.

**Required:** enforce source policy at every ingest entry point, and give operators an explicit
tenant configuration loader that verifies the target DB and does not silently inherit another
tenant's unused credentials.

### 7. High for trading decisions — hourly reporting changes meaning with the source filter

The real Outbrain hourly query is selected only when `source=outbrain` and no campaign is selected
(`api/server.ts:378`). Under the default **All Traffic Sources**, Hourly instead groups the
materialized view, whose Outbrain records are daily totals at midnight. That can turn a day's
Outbrain activity into an apparent 00:00 spike. Selecting an Outbrain campaign also falls back to
this daily-grain representation rather than producing real campaign-hourly data.

The specialized Outbrain hourly branch additionally ignores supplied status/GD filters, despite
those controls remaining available. This is inherited behavior, but Joe receives it unchanged.

**Required:** combine only genuinely hourly facts, expose unavailable breakdowns explicitly, and
hide/reject unsupported filters. Do not let daily totals appear as measured hourly performance.

### 8. Medium — a green freshness indicator does not mean the report is complete

`api/server.ts:38` uses the newest successful run across any source. The UI displays only this
overall timestamp (`app/dashboard/layout.tsx:31`), while the per-source response omits Outbrain.
A successful Taboola metadata job or a zero-row IA sync can make the dashboard appear fresh while
spend is stale or Flux is absent. The timestamp also does not establish successful MV publication.

TRACK.md's September Outbrain outage demonstrates the business consequence: current revenue plus
stale spend inflated margins. Automatic alerts were deliberately removed by the operator; this
review is not proposing to restore client email without instruction.

**Required:** display separate cost/revenue freshness and coverage, last successful report
publication, and incomplete-data status. Operational detection can be implemented without emailing
clients.

### 9. Medium — ENABLE_CRON=false does not disable the worker

`config/env.ts:53` uses `z.coerce.boolean()`, which converts any non-empty string to true. Confirmed
with the installed dependency: both `'false'` and `'true'` parse as `true`. Starting the worker with
the documented `ENABLE_CRON=false` therefore schedules jobs. This does **not** mean the current
API start command runs cron: it starts a different entry point. It means the advertised worker
disable switch is broken.

**Required:** explicitly parse accepted true/false strings and reject invalid values.

## Product and engineering assessment

**What is strong:** one codebase, isolated data stores, separate web/worker processes, source-aware
scheduled backfills, tenant inspection tooling, bulk IA upserts, and a substantial history of
source reconciliation. The table supports useful operator workflows: searchable filters, numeric
column filters, recomputed totals, frozen columns, sorting and Excel exports. There is no reason to
rewrite the whole application to onboard this second client.

**What still feels specific to Nadia:** branding changes only the title/export prefix/default
account. Joe retains DDC-specific explanatory text despite DDC being disabled
(`DashboardShell.tsx:64`), generic dimension notices that contradict available Outbrain breakdowns,
and all seven tabs regardless of supported data. Capability-driven notices and meaningful empty
states would make the app easier to trust. This assessment comes from code, not a visual browser run.

**A direct workflow defect:** `NavTabs.tsx:23` links to bare routes and drops the query string.
Switching Campaign → Ads loses date/account/source/feed selections, undermining the very comparison
the client uses to validate the numbers. FilterBar also initializes state from the URL without
resynchronizing it on navigation, and mixes immediate application with a separate Apply button.
Server default dates use UTC while browser presets use local dates. Preserve shared filters across
tabs, synchronize displayed/applied state, and state the reporting timezone consistently.

**Performance debt is inherited:** no-store requests reload options/stats, the table renders the
full result, and MV refresh is blocking. The September 22 plan recorded a 90-day Ads timeout and
slow first loads on Nadia's data. Those are historical measurements, not freshly measured Joe
latencies; Joe's empty database hides this issue. Start with measured caching/indexing/loading-state
work after correctness/security, then remeasure on representative data.

**Maintainability:** the 2,565-line API SQL builder and separately maintained MV duplicate attribution
rules. TRACK.md repeatedly records one branch being fixed while another remained wrong. The many
diagnostic scripts provide useful history but are not a repeatable automated regression suite.
Establish fixtures and assertions for revenue conservation, both spend/revenue across Campaign and
Ads, feed partitioning, orphan handling, ownership exclusion, first-run setup, and source gating.
Compare to independent source totals: two reports can agree while both omit Flux revenue.

**The durable token cache is useful but incomplete:** it removes restart-driven logins when the
store is available. Separate per-deployment stores are not shared login coordination, and the client
has no login single-flight or distributed lock. Simultaneous expiry, 401 recovery, cron/backfill
overlap or cache failures can still compete for the same login quota. Secure the store first, then
coordinate refresh and avoid claiming the quota risk has disappeared.

**Documentation needs one current state:** CLAUDE.md §12 still says Joe is unbuilt and migration
047 is latest, while §13/TRACK/checklist describe the implementation and 048. The plan header still
lists resolved questions. The checklist's “everything the code needs is built” claim is too strong
given the Flux and partner-tagging gaps. An executable preflight is more dependable than requiring
the operator to reconcile several partially stale documents.

## Recommended completion order

1. Close anonymous database access and protect the token; then handle token invalidation/rotation.
2. Authenticate/authorize the Express API and enforce the intended invitation policy.
3. Complete Joe Flux ingestion, IA account mapping, and lossless orphan handling.
4. Make ownership and source policy explicit on every ingest/recovery path; fix the cron boolean.
5. Correct hourly semantics, freshness, tab filter continuity and tenant-specific explanatory text.
6. Run a first-trade acceptance matrix against independent partner totals, including Yahoo and Flux
   separately, all Joe accounts, source/account/feed/status combinations, and both spend and revenue.
7. Verify both deployments after the operator deploys, then improve measured performance.

The main launch criterion is not that the pages render or the databases are separate. It is that
only approved users can access the data, only Joe's data enters Joe's store, all of Joe's revenue is
included, and incomplete or estimated figures cannot look like complete measured performance.

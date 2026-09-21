# Image Advantage (AMOS) API — Local Reference

Fetched 2026-05-29 by live API exploration (Theneo docs are JS SPA, not scrapable).

---

## Auth

**POST** `https://api.vpptechia.com/v1/auth/login`

Request (form-encoded, NOT JSON):
```
Content-Type: application/x-www-form-urlencoded
email=nauman1029%40gmail.com&password=nauman
```

Response 200:
```json
{
  "token": "694658|d257JYScNBNvuClynPEnpioQ8MKp1fjosgavB6EIbcee7596",
  "user_id": 511,
  "name": "Nauman Faheem",
  "email": "nauman1029@gmail.com",
  "email_verified_at": null,
  "created_at": "2026-05-21T16:58:06.000000Z",
  "last_login_at": "..."
}
```

Token format: `{id}|{hash}` (Laravel Sanctum personal access token).
Use as: `Authorization: Bearer {token}`.
Token lifetime: unknown — assume short-lived, re-auth per sync run.

---

## Base URL

`https://api.vpptechia.com/v1/`

Response bodies are gzip-compressed (Content-Encoding: gzip). Must pass `--compressed` / decompress client-side.

---

## Endpoints

### Yahoo Metrics (y-metrics) — the active data source for account 398

All are GET requests. Single-day only (no date ranges). Paginated at 5,000 rows/page.

#### Daily revenue (all affiliates)
```
GET /v1/y-metrics/revenue/daily
  ?account_id=398
  &date=YYYY-MM-DD
  &page=1
Headers: Authorization: Bearer {token}, Accept: application/json
```

#### Daily revenue by affiliate (granular)
```
GET /v1/y-metrics/revenue/daily/by-affiliate
  ?account_id=398
  &affiliate=ssm.n2s.hpc.tb
  &date=YYYY-MM-DD
  &page=1
Headers: Authorization: Bearer {token}, Accept: application/json
```

#### Hourly revenue (all affiliates)
```
GET /v1/y-metrics/revenue/hourly
  ?account_id=398
  &date=YYYY-MM-DD
  &page=1
```

#### Hourly revenue by affiliate (granular)
```
GET /v1/y-metrics/revenue/hourly/by-affiliate
  ?account_id=398
  &affiliate=ssm.n2s.hpc.tb
  &date=YYYY-MM-DD
  &page=1
```

Also documented: `/by-device`, `/by-market`, `/eligibility` — not relevant for revenue sync.

### Non-Yahoo Metrics (x-metrics)
`GET /v1/x-metrics/revenue/daily?account_id=398&date=...` → returns empty (total: 0) for this account. Not used.

---

## Response Schema

### Daily row fields
```
y_date            string   "YYYY-MM-DD"
type_tag          string   "{account_id}_{affiliate}_{user_tag}"
searches          int      total searches triggered
bidded_searches   int      searches that returned bidded results
bidded_results    int      total bidded results shown
bidded_clicks     int      clicks on bidded results  ← AD CLICKS equivalent
coverage          float    bidded_searches / searches
ctr               float    bidded_clicks / bidded_results
tq_score          float    traffic quality score
account_id        int      398
affiliate         string   e.g. "ssm.n2s.hpc.tb"
user_tag          string   "{campaign_id}.{item_id}.{site_slug}"  ← JOIN KEY
composition       null
trigger_index     null
temp_affiliate    null
partner_rev_share float    revenue in USD  ← REVENUE equivalent
```

### Hourly row adds
```
y_time            int      hour 0-23 UTC
ad_type           string   "TA" (Text Ads)
```

### Pagination envelope
```json
{
  "current_page": 1,
  "data": [...],
  "last_page": N,
  "total": N,
  "per_page": 5000,
  "first_page_url": "...", "last_page_url": "...",
  "next_page_url": "...|null", "prev_page_url": "...|null"
}
```

---

## Metric Equivalences (vs Codefuel / partner_stats_hourly)

| Dashboard metric | Codefuel field  | Image Advantage field |
|------------------|-----------------|-----------------------|
| revenue          | revenue         | partner_rev_share     |
| ad_clicks        | ad_clicks       | bidded_clicks         |
| sessions         | sessions        | searches              |
| (no equivalent)  | conversions     | —                     |

---

## Affiliates for Account 398

Taboola (in scope):
- `ssm.n2s.hpc.tb` — High Price Click, Taboola
- `ssm.n2s.pro.tb` — Pro product, Taboola
- `ssm.n2s.s4s.tb` — S4S product, Taboola

Outbrain (OUT OF SCOPE — do not sync):
- `ssm.n2s.hpc.ob`
- `ssm.n2s.pro.ob`
- `ssm.n2s.s4s.ob`

---

## JOIN KEY — Critical Detail

`user_tag` format: `{taboola_campaign_id}.{taboola_item_id}.{site_slug}`

Examples:
- `"49396103.1541308.fengwo-padmel"`   → campaign 49396103, item 1541308
- `"49396103.1566326.newclick-cyberspace-bedgut"` → campaign 49396103, item 1566326

`taboola_campaign_id` maps to `campaigns.external_id`
`taboola_item_id` maps to `ads.external_id`

This is DIFFERENT from Codefuel which joins on (gd_param → asset_gid) + (r_param → channel).
Image Advantage does NOT use gd/r URL params.

### Aggregate / unresolved rows
Some rows have placeholder user_tags that cannot be attributed:
- `"ut"` — generic fallback when UT parameter wasn't captured
- `"campaign_id.site_id.site"` — literal template string (misconfigured tracking)

These rows accumulate revenue that can't be joined to a specific campaign.
Observed: on May 20, ALL TB revenue fell into these unattributed rows.
On May 26, most TB revenue was granular (by-affiliate endpoint showed per-campaign data).
Behaviour may stabilize as the integration matures.

---

## Rate Limits
Not documented. Unknown.

---

## Data Availability
- Account 398 created: 2026-05-21
- First TB revenue data: ~2026-05-20
- No historical data before May 2026
- API: single-day queries only — must loop day-by-day for backfill

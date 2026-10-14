# Message to Nadia — Accounts tab + Click Margin $ (2026-10-14)

**Context:** her 2026-10-14 requests — (1) a tab showing all active accounts by feed provider with a
previous-day performance summary so she can see which account to prioritise, (2) a "Clicks Margin $"
column on all performance tabs, formula `RPC's - Yahoo CPA`. Both built, deployed and verified live
(see TRACK.md 2026-10-14).

**Figures below are month-to-date, 2026-10-01..2026-10-13**, read from the live dashboard. Deliberately
NOT yesterday-only: her complaint was about *this month*, and 13 Oct on its own was positive
(+$102.76), which would have misrepresented the trend. Spend and revenue cover the same window on
every row — the Accounts tab reads one joined view, so the window-mismatch error that nearly went out
in the glance.com message is not possible here.

**SBH_ssm_08 is deliberately NOT presented as a losing account.** It is untagged, so its spend shows
without matched revenue; calling that a performance problem would be the same mistake as the
glance.com draft. It is framed as an open question instead.

---

Hi Nadia,

Both of your requests are live on the dashboard now.

**1. New "Accounts" tab**

It's the first tab, and it opens on **yesterday** by default. Accounts are grouped by feed provider,
and each provider has a summary line showing Spend, Revenue, Profit and Margin — with the biggest
loss sorted to the top of each group, so the account needing attention is the first one you see. You
can change the date range like on any other tab, and export it to Excel.

**2. "Click Margin $" column**

Added to every tab, sitting between Yahoo CPA and Profit, using your formula:
**Click Margin $ = RPC's − Yahoo CPA**. It's your profit per click, so a negative figure means that
row is losing money on every click it buys.

**What it shows for 1–13 October**

Overall you're at **$24,699.70 spend / $26,009.79 revenue = +$1,310.09 profit (5.04%)** — thin, but
positive. The reason it's thin is concentrated in a few accounts:

*Losing money:*

| Account | Feed | Spend | Revenue | Profit | Margin |
|---|---|---|---|---|---|
| SBH_ssm_09 | DDC | $2,552.38 | $1,446.94 | **−$1,105.44** | −76.4% |
| SBH_ssm_02 | Codefuel | $1,388.96 | $1,004.67 | −$384.29 | −38.3% |
| SBH_ssm_07 | Image Advantage | $4,535.79 | $4,255.71 | −$280.08 | −6.6% |
| SBH_ssm_03 | Codefuel | $240.62 | $75.92 | −$164.70 | −216.9% |
| SBH_ssm_11 | Codefuel | $299.01 | $244.95 | −$54.06 | −22.1% |

*Making money:*

| Account | Feed | Spend | Revenue | Profit | Margin |
|---|---|---|---|---|---|
| SBH_ssm_06 | Image Advantage | $6,787.22 | $8,238.04 | **+$1,450.82** | 17.6% |
| SBH_ssm_05 | Image Advantage | $7,474.22 | $8,062.69 | +$588.47 | 7.3% |
| SBH_ssm_14 | Codefuel | $390.83 | $806.01 | +$415.18 | 51.5% |
| SBH_ssm_01 | Codefuel | $857.14 | $1,132.60 | +$275.46 | 24.3% |

**SBH_ssm_09 (DDC) is the clear priority** — it's losing $1,105 this month at −76% margin, which
cancels out most of what the rest of the business earns. After that it's SBH_ssm_02, then SBH_ssm_07
(small percentage, but on the second-largest spend in the business, so it moves the most money).
Together the loss-making accounts are costing about $2,160 — without them you'd be at roughly $3,470
profit instead of $1,310.

**Two things I need from you:**

1. **SBH_ssm_08** shows $173.53 of spend and $0 revenue. That's because we've still never been told
   which feed provider it belongs to, so its revenue can't be matched to it — it's not necessarily a
   loss, it may just be unmatched. Same question still open for SBH_ssm_10. Can you confirm which
   partner each of those two feeds?
2. There's **$474.13 of revenue this month that doesn't tie back to any account** (shown as
   "Unattributed" at the bottom of the tab). It's counted in your totals so nothing is missing, but it
   can't be credited to a specific account until the tracking tags line up. This is the same
   tracking-template issue I've raised before.

Let me know if you'd like the Accounts tab to default to a different period than yesterday.

---

## Source figures (for our records)

Live read of `/dashboard/accounts?from=2026-10-01&to=2026-10-13`, sorted by profit ascending:

```
SBH_ssm_09          DDC               2552.38   1446.94  -1105.44   -76.40%
SBH_ssm_02          Codefuel          1388.96   1004.67   -384.29   -38.25%
SBH_ssm_07          Image Advantage   4535.79   4255.71   -280.08    -6.58%
SBH_ssm_08          (Untagged)         173.53      0.00   -173.53     0.00%
SBH_ssm_03          Codefuel           240.62     75.92   -164.70  -216.94%
SBH_ssm_11_Codefuel Codefuel           299.01    244.95    -54.06   -22.07%
SBH_ssm_12/13       Codefuel             0.00      0.00      0.00     0.00%
TDG - SSM_4433 LGA3 Image Advantage      0.00    268.12    268.12   100.00%
SBH_ssm_01          Codefuel           857.14   1132.60    275.46    24.32%
SBH_ssm_14_Codefuel Codefuel           390.83    806.01    415.18    51.51%
(Unattributed)      —                    0.00    474.13    474.13   100.00%
SBH_ssm_05          Image Advantage   7474.22   8062.69    588.47     7.30%
SBH_ssm_06          Image Advantage   6787.22   8238.04   1450.82    17.61%
TOTAL                                24699.70  26009.79   1310.09     5.04%
```

Per-provider: Codefuel 7 accounts +$87.59 (2.68%) · DDC 1 account −$1,105.44 (−76.40%) ·
Image Advantage 4 accounts +$2,027.34 (9.74%) · Unattributed +$474.13 · Untagged −$173.53.

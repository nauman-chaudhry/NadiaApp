# Reply to Nadia — matching fixed and live (drafted 2026-09-04)

Hi Nadia,

You were right — I was matching the wrong thing. I'd been matching the TT against Outbrain's internal
IDs, which worked for the few you built with the `ad_id` macro and could never work for the ones you
made manually. The tag is in the ad's landing URL, so I'm now reading it from there and matching the
first 34 characters, the same way you do in Excel.

**It's live, and everything matches from 22 July to 2 September:**

- **$7,093.41** of DDC revenue, tying to your DDC report **to the cent, day by day, all 43 days**
- **32 campaigns** and **135 ads** now carry their own revenue — nothing left unattributed
- SBH_ssm_09: **$8,933.03 spent, $7,093.41 earned, −$1,839.62 at −25.9%**

**Going forward:** nothing for you to do. The dashboard reads both the manual TTs and the `ad_id`
macro, so all history stays as-is and new macro-built campaigns match automatically. Switch whenever.

**One caveat before you act on per-ad numbers.** About a third of the TTs are used on more than one
ad, and DDC only reports at tag level. So campaign and account totals are exact, but per-ad revenue
is exact for roughly a third and a click-weighted split for the rest. One unique TT per ad fixes
that — which the `ad_id` macro now gives you automatically.

**On publisher performance.** DDC only started sending the publisher ID on 28 August, so a
like-for-like comparison is only possible from then. For 28 Aug – 2 Sep:

| Publisher | Spend | Revenue | Profit |
|---|---|---|---|
| sportscentralnews | $1,010.55 | $300.18 | −$710.37 |
| glance.com | $618.76 | $536.49 | −$82.27 |
| Soccer News Reports | $123.55 | $136.29 | +$12.74 |
| Journey Peaks | $112.34 | $128.23 | +$15.89 |

**sportscentralnews is the one costing you money** — half the window's spend for a fifth of its
revenue. It's only six days of data, so worth watching another week before cutting, but that's where
I'd look first.

DDC's reporting runs about two days behind, so the dashboard is complete to 2 September and fills in
the rest automatically.

Thanks,
Nauman

# Reply to Nadia — DDC refresh, schedule, hourly (drafted 2026-09-05)

Hi Nadia,

Good to hear — and yes, connecting new accounts is straightforward now. Same setup, different
domains per partner, and they'll come through automatically.

**Refreshed — yesterday is in.** The dashboard now shows 4 September at **$238.13**, matching your
screenshot exactly. 1–4 September all tie to your console to the cent.

**You're right about the timing, and I was wrong.** Their data isn't two days behind. What actually
happens is their API sometimes replies "no stats for this date" for a day that *does* have data —
I asked for 4 September three times and got nothing, then asked again and it returned the full
$238.13, with nothing changed in between. That's what I mistook for a delay. I've changed our side
to retry, and to cross-check each day against their own daily totals, so a blip can't quietly leave
a day at zero any more.

**Automated pulls are set up: every 3 hours.** That covers your 11:45 window and the times they run
late, and it means we don't depend on their publishing at exactly the same time each day. Each run
re-checks the last 4 days, so anything missed gets picked up on the next pass without me touching it.

**On hourly — yes, it exists.** I've just tested it and it works: an hourly feed covering the last
~3 days, broken down by hour, country, device and campaign tag. I checked it against your daily
numbers and it matches ($210.02 vs $210.01 for the 3rd). Two things worth knowing:

- It adds a **device breakdown** (Smart Phones / Desktop), which the daily report doesn't have.
- TQ is in the feed but still reads 0.00, same as before.

It's not wired into the dashboard yet — want me to add it? It would give you an Hourly tab for DDC
and device-level reporting. Say the word and I'll set it up.

Thanks,
Nauman

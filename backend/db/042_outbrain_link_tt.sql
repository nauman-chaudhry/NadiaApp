-- Migration 042: store the DDC type tag that lives in each Outbrain promoted
-- link's landing URL.
--
-- THE BUG THIS FIXES. DDC reports revenue keyed by `tt`, and we were trying to
-- resolve that value against Outbrain object IDs (campaign_id / link_id). It is
-- not an Outbrain ID — Outbrain's own API answers `{"message":"Invalid id ..."}`
-- for them. 91 of 101 live tags matched nothing and 82.8% of DDC revenue could
-- only be shown at account level.
--
-- `tt` is a URL parameter the client puts in the ad's landing page, exactly as
-- documented in her setup notes:
--
--   startgonow.com/<path>/?amxt=blue&tmpl=C244&tt=<34-hex>&kw=<keywords>
--
-- So the join is DDC.tt -> the `tt` inside the promoted link's own URL. Verified
-- against the live Outbrain API: all 235 promoted links on SBH_ssm_09 carry a
-- `tt=` param, 196 distinct values, and they resolve **100% of DDC revenue**
-- (the only 3 unmatched tags are `{{ad` — an unsubstituted macro — plus the
-- `abc123` example from the docs and a literal `null`, all worth $0.00).
--
-- Grain: a tt maps to one promoted link 158 times out of 196, but 38 tags are
-- reused across several links and campaigns, so revenue for those has to be
-- allocated by traffic rather than assigned outright. The column is therefore
-- NOT unique.

ALTER TABLE outbrain_ad_links
  ADD COLUMN IF NOT EXISTS tt_param TEXT;

-- Lookup is always tt -> links, so index that direction. Partial: most rows will
-- have a tt, but never index the empty ones.
CREATE INDEX IF NOT EXISTS idx_ob_ad_links_tt
  ON outbrain_ad_links (tt_param)
  WHERE tt_param IS NOT NULL AND tt_param <> '';

COMMENT ON COLUMN outbrain_ad_links.tt_param IS
  'DDC type tag parsed from the promoted link''s landing URL (?tt=...). Joins to '
  'partner_stats_hourly.campaign_ext_id with the ob: prefix stripped, for DDC rows. '
  'Not unique: one tag can be reused across links and campaigns.';

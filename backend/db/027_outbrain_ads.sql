-- Migration 027: outbrain_ads — (gd, r) -> Outbrain campaign map
--
-- Outbrain promoted-link URLs carry gd= (the GID) and r= (the promoted-link id).
-- Codefuel-Outbrain revenue is keyed by (asset_gid = gd, channel = r). This table
-- maps each (gd, r) to its Outbrain campaign so that Codefuel-Outbrain revenue can
-- be attributed per campaign (the analog of the Taboola `ads` table). Verified:
-- 100% of Codefuel-Outbrain revenue matches a (gd, r) here.

CREATE TABLE IF NOT EXISTS outbrain_ads (
  gd_param    TEXT NOT NULL,
  r_param     TEXT NOT NULL,
  campaign_id TEXT NOT NULL REFERENCES outbrain_campaigns(campaign_id) ON DELETE CASCADE,
  updated_at  TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (gd_param, r_param)
);
CREATE INDEX IF NOT EXISTS idx_ob_ads_campaign ON outbrain_ads (campaign_id);

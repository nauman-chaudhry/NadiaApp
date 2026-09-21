-- Migration 029: outbrain_ad_links — promoted-link id -> campaign
--
-- IA-Outbrain user_tag's first segment is EITHER an Outbrain campaign_id OR a
-- promoted-link id (the spec's "campaign_id OR ad_id"; ~25% of revenue uses the
-- ad_id form). This table maps each promoted-link id to its campaign so those
-- rows attribute to the right campaign instead of showing as unnamed
-- "(Outbrain campaign <hex>)" rows. Populated by syncOutbrainPromotedLinks.

CREATE TABLE IF NOT EXISTS outbrain_ad_links (
  link_id     TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL REFERENCES outbrain_campaigns(campaign_id) ON DELETE CASCADE,
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ob_adlinks_campaign ON outbrain_ad_links (campaign_id);

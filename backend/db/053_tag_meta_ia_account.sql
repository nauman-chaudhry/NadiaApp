-- 053: tag the Meta ad account "Yahoo - Image Advantage" to Image Advantage.
--
-- Meta cost ingestion (sync/meta.ts, 2026-11-19) registers Meta ad accounts in
-- ad_accounts under platform 'facebook' with client_partner_id = NULL, like every
-- other platform: the revenue partner is a business fact the API cannot tell us.
-- This account monetises through IA — its name says so, Nadia calls it "Meta_IA",
-- and 100% of IA's attributed Meta revenue since 1 Sep ($1,012.45) carries one
-- of its campaign ids. Untagged, it would sit outside every Project filter.
--
-- Matched on external_id (the Meta ad account id), never name.
-- Idempotent; an existing non-NULL tag is never overwritten. On a database where
-- the Meta sync has not yet run (e.g. Joe's), this matches nothing.

UPDATE ad_accounts a
   SET client_partner_id = (SELECT id FROM client_partners WHERE code = 'image_advantage')
 WHERE a.platform_id = (SELECT id FROM platforms WHERE code = 'facebook')
   AND a.client_partner_id IS NULL
   AND a.external_id = 'act_1024718543367189';  -- Yahoo - Image Advantage

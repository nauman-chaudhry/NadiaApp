-- 051: tag SBH_ssm_08 and SBH_ssm_15_IA_Flux to Image Advantage.
--
-- Both Outbrain marketers auto-registered with client_partner_id = NULL, which
-- is deliberate (see the comment in sync/outbrain.ts) — a marketer's revenue
-- partner is a business fact the API cannot tell us, so it is always set by
-- hand. Nadia confirmed both on 2026-11-09/10:
--
--   SBH_ssm_08           $13,857.95 spend / 554,731 clicks over 32 days from 1 Oct
--   SBH_ssm_15_IA_Flux      $475.13 spend /   7,345 clicks over 21 days from 19 Oct
--
-- Until now both sat outside every Project filter, so that spend was invisible
-- in the per-partner views.
--
-- Matched on external_id (the Outbrain marketer id), not name: names are edited
-- in the Outbrain UI and re-synced, ids are not.
--
-- NOTE (SBH_ssm_08): no IA revenue currently resolves to this account's
-- campaigns, so it will show spend against zero revenue until we learn which IA
-- affiliate reports its traffic. That question is with Nadia. Tagging it is
-- still correct — the spend belongs under IA either way.
--
-- Idempotent: re-running changes nothing, and an existing non-NULL tag is never
-- overwritten (never clobber a manual decision — cf. migration 031's ELSE 1).

UPDATE ad_accounts a
   SET client_partner_id = (SELECT id FROM client_partners WHERE code = 'image_advantage')
 WHERE a.platform_id = 2
   AND a.client_partner_id IS NULL
   AND a.external_id IN (
     '00d24b7bb4d1d6ad24c6af7d1c876800a7',  -- SBH_ssm_08
     '000fd51e0a010baa2f9cf4bc63070880a6'   -- SBH_ssm_15_IA_Flux
   );

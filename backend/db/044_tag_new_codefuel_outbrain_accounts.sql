-- Migration 044: tag the four new Outbrain accounts as Codefuel.
--
-- The client had Outbrain create SBH_ssm_11..14_Codefuel and is launching
-- campaigns into them now. Everything else about them already works on its own:
-- `syncOutbrainCampaigns` auto-registered each marketer as an ad_accounts row,
-- and campaigns, promoted links, gd/r extraction and cost all iterate every
-- marketer, so they sync with no code change. The ONLY manual step is the
-- partner tag, which is deliberately left NULL at registration so an account is
-- never silently mis-assigned (see the comment in sync/outbrain.ts).
--
-- `ad_accounts.client_partner_id` is the sole link between an ad account and its
-- monetizer and is what powers the Project filter, so until this runs the four
-- accounts show as "Untagged" and are invisible under Project = Codefuel.
--
-- Tagged EXPLICITLY by external_id, one row at a time. Migration 031 used
-- `CASE ... ELSE 1` (= Codefuel) as a catch-all, which would silently mis-tag
-- any future marketer that is not Codefuel — DDC's SBH_ssm_09 would have been
-- wrong under that rule. CLAUDE.md §10 calls that pattern out; do not copy it.
--
-- Idempotent: the WHERE clause skips rows already tagged, so re-running is a
-- no-op, and platform_id = 2 scopes it to Outbrain.

UPDATE ad_accounts
   SET client_partner_id = (SELECT id FROM client_partners WHERE code = 'codefuel')
 WHERE platform_id = 2
   AND external_id IN (
     '00e08fd8f3e785f72ac0e8b550267ffd95',  -- SBH_ssm_11_Codefuel
     '00a5d7c0f1a2cd752729f448f91bbd4f64',  -- SBH_ssm_12_Codefuel
     '00f30d1605c0a1ecbde733e0374c647f0f',  -- SBH_ssm_13_Codefuel
     '004953330df8247f6039290af5d47db843'   -- SBH_ssm_14_Codefuel
   )
   AND client_partner_id IS DISTINCT FROM (SELECT id FROM client_partners WHERE code = 'codefuel');

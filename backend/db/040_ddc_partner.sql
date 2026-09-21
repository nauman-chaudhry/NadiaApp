-- Migration 040: register DDC as a revenue partner and tag its Outbrain account.
--
-- DDC (Domain Development Corp) is the third monetization partner, alongside
-- Codefuel and Image Advantage. It monetizes Outbrain marketer SBH_ssm_09, which
-- has been spending since 2026-07-22 with no revenue wired in.
--
-- This migration adds NO COLUMNS and changes NO CONSTRAINT:
--   * DDC rows reuse partner_stats_hourly's existing ATTRIBUTED row shape.
--   * granularity = 'daily' (already allowed by the CHECK). DDC writes no
--     'hourly' rows at all, so the MV's hourly-wins de-dup can never shadow it.
--     A dedicated 'ddc-daily' value was considered and rejected: it would fall
--     into the same fallback arm of the MV's `ps` CTE as 'daily' (x-daily is
--     exempt only because 037 names it explicitly), so it would buy nothing
--     while costing an ACCESS EXCLUSIVE CHECK rebuild on the largest table.
--   * TQ / Source TQ are NOT stored — the client asked to defer them, and the
--     stats API retains 40+ days so they can be added AND backfilled later.
--
-- Ordering matters: this must land before 041, which rebuilds the MV with CTEs
-- that join client_partners on code = 'ddc'. A missing row there returns zero
-- rows SILENTLY rather than erroring. Filename order guarantees it.

-- 1. The partner.
INSERT INTO client_partners (code, name)
VALUES ('ddc', 'DDC / Domain Development Corp')
ON CONFLICT (code) DO NOTHING;

-- 2. Tag the account. ad_accounts.client_partner_id is the ONLY link between an
--    ad account and its monetizer, and it powers the Project filter. The client
--    confirmed partners are one-per-account and that SBH_ssm_09 is DDC's only
--    account for now; SBH_ssm_08 and SBH_ssm_10 are deliberately left untagged.
--
--    Scoped by platform_id = 2 (Outbrain) as well as external_id, so this can
--    never touch a Taboola account that happens to share an external id.
UPDATE ad_accounts
   SET client_partner_id = (SELECT id FROM client_partners WHERE code = 'ddc')
 WHERE platform_id = 2
   AND external_id = '005f9aba0aa397a39cb174bc7b69c1e1fa'
   AND client_partner_id IS DISTINCT FROM (SELECT id FROM client_partners WHERE code = 'ddc');

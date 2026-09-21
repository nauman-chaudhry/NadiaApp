-- Migration 031: register Outbrain marketers as ad_accounts
--
-- Adds the 7 SBH_ssm_XX Outbrain marketers to ad_accounts so they appear in the
-- account dropdown and so account-based filtering works on Outbrain rows. Each is
-- tagged with its revenue partner (ssm_01..04 = Codefuel, ssm_05..07 = Image
-- Advantage) — this is what makes the partner filter compose with the source
-- filter for Outbrain (e.g. source=outbrain + Codefuel account group ->
-- Codefuel-Outbrain only) without any new query param.

INSERT INTO ad_accounts (platform_id, external_id, name, client_partner_id, status, currency, timezone)
SELECT 2 AS platform_id,
       oc.marketer_id,
       MAX(oc.account_name) AS name,
       CASE WHEN MAX(oc.account_name) IN ('SBH_ssm_05','SBH_ssm_06','SBH_ssm_07') THEN 2 ELSE 1 END AS client_partner_id,
       'active', 'USD', 'America/New_York'
FROM outbrain_campaigns oc
WHERE NOT EXISTS (
  SELECT 1 FROM ad_accounts a WHERE a.platform_id = 2 AND a.external_id = oc.marketer_id
)
GROUP BY oc.marketer_id;

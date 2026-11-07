import { query } from '../src/db/client';
const p=(t:string,r:any)=>{console.log('\n### '+t); console.table(r);};
async function main(){
  const base = `
    WITH ia AS (SELECT left(p.item_ext_id,29) k, SUM(p.revenue) rev, SUM(p.ad_clicks) acl, SUM(p.sessions) ses
                FROM partner_stats_hourly p JOIN client_partners cp ON cp.id=p.client_partner_id
                WHERE cp.code='image_advantage' AND p.source_platform='Outbrain'
                  AND p.hour_utc>='2026-10-01' AND p.hour_utc<'2026-11-01' GROUP BY 1),
         ob AS (SELECT left(publisher_uuid,29) k, MAX(publisher_name) nm, SUM(spent) sp, SUM(clicks) cl
                FROM outbrain_publisher_daily WHERE day_utc>='2026-10-01' AND day_utc<'2026-11-01' GROUP BY 1),
         j AS (SELECT ob.nm, ob.sp, ob.cl, COALESCE(ia.rev,0) rev, COALESCE(ia.acl,0) acl
               FROM ob LEFT JOIN ia ON ia.k=ob.k WHERE ob.sp>0)`;

  p('October: all matched publishers, bucketed by outcome', await query(base + `
    SELECT CASE WHEN rev=0 THEN 'A. zero revenue'
                WHEN rev < sp*0.5 THEN 'B. revenue < 50% of spend'
                WHEN rev < sp     THEN 'C. loss-making'
                ELSE 'D. profitable' END AS bucket,
           COUNT(*) AS publishers, ROUND(SUM(sp)::numeric,2) AS spend,
           ROUND(SUM(rev)::numeric,2) AS revenue, ROUND(SUM(rev-sp)::numeric,2) AS profit
    FROM j GROUP BY 1 ORDER BY 1`));

  p('October: worst 10 by loss, spend >= $50 (volume-gated)', await query(base + `
    SELECT nm AS publisher, ROUND(sp::numeric,2) AS spend, ROUND(rev::numeric,2) AS revenue,
           ROUND((rev-sp)::numeric,2) AS loss, cl AS ob_clicks, acl AS feed_clicks,
           ROUND((acl::numeric/NULLIF(cl,0)),3) AS feedclick_per_obclick
    FROM j WHERE sp>=50 AND rev<sp ORDER BY (rev-sp) ASC LIMIT 10`));

  p('October headline', await query(base + `
    SELECT COUNT(*) AS publishers, ROUND(SUM(sp)::numeric,2) AS total_spend,
           ROUND(SUM(rev)::numeric,2) AS total_revenue,
           COUNT(*) FILTER (WHERE rev<sp AND sp>=50) AS losers_over_50,
           ROUND(SUM(sp-rev) FILTER (WHERE rev<sp AND sp>=50)::numeric,2) AS loss_from_those
    FROM j`));
}
main().then(()=>process.exit(0)).catch(e=>{console.error('ERR',e.message);process.exit(1);});

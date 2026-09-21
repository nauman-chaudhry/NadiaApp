import pg from 'pg';
const conn=process.env.DATABASE_URL, deadline=Date.now()+45*60*1000;
const iso=d=>d.toISOString().slice(0,10);
const yest=iso(new Date(Date.now()-864e5));
while (Date.now()<deadline) {
  const p=new pg.Pool({connectionString:conn,max:1}); p.on('error',()=>{});
  try{
    const r=(await p.query(`SELECT to_char(started_at,'HH24:MI') t, window_start::date::text d
      FROM sync_runs WHERE source='codefuel' AND started_at > now()-INTERVAL '70 minutes' ORDER BY started_at`)).rows;
    if (r.some(x=>x.d===yest)) {
      const h=(await p.query(`SELECT ROUND(revenue::numeric,2)::text rev FROM partner_stats_hourly ps
        JOIN client_partners cp ON cp.id=ps.client_partner_id
        WHERE cp.code='codefuel' AND ps.granularity='hourly' AND ps.hour_utc::date=$1::date
          AND EXTRACT(HOUR FROM hour_utc)=23 LIMIT 1`,[yest])).rows;
      console.log(`NEW CODE CONFIRMED: ${r.length} codefuel runs this hour, days requested = ${[...new Set(r.map(x=>x.d))].join(', ')}`);
      console.log(`  ${yest} h23: ${h.length? '$'+h[0].rev+'   <-- GAP CLOSED' : 'STILL MISSING'}`);
      await p.end(); process.exit(0);
    }
    console.log(`[${new Date().toISOString().slice(11,16)}Z] still ${r.length} run(s)/hr, days=${[...new Set(r.map(x=>x.d))].join(',')||'none'}`);
  }catch(e){console.log('poll error:',e.message);}
  await p.end().catch(()=>{});
  await new Promise(r=>setTimeout(r,240000));
}
console.log('DEADLINE REACHED: new codefuel code never ran - worker not redeployed with this commit');

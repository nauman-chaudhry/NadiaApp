import { fetchFilterOptions, fetchStats, type StatsFilters, type StatsView } from '@/lib/api';
import { getAccessToken } from '@/lib/supabase/server';
import { Suspense } from 'react';
import FilterBar from './FilterBar';
import StatsTable from './StatsTable';

// Force dynamic rendering — DashboardShell makes live API calls that must not
// be cached or attempted at build time.
export const dynamic = 'force-dynamic';

interface Props {
  view: StatsView;
  searchParams: Record<string, string | undefined>;
  note?: string;
}

function today() { return new Date().toISOString().slice(0, 10); }
function daysAgo(n: number) {
  const d = new Date(); d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

export default async function DashboardShell({ view, searchParams, note }: Props) {
  const resolvedFrom = searchParams.from ?? daysAgo(13);
  const resolvedTo   = searchParams.to   ?? today();
  const token = await getAccessToken();
  const [options, stats] = await Promise.all([
    fetchFilterOptions(token),
    fetchStats({
      view,
      from:        resolvedFrom,
      to:          resolvedTo,
      account_id:  searchParams.account_id,
      campaign_id: searchParams.campaign_id,
      country:     searchParams.country,
      device:      searchParams.device,
      status:      searchParams.status,
      gd:          searchParams.gd,
      site:        searchParams.site,
      source:      searchParams.source,
      feed:        searchParams.feed,
    } as StatsFilters, token),
  ]);

  // Outbrain-specific tab notes:
  //   - Ads/Country/Site: now have real data. Show a caveat only when a campaign
  //     filter is active for Country/Site (Outbrain returns marketer-level data for
  //     those dims — the campaign filter has no effect on them).
  //   - Device: no API data available; tell Nadia rather than showing a blank table.
  //   - Hourly: Outbrain is daily-grain only; keep the existing explanation.
  // Country / Device / Site are Taboola-attributed only, and Image Advantage -- ~87%
  // of current revenue -- reports NO country and NO device at all (0 of 24,445 rows).
  // With Taboola cost stopped upstream these tabs therefore show a small fraction of
  // the business and can read as "the data is missing" rather than "this dimension is
  // not reported". Say so explicitly instead of leaving a near-empty table unexplained.
  const dimView = view === 'country' || view === 'device' || view === 'site';
  const dimCoverageNote = dimView
    ? `This tab breaks down only revenue that partners report with a ${view === 'site' ? 'publisher/site' : view}. Image Advantage does not report ${view === 'site' ? 'site' : view} at all, and Outbrain reports no ${view === 'site' ? 'site' : view}-level cost, so spend shows as 0 here and most revenue appears under "(Unattributed)". Use the Campaign tab for complete spend and revenue.`
    : undefined;

  const obSource = searchParams.source === 'outbrain';
  const obCampFiltered = obSource && !!searchParams.campaign_id;
  const outbrainDetailNote =
    obSource && view === 'device'
      // Outbrain exposes no device-level COST, but DDC's hourly feed carries
      // device, so revenue can be split even though spend cannot.
      ? 'Revenue is split by device from DDC. Outbrain does not expose device-level cost, so spend shows as 0 here — use the Campaign tab for spend. Device data covers roughly the last 3 days, which is how far back DDC\'s hourly feed goes.'
      : obSource && view === 'hourly'
        ? (searchParams.campaign_id
            ? 'Outbrain hourly cost is account-level only — the campaign filter is not applied. Clear the campaign filter to see the hourly breakdown.'
            // DDC now has a real hourly feed, but only for a rolling ~3 days.
            // Older days hold daily totals, which would otherwise all land at
            // hour 0, so they are excluded here rather than shown falsely.
            : 'DDC revenue is shown hourly for roughly the last 3 days, which is how far back DDC\'s hourly feed goes. Earlier days are daily totals and are not split by hour — use the Campaign or Daily tab for those.')
        : obCampFiltered && (view === 'country' || view === 'site')
          ? `Outbrain reports ${view === 'country' ? 'country' : 'publisher/site'} at the account level — the campaign filter is not applied to these figures. Showing all spend for the selected account(s).`
          : undefined;
  return (
    <>
      <Suspense><FilterBar options={options} /></Suspense>
      {/* Outbrain notice goes ABOVE the table — these views are empty/rolled-up
          under Outbrain, so a note below would sit off-screen and never be seen. */}
      {!outbrainDetailNote && dimCoverageNote && (
        <p className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded px-3 py-2 mb-3">
          {dimCoverageNote}
        </p>
      )}
      {outbrainDetailNote && (
        <p className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded px-3 py-2 mb-3">
          {outbrainDetailNote}
        </p>
      )}
      <StatsTable view={view} data={stats.rows} totals={stats.totals} accounts={options.accounts} from={resolvedFrom} to={resolvedTo} />
      {note && <p className="text-xs text-gray-400 mt-3">{note}</p>}
    </>
  );
}

export const dynamic = 'force-dynamic';
import DashboardShell from '@/components/DashboardShell';

export default function SitePage({ searchParams }: { searchParams: Record<string, string | undefined> }) {
  return (
    <DashboardShell view="site" searchParams={searchParams}
      note="Site rows show Taboola publisher cost with Image Advantage revenue matched per site. Codefuel does not report a site breakdown, so its revenue appears as one aggregate row. Site cost is account-level: campaign and GD filters show no rows." />
  );
}

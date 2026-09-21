export const dynamic = 'force-dynamic';
import DashboardShell from '@/components/DashboardShell';


export default function AdsPage({ searchParams }: { searchParams: Record<string, string | undefined> }) {
  return <DashboardShell view="ads" searchParams={searchParams} />;
}

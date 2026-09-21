export const dynamic = 'force-dynamic';
import DashboardShell from '@/components/DashboardShell';

export default function CampaignPage({ searchParams }: { searchParams: Record<string, string | undefined> }) {
  return <DashboardShell view="campaign" searchParams={searchParams} />;
}

export const dynamic = 'force-dynamic';
import DashboardShell from '@/components/DashboardShell';

export default function HourlyPage({ searchParams }: { searchParams: Record<string, string | undefined> }) {
  return <DashboardShell view="hourly" searchParams={searchParams} />;
}

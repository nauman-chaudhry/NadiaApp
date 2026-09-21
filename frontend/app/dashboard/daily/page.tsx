export const dynamic = 'force-dynamic';
import DashboardShell from '@/components/DashboardShell';

export default function DailyPage({ searchParams }: { searchParams: Record<string, string | undefined> }) {
  return <DashboardShell view="daily" searchParams={searchParams} />;
}

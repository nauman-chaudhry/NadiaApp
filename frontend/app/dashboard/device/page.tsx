export const dynamic = 'force-dynamic';
import DashboardShell from '@/components/DashboardShell';

export default function DevicePage({ searchParams }: { searchParams: Record<string, string | undefined> }) {
  return <DashboardShell view="device" searchParams={searchParams} />;
}

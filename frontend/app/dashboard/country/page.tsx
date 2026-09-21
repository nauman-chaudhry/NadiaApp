export const dynamic = 'force-dynamic';
import DashboardShell from '@/components/DashboardShell';

export default function CountryPage({ searchParams }: { searchParams: Record<string, string | undefined> }) {
  return <DashboardShell view="country" searchParams={searchParams} />;
}

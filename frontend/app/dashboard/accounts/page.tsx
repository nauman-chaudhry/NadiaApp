export const dynamic = 'force-dynamic';
import DashboardShell from '@/components/DashboardShell';

export default function AccountsPage({ searchParams }: { searchParams: Record<string, string | undefined> }) {
  return (
    <DashboardShell view="accounts" searchParams={searchParams}
      note="One row per active account, grouped by revenue partner. Totals match the Campaign tab for the same filters — both read the same joined view. Accounts with no activity in the period are not listed." />
  );
}

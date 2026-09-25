import { fetchSyncStatus } from '@/lib/api';
import { getAccessToken } from '@/lib/supabase/server';
import { APP_NAME } from '@/lib/brand';
import NavTabs from './NavTabs';
import SignOutButton from './SignOutButton';

function relativeTime(iso: string | null): string {
  if (!iso) return 'never';
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 1)  return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24)  return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function staleness(iso: string | null): 'ok' | 'warn' | 'stale' {
  if (!iso) return 'stale';
  const hrs = (Date.now() - new Date(iso).getTime()) / 3_600_000;
  if (hrs < 4)  return 'ok';
  if (hrs < 12) return 'warn';
  return 'stale';
}

const STALE_COLORS = { ok: 'text-teal-100', warn: 'text-yellow-300', stale: 'text-red-300' };

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  let syncStatus = null;
  try { syncStatus = await fetchSyncStatus(await getAccessToken()); } catch { /* non-fatal — don't break layout */ }

  const lastSync = syncStatus?.last_sync_at ?? null;
  const level    = staleness(lastSync);

  return (
    <div className="min-h-screen flex flex-col">
      <header className="bg-teal-600 text-white px-6 py-3 flex items-center justify-between">
        <span className="font-semibold text-base tracking-tight">{APP_NAME} · Ad Performance</span>
        <div className="flex items-center gap-4">
          <span
            className={`text-xs ${STALE_COLORS[level]}`}
            title={lastSync ? `Last synced: ${lastSync}` : 'No sync recorded'}
          >
            Data last synced: {relativeTime(lastSync)}
          </span>
          <SignOutButton />
        </div>
      </header>
      <NavTabs />
      <main className="flex-1 px-6 py-4">{children}</main>
    </div>
  );
}

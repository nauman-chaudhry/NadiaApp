import { Suspense } from 'react';
import { fetchSyncStatus, type SyncStatus } from '@/lib/api';
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

const SOURCE_LABEL: Record<string, string> = {
  taboola: 'Taboola cost', outbrain: 'Outbrain cost', codefuel: 'Codefuel revenue',
  image_advantage: 'Image Advantage revenue', ddc: 'DDC revenue',
};

// Freshness is judged per SOURCE, on its last SUCCESSFUL run, and the headline
// reflects the worst one. The old single "last synced" timestamp took the newest
// success across any job, so a healthy Taboola metadata tick made the dashboard
// look fresh while Outbrain spend had been failing for 17 hours (2026-09-17).
function freshness(s: SyncStatus | null): { level: 'ok' | 'warn' | 'stale'; headline: string; detail: string } {
  if (!s) return { level: 'stale', headline: 'unknown', detail: 'Sync status unavailable' };
  const perSource = s.sources
    .filter(x => s.enabled_sources?.includes(x.name) ?? true)
    .map(x => ({ name: x.name, at: x.last_success ?? null }));
  if (perSource.length === 0) return { level: 'stale', headline: 'never', detail: 'No sync recorded' };
  const worst = perSource.reduce((a, b) => (!a.at ? a : !b.at ? b : new Date(a.at) < new Date(b.at) ? a : b));
  const hrs = worst.at ? (Date.now() - new Date(worst.at).getTime()) / 3_600_000 : Infinity;
  const level = hrs < 4 ? 'ok' : hrs < 12 ? 'warn' : 'stale';
  const detail = perSource
    .map(x => `${SOURCE_LABEL[x.name] ?? x.name}: ${x.at ? relativeTime(x.at) : 'never'}`)
    .join(' · ');
  const stale = s.stale ?? [];
  const headline = stale.length
    ? `${relativeTime(worst.at)} — ${stale.map(n => SOURCE_LABEL[n] ?? n).join(', ')} behind`
    : relativeTime(worst.at);
  return { level, headline, detail };
}

const STALE_COLORS = { ok: 'text-teal-100', warn: 'text-yellow-300', stale: 'text-red-300' };

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  let syncStatus: SyncStatus | null = null;
  try { syncStatus = await fetchSyncStatus(await getAccessToken()); } catch { /* non-fatal — don't break layout */ }
  const f = freshness(syncStatus);

  return (
    <div className="min-h-screen flex flex-col">
      <header className="bg-teal-600 text-white px-6 py-3 flex items-center justify-between">
        <span className="font-semibold text-base tracking-tight">{APP_NAME} · Ad Performance</span>
        <div className="flex items-center gap-4">
          <span className={`text-xs ${STALE_COLORS[f.level]}`} title={f.detail}>
            Data last synced: {f.headline}
          </span>
          <SignOutButton />
        </div>
      </header>
      {/* NavTabs reads the query string (to carry filters across tabs), which
          needs a Suspense boundary in the App Router. */}
      <Suspense><NavTabs /></Suspense>
      <main className="flex-1 px-6 py-4">{children}</main>
    </div>
  );
}

'use client';
import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import clsx from 'clsx';

const TABS = [
  { label: 'Campaign', href: '/dashboard/campaign' },
  { label: 'Daily',    href: '/dashboard/daily' },
  { label: 'Hourly',   href: '/dashboard/hourly' },
  { label: 'Device',   href: '/dashboard/device' },
  { label: 'Country',  href: '/dashboard/country' },
  { label: 'Ads',      href: '/dashboard/ads' },
  { label: 'Site',     href: '/dashboard/site' },
];

// Filters that only one tab can honour and must not follow the user to the
// others (FilterBar hides these controls there and would otherwise show a
// value as applied that the API ignores).
const TAB_ONLY: Record<string, string[]> = {
  country: ['country'],
  device:  ['device'],
};

export default function NavTabs() {
  const path = usePathname();
  const sp = useSearchParams();
  return (
    <nav className="border-b border-gray-200 bg-white px-6 flex gap-1">
      {TABS.map((t) => {
        // Carry the current filters (dates, account, source, feed, campaign,
        // status, GD) across tabs. Bare links reset everything on each switch,
        // which broke the Campaign-vs-Ads comparison the client relies on.
        const q = new URLSearchParams(sp.toString());
        const target = t.href.split('/').pop() ?? '';
        for (const [tab, keys] of Object.entries(TAB_ONLY)) {
          if (tab !== target) keys.forEach(k => q.delete(k));
        }
        const href = q.toString() ? `${t.href}?${q}` : t.href;
        return (
          <Link
            key={t.href}
            href={href}
            className={clsx(
              'px-4 py-2.5 text-sm font-medium border-b-2 -mb-px transition-colors',
              path === t.href
                ? 'border-teal-600 text-teal-700'
                : 'border-transparent text-gray-500 hover:text-gray-800 hover:border-gray-300',
            )}
          >
            {t.label}
          </Link>
        );
      })}
    </nav>
  );
}

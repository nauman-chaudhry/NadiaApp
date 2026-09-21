'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
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

export default function NavTabs() {
  const path = usePathname();
  return (
    <nav className="border-b border-gray-200 bg-white px-6 flex gap-1">
      {TABS.map((t) => (
        <Link
          key={t.href}
          href={t.href}
          className={clsx(
            'px-4 py-2.5 text-sm font-medium border-b-2 -mb-px transition-colors',
            path === t.href
              ? 'border-teal-600 text-teal-700'
              : 'border-transparent text-gray-500 hover:text-gray-800 hover:border-gray-300',
          )}
        >
          {t.label}
        </Link>
      ))}
    </nav>
  );
}

'use client';
import { useRouter, useSearchParams, usePathname } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from 'react';
import type { FilterOptions } from '@/lib/api';
import { format, subDays, startOfMonth, endOfMonth, subMonths } from 'date-fns';

// The sub-account pre-selected on first load (per deployment; see lib/brand.ts).
// For Nadia it is her baseline Taboola sub-account so the dashboard matches her
// Taboola/Codefuel UI without manual filtering.
import { DEFAULT_ACCOUNT_NAME } from '@/lib/brand';

interface Props { options: FilterOptions }

function today()        { return format(new Date(), 'yyyy-MM-dd'); }
function daysAgo(n: number) { return format(subDays(new Date(), n), 'yyyy-MM-dd'); }

// Partner badge colours — used in dropdown list and group buttons
const PARTNER_COLORS: Record<string, string> = {
  codefuel:        'bg-blue-100 text-blue-700',
  image_advantage: 'bg-purple-100 text-purple-700',
  ddc:             'bg-emerald-100 text-emerald-700',
};
const PARTNER_LABELS: Record<string, string> = {
  codefuel:        'CF',
  image_advantage: 'IA',
  ddc:             'DDC',
};
const PARTNER_FULL: Record<string, string> = {
  codefuel:        'Codefuel',
  image_advantage: 'Image Advantage',
  ddc:             'DDC',
};

type Account = { id: number; name: string; partner_code: string | null; source?: string };

// ─── Date range picker: presets + custom ──────────────────────────────────────
interface Preset { key: string; label: string; range: () => [string, string] }

const PRESETS: Preset[] = [
  { key: 'today',      label: 'Today',        range: () => [today(), today()] },
  { key: 'yesterday',  label: 'Yesterday',    range: () => [daysAgo(1), daysAgo(1)] },
  { key: 'last7',      label: 'Last 7 days',  range: () => [daysAgo(6),  today()] },
  { key: 'last14',     label: 'Last 14 days', range: () => [daysAgo(13), today()] },
  { key: 'last30',     label: 'Last 30 days', range: () => [daysAgo(29), today()] },
  { key: 'last90',     label: 'Last 90 days', range: () => [daysAgo(89), today()] },
  { key: 'thismonth',  label: 'This Month',   range: () => [format(startOfMonth(new Date()), 'yyyy-MM-dd'), today()] },
  { key: 'lastmonth',  label: 'Last Month',   range: () => {
    const lm = subMonths(new Date(), 1);
    return [format(startOfMonth(lm), 'yyyy-MM-dd'), format(endOfMonth(lm), 'yyyy-MM-dd')];
  } },
];

function DateRangePicker({
  from, to, onApply,
}: {
  from: string; to: string;
  onApply: (from: string, to: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [draftFrom, setDraftFrom] = useState(from);
  const [draftTo, setDraftTo] = useState(to);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);

  // Keep drafts in sync when the applied range changes externally.
  useEffect(() => { setDraftFrom(from); setDraftTo(to); }, [from, to]);

  // Trigger label: preset name when the range matches one, else the raw dates.
  const label = useMemo(() => {
    for (const p of PRESETS) {
      const [f, t] = p.range();
      if (f === from && t === to) return p.label;
    }
    return `${from} → ${to}`;
  }, [from, to]);

  const pickPreset = (p: Preset) => {
    const [f, t] = p.range();
    onApply(f, t);
    setOpen(false);
  };

  const applyCustom = () => {
    if (draftFrom && draftTo && draftFrom <= draftTo) {
      onApply(draftFrom, draftTo);
      setOpen(false);
    }
  };

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen(o => !o)}
        className="border border-gray-300 rounded px-2 py-1 text-sm h-8 flex items-center gap-1.5 bg-white focus:outline-none focus:ring-1 focus:ring-teal-600"
        title="Date range"
      >
        <span className="text-gray-400 text-xs">📅</span>
        <span className="text-gray-700 whitespace-nowrap">{label}</span>
        <span className="text-gray-400 text-xs">▾</span>
      </button>

      {open && (
        <div className="absolute z-50 top-full mt-1 left-0 bg-white border border-gray-200 rounded shadow-lg flex text-sm">
          {/* Custom range: calendar date inputs + Apply/Cancel */}
          <div className="p-3 border-r border-gray-100 min-w-[220px]">
            <div className="text-xs font-semibold text-gray-500 mb-2 uppercase tracking-wide">Custom range</div>
            <label className="block text-xs text-gray-500 mb-1">Start date</label>
            <input type="date" value={draftFrom} max={draftTo || undefined}
              onChange={e => setDraftFrom(e.target.value)}
              className="w-full border border-gray-300 rounded px-2 py-1 text-sm mb-2 focus:outline-none focus:ring-1 focus:ring-teal-600" />
            <label className="block text-xs text-gray-500 mb-1">End date</label>
            <input type="date" value={draftTo} min={draftFrom || undefined} max={today()}
              onChange={e => setDraftTo(e.target.value)}
              className="w-full border border-gray-300 rounded px-2 py-1 text-sm mb-3 focus:outline-none focus:ring-1 focus:ring-teal-600" />
            <div className="flex gap-2 justify-end">
              <button onClick={() => setOpen(false)}
                className="h-7 px-3 text-xs rounded border border-gray-300 text-gray-600 hover:bg-gray-50">Cancel</button>
              <button onClick={applyCustom}
                disabled={!draftFrom || !draftTo || draftFrom > draftTo}
                className="h-7 px-3 text-xs rounded bg-teal-600 text-white hover:bg-teal-700 font-medium disabled:opacity-40">Apply</button>
            </div>
          </div>
          {/* Preset list */}
          <div className="py-1 min-w-[140px]">
            {PRESETS.map(p => {
              const [f, t] = p.range();
              const active = f === from && t === to;
              return (
                <button key={p.key} onClick={() => pickPreset(p)}
                  className={`block w-full text-left px-3 py-1.5 text-sm hover:bg-teal-50 ${active ? 'text-teal-700 font-medium bg-teal-50' : 'text-gray-700'}`}>
                  {p.label}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Searchable multi-select dropdown (Nadia's Outbrain-style picker) ─────────
// Pattern: search box on top, Clear All + "N selected", "All" checkbox,
// checkboxes per item filtered live by the search text, Apply/Cancel at bottom.
interface PickerItem {
  key: string;             // stable id used in the selection
  label: string;
  badge?: { text: string; className: string } | null;
  group?: string;          // optional section header (e.g. platform)
}

function SearchableMultiSelect({
  items, selected, onApply, allLabel, noun, width = 340,
}: {
  items: PickerItem[];
  selected: string[];      // empty = "all"
  onApply: (keys: string[]) => void;
  allLabel: string;        // e.g. "All accounts"
  noun: string;            // e.g. "accounts" | "campaigns" — for the trigger label
  width?: number;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [draft, setDraft] = useState<string[]>(selected);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);

  // Re-seed the draft each time the dropdown opens (Cancel = just close).
  const openPicker = () => {
    setDraft(selected);
    setSearch('');
    setOpen(o => !o);
  };

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return items;
    return items.filter(i => i.label.toLowerCase().includes(q) || i.key.toLowerCase().includes(q));
  }, [items, search]);

  const toggle = (key: string) =>
    setDraft(d => d.includes(key) ? d.filter(x => x !== key) : [...d, key]);

  const triggerLabel =
    selected.length === 0
      ? allLabel
      : selected.length === 1
        ? (items.find(i => i.key === selected[0])?.label ?? `1 ${noun.replace(/s$/, '')}`)
        : `Multiple ${noun} (${selected.length})`;

  const apply = () => { onApply(draft); setOpen(false); };

  return (
    <div ref={ref} className="relative">
      <button
        onClick={openPicker}
        className="border border-gray-300 rounded px-2 py-1 text-sm h-8 flex items-center gap-1 bg-white focus:outline-none focus:ring-1 focus:ring-teal-600 min-w-[150px] max-w-[240px]"
        title={triggerLabel}
      >
        <span className="truncate flex-1 text-left text-gray-700">{triggerLabel}</span>
        <span className="text-gray-400 text-xs flex-shrink-0">▾</span>
      </button>

      {open && (
        <div className="absolute z-50 top-full mt-1 left-0 bg-white border border-gray-200 rounded shadow-lg flex flex-col"
          style={{ width, maxHeight: 420 }}>
          {/* Search */}
          <div className="p-2 border-b border-gray-100">
            <input
              type="text" autoFocus value={search} onChange={e => setSearch(e.target.value)}
              placeholder={`Search ${noun}…`}
              className="w-full h-8 px-2 text-sm rounded border border-gray-300 focus:outline-none focus:ring-1 focus:ring-teal-600"
            />
          </div>
          {/* Clear All + counter */}
          <div className="flex items-center justify-between px-3 py-1.5 border-b border-gray-100 text-xs">
            <button onClick={() => setDraft([])} className="text-teal-600 hover:underline">Clear All</button>
            <span className="text-gray-500">
              {draft.length === 0 ? `All ${noun}` : `${draft.length} selected`}
            </span>
          </div>
          {/* List */}
          <div className="overflow-y-auto flex-1">
            {/* "All" row — checked when nothing specific is selected */}
            <label className="flex items-center gap-2 px-3 py-2 hover:bg-gray-50 cursor-pointer border-b border-gray-100 select-none">
              <input type="checkbox" checked={draft.length === 0} onChange={() => setDraft([])}
                className="accent-teal-600" />
              <span className="text-sm text-gray-700 font-medium">{allLabel}</span>
            </label>
            {visible.map((item, i, arr) => {
              const showHeader = item.group && (i === 0 || arr[i - 1].group !== item.group);
              return (
                <div key={item.key}>
                  {showHeader && (
                    <div className="px-3 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-wide text-gray-400 bg-gray-50">
                      {item.group}
                    </div>
                  )}
                  <label className="flex items-center gap-2 px-3 py-1.5 hover:bg-gray-50 cursor-pointer select-none">
                    <input type="checkbox" checked={draft.includes(item.key)} onChange={() => toggle(item.key)}
                      className="accent-teal-600 flex-shrink-0" />
                    <span className="text-sm text-gray-700 truncate flex-1 min-w-0" title={item.label}>
                      {item.label}
                      {item.badge && (
                        <span className={`ml-1.5 text-xs font-semibold px-1 py-0.5 rounded ${item.badge.className}`}>
                          {item.badge.text}
                        </span>
                      )}
                    </span>
                  </label>
                </div>
              );
            })}
            {visible.length === 0 && (
              <div className="px-3 py-4 text-center text-gray-400 text-sm">No matches</div>
            )}
          </div>
          {/* Apply / Cancel */}
          <div className="flex gap-2 justify-end p-2 border-t border-gray-100">
            <button onClick={() => setOpen(false)}
              className="h-7 px-3 text-xs rounded border border-gray-300 text-gray-600 hover:bg-gray-50">Cancel</button>
            <button onClick={apply}
              className="h-7 px-3 text-xs rounded bg-teal-600 text-white hover:bg-teal-700 font-medium">Apply</button>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Main FilterBar ────────────────────────────────────────────────────────────
export default function FilterBar({ options }: Props) {
  const router   = useRouter();
  const pathname = usePathname();
  const sp       = useSearchParams();
  const [, startTransition] = useTransition();
  const [isRefreshing, startRefresh] = useTransition();

  // Which tab we are on. Country and Device are SPLIT DIMENSIONS, not campaign
  // attributes: the materialized view behind Campaign/Daily/Hourly is
  // campaign-hour-account grain and stores country/device as empty strings on every
  // row, so those filters could never do anything there -- picking a country returned
  // the byte-identical unfiltered total. That is the same "filter does nothing" defect
  // the client reported for campaigns and GDs, so rather than leave dead controls on
  // screen each one is shown only on the tab that can actually honour it.
  // Status is a campaign attribute and does not reach the dimension tabs' branches.
  const view = pathname.split('/').filter(Boolean).pop() ?? 'campaign';
  const showCountry = view === 'country';
  const showDevice  = view === 'device';
  const showStatus  = view !== 'country' && view !== 'device' && view !== 'site';

  const [from,       setFrom]       = useState(sp.get('from')        ?? daysAgo(13));
  const [to,         setTo]         = useState(sp.get('to')          ?? today());
  const [device,     setDevice]     = useState(sp.get('device')      ?? '');
  const [source,     setSource]     = useState(sp.get('source')      ?? 'all');
  const [feed,       setFeed]       = useState(sp.get('feed')        ?? 'all');

  // Multi-select filters (comma-separated in the URL; empty = all).
  const csv = (key: string) => (sp.get(key) ?? '').split(',').map(s => s.trim()).filter(Boolean);
  const [statuses,  setStatuses]  = useState<string[]>(() => csv('status'));
  const [countries, setCountries] = useState<string[]>(() => csv('country'));
  const [gds,       setGds]       = useState<string[]>(() => csv('gd'));

  // campaign_id in the URL is comma-separated external ids (multi-select).
  const [campaignIds, setCampaignIds] = useState<string[]>(() => {
    const raw = sp.get('campaign_id');
    if (!raw) return [];
    return raw.split(',').map(s => s.trim()).filter(Boolean);
  });

  // account_id in the URL is comma-separated IDs, 'all' for explicit all-accounts,
  // or absent (null) on first load → default to the baseline account.
  const [accountIds, setAccountIds] = useState<number[]>(() => {
    const raw = sp.get('account_id');
    if (raw === null) {
      const def = options.accounts.find(a => a.name === DEFAULT_ACCOUNT_NAME);
      return def ? [def.id] : [];
    }
    if (raw === 'all' || raw === '') return [];
    return raw.split(',').map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n));
  });

  const pushQuery = useCallback((mutate: (q: URLSearchParams) => void) => {
    const q = new URLSearchParams(sp.toString());
    mutate(q);
    startTransition(() => router.push(`${pathname}?${q}`));
  }, [sp, pathname, router]);

  const apply = useCallback(() => {
    const q = new URLSearchParams();
    if (from) q.set('from', from);
    if (to)   q.set('to',   to);
    q.set('account_id', accountIds.length > 0 ? accountIds.join(',') : 'all');
    if (campaignIds.length > 0) q.set('campaign_id', campaignIds.join(','));
    // Only send what this tab can honour, so a stale value from another tab cannot
    // silently linger in the URL and look like an applied filter.
    if (showCountry && countries.length > 0) q.set('country', countries.join(','));
    if (showDevice  && device)               q.set('device',  device);
    if (showStatus  && statuses.length > 0)  q.set('status',  statuses.join(','));
    if (gds.length > 0)         q.set('gd',     gds.join(','));
    if (source && source !== 'all') q.set('source', source);
    if (feed && feed !== 'all')     q.set('feed',   feed);
    startTransition(() => router.push(`${pathname}?${q}`));
  }, [from, to, accountIds, campaignIds, countries, device, statuses, gds, source, feed, pathname, router, showCountry, showDevice, showStatus]);

  // Date range applies immediately (presets and custom Apply both land here).
  const handleDateApply = useCallback((f: string, t: string) => {
    setFrom(f); setTo(t);
    pushQuery(q => { q.set('from', f); q.set('to', t); });
  }, [pushQuery]);

  // Account changes apply immediately (no "Apply" needed)
  const handleAccountChange = useCallback((ids: number[]) => {
    setAccountIds(ids);
    pushQuery(q => q.set('account_id', ids.length > 0 ? ids.join(',') : 'all'));
  }, [pushQuery]);

  // Campaign multi-select applies on its dropdown Apply.
  const handleCampaignChange = useCallback((ids: string[]) => {
    setCampaignIds(ids);
    pushQuery(q => {
      if (ids.length > 0) q.set('campaign_id', ids.join(',')); else q.delete('campaign_id');
    });
  }, [pushQuery]);

  // Source toggle applies immediately. Reset the account selection so a Taboola
  // account isn't left selected while Outbrain is active (and vice versa).
  const handleSourceChange = useCallback((src: string) => {
    setSource(src);
    setAccountIds([]);
    pushQuery(q => {
      if (src === 'all') q.delete('source'); else q.set('source', src);
      q.set('account_id', 'all');
    });
  }, [pushQuery]);

  // Generic immediate-apply for the multi-select filters.
  const makeMultiHandler = (key: string, set: (v: string[]) => void) =>
    (vals: string[]) => {
      set(vals);
      pushQuery(q => {
        if (vals.length > 0) q.set(key, vals.join(',')); else q.delete(key);
      });
    };
  const handleStatusChange  = makeMultiHandler('status',  setStatuses);
  const handleCountryChange = makeMultiHandler('country', setCountries);
  const handleGdChange      = makeMultiHandler('gd',      setGds);

  // Hard refresh: re-runs every server component on the route, which re-fetches
  // stats/options/sync-status from the API (all are cache: 'no-store'). This is
  // a fresh data pull, not a browser reload.
  const hardRefresh = () => startRefresh(() => router.refresh());

  // Feeds (IA concept: Yahoo = y-metrics search, Flux = x-metrics display).
  // Applies immediately, like Traffic Source.
  const handleFeedChange = useCallback((f: string) => {
    setFeed(f);
    pushQuery(q => {
      if (f === 'all') q.delete('feed'); else q.set('feed', f);
    });
  }, [pushQuery]);

  // ── Project (partner group) dropdown ─────────────────────────────────────────
  const scopedAccounts = source === 'all'
    ? options.accounts
    : options.accounts.filter(a => a.source === source);

  const selectGroup = (groupKey: string) => {
    if (groupKey === '__all__')      { handleAccountChange([]); return; }
    if (groupKey === '__untagged__') { handleAccountChange(scopedAccounts.filter(a => a.partner_code === null).map(a => a.id)); return; }
    handleAccountChange(scopedAccounts.filter(a => a.partner_code === groupKey).map(a => a.id));
  };

  const activeGroup = useMemo(() => {
    if (accountIds.length === 0) return '__all__';
    const selected = scopedAccounts.filter(a => accountIds.includes(a.id));
    const codes = new Set(selected.map(a => a.partner_code));
    if (codes.size === 1) {
      const code = [...codes][0];
      if (code === null) return '__untagged__';
      return code;
    }
    return null;
  }, [accountIds, scopedAccounts]);

  const hasPartner  = (code: string) => scopedAccounts.some(a => a.partner_code === code);
  const hasUntagged = scopedAccounts.some(a => a.partner_code === null);

  // ── Picker items ─────────────────────────────────────────────────────────────
  const accountItems: PickerItem[] = useMemo(() =>
    [...scopedAccounts]
      .sort((a, b) => (a.source ?? '').localeCompare(b.source ?? '') || a.name.localeCompare(b.name))
      .map(a => ({
        key: String(a.id),
        label: a.name,
        group: a.source === 'outbrain' ? 'Outbrain Accounts' : 'Taboola Accounts',
        badge: a.partner_code
          ? { text: PARTNER_LABELS[a.partner_code] ?? a.partner_code, className: PARTNER_COLORS[a.partner_code] ?? 'bg-gray-100 text-gray-600' }
          : null,
      })),
    [scopedAccounts]);

  const campaignItems: PickerItem[] = useMemo(() =>
    options.campaigns.map(c => ({ key: c.external_id, label: c.name })),
    [options.campaigns]);

  // "Showing X of Y" account status line
  const statusText = useMemo(() => {
    if (accountIds.length === 0) return `All accounts (${scopedAccounts.length})`;
    const selected = scopedAccounts.filter(a => accountIds.includes(a.id));
    const counts: Record<string, number> = {};
    for (const a of selected) {
      const key = a.partner_code ?? '__untagged__';
      counts[key] = (counts[key] ?? 0) + 1;
    }
    const parts = Object.entries(counts).map(([code, n]) => {
      const label = code === '__untagged__' ? 'Untagged' : (PARTNER_FULL[code] ?? code);
      return `${n} ${label}`;
    });
    return `Showing ${accountIds.length} of ${scopedAccounts.length} · ${parts.join(' · ')}`;
  }, [accountIds, scopedAccounts]);

  return (
    <div className="flex flex-wrap items-end gap-2 mb-4">
      {/* Date range: presets + custom picker */}
      <DateRangePicker from={from} to={to} onApply={handleDateApply} />

      {/* Traffic Source — search-and-select dropdown. Selecting one source
          filters to it; none or both = All (the API takes a single source). */}
      <SearchableMultiSelect
        items={[{ key: 'taboola', label: 'Taboola' }, { key: 'outbrain', label: 'Outbrain' }]}
        selected={source === 'all' ? [] : [source]}
        onApply={keys => handleSourceChange(keys.length === 1 ? keys[0] : 'all')}
        allLabel="All Traffic Sources"
        noun="sources"
        width={260}
      />

      {/* Project (partner group) — single-select */}
      <div>
        <div className="flex items-center gap-1">
          <select
            value={activeGroup ?? '__custom__'}
            onChange={e => selectGroup(e.target.value)}
            className="border border-gray-300 rounded px-2 py-1 text-sm h-8 max-w-[200px] focus:outline-none focus:ring-1 focus:ring-teal-600"
            title="Project"
          >
            <option value="__all__">All Projects</option>
            {hasPartner('codefuel')        && <option value="codefuel">Codefuel</option>}
            {hasPartner('image_advantage') && <option value="image_advantage">Image Advantage</option>}
            {hasPartner('ddc')             && <option value="ddc">DDC</option>}
            {hasUntagged                   && <option value="__untagged__">Untagged</option>}
            {activeGroup === null && <option value="__custom__" disabled>Custom selection</option>}
          </select>

          {/* Account: searchable multi-select */}
          <SearchableMultiSelect
            items={accountItems}
            selected={accountIds.map(String)}
            onApply={keys => handleAccountChange(keys.map(k => parseInt(k, 10)).filter(n => !isNaN(n)))}
            allLabel="All accounts"
            noun="accounts"
          />
        </div>
        <div className="text-xs text-gray-400 mt-0.5 pl-0.5 whitespace-nowrap leading-none">
          {statusText}
        </div>
      </div>

      {/* Feeds (IA only): Yahoo = y-metrics search, Flux = x-metrics display.
          Shown when Project = Image Advantage — or when a feed is active, so
          the user can always see and reset it. */}
      {(activeGroup === 'image_advantage' || feed !== 'all') && (
        <select value={feed} onChange={e => handleFeedChange(e.target.value)}
          className="border border-gray-300 rounded px-2 py-1 text-sm h-8 focus:outline-none focus:ring-1 focus:ring-teal-600"
          title="Feeds (Image Advantage)">
          <option value="all">All Feeds</option>
          <option value="yahoo">Yahoo</option>
          <option value="flux">Flux</option>
        </select>
      )}

      {/* Campaign: searchable multi-select */}
      <SearchableMultiSelect
        items={campaignItems}
        selected={campaignIds}
        onApply={handleCampaignChange}
        allLabel="All campaigns"
        noun="campaigns"
        width={380}
      />

      {/* Status — search-and-select multi */}
      {showStatus && (
      <SearchableMultiSelect
        items={options.statuses.map(s => ({ key: s.status, label: s.status }))}
        selected={statuses}
        onApply={handleStatusChange}
        allLabel="All statuses"
        noun="statuses"
        width={260}
      />
      )}

      {/* Country — search-and-select multi */}
      {showCountry && (
      <SearchableMultiSelect
        items={options.countries.map(c => ({ key: c.country, label: c.country }))}
        selected={countries}
        onApply={handleCountryChange}
        allLabel="All countries"
        noun="countries"
        width={260}
      />
      )}

      {/* Device */}
      {showDevice && (
      <select value={device} onChange={e => setDevice(e.target.value)}
        className="border border-gray-300 rounded px-2 py-1 text-sm h-8 focus:outline-none focus:ring-1 focus:ring-teal-600">
        <option value="">All devices</option>
        {options.devices.map(d => <option key={d.device} value={d.device}>{d.device}</option>)}
      </select>
      )}

      {/* GD param — search-and-select multi */}
      {options.gds.length > 0 && (
        <SearchableMultiSelect
          items={options.gds.map(g => ({ key: g.gd_param, label: g.gd_param }))}
          selected={gds}
          onApply={handleGdChange}
          allLabel="All GDs"
          noun="GDs"
          width={300}
        />
      )}

      <button onClick={apply}
        className="h-8 px-4 bg-teal-600 text-white text-sm rounded hover:bg-teal-700 font-medium">
        Apply
      </button>

      {/* Hard refresh: re-fetch fresh data from the API */}
      <button onClick={hardRefresh} disabled={isRefreshing} title="Re-fetch the latest data"
        className="h-8 px-3 text-sm rounded border border-gray-300 text-gray-600 hover:bg-gray-50 font-medium flex items-center gap-1.5 disabled:opacity-60">
        <span className={isRefreshing ? 'inline-block animate-spin' : ''}>⟳</span>
        {isRefreshing ? 'Refreshing…' : 'Refresh'}
      </button>
    </div>
  );
}

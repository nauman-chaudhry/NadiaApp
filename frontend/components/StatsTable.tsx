'use client';
import {
  useReactTable, getCoreRowModel, getSortedRowModel,
  flexRender, type ColumnDef, type SortingState,
} from '@tanstack/react-table';
import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { StatsRow, StatsView } from '@/lib/api';
import { fmtInt, fmtMoney, fmtPct } from '@/lib/formatters';

// ─── Client-side totals (mirrors server computeTotals) ──────────────────────
// Used when client filters are active so the Total row reflects the filtered set.
function computeTotalsClient(rows: StatsRow[]): Record<string, number> {
  if (rows.length === 0) return {};
  const s = (k: string) => rows.reduce((acc, r) => acc + (Number(r[k]) || 0), 0);
  const impressions = s('impressions'), clicks = s('clicks'), spent = s('spent');
  const revenue = s('revenue'), conversions = s('conversions');
  const ad_clicks = s('ad_clicks'), sessions = s('sessions');
  const profit = revenue - spent;
  const conversion_scrub = conversions - ad_clicks;
  return {
    impressions, clicks, spent, revenue, conversions, ad_clicks, sessions, profit,
    actual_cpm:          impressions > 0 ? spent * 1000 / impressions           : 0,
    ctr_pct:             impressions > 0 ? clicks * 100 / impressions           : 0,
    actual_cpc:          clicks > 0      ? spent / clicks                       : 0,
    conversion_rate_pct: clicks > 0      ? conversions * 100 / clicks           : 0,
    actual_cpa:          conversions > 0 ? spent / conversions                  : 0,
    rpc:                 ad_clicks > 0   ? revenue / ad_clicks                  : 0,
    margin_pct:          revenue > 0     ? (revenue - spent) * 100 / revenue    : 0,
    yahoo_cpa:           ad_clicks > 0   ? spent / ad_clicks                    : 0,
    conversion_scrub,
    scrub_rate_pct:      conversions > 0 ? conversion_scrub * 100 / conversions : 0,
  };
}

// ─── Inline column filters (permanent filter row) ───────────────────────────
// Each column has an always-visible input in a filter row under the headers,
// plus a ≡ mode selector. Text columns filter by string match; numeric columns
// by comparison. Filtering is client-side, debounced, and AND-composed.
interface ColFilter { mode: string; value: string; value2?: string }
type Filters = Record<string, ColFilter>;   // keyed by column accessorKey

const TEXT_MODES = [
  { value: 'contains',    label: 'Contains' },
  { value: 'notcontains', label: 'Does not contain' },
  { value: 'startswith',  label: 'Starts with' },
  { value: 'equals',      label: 'Equals' },
  { value: 'isempty',     label: 'Is empty' },
];
const NUM_MODES = [
  { value: 'gt',        label: 'Greater than' },
  { value: 'lt',        label: 'Less than' },
  { value: 'eq',        label: 'Equals' },
  { value: 'between',   label: 'Between' },
  { value: 'iszero',    label: 'Is zero' },
  { value: 'isnotzero', label: 'Is not zero' },
];
const DEFAULT_TEXT_MODE = 'contains';
const DEFAULT_NUM_MODE  = 'gt';
// Modes that need no value typed to be active.
const NO_VALUE_MODES = new Set(['isempty', 'iszero', 'isnotzero']);

function modeLabel(kind: 'text' | 'numeric', mode: string): string {
  const list = kind === 'numeric' ? NUM_MODES : TEXT_MODES;
  return list.find(m => m.value === mode)?.label ?? mode;
}

// Is this filter doing anything? (a value typed, or a no-value mode chosen)
function isFilterActive(f: ColFilter | undefined): boolean {
  if (!f) return false;
  if (NO_VALUE_MODES.has(f.mode)) return true;
  return f.value.trim() !== '';
}

function passesTextFilter(raw: unknown, f: ColFilter): boolean {
  const val = String(raw ?? '').toLowerCase();
  if (f.mode === 'isempty') return val === '' || val === '—';
  const q = f.value.trim().toLowerCase();
  if (!q) return true;
  switch (f.mode) {
    case 'contains':    return val.includes(q);
    case 'notcontains': return !val.includes(q);
    case 'startswith':  return val.startsWith(q);
    case 'equals':      return val === q;
    default:            return true;
  }
}

function passesNumericFilter(raw: unknown, f: ColFilter): boolean {
  const v = Number(raw);
  if (f.mode === 'iszero')    return v === 0;
  if (f.mode === 'isnotzero') return v !== 0;
  const a = f.value.trim() === '' ? null : Number(f.value);
  if (a === null || Number.isNaN(a)) return true; // incomplete → no-op
  if (Number.isNaN(v)) return false;
  switch (f.mode) {
    case 'gt': return v > a;
    case 'lt': return v < a;
    case 'eq': return v === a;
    case 'between': {
      const b = f.value2 == null || f.value2.trim() === '' ? null : Number(f.value2);
      if (b === null || Number.isNaN(b)) return v >= a;
      return v >= Math.min(a, b) && v <= Math.max(a, b);
    }
    default: return true;
  }
}

// ─── Filter cell: ≡ mode menu + always-visible input(s) ─────────────────────
function FilterCell({
  kind, filter, onChange,
}: {
  kind: 'text' | 'numeric';
  filter: ColFilter | undefined;
  onChange: (f: ColFilter | undefined) => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const modes = kind === 'numeric' ? NUM_MODES : TEXT_MODES;
  const mode  = filter?.mode ?? (kind === 'numeric' ? DEFAULT_NUM_MODE : DEFAULT_TEXT_MODE);
  const value = filter?.value ?? '';
  const value2 = filter?.value2 ?? '';
  const active = isFilterActive(filter);
  const noValue = NO_VALUE_MODES.has(mode);

  useEffect(() => {
    if (!menuOpen) return;
    const close = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setMenuOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [menuOpen]);

  const update = (patch: Partial<ColFilter>) => {
    const next: ColFilter = { mode, value, value2, ...patch };
    // Drop the filter entirely when it's a no-op (default mode, no value).
    if (!NO_VALUE_MODES.has(next.mode) && next.value.trim() === '' &&
        next.mode === (kind === 'numeric' ? DEFAULT_NUM_MODE : DEFAULT_TEXT_MODE)) {
      onChange(undefined);
    } else {
      onChange(next);
    }
  };
  const setMode  = (m: string) => { update({ mode: m }); setMenuOpen(false); };
  const setValue = (s: string) => update({ value: s });
  const setValue2 = (s: string) => update({ value2: s });
  const clear = () => onChange(undefined);

  return (
    <div ref={ref} className="relative flex items-center gap-0.5">
      <button
        type="button"
        onClick={() => setMenuOpen(o => !o)}
        title={modeLabel(kind, mode)}
        className={`flex-shrink-0 text-[11px] leading-none px-0.5 ${active ? 'text-teal-600' : 'text-gray-400 hover:text-gray-700'}`}
      >≡</button>
      {!noValue && (
        <input
          type={kind === 'numeric' ? 'number' : 'text'}
          value={value}
          onChange={e => setValue(e.target.value)}
          placeholder={mode === 'between' ? 'min' : ''}
          className={`w-full min-w-0 h-6 px-1 text-xs rounded border bg-white focus:outline-none focus:ring-1 focus:ring-teal-600 ${active ? 'border-teal-400 bg-teal-50' : 'border-gray-200'}`}
        />
      )}
      {!noValue && mode === 'between' && (
        <input
          type="number" value={value2} onChange={e => setValue2(e.target.value)} placeholder="max"
          className={`w-full min-w-0 h-6 px-1 text-xs rounded border bg-white focus:outline-none focus:ring-1 focus:ring-teal-600 ${active ? 'border-teal-400 bg-teal-50' : 'border-gray-200'}`}
        />
      )}
      {noValue && (
        <span className="text-[11px] text-teal-700 bg-teal-50 border border-teal-200 rounded px-1 h-6 flex items-center whitespace-nowrap">
          {modeLabel(kind, mode)}
        </span>
      )}
      {active && (
        <button type="button" onClick={clear} title="Clear filter"
          className="flex-shrink-0 text-gray-400 hover:text-gray-700 text-xs leading-none">×</button>
      )}
      {menuOpen && (
        <div className="absolute z-50 top-full mt-1 left-0 bg-white border border-gray-200 rounded shadow-lg py-1 min-w-[140px] text-left font-normal">
          {modes.map(m => (
            <button key={m.value} type="button" onClick={() => setMode(m.value)}
              className={`block w-full text-left px-2 py-1 text-xs hover:bg-gray-50 ${m.value === mode ? 'text-teal-600 font-medium' : 'text-gray-700'}`}>
              {m.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Column category → header background tint ────────────────────────────────
type ColCategory = 'dimension' | 'taboola' | 'partner';

const HEADER_BG: Record<ColCategory, string | undefined> = {
  dimension: undefined,
  taboola:   'rgba(59,130,246,0.08)',
  partner:   'rgba(34,197,94,0.08)',
};

// Partner badge colours for campaign group headers
const ACCT_BADGE: Record<string, { bg: string; label: string }> = {
  codefuel:        { bg: 'bg-blue-100 text-blue-700',    label: 'Codefuel' },
  image_advantage: { bg: 'bg-purple-100 text-purple-700', label: 'IA' },
  ddc:             { bg: 'bg-emerald-100 text-emerald-700', label: 'DDC' },
};

// ─── Column helpers ────────────────────────────────────────────────────────────
function moneyCol(id: string, header: string, cat: ColCategory): ColumnDef<StatsRow> {
  return {
    accessorKey: id, header,
    meta: { category: cat, numeric: true },
    cell: ({ getValue }) => {
      const v = Number(getValue());
      return <span className={v < 0 ? 'text-red-600' : ''}>{fmtMoney(v)}</span>;
    },
  };
}
function intCol(id: string, header: string, cat: ColCategory): ColumnDef<StatsRow> {
  return { accessorKey: id, header, meta: { category: cat, numeric: true }, cell: ({ getValue }) => fmtInt(getValue() as number) };
}
function pctCol(id: string, header: string, cat: ColCategory): ColumnDef<StatsRow> {
  return { accessorKey: id, header, meta: { category: cat, numeric: true }, cell: ({ getValue }) => fmtPct(getValue() as number) };
}
function txtCol(id: string, header: string, cat: ColCategory, maxW = 220): ColumnDef<StatsRow> {
  return {
    accessorKey: id, header,
    meta: { category: cat },
    cell: ({ getValue }) => (
      <span style={{ maxWidth: maxW, display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
        title={String(getValue() ?? '')}>
        {String(getValue() ?? '—')}
      </span>
    ),
  };
}
function idCol(id: string, header: string, cat: ColCategory): ColumnDef<StatsRow> {
  return {
    accessorKey: id, header,
    meta: { category: cat },
    cell: ({ getValue }) => (
      <span className="font-mono text-xs text-gray-500">{String(getValue() ?? '—')}</span>
    ),
  };
}

// ─── Shared metric block ───────────────────────────────────────────────────────
const TABOOLA_COLS: ColumnDef<StatsRow>[] = [
  intCol('impressions',         'Impressions',  'taboola'),
  intCol('clicks',              'Clicks',       'taboola'),
  pctCol('ctr_pct',             'CTR%',         'taboola'),
  moneyCol('actual_cpc',        'Actual CPC',   'taboola'),
  moneyCol('spent',             'Spent',        'taboola'),
  intCol('conversions',         'Conversion',   'taboola'),
  moneyCol('actual_cpa',        'Actual CPA',   'taboola'),
  pctCol('conversion_rate_pct', 'CVR%',         'taboola'),
];

const PARTNER_COLS: ColumnDef<StatsRow>[] = [
  moneyCol('revenue',        'Revenue',       'partner'),
  intCol('ad_clicks',        'Ad Clicks',     'partner'),
  intCol('sessions',         'Sessions',      'partner'),
  moneyCol('rpc',            "RPC's",         'partner'),
  moneyCol('yahoo_cpa',      'Yahoo CPA',     'partner'),
  moneyCol('profit',         'Profit',        'partner'),
  pctCol('margin_pct',       'Margin%',       'partner'),
  intCol('conversion_scrub', 'Conv. Scrub',   'partner'),
  pctCol('scrub_rate_pct',   'Scrub Rate%',   'partner'),
];

// ─── Column definitions per view ──────────────────────────────────────────────
const VIEW_COLUMNS: Record<StatsView, ColumnDef<StatsRow>[]> = {
  campaign: [
    txtCol('campaign_name',   'Campaign',    'dimension', 280),
    idCol('campaign_id',      'Campaign ID', 'dimension'),
    txtCol('ad_account_name', 'Account',     'dimension', 160),
    ...TABOOLA_COLS,
    ...PARTNER_COLS,
  ],
  daily: [
    {
      accessorKey: 'day', header: 'Date',
      meta: { category: 'dimension' as ColCategory },
      cell: ({ getValue }) => String(getValue() ?? '').slice(0, 10),
    },
    ...TABOOLA_COLS,
    ...PARTNER_COLS,
  ],
  hourly: [
    {
      accessorKey: 'hour', header: 'Hour (UTC)',
      meta: { category: 'dimension' as ColCategory },
      cell: ({ getValue }) => `${String(getValue() ?? 0).padStart(2, '0')}:00`,
    },
    ...TABOOLA_COLS,
    ...PARTNER_COLS,
  ],
  device: [
    txtCol('device',  'Device',  'dimension', 120),
    ...TABOOLA_COLS, ...PARTNER_COLS,
  ],
  country: [
    txtCol('country', 'Country', 'dimension', 80),
    ...TABOOLA_COLS, ...PARTNER_COLS,
  ],
  ads: [
    txtCol('ad_title',      'Ad Title',    'dimension', 260),
    idCol('taboola_ad_id',  'Ad ID',       'dimension'),
    txtCol('campaign_name', 'Campaign',    'dimension', 180),
    idCol('campaign_id',    'Campaign ID', 'dimension'),
    txtCol('gd_param',      'GD',          'dimension', 100),
    ...TABOOLA_COLS, ...PARTNER_COLS,
  ],
  site: [
    txtCol('site', 'Site', 'dimension', 200),
    ...TABOOLA_COLS, ...PARTNER_COLS,
  ],
};

// ─── Excel export ───────────────────────────────────────────────────────────
type ExpType = 'text' | 'int' | 'money' | 'pct';
interface ExpCol { key: string; header: string; type: ExpType }

// Per-tab export columns (human-readable headers), per Nadia's spec.
const EXPORT_COLUMNS: Record<StatsView, ExpCol[]> = {
  campaign: [
    { key: 'campaign_name', header: 'Campaign', type: 'text' },
    { key: 'campaign_id', header: 'Campaign ID', type: 'text' },
    { key: 'ad_account_name', header: 'Account', type: 'text' },
    { key: 'impressions', header: 'Impressions', type: 'int' },
    { key: 'clicks', header: 'Clicks', type: 'int' },
    { key: 'ctr_pct', header: 'CTR%', type: 'pct' },
    { key: 'actual_cpc', header: 'Actual CPC', type: 'money' },
    { key: 'spent', header: 'Spent', type: 'money' },
    { key: 'conversions', header: 'Conversions', type: 'int' },
    { key: 'revenue', header: 'Revenue', type: 'money' },
    { key: 'ad_clicks', header: 'Ad Clicks', type: 'int' },
    { key: 'sessions', header: 'Sessions', type: 'int' },
    { key: 'profit', header: 'Profit', type: 'money' },
    { key: 'margin_pct', header: 'Margin%', type: 'pct' },
  ],
  daily: [
    { key: 'day', header: 'Date', type: 'text' },
    { key: 'impressions', header: 'Impressions', type: 'int' },
    { key: 'clicks', header: 'Clicks', type: 'int' },
    { key: 'ctr_pct', header: 'CTR%', type: 'pct' },
    { key: 'spent', header: 'Spent', type: 'money' },
    { key: 'conversions', header: 'Conversions', type: 'int' },
    { key: 'revenue', header: 'Revenue', type: 'money' },
    { key: 'ad_clicks', header: 'Ad Clicks', type: 'int' },
    { key: 'sessions', header: 'Sessions', type: 'int' },
    { key: 'profit', header: 'Profit', type: 'money' },
    { key: 'margin_pct', header: 'Margin%', type: 'pct' },
  ],
  hourly: [
    { key: 'hour', header: 'Hour (UTC)', type: 'text' },
    { key: 'impressions', header: 'Impressions', type: 'int' },
    { key: 'clicks', header: 'Clicks', type: 'int' },
    { key: 'ctr_pct', header: 'CTR%', type: 'pct' },
    { key: 'spent', header: 'Spent', type: 'money' },
    { key: 'conversions', header: 'Conversions', type: 'int' },
    { key: 'revenue', header: 'Revenue', type: 'money' },
    { key: 'ad_clicks', header: 'Ad Clicks', type: 'int' },
    { key: 'sessions', header: 'Sessions', type: 'int' },
    { key: 'profit', header: 'Profit', type: 'money' },
    { key: 'margin_pct', header: 'Margin%', type: 'pct' },
  ],
  device: [
    { key: 'device', header: 'Device', type: 'text' },
    { key: 'impressions', header: 'Impressions', type: 'int' },
    { key: 'clicks', header: 'Clicks', type: 'int' },
    { key: 'ctr_pct', header: 'CTR%', type: 'pct' },
    { key: 'spent', header: 'Spent', type: 'money' },
    { key: 'revenue', header: 'Revenue', type: 'money' },
    { key: 'ad_clicks', header: 'Ad Clicks', type: 'int' },
    { key: 'sessions', header: 'Sessions', type: 'int' },
    { key: 'profit', header: 'Profit', type: 'money' },
    { key: 'margin_pct', header: 'Margin%', type: 'pct' },
  ],
  country: [
    { key: 'country', header: 'Country', type: 'text' },
    { key: 'impressions', header: 'Impressions', type: 'int' },
    { key: 'clicks', header: 'Clicks', type: 'int' },
    { key: 'ctr_pct', header: 'CTR%', type: 'pct' },
    { key: 'spent', header: 'Spent', type: 'money' },
    { key: 'revenue', header: 'Revenue', type: 'money' },
    { key: 'ad_clicks', header: 'Ad Clicks', type: 'int' },
    { key: 'sessions', header: 'Sessions', type: 'int' },
    { key: 'profit', header: 'Profit', type: 'money' },
    { key: 'margin_pct', header: 'Margin%', type: 'pct' },
  ],
  ads: [
    { key: 'ad_title', header: 'Ad Title', type: 'text' },
    { key: 'taboola_ad_id', header: 'Ad ID', type: 'text' },
    { key: 'campaign_name', header: 'Campaign', type: 'text' },
    { key: 'campaign_id', header: 'Campaign ID', type: 'text' },
    { key: 'gd_param', header: 'GD', type: 'text' },
    { key: 'impressions', header: 'Impressions', type: 'int' },
    { key: 'clicks', header: 'Clicks', type: 'int' },
    { key: 'ctr_pct', header: 'CTR%', type: 'pct' },
    { key: 'actual_cpc', header: 'Actual CPC', type: 'money' },
    { key: 'spent', header: 'Spent', type: 'money' },
    { key: 'conversions', header: 'Conversions', type: 'int' },
    { key: 'revenue', header: 'Revenue', type: 'money' },
    { key: 'ad_clicks', header: 'Ad Clicks', type: 'int' },
    { key: 'sessions', header: 'Sessions', type: 'int' },
    { key: 'profit', header: 'Profit', type: 'money' },
    { key: 'margin_pct', header: 'Margin%', type: 'pct' },
  ],
  site: [
    { key: 'site', header: 'Site', type: 'text' },
    { key: 'impressions', header: 'Impressions', type: 'int' },
    { key: 'clicks', header: 'Clicks', type: 'int' },
    { key: 'ctr_pct', header: 'CTR%', type: 'pct' },
    { key: 'spent', header: 'Spent', type: 'money' },
    { key: 'revenue', header: 'Revenue', type: 'money' },
    { key: 'ad_clicks', header: 'Ad Clicks', type: 'int' },
    { key: 'sessions', header: 'Sessions', type: 'int' },
    { key: 'profit', header: 'Profit', type: 'money' },
    { key: 'margin_pct', header: 'Margin%', type: 'pct' },
  ],
};

const round2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;

// ─── Global search ───────────────────────────────────────────────────────────
// Top-level search box: matches campaign name, ad name, or IDs — any of the
// view's dimension keys. Empty list = view has no searchable dimensions.
const SEARCH_KEYS: Record<StatsView, string[]> = {
  campaign: ['campaign_name', 'campaign_id', 'ad_account_name'],
  ads:      ['ad_title', 'taboola_ad_id', 'campaign_name', 'campaign_id', 'gd_param'],
  site:     ['site'],
  country:  ['country'],
  device:   ['device'],
  daily:    [],
  hourly:   [],
};

// ─── Zebra striping + frozen first column ────────────────────────────────────
// Row backgrounds must be set per-CELL (not per-row) because the first column
// is sticky-left: a sticky cell needs an opaque background of its own or the
// scrolled columns show through underneath it.
const ZEBRA = ['bg-white', 'bg-[#f7f8fa]'];        // subtle alternation
const HOVER_BG = 'group-hover:bg-[#eef6f6]';       // gentle teal-tinted hover
// Sticky-left classes for the first body/header/filter/total cells.
const STICKY_FIRST = 'sticky left-0';

// Format a raw cell value for the spreadsheet (numbers stay numbers so Excel
// can sum/sort; dimension columns get their display form).
function expValue(row: StatsRow, col: ExpCol): string | number {
  const v = row[col.key];
  switch (col.type) {
    case 'int':   return Math.round(Number(v) || 0);
    case 'money': return round2(Number(v) || 0);
    case 'pct':   return round2(Number(v) || 0);
    default:
      if (col.key === 'day')  return String(v ?? '').slice(0, 10);
      if (col.key === 'hour') return `${String(v ?? 0).padStart(2, '0')}:00`;
      return String(v ?? '');
  }
}

async function exportXlsx(
  view: StatsView, rows: StatsRow[], totals: Record<string, number>, from: string, to: string,
) {
  const XLSX = await import('xlsx');
  const cols = EXPORT_COLUMNS[view];
  const headers = cols.map(c => c.header);

  const body = rows.map(r => {
    const o: Record<string, string | number> = {};
    for (const c of cols) o[c.header] = expValue(r, c);
    return o;
  });

  // TOTAL row: label in the first column, summed/derived metrics elsewhere.
  const totalRow: Record<string, string | number> = {};
  cols.forEach((c, i) => {
    if (i === 0) { totalRow[c.header] = 'TOTAL'; return; }
    if (c.type === 'text') { totalRow[c.header] = ''; return; }
    totalRow[c.header] = round2(Number(totals[c.key]) || 0);
  });

  const ws = XLSX.utils.json_to_sheet([...body, totalRow], { header: headers });
  ws['!cols'] = cols.map(c => ({
    wch: Math.max(c.header.length + 2, c.type === 'text' ? 24 : 12),
  }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, view.slice(0, 31));
  XLSX.writeFile(wb, `seven-sphere-${view}-${from}-${to}.xlsx`);
}

// ─── Totals row ────────────────────────────────────────────────────────────────
function TotalsRow({
  columns,
  totals,
  rowCount,
}: {
  columns: ColumnDef<StatsRow>[];
  totals: Record<string, number>;
  rowCount?: number;
}) {
  return (
    <tfoot>
      <tr className="border-t-2 border-gray-400 bg-gray-50">
        {columns.map((col, i) => {
          const key = (col as any).accessorKey as string;
          if (i === 0) {
            return (
              <td key={key} className={`py-2 px-3 font-semibold text-gray-900 whitespace-nowrap border-r border-gray-200 ${STICKY_FIRST} bg-gray-50 z-[1]`}>
                Total{rowCount != null ? `: ${rowCount}` : ''}
              </td>
            );
          }
          if (!key || !(key in totals)) {
            return <td key={key ?? i} className="py-2 px-3 font-mono whitespace-nowrap text-gray-400 border-r border-gray-200 last:border-r-0">—</td>;
          }
          const cellFn = col.cell as ((ctx: any) => React.ReactNode) | undefined;
          const formatted = cellFn?.({ getValue: () => totals[key] });
          return (
            <td key={key} className="py-2 px-3 font-mono font-semibold whitespace-nowrap border-r border-gray-200 last:border-r-0">
              {formatted ?? String(totals[key])}
            </td>
          );
        })}
      </tr>
    </tfoot>
  );
}

// ─── Component ─────────────────────────────────────────────────────────────────
interface Props {
  view: StatsView;
  data: StatsRow[];
  totals?: Record<string, number>;
  /** Passed so campaign group headers can show partner badges. */
  accounts?: { id: number; name: string; partner_code: string | null }[];
  /** Resolved date range — used for the Excel export filename. */
  from?: string;
  to?: string;
}

export default function StatsTable({ view, data, totals, accounts, from, to }: Props) {
  const [sorting, setSorting] = useState<SortingState>([]);
  const columns = VIEW_COLUMNS[view];

  // ── Column reordering (drag headers) ─────────────────────────────────────────
  // Drag a column header onto another to reorder. The first column (campaign
  // name / primary dimension) is locked — it stays frozen left. Order persists
  // per view in localStorage.
  const defaultOrder = useMemo(
    () => columns.map(c => (c as any).accessorKey as string),
    [columns],
  );
  const [columnOrder, setColumnOrder] = useState<string[]>(defaultOrder);
  useEffect(() => {
    try {
      const saved = localStorage.getItem(`ssm-colorder-${view}`);
      if (saved) {
        const arr = JSON.parse(saved) as string[];
        if (Array.isArray(arr) && arr.length === defaultOrder.length &&
            defaultOrder.every(k => arr.includes(k)) && arr[0] === defaultOrder[0]) {
          setColumnOrder(arr);
          return;
        }
      }
    } catch { /* corrupted saved order → fall through to default */ }
    setColumnOrder(defaultOrder);
  }, [view, defaultOrder]);

  const dragKey = useRef<string | null>(null);
  const moveColumn = (fromKey: string, toKey: string) => {
    if (fromKey === toKey) return;
    setColumnOrder(prev => {
      const next = prev.filter(k => k !== fromKey);
      const at = next.indexOf(toKey);
      if (at < 1) return prev;               // never displace the locked first column
      next.splice(at, 0, fromKey);
      try { localStorage.setItem(`ssm-colorder-${view}`, JSON.stringify(next)); } catch {}
      return next;
    });
  };

  // Columns in display order — used by the totals row so it matches the table.
  const orderedColumns = useMemo(
    () => columnOrder
      .map(k => columns.find(c => (c as any).accessorKey === k))
      .filter((c): c is ColumnDef<StatsRow> => c !== undefined),
    [columnOrder, columns],
  );

  // ── Frozen header rows ───────────────────────────────────────────────────────
  // The column-header row and (when present) the inline filter row stay pinned
  // to the top of the table's own scroll area, so long result sets can be
  // scrolled without losing sight of column names or active filters — same idea
  // as freezing the top rows in a spreadsheet. The filter row's sticky offset is
  // measured (not hardcoded) so it lines up exactly under the header row.
  const headerRowRef = useRef<HTMLTableRowElement>(null);
  const [headerRowHeight, setHeaderRowHeight] = useState(0);
  useLayoutEffect(() => {
    if (headerRowRef.current) setHeaderRowHeight(headerRowRef.current.offsetHeight);
  }, [columns, view]);

  // ── Inline column filters (permanent filter row) ────────────────────────────
  // Shown on Campaign and Ads tabs (the table views with per-row dimensions).
  const showFilterRow = view === 'campaign' || view === 'ads';
  // Map accessorKey → filter kind (numeric vs text) from column meta.
  const colKind = useMemo(() => {
    const m: Record<string, 'text' | 'numeric'> = {};
    for (const c of columns) {
      const key = (c as any).accessorKey as string | undefined;
      if (key) m[key] = (c.meta as any)?.numeric ? 'numeric' : 'text';
    }
    return m;
  }, [columns]);

  // Raw filters update immediately (responsive inputs); applied filters are
  // debounced 300ms so we don't re-filter the dataset on every keystroke.
  const [filters, setFilters] = useState<Filters>({});
  const [appliedFilters, setAppliedFilters] = useState<Filters>({});

  // Global search box — matches ANY of the view's dimension keys (campaign
  // name, ad name, IDs). Same debounce rhythm as the column filters.
  const searchKeys = SEARCH_KEYS[view];
  const [search, setSearch] = useState('');
  const [appliedSearch, setAppliedSearch] = useState('');

  // Reset filters when the view changes (column set differs per view).
  useEffect(() => { setFilters({}); setAppliedFilters({}); setSearch(''); setAppliedSearch(''); }, [view]);

  useEffect(() => {
    const t = setTimeout(() => setAppliedFilters(filters), 300);
    return () => clearTimeout(t);
  }, [filters]);

  useEffect(() => {
    const t = setTimeout(() => setAppliedSearch(search), 300);
    return () => clearTimeout(t);
  }, [search]);

  const activeFilters = useMemo(
    () => Object.entries(appliedFilters).filter(([, f]) => isFilterActive(f)),
    [appliedFilters],
  );
  // For the toolbar count / clear-all we use the *raw* filters so the indicator
  // appears instantly while the debounced filtering catches up.
  const anyRawActive = useMemo(
    () => Object.values(filters).some(isFilterActive),
    [filters],
  );

  const searchActive = appliedSearch.trim() !== '' && searchKeys.length > 0;

  const filteredData = useMemo(() => {
    let rows = data;
    if (searchActive) {
      const q = appliedSearch.trim().toLowerCase();
      rows = rows.filter(row =>
        searchKeys.some(k => String(row[k] ?? '').toLowerCase().includes(q)),
      );
    }
    if (activeFilters.length === 0) return rows;
    return rows.filter(row =>
      activeFilters.every(([key, f]) =>
        colKind[key] === 'numeric' ? passesNumericFilter(row[key], f) : passesTextFilter(row[key], f),
      ),
    );
  }, [data, activeFilters, colKind, searchActive, appliedSearch, searchKeys]);

  const setColFilter = (key: string, f: ColFilter | undefined) =>
    setFilters(prev => {
      const next = { ...prev };
      if (f === undefined) delete next[key]; else next[key] = f;
      return next;
    });
  const clearAllFilters = () => { setFilters({}); setAppliedFilters({}); setSearch(''); setAppliedSearch(''); };

  const filtersActive = activeFilters.length > 0 || searchActive;
  // Totals reflect the filtered set when any filter is active.
  const effectiveTotals = filtersActive ? computeTotalsClient(filteredData) : totals;

  const table = useReactTable({
    data: filteredData,
    columns,
    state: { sorting, columnOrder },
    onSortingChange: setSorting,
    onColumnOrderChange: setColumnOrder,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  });

  // ── Campaign group headers ─────────────────────────────────────────────────
  // Build a name → partner_code lookup from the accounts prop.
  const partnerByName = useMemo(() => {
    const map = new Map<string, string | null>();
    for (const a of accounts ?? []) map.set(a.name, a.partner_code);
    return map;
  }, [accounts]);

  // Group consecutive rows by ad_account_name (only for campaign view).
  // Rows are stable-sorted by account name first so groups are always contiguous;
  // within each group they keep tanstack's sort order (spend DESC by default).
  type GroupInfo = {
    accountName: string;
    partnerCode: string | null;
    spent: number;
    clicks: number;
    conversions: number;
    rows: ReturnType<typeof table.getRowModel>['rows'];
  };

  const campaignGroups = useMemo<GroupInfo[] | null>(() => {
    if (view !== 'campaign') return null;

    const sortedRows = [...table.getRowModel().rows].sort((a, b) => {
      const an = String(a.getValue('ad_account_name') ?? '');
      const bn = String(b.getValue('ad_account_name') ?? '');
      return an.localeCompare(bn);
    });

    // Count distinct accounts — only show headers when there are 2+
    const accountNames = new Set(sortedRows.map(r => String(r.getValue('ad_account_name') ?? '')));
    if (accountNames.size <= 1) return null;

    const groups: GroupInfo[] = [];
    for (const row of sortedRows) {
      const acctName = String(row.getValue('ad_account_name') ?? '');
      const last = groups[groups.length - 1];
      if (!last || last.accountName !== acctName) {
        groups.push({
          accountName: acctName,
          partnerCode: partnerByName.get(acctName) ?? null,
          spent: 0, clicks: 0, conversions: 0,
          rows: [],
        });
      }
      const g = groups[groups.length - 1];
      g.rows.push(row);
      g.spent       += Number(row.getValue('spent')       ?? 0);
      g.clicks      += Number(row.getValue('clicks')      ?? 0);
      g.conversions += Number(row.getValue('conversions') ?? 0);
    }
    return groups;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, filteredData, sorting, partnerByName]);

  if (data.length === 0) {
    return <p className="text-gray-400 text-sm mt-6">No data for this period.</p>;
  }

  const doExport = () =>
    exportXlsx(view, filteredData, effectiveTotals ?? {}, from ?? '', to ?? '');

  // ── Toolbar: search + clear-all/count (left) + Excel export (right). ──
  const anyRawSearch = search.trim() !== '';
  const toolbar = (
    <div className="flex flex-wrap items-center gap-2 mb-2">
      {searchKeys.length > 0 && (
        <div className="relative">
          <span className="absolute left-2 top-1/2 -translate-y-1/2 text-gray-400 text-xs pointer-events-none">🔍</span>
          <input
            type="text"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder={view === 'ads' ? 'Search ad, campaign or ID…' : 'Search campaign or ID…'}
            className="h-8 w-72 pl-7 pr-7 text-sm rounded border border-gray-300 bg-white focus:outline-none focus:ring-1 focus:ring-teal-600"
          />
          {anyRawSearch && (
            <button type="button" onClick={() => setSearch('')} title="Clear search"
              className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-700 text-sm leading-none">×</button>
          )}
        </div>
      )}
      {(anyRawActive || anyRawSearch) && (
        <>
          <button onClick={clearAllFilters}
            className="h-7 px-2.5 text-xs rounded border border-gray-300 text-gray-600 hover:bg-gray-50">
            Clear all filters
          </button>
          <span className="text-xs text-gray-400">
            Showing {filteredData.length} of {data.length} rows
          </span>
        </>
      )}
      <button onClick={doExport} title="Download the visible rows as an .xlsx file"
        className="ml-auto h-7 px-3 text-xs rounded border border-teal-600 text-teal-700 hover:bg-teal-50 font-medium flex items-center gap-1">
        <span>⭳</span> Export .xlsx
      </button>
    </div>
  );

  return (
    <>
    {toolbar}
    <div className="overflow-auto rounded border border-gray-200 max-h-[calc(100vh-260px)]">
      <table className="w-full text-sm table-dense">
        <thead>
          {table.getHeaderGroups().map(hg => (
            <tr key={hg.id} ref={headerRowRef} className="sticky top-0 z-20 bg-gray-50 border-b border-gray-200">
              {hg.headers.map((h, hi) => {
                const cat: ColCategory = (h.column.columnDef.meta as any)?.category ?? 'dimension';
                const bg = HEADER_BG[cat];
                // First column is frozen left; needs its own opaque bg + higher z
                // so scrolled columns pass underneath it. It is also excluded
                // from drag reordering.
                const frozen = hi === 0 ? `${STICKY_FIRST} z-30 bg-gray-50` : '';
                const colKey = (h.column.columnDef as any).accessorKey as string;
                return (
                  <th key={h.id}
                    style={bg ? { background: bg } : undefined}
                    className={`text-left font-medium text-gray-600 select-none whitespace-nowrap border-r border-gray-200 last:border-r-0 ${frozen} ${h.column.getCanSort() ? 'cursor-pointer hover:text-gray-900' : ''}`}
                    onClick={h.column.getToggleSortingHandler()}
                    draggable={hi !== 0}
                    onDragStart={hi !== 0 ? () => { dragKey.current = colKey; } : undefined}
                    onDragOver={hi !== 0 ? (e) => e.preventDefault() : undefined}
                    onDrop={hi !== 0 ? (e) => {
                      e.preventDefault();
                      if (dragKey.current) moveColumn(dragKey.current, colKey);
                      dragKey.current = null;
                    } : undefined}
                    title={hi !== 0 ? 'Click to sort · drag to reorder' : undefined}
                  >
                    {flexRender(h.column.columnDef.header, h.getContext())}
                    {h.column.getIsSorted() === 'asc'  ? ' ↑' : ''}
                    {h.column.getIsSorted() === 'desc' ? ' ↓' : ''}
                  </th>
                );
              })}
            </tr>
          ))}
          {/* Permanent inline filter row — always visible on Campaign/Ads tabs.
              Sticky offset is the measured header-row height so it sits right
              below the frozen column-header row, not on top of it. */}
          {showFilterRow && (
            <tr style={{ top: headerRowHeight }} className="sticky z-10 border-b border-gray-200">
              {table.getHeaderGroups()[0].headers.map((h, hi) => {
                const colKey = (h.column.columnDef as any).accessorKey as string | undefined;
                const kind = colKey ? colKind[colKey] : undefined;
                const frozen = hi === 0 ? `${STICKY_FIRST} z-30` : '';
                return (
                  <th key={h.id} style={{ background: '#f1f3f5' }}
                    className={`px-1 py-1 font-normal align-middle border-r border-gray-200 last:border-r-0 ${frozen}`}>
                    {colKey && kind && (
                      <FilterCell
                        kind={kind}
                        filter={filters[colKey]}
                        onChange={(f) => setColFilter(colKey, f)}
                      />
                    )}
                  </th>
                );
              })}
            </tr>
          )}
        </thead>

        <tbody className="divide-y divide-gray-100">
          {campaignGroups
            ? campaignGroups.map((group, gi) => (
                <Fragment key={`${group.accountName}-${gi}`}>
                  {/* ── Account group header row ── */}
                  <tr style={{ background: 'rgba(59,130,246,0.06)' }} className="border-t border-blue-100">
                    <td colSpan={columns.length} className="px-3 py-1.5">
                      <span className="font-semibold text-gray-800 text-xs">{group.accountName}</span>
                      {group.partnerCode && ACCT_BADGE[group.partnerCode] && (
                        <span className={`ml-2 text-xs font-semibold px-1 py-0.5 rounded ${ACCT_BADGE[group.partnerCode].bg}`}>
                          {ACCT_BADGE[group.partnerCode].label}
                        </span>
                      )}
                      <span className="ml-4 text-xs text-gray-500">
                        Spend&nbsp;{fmtMoney(group.spent)}
                        &nbsp;·&nbsp;Clicks&nbsp;{fmtInt(group.clicks)}
                        &nbsp;·&nbsp;Conv&nbsp;{fmtInt(group.conversions)}
                      </span>
                    </td>
                  </tr>
                  {/* ── Rows for this account ── */}
                  {group.rows.map((row, ri) => (
                    <tr key={row.id} className={`group ${ZEBRA[ri % 2]}`}>
                      {row.getVisibleCells().map((cell, ci) => (
                        <td key={cell.id}
                          className={`font-mono whitespace-nowrap border-r border-gray-200 last:border-r-0 ${HOVER_BG} ${ci === 0 ? `${STICKY_FIRST} z-[1] ${ZEBRA[ri % 2]}` : ''}`}>
                          {flexRender(cell.column.columnDef.cell, cell.getContext())}
                        </td>
                      ))}
                    </tr>
                  ))}
                </Fragment>
              ))
            : table.getRowModel().rows.map((row, ri) => (
                <tr key={row.id} className={`group ${ZEBRA[ri % 2]}`}>
                  {row.getVisibleCells().map((cell, ci) => (
                    <td key={cell.id}
                      className={`font-mono whitespace-nowrap border-r border-gray-200 last:border-r-0 ${HOVER_BG} ${ci === 0 ? `${STICKY_FIRST} z-[1] ${ZEBRA[ri % 2]}` : ''}`}>
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </td>
                  ))}
                </tr>
              ))
          }
          {filteredData.length === 0 && (
            <tr>
              <td colSpan={columns.length} className="px-3 py-4 text-center text-gray-400 text-sm">
                No rows match the current filters.{' '}
                <button onClick={clearAllFilters} className="text-teal-600 hover:underline">Clear filters</button>
              </td>
            </tr>
          )}
        </tbody>

        {effectiveTotals && Object.keys(effectiveTotals).length > 0 && filteredData.length > 0 && (
          <TotalsRow columns={orderedColumns} totals={effectiveTotals} rowCount={filteredData.length} />
        )}
      </table>
    </div>
    </>
  );
}

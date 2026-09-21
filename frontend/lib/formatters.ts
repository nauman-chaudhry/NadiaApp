// Formatters chosen to match the Power BI dashboard Nadia is currently using.

const intFmt     = new Intl.NumberFormat('en-US');
const moneyFmt   = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const decimalFmt = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function fmtInt(n: number | null | undefined): string {
  if (n == null) return '—';
  return intFmt.format(Math.round(Number(n)));
}

export function fmtMoney(n: number | null | undefined): string {
  if (n == null) return '—';
  return moneyFmt.format(Number(n));
}

export function fmtDecimal(n: number | null | undefined): string {
  if (n == null) return '—';
  return decimalFmt.format(Number(n));
}

export function fmtPct(n: number | null | undefined): string {
  if (n == null) return '—';
  return `${decimalFmt.format(Number(n))}%`;
}

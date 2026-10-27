import type { AccountUsageDto } from '@10db/contracts';

const TOKENS = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });
const USD = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const MONTH = new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });

/** A token count in compact form, as in "1.2M". */
export function formatTokens(n: number): string {
  return TOKENS.format(n);
}

/** Dollars with cents, as in "$123.45". */
export function formatUsd(n: number): string {
  return USD.format(n);
}

/** "2026-10" as "October 2026"; read in UTC so no time zone moves the month. */
export function monthLabel(month: string): string {
  return MONTH.format(new Date(`${month}-01T00:00:00Z`));
}

/**
 * How much of the monthly cap the month's spend is, as a percentage that may exceed 100. Null
 * when there is no cap or no dollar cost (a subscription).
 */
export function capShare(usage: AccountUsageDto): { pct: number; reached: boolean } | null {
  const { monthlyCapUsd } = usage;
  const spent = usage.total.costUsd;
  if (monthlyCapUsd === null || spent === null) return null;
  return { pct: (spent / monthlyCapUsd) * 100, reached: spent >= monthlyCapUsd };
}

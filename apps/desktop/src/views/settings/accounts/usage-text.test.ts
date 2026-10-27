import { describe, expect, it } from 'vitest';
import { accountUsageDto } from '../../../test/account-fixtures';
import { capShare, formatTokens, formatUsd, monthLabel } from './usage-text';

const totals = (costUsd: number | null) => ({
  tokensIn: 1,
  tokensOut: 1,
  tokensCached: 0,
  costUsd,
});

describe('formatTokens', () => {
  it.each([
    { name: 'zero', n: 0, text: '0' },
    { name: 'under a thousand', n: 999, text: '999' },
    { name: 'thousands', n: 12_300, text: '12.3K' },
    { name: 'millions', n: 1_200_000, text: '1.2M' },
  ])('$name', ({ n, text }) => {
    expect(formatTokens(n)).toBe(text);
  });
});

describe('formatUsd', () => {
  it.each([
    { name: 'cents', n: 123.45, text: '$123.45' },
    { name: 'zero', n: 0, text: '$0.00' },
    { name: 'thousands', n: 1234.5, text: '$1,234.50' },
  ])('$name', ({ n, text }) => {
    expect(formatUsd(n)).toBe(text);
  });
});

describe('monthLabel', () => {
  it.each([
    { name: 'October', month: '2026-10', text: 'October 2026' },
    { name: 'January', month: '2026-01', text: 'January 2026' },
    { name: 'December', month: '2025-12', text: 'December 2025' },
  ])('$name', ({ month, text }) => {
    expect(monthLabel(month)).toBe(text);
  });
});

describe('capShare', () => {
  it.each([
    {
      name: 'a metered account under its cap',
      usage: accountUsageDto({ total: totals(25), monthlyCapUsd: 100 }),
      share: { pct: 25, reached: false },
    },
    {
      name: 'exactly at the cap',
      usage: accountUsageDto({ total: totals(100), monthlyCapUsd: 100 }),
      share: { pct: 100, reached: true },
    },
    {
      name: 'over the cap',
      usage: accountUsageDto({ total: totals(150), monthlyCapUsd: 100 }),
      share: { pct: 150, reached: true },
    },
    {
      name: 'no cap',
      usage: accountUsageDto({ total: totals(25), monthlyCapUsd: null }),
      share: null,
    },
    {
      name: 'a subscription with no dollar cost',
      usage: accountUsageDto({ total: totals(null), monthlyCapUsd: 100 }),
      share: null,
    },
  ])('$name', ({ usage, share }) => {
    expect(capShare(usage)).toEqual(share);
  });
});

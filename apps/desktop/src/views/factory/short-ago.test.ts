import { describe, expect, it } from 'vitest';
import { formatTokens } from './format-tokens';
import { shortAgo } from './short-ago';

const NOW = Date.UTC(2026, 10, 2, 12);
const before = (ms: number) => new Date(NOW - ms).toISOString();

describe('shortAgo', () => {
  it.each([
    { name: 'under a minute', ms: 30_000, text: 'just now' },
    { name: 'a future time', ms: -5_000, text: 'just now' },
    { name: 'minutes', ms: 5 * 60_000 + 59_000, text: '5m ago' },
    { name: 'hours', ms: 3 * 3_600_000 + 1_800_000, text: '3h ago' },
    { name: 'days', ms: 2 * 86_400_000 + 3_600_000, text: '2d ago' },
  ])('says $name as $text', ({ ms, text }) => {
    expect(shortAgo(before(ms), NOW)).toBe(text);
  });
});

describe('formatTokens', () => {
  it.each([
    { tokens: 0, text: '0' },
    { tokens: 850, text: '850' },
    { tokens: 412_000, text: '412k' },
    { tokens: 1_250_000, text: '1.3M' },
  ])('writes $tokens as $text', ({ tokens, text }) => {
    expect(formatTokens(tokens)).toBe(text);
  });
});

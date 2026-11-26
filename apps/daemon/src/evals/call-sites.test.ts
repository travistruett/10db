import { EvalCallPattern, EvalManifest } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import { STOCK_CALL_PATTERNS } from './call-sites';

describe('call patterns', () => {
  it('holds the stock table to the rules a recorded pattern meets', () => {
    for (const pattern of STOCK_CALL_PATTERNS)
      expect(EvalCallPattern.parse(pattern)).toEqual(pattern);
  });

  it('refuses a regex git grep -E would read differently, or a glob git has no syntax for', () => {
    const refused = (regex: string, globs = ['**']) =>
      !EvalCallPattern.safeParse({ label: 'x', regex, globs }).success;
    expect(refused('@register_task')).toBe(false);
    expect(refused('[[:space:]]def[[:space:]]run\\(')).toBe(false);
    expect(refused('run(')).toBe(true);
    expect(refused('\\bquery\\(')).toBe(true);
    expect(refused('(?:a|b)')).toBe(true);
    expect(refused('a.*?b')).toBe(true);
    expect(refused('ok', ['src/**/*.{py,ts}'])).toBe(true);
    expect(EvalManifest.parse({ suites: [], gaps: [] }).callPatterns).toEqual([]);
  });
});

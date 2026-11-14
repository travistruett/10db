import { describe, expect, it } from 'vitest';
import { BenchmarkKeyInput, BenchmarkStatusDto } from './benchmarks';

describe('benchmark key input', () => {
  it('trims the key', () => {
    expect(BenchmarkKeyInput.parse({ key: '  aa-abc  ' })).toEqual({ key: 'aa-abc' });
  });

  it.each([
    ['empty', { key: '' }],
    ['blank', { key: '   ' }],
    ['holding a space', { key: 'aa abc' }],
    ['holding a quote', { key: 'aa"abc' }],
    ['holding a backslash', { key: 'aa\\abc' }],
    ['with an unknown field', { key: 'aa-abc', extra: 1 }],
  ])('rejects a key that is %s', (_name, input) => {
    expect(BenchmarkKeyInput.safeParse(input).success).toBe(false);
  });
});

describe('benchmark status', () => {
  it('reads a status from before the off switch was reported as not off', () => {
    const parsed = BenchmarkStatusDto.parse({
      keyConfigured: false,
      lastSyncAt: null,
      lastSuccessAt: null,
      outcome: null,
      message: null,
      models: 0,
      unmeasuredProfiles: [],
    });
    expect(parsed.off).toBe(false);
    expect(parsed.openRouter).toEqual({
      keyConfigured: false,
      lastSuccessAt: null,
      outcome: null,
      message: null,
      off: false,
    });
  });
});

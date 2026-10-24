import type { BenchmarkStatusDto } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import { syncWarning } from './warning';

const status = (outcome: BenchmarkStatusDto['outcome'], message: string | null = null) =>
  ({
    keyConfigured: true,
    lastSyncAt: '2026-10-17T12:00:00.000Z',
    lastSuccessAt: null,
    outcome,
    message,
    models: 0,
    indexVersion: null,
    unmeasuredProfiles: [],
    missingScores: [],
  }) satisfies BenchmarkStatusDto;

describe('syncWarning', () => {
  it.each([
    { name: 'no sync yet', outcome: null, warning: null },
    { name: 'a good sync', outcome: 'ok' as const, warning: null },
    { name: 'no key, which is not a failure', outcome: 'no_key' as const, warning: null },
    {
      name: 'a rejected key',
      outcome: 'unauthorized' as const,
      warning: { outcome: 'unauthorized', message: 'Artificial Analysis refused the key' },
    },
    {
      name: 'the rate limit',
      outcome: 'rate_limited' as const,
      warning: {
        outcome: 'rate_limited',
        message: 'The daily Artificial Analysis limit is used up',
      },
    },
    {
      name: 'a failed sync',
      outcome: 'failed' as const,
      warning: { outcome: 'failed', message: 'Artificial Analysis answered 503' },
    },
  ])('gives $name the warning $warning', ({ outcome, warning }) => {
    const message = warning?.message ?? null;
    expect(syncWarning(status(outcome, message))).toEqual(warning);
  });

  it('names a failed sync that has no message with the outcome', () => {
    expect(syncWarning(status('failed'))).toEqual({
      outcome: 'failed',
      message: 'The last Artificial Analysis sync failed',
    });
  });
});

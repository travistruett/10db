import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { insertJudgeCall, type JudgeCallInput } from './judge-calls';
import { judgeCallModelStats } from './judge-call-stats';
import type { Store } from './store';
import { createTestStore } from './test-support';

let store: Store;
let close: () => void;
let now = new Date('2026-11-01T10:00:00.000Z');

beforeEach(() => {
  now = new Date('2026-11-01T10:00:00.000Z');
  ({ store, close } = createTestStore(() => now));
});
afterEach(() => {
  close();
});

const call = (over: Partial<JudgeCallInput>): JudgeCallInput => ({
  decision: 'review_size',
  model: 'liquid/d1',
  state: 'state',
  question: 'q',
  answer: 'skip',
  confidence: 0.9,
  outcome: 'acted',
  latencyMs: 100,
  costUsd: 0.001,
  workstreamId: null,
  taskId: null,
  ...over,
});
const log = (over: Partial<JudgeCallInput>, at = now) => {
  now = at;
  store.write((ctx) => insertJudgeCall(ctx, call(over)));
};

describe('judgeCallModelStats', () => {
  it('counts each model’s answered calls, their cost and their median latency', () => {
    log({ latencyMs: 100, costUsd: 0.001 });
    log({ latencyMs: 300, costUsd: 0.003 });
    log({ latencyMs: 200, costUsd: null, outcome: 'below_floor' });
    log({ model: 'typesafe/jev-1.14', latencyMs: 50, costUsd: 0.5, outcome: 'shadow' });
    expect(judgeCallModelStats(store.db, '2026-10-01T00:00:00.000Z')).toEqual([
      { model: 'liquid/d1', calls: 3, costedCalls: 2, totalCostUsd: 0.004, medianLatencyMs: 200 },
      {
        model: 'typesafe/jev-1.14',
        calls: 1,
        costedCalls: 1,
        totalCostUsd: 0.5,
        medianLatencyMs: 50,
      },
    ]);
  });

  it.each([
    'fallback_off',
    'fallback_no_key',
    'fallback_timeout',
    'fallback_error',
    'stopped',
  ] as const)('does not count a %s call', (outcome) => {
    log({ outcome });
    expect(judgeCallModelStats(store.db, '2026-10-01T00:00:00.000Z')).toEqual([]);
  });

  it('leaves out calls before the time asked, and reads no latency as no median', () => {
    log({ latencyMs: 100 }, new Date('2026-09-01T00:00:00.000Z'));
    log({ latencyMs: null, costUsd: null }, new Date('2026-11-01T00:00:00.000Z'));
    expect(judgeCallModelStats(store.db, '2026-10-01T00:00:00.000Z')).toEqual([
      { model: 'liquid/d1', calls: 1, costedCalls: 0, totalCostUsd: 0, medianLatencyMs: null },
    ]);
  });
});

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { insertJudgeCall, type JudgeCallInput } from './judge-calls';
import { judgeCallModelStats, judgeDecisionStats } from './judge-call-stats';
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
    // A call the builder overrode was answered, and cost what it cost.
    log({ latencyMs: 400, costUsd: 0.004, outcome: 'overridden' });
    log({ model: 'typesafe/jev-1.14', latencyMs: 50, costUsd: 0.5, outcome: 'shadow' });
    expect(judgeCallModelStats(store.db, '2026-10-01T00:00:00.000Z')).toEqual([
      { model: 'liquid/d1', calls: 4, costedCalls: 3, totalCostUsd: 0.008, medianLatencyMs: 250 },
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

describe('judgeDecisionStats', () => {
  it('counts each outcome apart, a stopped call not among the fallbacks', () => {
    log({ outcome: 'acted', latencyMs: 100, costUsd: 0.001, confidence: 0.9 });
    log({ outcome: 'below_floor', latencyMs: 300, costUsd: 0.002, confidence: 0.4 });
    log({
      outcome: 'shadow',
      latencyMs: 200,
      costUsd: null,
      confidence: 0.7,
      model: 'typesafe/jev-1.14',
    });
    log({ outcome: 'overridden', latencyMs: 400, costUsd: 0.004, confidence: 0.6 });
    log({ outcome: 'stopped', latencyMs: null, costUsd: null, confidence: null });
    log({ outcome: 'fallback_timeout', latencyMs: 4000, costUsd: null, confidence: null });
    log({ outcome: 'fallback_error', latencyMs: null, costUsd: null, confidence: null });
    log({ outcome: 'fallback_off', latencyMs: null, costUsd: null, confidence: null });
    log({ outcome: 'fallback_no_key', latencyMs: null, costUsd: null, confidence: null });
    log({ decision: 'shape_ready', outcome: 'acted', confidence: 0.8 });
    expect(judgeDecisionStats(store.db, '2026-10-01T00:00:00.000Z')).toEqual([
      {
        decision: 'review_size',
        calls: 9,
        acted: 1,
        belowFloor: 1,
        shadow: 1,
        overridden: 1,
        stopped: 1,
        fallbacks: { off: 1, no_key: 1, timeout: 1, error: 1 },
        costUsd: 0.007,
        medianLatencyMs: 250,
        answers: [
          { model: 'liquid/d1', confidence: 0.9 },
          { model: 'liquid/d1', confidence: 0.4 },
          { model: 'typesafe/jev-1.14', confidence: 0.7 },
          { model: 'liquid/d1', confidence: 0.6 },
        ],
      },
      expect.objectContaining({ decision: 'shape_ready', calls: 1, acted: 1 }),
    ]);
  });

  it('lists the answers oldest call first, whatever order they were logged in', () => {
    log({ outcome: 'acted', confidence: 0.1 }, new Date('2026-11-01T12:00:00.000Z'));
    log({ outcome: 'acted', confidence: 0.2 }, new Date('2026-11-01T11:00:00.000Z'));
    log({ outcome: 'acted', confidence: 0.3 }, new Date('2026-11-01T13:00:00.000Z'));
    const [stats] = judgeDecisionStats(store.db, '2026-10-01T00:00:00.000Z');
    expect(stats?.answers.map((a) => a.confidence)).toEqual([0.2, 0.1, 0.3]);
  });

  it('leaves out a decision with no calls since the time asked', () => {
    log({ outcome: 'acted' }, new Date('2026-09-01T00:00:00.000Z'));
    expect(judgeDecisionStats(store.db, '2026-10-01T00:00:00.000Z')).toEqual([]);
  });
});

import { mintId } from '@10db/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  deleteJudgeCallsBefore,
  insertJudgeCall,
  type JudgeCallInput,
  listJudgeCalls,
  pageJudgeCalls,
  recordJudgeOutcome,
} from './judge-calls';
import type { Store } from './store';
import { createTestStore } from './test-support';

let store: Store;
let close: () => void;
let now = new Date('2026-10-31T10:00:00.000Z');

beforeEach(() => {
  now = new Date('2026-10-31T10:00:00.000Z');
  ({ store, close } = createTestStore(() => now));
});
afterEach(() => {
  close();
});

const call = {
  decision: 'review_size',
  model: 'typesafe/jev-1.13',
  state: 'the task and its diff',
  question: 'Does this need a review?',
  answer: 'skip',
  confidence: 0.93,
  outcome: 'fallback_error',
  latencyMs: 280,
  costUsd: 0.0002,
  workstreamId: null,
  taskId: null,
} as const;

describe('judge calls', () => {
  it('logs a call and reads it back newest first', () => {
    const first = store.write((ctx) => insertJudgeCall(ctx, call)).value;
    now = new Date('2026-10-31T10:05:00.000Z');
    const taskId = mintId('Task');
    const second = store.write((ctx) =>
      insertJudgeCall(ctx, { ...call, answer: null, confidence: null, taskId }),
    ).value;
    const listed = listJudgeCalls(store.db, 10);
    expect(listed.map((c) => c.id)).toEqual([second, first]);
    expect(listed[1]).toEqual({
      id: first,
      decision: 'review_size',
      model: 'typesafe/jev-1.13',
      question: 'Does this need a review?',
      answer: 'skip',
      confidence: 0.93,
      outcome: 'fallback_error',
      latencyMs: 280,
      costUsd: 0.0002,
      workstreamId: null,
      taskId: null,
      createdAt: '2026-10-31T10:00:00.000Z',
    });
    expect(listed[0]?.taskId).toBe(taskId);
  });

  it('limits the list', () => {
    for (let i = 0; i < 3; i += 1) store.write((ctx) => insertJudgeCall(ctx, call));
    expect(listJudgeCalls(store.db, 2)).toHaveLength(2);
  });

  it('never lists the state it sent', () => {
    store.write((ctx) => insertJudgeCall(ctx, call));
    expect(JSON.stringify(listJudgeCalls(store.db, 10))).not.toContain('the task and its diff');
  });

  it('records the outcome the decision acted on', () => {
    const id = store.write((ctx) => insertJudgeCall(ctx, call)).value;
    store.write((ctx) => {
      recordJudgeOutcome(ctx, id, 'acted');
    });
    expect(listJudgeCalls(store.db, 10)[0]?.outcome).toBe('acted');
  });

  it('deletes calls older than the cutoff and keeps the rest', () => {
    const old = store.write((ctx) => insertJudgeCall(ctx, call)).value;
    now = new Date('2026-12-05T10:00:00.000Z');
    const recent = store.write((ctx) => insertJudgeCall(ctx, call)).value;
    const removed = store.write((ctx) =>
      deleteJudgeCallsBefore(ctx, '2026-11-05T10:00:00.000Z'),
    ).value;
    expect(removed).toBe(1);
    expect(listJudgeCalls(store.db, 10).map((c) => c.id)).toEqual([recent]);
    expect(old).not.toBe(recent);
  });
});

describe('pageJudgeCalls', () => {
  const log = (over: Partial<JudgeCallInput> & { n: number }) => {
    now = new Date(now.getTime() + 1000);
    const { n, ...rest } = over;
    store.write((ctx) => insertJudgeCall(ctx, { ...call, question: `q${String(n)}`, ...rest }));
  };
  const questions = (page: ReturnType<typeof pageJudgeCalls>) => page.calls.map((c) => c.question);

  it.each([
    {
      name: 'every call with nothing asked',
      q: { limit: 10, offset: 0 },
      expected: ['q4', 'q3', 'q2', 'q1', 'q0'],
      total: 5,
    },
    {
      name: 'the second page by offset, with the total of all',
      q: { limit: 2, offset: 2 },
      expected: ['q2', 'q1'],
      total: 5,
    },
    {
      name: 'one decision, and the total of that decision only',
      q: { limit: 10, offset: 0, decision: 'shape_ready' as const },
      expected: ['q3', 'q1'],
      total: 2,
    },
    {
      name: 'one outcome',
      q: { limit: 10, offset: 0, outcome: 'acted' as const },
      expected: ['q2', 'q0'],
      total: 2,
    },
    {
      name: 'a decision and an outcome together',
      q: { limit: 10, offset: 0, decision: 'shape_ready' as const, outcome: 'acted' as const },
      expected: [],
      total: 0,
    },
  ])('answers $name', ({ q, expected, total }) => {
    log({ n: 0, outcome: 'acted' });
    log({ n: 1, decision: 'shape_ready', outcome: 'below_floor' });
    log({ n: 2, outcome: 'acted' });
    log({ n: 3, decision: 'shape_ready', outcome: 'fallback_timeout' });
    log({ n: 4, outcome: 'stopped' });
    const page = pageJudgeCalls(store.db, q);
    expect(questions(page)).toEqual(expected);
    expect(page.total).toBe(total);
  });
});

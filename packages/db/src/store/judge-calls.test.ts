import { mintId } from '@10db/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  deleteJudgeCallsBefore,
  insertJudgeCall,
  listJudgeCalls,
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

import { EventType, LinearEventKind, mintId, type DaemonEvent } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import { linearRowOf, type LinearEventRead } from './reporter-events';

const ws = mintId('Workstream');
const batchId = mintId('Batch');
const task = mintId('Task');

function event(
  type: DaemonEvent['type'],
  data: DaemonEvent['data'],
  entityId: string = ws,
): DaemonEvent {
  return { seq: 1, type, entityType: 'x', entityId, data, at: '2026-11-22T10:00:00.000Z' };
}
const wsRead = (ends: number): LinearEventRead => ({
  workstream: { id: ws, taskId: task, failureKind: null, ends, stepResultAt: null },
});
const keys = (e: DaemonEvent, read: LinearEventRead): string[] =>
  linearRowOf(e, read).map((d) => d.dedupeKey);
const changed = (to: string): DaemonEvent =>
  event(EventType.WorkstreamChanged, { from: 'QUEUED', to, reason: null });

describe('linearRowOf', () => {
  it('keys a run by its workstream and the ends before it, so only a Retry posts again', () => {
    expect(keys(changed('STARTING'), wsRead(0))).toEqual([`run_started:${ws}:0`]);
    // A re-entry with no end between has the same key, which the store's dedupe drops.
    expect(keys(changed('STARTING'), wsRead(0))).toEqual([`run_started:${ws}:0`]);
    // FAILED, then Retry (STARTING) and DONE on the same workstream.
    expect(keys(changed('FAILED'), wsRead(0))).toEqual([`ended:${ws}:0`]);
    expect(keys(changed('STARTING'), wsRead(1))).toEqual([`run_started:${ws}:1`]);
    expect(keys(changed('DONE'), wsRead(1))).toEqual([`ended:${ws}:1`]);
  });

  it('makes nothing from a step without a verdict, or a batch update that is not a PR event', () => {
    expect(
      keys(event(EventType.StepChanged, { stepIndex: 1, role: 'plan', verdict: null }), wsRead(0)),
    ).toEqual([]);
    const batch = (prState: string): LinearEventRead => ({
      batch: {
        prUrl: 'https://github.com/a/b/pull/1',
        prState,
        workstreams: [{ id: ws, taskId: task }],
      },
    });
    const prChanged = event(EventType.BatchUpdated, { changed: ['pr'] }, batchId);
    expect(keys(prChanged, batch('open'))).toEqual([]);
    expect(linearRowOf(prChanged, batch('merged')).map((d) => [d.event, d.dedupeKey])).toEqual([
      [LinearEventKind.PrMerged, `pr_merged:${batchId}`],
    ]);
  });
});

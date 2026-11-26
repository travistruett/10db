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
  workstream: { id: ws, taskId: task, failureKind: null, ends },
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

  it('folds a burst of waiting items and the plan-review verdicts into one update per run', () => {
    const inbox = (ends: number): LinearEventRead => ({
      inbox: { title: 'Needs you', workstreams: [{ id: ws, taskId: task, ends }] },
    });
    const opened = (id: string): DaemonEvent =>
      event(EventType.InboxOpened, { kind: 'question' }, id);
    expect(keys(opened('inb_1'), inbox(0))).toEqual(keys(opened('inb_2'), inbox(0)));
    // A Retry after an end is a new phase.
    expect(keys(opened('inb_3'), inbox(1))).not.toEqual(keys(opened('inb_1'), inbox(0)));

    const step = (stepIndex: number, role: string): string[] =>
      keys(event(EventType.StepChanged, { stepIndex, role, verdict: 'reject' }), wsRead(0));
    // A plan review has no comment of its own: the run's one verdict comment tells it with the code review.
    expect(step(1, 'plan_review')).toEqual([]);
    expect(step(3, 'review')).toEqual([`verdict:${ws}:0`]);
    expect(step(5, 'qa')).toEqual(step(3, 'review'));
  });

  it('makes nothing from a step without a verdict, or a batch update that is not a PR event', () => {
    expect(
      keys(event(EventType.StepChanged, { stepIndex: 1, role: 'plan', verdict: null }), wsRead(0)),
    ).toEqual([]);
    const batch = (prState: string): LinearEventRead => ({
      batch: {
        prUrl: 'https://github.com/a/b/pull/1',
        prState,
        shippedLocalCopy: false,
        workstreams: [{ id: ws, taskId: task }],
      },
    });
    const prChanged = event(EventType.BatchUpdated, { changed: ['pr'] }, batchId);
    expect(keys(prChanged, batch('open'))).toEqual([]);
    // A shipped batch (its pull request opened) makes no comment: the landing is the merge.
    expect(keys(event(EventType.BatchUpdated, { to: 'SHIPPED' }, batchId), batch('open'))).toEqual(
      [],
    );
    expect(linearRowOf(prChanged, batch('merged')).map((d) => [d.event, d.dedupeKey])).toEqual([
      [LinearEventKind.PrMerged, `pr_merged:${batchId}`],
    ]);
    // A local copy has no pull request: its landing is the batch shipping, and its comment carries the pictures.
    const shipped = event(EventType.BatchUpdated, { to: 'SHIPPED' }, batchId);
    const landed = linearRowOf(shipped, {
      batch: {
        prUrl: null,
        prState: null,
        shippedLocalCopy: true,
        workstreams: [{ id: ws, taskId: task }],
      },
    });
    expect(
      landed.map((d) => [d.event, d.dedupeKey, d.detail['prUrl'], d.detail['localCopy']]),
    ).toEqual([[LinearEventKind.PrMerged, `landed:${batchId}`, null, true]]);
  });
});

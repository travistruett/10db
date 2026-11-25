import {
  BatchState,
  mintId,
  QueueWaitKind,
  WorkstreamState,
  type QueueWait,
  type TaskId,
} from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import { findStalls, StallAction, type StallInput } from './rules';

const NOW = new Date('2026-11-25T12:00:00.000Z');
const ago = (minutes: number): string => new Date(NOW.getTime() - minutes * 60_000).toISOString();
const projectId = mintId('Project');

function queuedRun(wait: Partial<QueueWait> & { kind: QueueWait['kind'] }, batchId = null) {
  return {
    run: {
      id: mintId('Workstream'),
      projectId,
      taskId: mintId('Task'),
      batchId,
      state: WorkstreamState.Queued,
    },
    title: 'Fix login',
    wait: { line: 'for something', endless: false, since: ago(0), on: null, ...wait },
  };
}

function input(over: Partial<StallInput>): StallInput {
  return { now: NOW, queued: [], active: [], batches: [], carried: new Map(), ...over };
}

describe('findStalls', () => {
  it('counts a queued wait by its kind and its age, and an endless one at once', () => {
    const dep: TaskId = mintId('Task');
    const cases: [string, Parameters<typeof queuedRun>[0], boolean][] = [
      ['a lane past the threshold', { kind: QueueWaitKind.Lane, since: ago(60) }, false],
      ['a folder at 14 minutes', { kind: QueueWaitKind.Folder, since: ago(14) }, false],
      ['a folder at 16 minutes', { kind: QueueWaitKind.Folder, since: ago(16) }, true],
      [
        'a cancelled dependency',
        { kind: QueueWaitKind.Dependency, endless: true, on: { taskId: dep, workstreamId: null } },
        true,
      ],
      ['a landing on its own copy', { kind: QueueWaitKind.Dependency, endless: true }, true],
      ['a claim held by a finished run', { kind: QueueWaitKind.Claim, endless: true }, true],
      ['a copy that is over', { kind: QueueWaitKind.Copy, endless: true }, true],
    ];
    for (const [name, wait, stuck] of cases) {
      const found = findStalls(input({ queued: [queuedRun(wait)] }));
      expect(found.length, name).toBe(stuck ? 1 : 0);
    }
  });

  it('offers a retry of a failed dependency, and names the run and its wait', () => {
    const failed = mintId('Workstream');
    const q = queuedRun({
      kind: QueueWaitKind.Dependency,
      line: 'for Set up auth, which failed',
      endless: true,
      on: { taskId: mintId('Task'), workstreamId: failed },
    });
    const [stall] = findStalls(input({ queued: [q] }));
    expect(stall).toMatchObject({
      key: `stuck:run:${q.run.id}`,
      workstreamId: q.run.id,
      title: 'Fix login',
      dependencyRunId: failed,
      actions: [StallAction.CancelRun, StallAction.RetryDependency],
    });
    expect(stall?.reason).toContain('for Set up auth, which failed');
  });

  it('finds an active run idle past its threshold, and not before', () => {
    const run = (minutes: number) => ({
      id: mintId('Workstream'),
      projectId,
      taskTitle: 'Build it',
      state: WorkstreamState.Running,
      lastActivityAt: ago(minutes),
      updatedAt: ago(90),
    });
    expect(findStalls(input({ active: [run(19)] }))).toHaveLength(0);
    expect(findStalls(input({ active: [run(21)] }))).toHaveLength(1);
  });

  it('folds an open batch whose only unfinished member can never start into one batch stall', () => {
    const batchId = mintId('Batch');
    const waiting = queuedRun({ kind: QueueWaitKind.Dependency, endless: true }, null);
    const done = Array.from({ length: 6 }, () => ({
      id: mintId('Workstream'),
      state: WorkstreamState.Done,
    }));
    const found = findStalls(
      input({
        queued: [{ ...waiting, run: { ...waiting.run, batchId } }],
        batches: [
          {
            batch: {
              id: batchId,
              projectId,
              title: 'Ampsio copy',
              state: BatchState.Open,
              passId: null,
              updatedAt: ago(5),
            },
            members: [...done, { id: waiting.run.id, state: WorkstreamState.Queued }],
          },
        ],
      }),
    );
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      key: `stuck:batch:${batchId}`,
      workstreamId: null,
      batchId,
      waitingRunIds: [waiting.run.id],
      actions: [StallAction.CancelWaiting, StallAction.AbandonBatch],
    });
  });

  it('finds a batch shipping past its threshold', () => {
    const batch = (minutes: number) => ({
      batch: {
        id: mintId('Batch'),
        projectId,
        title: 'Copy',
        state: BatchState.Shipping,
        passId: null,
        updatedAt: ago(minutes),
      },
      members: [],
    });
    expect(findStalls(input({ batches: [batch(59)] }))).toHaveLength(0);
    expect(findStalls(input({ batches: [batch(61)] }))).toHaveLength(1);
  });

  it('keeps the earlier since an open card carried across a restart', () => {
    const q = queuedRun({ kind: QueueWaitKind.Claim, endless: true, since: ago(1) });
    const [stall] = findStalls(
      input({ queued: [q], carried: new Map([[`stuck:run:${q.run.id}`, ago(40)]]) }),
    );
    expect(stall?.since).toBe(ago(40));
  });
});

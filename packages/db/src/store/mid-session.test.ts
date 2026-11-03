import { BatchState, WorkstreamState as S, type WorkstreamId } from '@10db/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { insertBatch, transitionBatch } from './batches';
import type { Store } from './store';
import { insertTask } from './tasks';
import { createTestStore, seedProject } from './test-support';
import {
  countMidSession,
  insertWorkstream,
  patchWorkstream,
  transitionWorkstream,
} from './workstreams';

let store: Store;
let close: () => void;
beforeEach(() => {
  ({ store, close } = createTestStore(() => new Date('2026-10-29T12:00:00.000Z')));
});
afterEach(() => {
  close();
});

function workstream(): WorkstreamId {
  const project = seedProject(store);
  const task = store.write((ctx) =>
    insertTask(ctx, project.id, { title: 'T', acceptanceCriteria: ['x'], areas: ['api'] }),
  ).value;
  return store.write((ctx) => insertWorkstream(ctx, task.id)).value.id;
}

function moveThrough(id: WorkstreamId, path: readonly S[]): void {
  for (const to of path) {
    store.write((ctx) => transitionWorkstream(ctx, id, { to, fence: null }));
  }
}

describe('countMidSession', () => {
  it('is zero when nothing runs', () => {
    expect(countMidSession(store.db)).toBe(0);
  });

  it('does not count work that is only queued', () => {
    workstream();
    expect(countMidSession(store.db)).toBe(0);
  });

  it.each([
    ['starting', [S.Starting]],
    ['running', [S.Starting, S.Running]],
    ['verifying', [S.Starting, S.Running, S.Verifying]],
  ] as const)('counts a lane that is %s', (_name, path) => {
    moveThrough(workstream(), path);
    expect(countMidSession(store.db)).toBe(1);
  });

  it('counts a gate process that is running', () => {
    const id = workstream();
    store.write((ctx) => {
      patchWorkstream(ctx, id, null, { gatePid: 4242, gatePidStart: 'x' });
    });
    expect(countMidSession(store.db)).toBe(1);
  });

  it('counts a batch that is being cut', () => {
    const project = seedProject(store);
    store.write((ctx) =>
      insertBatch(ctx, { projectId: project.id, title: 'B', baseBranch: 'main' }),
    );
    expect(countMidSession(store.db)).toBe(1);
  });

  it('counts a batch that is shipping, but not one that is only open', () => {
    const project = seedProject(store);
    const batch = store.write((ctx) =>
      insertBatch(ctx, { projectId: project.id, title: 'B', baseBranch: 'main' }),
    ).value;
    store.write((ctx) => transitionBatch(ctx, batch.id, { to: BatchState.Open }));
    expect(countMidSession(store.db)).toBe(0);
    store.write((ctx) => transitionBatch(ctx, batch.id, { to: BatchState.Shipping }));
    expect(countMidSession(store.db)).toBe(1);
  });
});

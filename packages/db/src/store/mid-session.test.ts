import {
  BatchState,
  WorkstreamState as S,
  type SessionId,
  type WorkstreamId,
} from '@10db/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { insertBatch, transitionBatch } from './batches';
import type { Store } from './store';
import { insertTask } from './tasks';
import { createTestStore, seedProject } from './test-support';
import {
  countMidSession,
  countWaitingOnCard,
  insertWorkstream,
  isLaneWaitingOnCard,
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

  describe('a lane waiting on a card', () => {
    function waitingOnCard(): WorkstreamId {
      const id = workstream();
      moveThrough(id, [S.Starting, S.Running]);
      store.write((ctx) => {
        patchWorkstream(ctx, id, null, {
          currentSessionId: 'ses_01a00000-0000-7000-8000-000000000001' as SessionId,
        });
        transitionWorkstream(ctx, id, { to: S.WaitingHuman, fence: null });
      });
      return id;
    }

    it('counts while its session is live, unless the caller leaves such lanes out', () => {
      waitingOnCard();
      expect(countMidSession(store.db)).toBe(1);
      expect(countMidSession(store.db, { waitingOnCard: true })).toBe(1);
      expect(countMidSession(store.db, { waitingOnCard: false })).toBe(0);
      expect(countWaitingOnCard(store.db)).toBe(1);
    });

    it('is not counted twice when it also runs a gate, and a gate still counts without it', () => {
      const id = waitingOnCard();
      store.write((ctx) => {
        patchWorkstream(ctx, id, null, { gatePid: 4242, gatePidStart: 'x' });
      });
      expect(countMidSession(store.db, { waitingOnCard: false })).toBe(1);
      expect(countWaitingOnCard(store.db)).toBe(0);
    });

    it('is no wait at all once its session is gone: recovery keeps its place', () => {
      const id = waitingOnCard();
      store.write((ctx) => {
        patchWorkstream(ctx, id, null, { currentSessionId: null });
      });
      expect(countMidSession(store.db)).toBe(0);
      expect(countWaitingOnCard(store.db)).toBe(0);
      expect(isLaneWaitingOnCard(store.db, id)).toBe(false);
    });

    it('is told apart from a lane that runs, one with a gate, and one that is not there', () => {
      const id = waitingOnCard();
      expect(isLaneWaitingOnCard(store.db, id)).toBe(true);
      expect(isLaneWaitingOnCard(store.db, 'wks_missing' as WorkstreamId)).toBe(false);
      store.write((ctx) => {
        patchWorkstream(ctx, id, null, { gatePid: 4242, gatePidStart: 'x' });
      });
      expect(isLaneWaitingOnCard(store.db, id)).toBe(false);
      const running = workstream();
      moveThrough(running, [S.Starting, S.Running]);
      expect(isLaneWaitingOnCard(store.db, running)).toBe(false);
    });
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

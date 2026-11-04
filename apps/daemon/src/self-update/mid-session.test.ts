import { BatchState, WorkstreamState as S, type SessionId } from '@10db/contracts';
import {
  countWaitingOnCard,
  createTestStore,
  insertBatch,
  insertTask,
  insertWorkstream,
  patchWorkstream,
  seedProject,
  transitionBatch,
  transitionWorkstream,
} from '@10db/db';
import { describe, expect, it } from 'vitest';
import { midSessionWork } from './mid-session';

const quiet = { turnsInProgress: () => 0 };

describe('midSessionWork', () => {
  it('is zero when nothing runs and no job is queued', () => {
    const { store, close } = createTestStore();
    expect(midSessionWork(store.db, { pending: () => 0 }, quiet)).toBe(0);
    close();
  });

  it('counts a delivery job that is queued or running: a ship is a job before it is a row', () => {
    const { store, close } = createTestStore();
    expect(midSessionWork(store.db, { pending: () => 2 }, quiet)).toBe(2);
    close();
  });

  it('counts a shaping conversation with a turn under way: a quit would cut off the answer', () => {
    const { store, close } = createTestStore();
    const none = { pending: () => 0 };
    expect(midSessionWork(store.db, none, { turnsInProgress: () => 0 })).toBe(0);
    expect(midSessionWork(store.db, none, { turnsInProgress: () => 2 })).toBe(2);
    expect(midSessionWork(store.db, { pending: () => 1 }, { turnsInProgress: () => 1 })).toBe(2);
    close();
  });

  it('counts a lane waiting on a card with a live session, unless the drain leaves it out', () => {
    const { store, close } = createTestStore();
    const project = seedProject(store);
    const task = store.write((ctx) =>
      insertTask(ctx, project.id, { title: 'T', acceptanceCriteria: ['x'], areas: ['api'] }),
    ).value;
    const ws = store.write((ctx) => insertWorkstream(ctx, task.id)).value;
    for (const to of [S.Starting, S.Running]) {
      store.write((ctx) => transitionWorkstream(ctx, ws.id, { to, fence: null }));
    }
    store.write((ctx) => {
      patchWorkstream(ctx, ws.id, null, {
        currentSessionId: 'ses_01a00000-0000-7000-8000-000000000001' as SessionId,
      });
      transitionWorkstream(ctx, ws.id, { to: S.WaitingHuman, fence: null });
    });
    const none = { pending: () => 0 };
    expect(midSessionWork(store.db, none, quiet)).toBe(1);
    expect(midSessionWork(store.db, none, quiet, { waitingOnCard: false })).toBe(0);
    expect(countWaitingOnCard(store.db)).toBe(1);
    close();
  });

  it('counts a batch being cut and one shipping, together with the jobs', () => {
    const { store, close } = createTestStore();
    const project = seedProject(store);
    const cutting = store.write((ctx) =>
      insertBatch(ctx, { projectId: project.id, title: 'A', baseBranch: 'main' }),
    ).value;
    expect(midSessionWork(store.db, { pending: () => 0 }, quiet)).toBe(1);
    store.write((ctx) => transitionBatch(ctx, cutting.id, { to: BatchState.Open }));
    expect(midSessionWork(store.db, { pending: () => 0 }, quiet)).toBe(0);
    store.write((ctx) => transitionBatch(ctx, cutting.id, { to: BatchState.Shipping }));
    expect(midSessionWork(store.db, { pending: () => 1 }, quiet)).toBe(2);
    close();
  });
});

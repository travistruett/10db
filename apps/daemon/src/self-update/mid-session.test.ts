import { BatchState } from '@10db/contracts';
import { createTestStore, insertBatch, seedProject, transitionBatch } from '@10db/db';
import { describe, expect, it } from 'vitest';
import { midSessionWork } from './mid-session';

describe('midSessionWork', () => {
  it('is zero when nothing runs and no job is queued', () => {
    const { store, close } = createTestStore();
    expect(midSessionWork(store.db, { pending: () => 0 })).toBe(0);
    close();
  });

  it('counts a delivery job that is queued or running: a ship is a job before it is a row', () => {
    const { store, close } = createTestStore();
    expect(midSessionWork(store.db, { pending: () => 2 })).toBe(2);
    close();
  });

  it('counts a batch being cut and one shipping, together with the jobs', () => {
    const { store, close } = createTestStore();
    const project = seedProject(store);
    const cutting = store.write((ctx) =>
      insertBatch(ctx, { projectId: project.id, title: 'A', baseBranch: 'main' }),
    ).value;
    expect(midSessionWork(store.db, { pending: () => 0 })).toBe(1);
    store.write((ctx) => transitionBatch(ctx, cutting.id, { to: BatchState.Open }));
    expect(midSessionWork(store.db, { pending: () => 0 })).toBe(0);
    store.write((ctx) => transitionBatch(ctx, cutting.id, { to: BatchState.Shipping }));
    expect(midSessionWork(store.db, { pending: () => 1 })).toBe(2);
    close();
  });
});

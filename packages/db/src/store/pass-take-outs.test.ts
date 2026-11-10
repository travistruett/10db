import { mintId, TakeOutStep, type PassId, type TaskId } from '@10db/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  advanceTakeOut,
  createTestStore,
  deleteTakeOut,
  insertPass,
  insertTakeOut,
  insertTask,
  lastTakeOut,
  listUnfinishedTakeOuts,
  seedProject,
  type Store,
} from './index';

// Workbench spec §5.4, §12: a take-out records each step it finishes, so a restart goes on from the
// next one and follows the Drop choices made before it.

let store: Store;
let close: () => void;
let passId: PassId;
let taskId: TaskId;

beforeEach(() => {
  ({ store, close } = createTestStore(() => new Date('2026-11-09T12:00:00.000Z')));
  const project = seedProject(store, {
    delivery: 'local',
    areas: [{ name: 'settings', globs: ['src/settings/**'], role: 'page' }],
  });
  taskId = store.write((ctx) =>
    insertTask(ctx, project.id, {
      title: 'Settings',
      acceptanceCriteria: ['x'],
      areas: ['settings'],
    }),
  ).value.id;
  passId = mintId('Pass');
  store.write((ctx) =>
    insertPass(ctx, {
      id: passId,
      projectId: project.id,
      name: 'Polish',
      pageCap: 4,
      returnBranch: 'main',
      startSha: 'a'.repeat(40),
      branch: '10db/polish-abc123',
      baseBranch: 'main',
      repo: null,
      taskIds: [taskId],
      dirt: [],
    }),
  );
});
afterEach(() => {
  close();
});

describe("a take-out's row", () => {
  it('is written before any step, records each step and what it kept, and is unfinished until step 5', () => {
    const key = { taskId, passId };
    store.write((ctx) => insertTakeOut(ctx, { ...key, drops: [2] }));
    expect(listUnfinishedTakeOuts(store.db)).toEqual([
      expect.objectContaining({
        ...key,
        step: TakeOutStep.Written,
        tries: 0,
        drops: [2],
        left: [],
      }),
    ]);
    store.write((ctx) => advanceTakeOut(ctx, key, { step: TakeOutStep.HandEditsFolded, tries: 1 }));
    store.write((ctx) =>
      advanceTakeOut(ctx, key, {
        step: TakeOutStep.Kept,
        keptSha: 'b'.repeat(40),
        keptBaseSha: 'a'.repeat(40),
      }),
    );
    store.write((ctx) =>
      advanceTakeOut(ctx, key, { step: TakeOutStep.PutBack, left: ['src/settings/a.tsx'] }),
    );
    expect(lastTakeOut(store.db, taskId)).toMatchObject({
      step: TakeOutStep.PutBack,
      tries: 1,
      keptSha: 'b'.repeat(40),
      keptBaseSha: 'a'.repeat(40),
      left: ['src/settings/a.tsx'],
      drops: [2],
    });
    expect(() =>
      store.write((ctx) => advanceTakeOut(ctx, key, { step: TakeOutStep.Kept })),
    ).toThrow(/step 4/);
    store.write((ctx) => advanceTakeOut(ctx, key, { step: TakeOutStep.Done }));
    expect(listUnfinishedTakeOuts(store.db)).toEqual([]);
    expect(lastTakeOut(store.db, taskId)?.step).toBe(TakeOutStep.Done);
  });

  it('is deleted when a lone take-out stops, so the task has none', () => {
    const key = { taskId, passId };
    store.write((ctx) => insertTakeOut(ctx, { ...key, drops: [] }));
    store.write((ctx) => {
      deleteTakeOut(ctx, key);
    });
    expect(lastTakeOut(store.db, taskId)).toBeUndefined();
    expect(listUnfinishedTakeOuts(store.db)).toEqual([]);
  });
});

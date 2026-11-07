import type { ProjectDto } from '@10db/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { seedDefaultAccount } from './accounts';
import type { Store } from './store';
import { getTask, insertTask, patchTask } from './tasks';
import { createTestStore, seedProject } from './test-support';

let store: Store;
let close: () => void;
let project: ProjectDto;
beforeEach(() => {
  ({ store, close } = createTestStore());
  project = seedProject(store);
  store.write((ctx) => seedDefaultAccount(ctx, { expectedIdentity: null }));
});
afterEach(() => {
  close();
});

const base = { title: 'Alpha', acceptanceCriteria: ['x'], areas: ['api'] };

describe('a task’s own model setting', () => {
  it('is none until the builder sets one, and a patch sets it and clears it', () => {
    const task = store.write((ctx) => insertTask(ctx, project.id, base)).value;
    expect(task.modelSetting).toBeNull();
    const set = store.write((ctx) =>
      patchTask(ctx, task.id, { modelSetting: { kind: 'tier', tier: 'strongest' } }),
    ).value;
    expect(set.modelSetting).toEqual({ kind: 'tier', tier: 'strongest' });
    expect(getTask(store.db, task.id).modelSetting).toEqual({ kind: 'tier', tier: 'strongest' });
    // Another edit leaves the setting alone; null removes the override, which Automatic does not.
    const titled = store.write((ctx) => patchTask(ctx, task.id, { title: 'Beta' })).value;
    expect(titled.modelSetting).toEqual({ kind: 'tier', tier: 'strongest' });
    const automatic = store.write((ctx) =>
      patchTask(ctx, task.id, { modelSetting: { kind: 'automatic' } }),
    ).value;
    expect(automatic.modelSetting).toEqual({ kind: 'automatic' });
    const cleared = store.write((ctx) => patchTask(ctx, task.id, { modelSetting: null })).value;
    expect(cleared.modelSetting).toBeNull();
  });
});

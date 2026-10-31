import { ConflictError, type TaskInput } from '@10db/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { insertBatch, getBatch } from './batches';
import { getProject, patchProject } from './projects';
import type { Store } from './store';
import { getTask, insertTask, patchTask } from './tasks';
import { createTestStore, seedProject } from './test-support';
import { insertWorkstream } from './workstreams';

let store: Store;
let close: () => void;
beforeEach(() => {
  ({ store, close } = createTestStore());
});
afterEach(() => {
  close();
});

const TASK: TaskInput = { title: 'T', acceptanceCriteria: ['c'], areas: ['api'] };

describe('a project default for where work lands', () => {
  it('merges into the base branch unless the project says otherwise', () => {
    const project = seedProject(store);
    expect(project.landing).toBe('merge');
    const held = seedProject(store, { landing: 'hold' });
    expect(getProject(store.db, held.id).landing).toBe('hold');
  });

  it('can be changed to hold and back', () => {
    const project = seedProject(store);
    expect(
      store.write((ctx) => patchProject(ctx, project.id, { landing: 'hold' })).value.landing,
    ).toBe('hold');
    expect(
      store.write((ctx) => patchProject(ctx, project.id, { landing: 'merge' })).value.landing,
    ).toBe('merge');
  });
});

describe('a project default that names a branch', () => {
  it('gives new tasks that branch, and an explicit landing keeps its own', () => {
    const p = seedProject(store, { landing: 'branch', landingBranch: 'next' });
    expect(getProject(store.db, p.id)).toMatchObject({ landing: 'branch', landingBranch: 'next' });
    const task = store.write((ctx) => insertTask(ctx, p.id, TASK)).value;
    expect(getTask(store.db, task.id).landing).toEqual({ kind: 'branch', branch: 'next' });
    const held = store.write((ctx) =>
      insertTask(ctx, p.id, { ...TASK, landing: { kind: 'hold' } }),
    ).value;
    expect(held.landing).toEqual({ kind: 'hold' });
    const base = store.write((ctx) =>
      insertTask(ctx, p.id, { ...TASK, landing: { kind: 'base' } }),
    ).value;
    expect(base.landing).toEqual({ kind: 'base' });
  });

  it('can be set, changed and cleared by changing the default', () => {
    const p = seedProject(store);
    const set = store.write((ctx) =>
      patchProject(ctx, p.id, { landing: 'branch', landingBranch: 'next' }),
    ).value;
    expect(set).toMatchObject({ landing: 'branch', landingBranch: 'next' });
    const renamed = store.write((ctx) => patchProject(ctx, p.id, { landingBranch: 'dev' })).value;
    expect(renamed).toMatchObject({ landing: 'branch', landingBranch: 'dev' });
    const cleared = store.write((ctx) => patchProject(ctx, p.id, { landing: 'hold' })).value;
    expect(cleared).toMatchObject({ landing: 'hold', landingBranch: null });
  });

  it('is refused without a branch name', () => {
    const p = seedProject(store);
    expect(() => store.write((ctx) => patchProject(ctx, p.id, { landing: 'branch' }))).toThrow(
      'Name the branch new tasks land in',
    );
    expect(getProject(store.db, p.id).landing).toBe('merge');
  });
});

describe("a task's landing", () => {
  it.each([
    { name: 'merges when its project merges', project: 'merge', expected: { kind: 'base' } },
    { name: 'holds when its project holds', project: 'hold', expected: { kind: 'hold' } },
  ] as const)('starts from the project default: $name', ({ project, expected }) => {
    const p = seedProject(store, { landing: project });
    const task = store.write((ctx) => insertTask(ctx, p.id, TASK)).value;
    expect(task.landing).toEqual(expected);
    expect(getTask(store.db, task.id).landing).toEqual(expected);
  });

  it('keeps what the builder chose, a named branch included', () => {
    const p = seedProject(store);
    const onBranch = store.write((ctx) =>
      insertTask(ctx, p.id, { ...TASK, landing: { kind: 'branch', branch: 'feature/x' } }),
    ).value;
    expect(getTask(store.db, onBranch.id).landing).toEqual({ kind: 'branch', branch: 'feature/x' });
    const held = store.write((ctx) =>
      insertTask(ctx, p.id, { ...TASK, landing: { kind: 'hold' } }),
    ).value;
    expect(getTask(store.db, held.id).landing).toEqual({ kind: 'hold' });
  });

  it('does not move when the project default changes later', () => {
    const p = seedProject(store);
    const task = store.write((ctx) => insertTask(ctx, p.id, TASK)).value;
    store.write((ctx) => patchProject(ctx, p.id, { landing: 'hold' }));
    expect(getTask(store.db, task.id).landing).toEqual({ kind: 'base' });
  });

  it('can be changed until the task has run, and drops a branch it no longer names', () => {
    const p = seedProject(store);
    const task = store.write((ctx) =>
      insertTask(ctx, p.id, { ...TASK, landing: { kind: 'branch', branch: 'dev' } }),
    ).value;
    const held = store.write((ctx) => patchTask(ctx, task.id, { landing: { kind: 'hold' } })).value;
    expect(held.landing).toEqual({ kind: 'hold' });
    store.write((ctx) => insertWorkstream(ctx, task.id));
    expect(() =>
      store.write((ctx) => patchTask(ctx, task.id, { landing: { kind: 'base' } })),
    ).toThrow(ConflictError);
    expect(getTask(store.db, task.id).landing).toEqual({ kind: 'hold' });
  });

  it('still lets a started task change its other fields', () => {
    const p = seedProject(store);
    const task = store.write((ctx) => insertTask(ctx, p.id, TASK)).value;
    store.write((ctx) => insertWorkstream(ctx, task.id));
    expect(store.write((ctx) => patchTask(ctx, task.id, { title: 'Renamed' })).value.title).toBe(
      'Renamed',
    );
  });
});

describe("a batch's landing", () => {
  it('records its target branch and whether it merges by itself', () => {
    const p = seedProject(store);
    const merging = store.write((ctx) =>
      insertBatch(ctx, { projectId: p.id, title: 'A', baseBranch: 'feature/x', autoMerge: true }),
    ).value;
    expect(getBatch(store.db, merging.id)).toMatchObject({
      baseBranch: 'feature/x',
      autoMerge: true,
    });
    const held = store.write((ctx) =>
      insertBatch(ctx, {
        projectId: p.id,
        title: 'B',
        baseBranch: 'main',
        autoMerge: false,
        worktreePath: '/tmp/wt-b',
      }),
    ).value;
    expect(getBatch(store.db, held.id).autoMerge).toBe(false);
  });
});

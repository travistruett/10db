import { InvalidError, Rigor } from '@10db/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { deleteKind, insertKind } from './kinds';
import { getProject, patchProject } from './projects';
import { getShape, insertShape } from './shapes';
import type { Store } from './store';
import { getTask, insertTask, listTasks, patchTask } from './tasks';
import { createTestStore, seedProject } from './test-support';

let store: Store;
let close: () => void;
beforeEach(() => {
  ({ store, close } = createTestStore());
});
afterEach(() => {
  close();
});

const brief = {
  title: 'Add a thing',
  acceptanceCriteria: ['It works'],
  areas: ['api'],
};

describe('a task carries its rigor, kinds and effort pin', () => {
  it('stores them on insert and reads them back, with the rigor its kinds raise it to', () => {
    const project = seedProject(store);
    store.write((ctx) =>
      insertKind(ctx, { key: 'security', label: 'Security', minimumRigor: Rigor.Careful }),
    );
    const task = store.write((ctx) =>
      insertTask(ctx, project.id, {
        ...brief,
        rigor: 'light',
        kinds: [{ key: 'security', source: 'builder' }],
        effortPin: 'high',
      }),
    ).value;
    expect(task).toMatchObject({
      rigor: 'light',
      effectiveRigor: 'careful',
      kinds: [{ key: 'security', source: 'builder' }],
      effortPin: 'high',
    });
    expect(getTask(store.db, task.id)).toEqual(task);
  });

  it('defaults to no rigor, no kinds and no pin, and runs at the project default', () => {
    const project = seedProject(store);
    store.write((ctx) => patchProject(ctx, project.id, { defaultRigor: 'careful' }));
    expect(getProject(store.db, project.id).defaultRigor).toBe('careful');
    const task = store.write((ctx) => insertTask(ctx, project.id, brief)).value;
    expect(task).toMatchObject({
      rigor: null,
      kinds: [],
      effortPin: null,
      effectiveRigor: 'careful',
    });
  });

  it('changes them in a patch, clears a pin with null and refuses an unknown kind', () => {
    const project = seedProject(store);
    store.write((ctx) => insertKind(ctx, { key: 'ui', label: 'UI' }));
    const task = store.write((ctx) =>
      insertTask(ctx, project.id, { ...brief, effortPin: 'low' }),
    ).value;
    const patched = store.write((ctx) =>
      patchTask(ctx, task.id, {
        rigor: 'critical',
        kinds: [{ key: 'ui', source: 'agent' }],
        effortPin: null,
      }),
    ).value;
    expect(patched).toMatchObject({
      rigor: 'critical',
      kinds: [{ key: 'ui', source: 'agent' }],
      effortPin: null,
      effectiveRigor: 'critical',
    });
    expect(() =>
      store.write((ctx) => patchTask(ctx, task.id, { kinds: [{ key: 'nope', source: 'agent' }] })),
    ).toThrow(InvalidError);
  });

  it('records who set a rigor, pins one given at creation, and drops the source when it is cleared', () => {
    const project = seedProject(store);
    const made = (rigorSource?: 'agent' | 'judge') =>
      store.write((ctx) =>
        insertTask(ctx, project.id, { ...brief, rigor: 'careful' }, undefined, rigorSource),
      ).value;
    expect(made()).toMatchObject({ rigorSource: 'builder', rigorReason: null });
    expect(made('agent')).toMatchObject({ rigorSource: 'agent' });
    const none = store.write((ctx) => insertTask(ctx, project.id, brief)).value;
    expect(none).toMatchObject({ rigor: null, rigorSource: null, sizedByRules: true });

    const set = store.write((ctx) =>
      patchTask(ctx, none.id, { rigor: 'light' }, undefined, 'agent'),
    ).value;
    expect(set).toMatchObject({
      rigor: 'light',
      rigorSource: 'agent',
      effectiveRigorSource: 'agent',
    });
    const bySetter = store.write((ctx) => patchTask(ctx, none.id, { rigor: 'light' })).value;
    expect(bySetter.rigorSource).toBe('builder');
    const cleared = store.write((ctx) => patchTask(ctx, none.id, { rigor: null })).value;
    expect(cleared).toMatchObject({
      rigor: null,
      rigorSource: null,
      rigorReason: null,
      effectiveRigorSource: 'default',
    });
  });

  it('hands a task back to sizing when its rigor is cleared, and not for any other change', () => {
    const project = seedProject(store);
    const task = store.write((ctx) =>
      insertTask(ctx, project.id, { ...brief, rigor: 'careful' }),
    ).value;
    const sizedFor = (): unknown =>
      store.db.$client.prepare('SELECT sized_for FROM tasks WHERE id = ?').get(task.id);
    const sized = () =>
      store.db.$client.prepare("UPDATE tasks SET sized_for = 'fp' WHERE id = ?").run(task.id);
    sized();
    store.write((ctx) => patchTask(ctx, task.id, { rigor: 'light' }));
    expect(sizedFor()).toEqual({ sized_for: 'fp' });
    store.write((ctx) => patchTask(ctx, task.id, { rigor: null }));
    expect(sizedFor()).toEqual({ sized_for: null });
  });

  it('lets a task keep a kind the builder has deleted, and refuses it on any other task', () => {
    const project = seedProject(store);
    const kind = store.write((ctx) => insertKind(ctx, { key: 'ui', label: 'UI' })).value;
    const kept = store.write((ctx) =>
      insertTask(ctx, project.id, { ...brief, kinds: [{ key: 'ui', source: 'builder' }] }),
    ).value;
    const other = store.write((ctx) => insertTask(ctx, project.id, brief)).value;
    store.write((ctx) => {
      deleteKind(ctx, kind.id);
    });
    const patched = store.write((ctx) =>
      patchTask(ctx, kept.id, { effortPin: 'low', kinds: [{ key: 'ui', source: 'builder' }] }),
    ).value;
    expect(patched.kinds).toEqual([{ key: 'ui', source: 'builder' }]);
    expect(() =>
      store.write((ctx) => patchTask(ctx, other.id, { kinds: [{ key: 'ui', source: 'agent' }] })),
    ).toThrow(InvalidError);
  });

  it('reads the kinds and the project’s default rigor once for a whole list', () => {
    const project = seedProject(store);
    store.write((ctx) => insertKind(ctx, { key: 'ui', label: 'UI' }));
    for (let i = 0; i < 4; i += 1)
      store.write((ctx) =>
        insertTask(ctx, project.id, { ...brief, kinds: [{ key: 'ui', source: 'agent' }] }),
      );
    const prepared = vi.spyOn(store.db.$client, 'prepare');
    const tasks = listTasks(store.db, project.id);
    const reads = (table: string) =>
      prepared.mock.calls.filter(([sql]) => sql.includes(`from "${table}"`)).length;
    expect(tasks.map((t) => t.effectiveRigor)).toEqual(tasks.map(() => 'standard'));
    expect(reads('kinds')).toBe(1);
    expect(reads('projects')).toBe(1);
  });

  it('starts a conversation with no effort', () => {
    const project = seedProject(store);
    const shape = store.write((ctx) =>
      insertShape(ctx, project.id, { title: 'Talk', origin: 'app' }),
    ).value;
    expect(getShape(store.db, shape.id).effort).toBeNull();
  });
});

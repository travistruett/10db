import { InvalidError, Rigor } from '@10db/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { insertKind } from './kinds';
import { getProject, patchProject } from './projects';
import { getShape, insertShape } from './shapes';
import type { Store } from './store';
import { getTask, insertTask, patchTask } from './tasks';
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

  it('starts a conversation with no effort', () => {
    const project = seedProject(store);
    const shape = store.write((ctx) =>
      insertShape(ctx, project.id, { title: 'Talk', origin: 'app' }),
    ).value;
    expect(getShape(store.db, shape.id).effort).toBeNull();
  });
});

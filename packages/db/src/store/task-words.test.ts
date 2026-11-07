import type { ProjectDto } from '@10db/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { seedDefaultAccount } from './accounts';
import { insertGoal } from './goals';
import type { Store } from './store';
import { getTask, insertTask, patchTask } from './tasks';
import { BUILDER_HANDLE, insertPerson } from './team';
import { createTestStore, seedProject } from './test-support';
import { insertWorkstream } from './workstreams';

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

const base = { title: 'Stamp files without blocking', acceptanceCriteria: ['x'], areas: ['api'] };
const words = { headline: "Odd files can't freeze 10db", why: 'A FIFO could hang every lane.' };

describe('a task headline and why', () => {
  it('are stored on insert and come back on TaskDto', () => {
    const task = store.write((ctx) => insertTask(ctx, project.id, { ...base, ...words })).value;
    expect(task).toMatchObject(words);
    expect(getTask(store.db, task.id)).toMatchObject({ ...words, title: base.title });
  });

  it('are empty on a task made without them', () => {
    const task = store.write((ctx) => insertTask(ctx, project.id, base)).value;
    expect(task.headline).toBe('');
    expect(task.why).toBe('');
  });

  it('change with a patch, and an empty string clears them', () => {
    const task = store.write((ctx) => insertTask(ctx, project.id, base)).value;
    const edited = store.write((ctx) => patchTask(ctx, task.id, words)).value;
    expect(edited).toMatchObject({ ...words, title: base.title });
    const cleared = store.write((ctx) => patchTask(ctx, task.id, { why: '' })).value;
    expect(cleared).toMatchObject({ headline: words.headline, why: '' });
  });

  it('a patch refuses a headline over 80 characters, naming the field', () => {
    const task = store.write((ctx) => insertTask(ctx, project.id, base)).value;
    expect(() =>
      store.write((ctx) => patchTask(ctx, task.id, { headline: 'x'.repeat(81) })),
    ).toThrow(/headline is at most 80/);
  });

  it("are stored from a goal brief's tasks", () => {
    store.write((ctx) =>
      insertPerson(ctx, { handle: BUILDER_HANDLE, name: 'You', isBuilder: true }),
    );
    const goal = store.write((ctx) =>
      insertGoal(ctx, project.id, {
        brief: {
          title: 'Readable board',
          objective: 'Cards read in plain words.',
          tasks: [
            { key: 'a', title: base.title, areas: ['api'], ...words },
            { key: 'b', title: 'Another', areas: ['api'] },
          ],
        },
      }),
    ).value.goal;
    const [a, b] = goal.taskIds.map((id) => getTask(store.db, id));
    expect(a).toMatchObject(words);
    expect(b).toMatchObject({ headline: '', why: '' });
  });

  it("are carried on the task's workstream as taskHeadline beside taskTitle", () => {
    const task = store.write((ctx) => insertTask(ctx, project.id, { ...base, ...words })).value;
    const ws = store.write((ctx) =>
      insertWorkstream(ctx, task.id, { first: { model: 'claude-sonnet-5-5', effort: 'medium' } }),
    ).value;
    expect(ws.taskTitle).toBe(base.title);
    expect(ws.taskHeadline).toBe(words.headline);
  });
});

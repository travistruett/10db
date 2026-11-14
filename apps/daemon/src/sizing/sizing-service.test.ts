import type { TaskId, TaskInput } from '@10db/contracts';
import {
  createTestStore,
  getTask,
  insertKind,
  insertTask,
  insertWorkstream,
  listEventsAfter,
  moveTask,
  patchTask,
  readTaskSizing,
  seedProject,
  type Store,
} from '@10db/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ManualClock } from '../clock';
import { createEventBus, createStateStore, type EventBus, type StateStore } from '../events';
import type { Judge } from '../judge';
import { silentLogger } from '../log';
import { sizingFingerprint } from './fingerprint';
import { createSizingService, type SizingService } from './sizing-service';

let store: Store;
let close: () => void;
let bus: EventBus;
let state: StateStore;
let clock: ManualClock;
let projectId: ReturnType<typeof seedProject>['id'];
let service: SizingService | null;
const offJudge: Judge = {
  off: true,
  choose: () => Promise.reject(new Error('the judge is off: nothing may ask it')),
};

beforeEach(() => {
  clock = new ManualClock(new Date('2026-11-13T12:00:00.000Z'));
  ({ store, close } = createTestStore(() => clock.now()));
  bus = createEventBus();
  state = createStateStore(store, bus);
  service = null;
  store.write((ctx) => {
    insertKind(ctx, {
      key: 'migration',
      label: 'Migration',
      description: 'Changes the database schema.',
      impliedBy: ['migrations'],
    });
    insertKind(ctx, { key: 'docs', label: 'Docs', description: 'Writes documentation.' });
  });
  projectId = seedProject(store, { delivery: 'pull_request', prTitlePrefix: 'feat(app)' }).id;
});
afterEach(() => {
  service?.stop();
  close();
});

function start(judge: Judge = offJudge): SizingService {
  service = createSizingService({
    state,
    bus,
    judge,
    clock,
    log: silentLogger,
    joiningProblem: () => null,
  });
  return service;
}

const brief: TaskInput = { title: 'Alpha', acceptanceCriteria: ['it works'], areas: ['api'] };
const create = (input: Partial<TaskInput> = {}) =>
  state.write((ctx) => insertTask(ctx, projectId, { ...brief, ...input }));
const edit = (id: TaskId, patch: Parameters<typeof patchTask>[2]) =>
  state.write((ctx) => patchTask(ctx, id, patch));
const sizedFor = (id: TaskId) => readTaskSizing(store.db, id)?.sizedFor ?? null;
const changes = (id: TaskId) =>
  listEventsAfter(store.db, 0, 1000).filter((e) => e.entityId === id && e.type === 'task.changed');

describe('rules sizing on task events', () => {
  it.each([
    {
      name: 'an area a kind is implied by gives the kind, from the rules',
      areas: ['migrations'],
      want: [{ key: 'migration', source: 'rules' }],
    },
    { name: 'no such area gives no kind', areas: ['api'], want: [] },
  ])('a new task: $name, and it is sized', ({ areas, want }) => {
    start();
    const task = create({ areas });
    expect(getTask(store.db, task.id)).toMatchObject({ kinds: want, sizedByRules: true });
    expect(sizedFor(task.id)).toBe(sizingFingerprint(getTask(store.db, task.id)));
  });

  it('an edit of the areas sizes again: the kind comes with the area and goes with it', () => {
    start();
    const task = create();
    edit(task.id, { areas: ['migrations'] });
    expect(getTask(store.db, task.id).kinds).toEqual([{ key: 'migration', source: 'rules' }]);
    edit(task.id, { areas: ['api'] });
    expect(getTask(store.db, task.id).kinds).toEqual([]);
  });

  it('a change that touches none of the sized text does not size again', () => {
    start();
    const task = create();
    const before = changes(task.id).length;
    state.write((ctx) => moveTask(ctx, task.id, { to: null, after: null, before: null }));
    expect(changes(task.id)).toHaveLength(before + 1);
  });

  it('keeps a kind the builder gave, and never adds one the builder took off', () => {
    start();
    const task = create({ kinds: [{ key: 'docs', source: 'builder' }] });
    edit(task.id, { areas: ['migrations'], kinds: [{ key: 'docs', source: 'builder' }] });
    store.db.$client
      .prepare('UPDATE tasks SET kinds_off = ? WHERE id = ?')
      .run('["migration"]', task.id);
    edit(task.id, { title: 'Alpha again' });
    expect(getTask(store.db, task.id).kinds).toEqual([{ key: 'docs', source: 'builder' }]);
  });

  it('leaves a task that has started untouched', () => {
    start();
    const task = state.write((ctx) => {
      const made = insertTask(ctx, projectId, { ...brief, areas: ['migrations'] });
      insertWorkstream(ctx, made.id, { first: { model: 'claude-sonnet-5-5', effort: 'medium' } });
      return made;
    });
    expect(sizedFor(task.id)).toBeNull();
    expect(getTask(store.db, task.id).kinds).toEqual([]);
  });

  it('leaves a Workbench page alone', () => {
    start();
    store.db.$client.pragma('foreign_keys = OFF');
    const task = state.write((ctx) => {
      const made = insertTask(ctx, projectId, { ...brief, areas: ['migrations'] });
      store.db.$client.prepare("UPDATE tasks SET pass_id = 'pass_x' WHERE id = ?").run(made.id);
      return made;
    });
    expect(sizedFor(task.id)).toBeNull();
  });
});

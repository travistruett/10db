import { JudgeDecision, mintId, type TaskId, type TaskInput } from '@10db/contracts';
import {
  createTestStore,
  getTask,
  insertKind,
  insertTask,
  insertWorkstream,
  listEventsAfter,
  listJudgeCalls,
  patchJudgeConfig,
  moveTask,
  patchTask,
  readTaskSizing,
  seedAccount,
  seedProject,
  type Store,
} from '@10db/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ManualClock } from '../clock';
import { createEventBus, createStateStore, type EventBus, type StateStore } from '../events';
import type { Judge } from '../judge';
import { silentLogger } from '../log';
import { scriptedJudge, type ScriptedAnswer } from '../../test/scripted-judge';
import { sizingFingerprint } from './fingerprint';
import { createSizingService, type SizingService } from './sizing-service';

let store: Store;
let close: () => void;
let bus: EventBus;
let state: StateStore;
let clock: ManualClock;
let projectId: ReturnType<typeof seedProject>['id'];
let service: SizingService | null;
let account: ReturnType<typeof seedAccount> | null;
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
  account = null;
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

/** Decisions run on an account, so the judge is asked. */
const withAccount = () => {
  const made = account ?? seedAccount(store, { kind: 'openrouter', label: 'OpenRouter' });
  account = made;
  state.write((ctx) => patchJudgeConfig(ctx, { accountId: made.id }));
};

/** The answers a script gives: a rigor, and `yes` or `no` per kind key (`no` for a key not named). */
const answering =
  (rigor: ScriptedAnswer, kinds: Record<string, string> = {}) =>
  (req: { decision: JudgeDecision; question: string }): ScriptedAnswer => {
    if (req.decision === JudgeDecision.TaskRigor) return rigor;
    const key = Object.keys(kinds).find((k) => req.question.includes(`(${k})`));
    return { choice: key === undefined ? 'no' : (kinds[key] ?? 'no'), confidence: 0.9 };
  };
const careful: ScriptedAnswer = { choice: 'careful', confidence: 0.86 };
const sizing = (id: TaskId) => readTaskSizing(store.db, id);

describe('judge sizing', () => {
  beforeEach(withAccount);

  it('applies the judged rigor and kinds with their sources, reasons and calls', async () => {
    const judge = scriptedJudge(state, answering(careful, { docs: 'yes' }));
    const sizer = start(judge);
    const task = create();
    await sizer.settled([task.id]);
    expect(getTask(store.db, task.id)).toMatchObject({
      rigor: 'careful',
      rigorSource: 'judge',
      rigorReason: 'judged Careful (0.86)',
      effectiveRigorSource: 'judge',
      kinds: [{ key: 'docs', source: 'judge' }],
      sizedByRules: false,
    });
    const calls = listJudgeCalls(store.db, 10);
    expect(calls).toHaveLength(3);
    expect(calls.every((c) => c.taskId === task.id && c.outcome === 'acted')).toBe(true);
    const stored = sizing(task.id)?.sizingCalls;
    expect(stored?.rigor).toBe(calls.find((c) => c.decision === 'task_rigor')?.id);
    expect(Object.keys(stored?.kinds ?? {}).sort()).toEqual(['docs', 'migration']);
  });

  it('runs the rules over the judged answers: an implied kind and a judged one together', async () => {
    const sizer = start(scriptedJudge(state, answering(careful, { docs: 'yes' })));
    const task = create({ areas: ['migrations'] });
    await sizer.settled([task.id]);
    expect(getTask(store.db, task.id).kinds).toEqual([
      { key: 'migration', source: 'rules' },
      { key: 'docs', source: 'judge' },
    ]);
  });

  it.each([
    { name: 'the builder', source: 'builder' },
    { name: 'an agent', source: 'agent' },
  ] as const)('does not ask the rigor of a task whose rigor $name set', async ({ source }) => {
    const judge = scriptedJudge(state, answering(careful));
    const sizer = start(judge);
    const task = state.write((ctx) =>
      insertTask(ctx, projectId, { ...brief, rigor: 'light' }, undefined, source),
    );
    await sizer.settled([task.id]);
    expect(judge.asked(JudgeDecision.TaskRigor)).toHaveLength(0);
    expect(judge.asked(JudgeDecision.TaskKinds)).toHaveLength(2);
    expect(getTask(store.db, task.id)).toMatchObject({ rigor: 'light', rigorSource: source });
  });

  it.each([
    {
      name: 'a kind the builder gave',
      make: () => create({ kinds: [{ key: 'docs', source: 'builder' }] }),
      asked: ['migration'],
    },
    {
      name: 'a kind an agent gave',
      make: () => create({ kinds: [{ key: 'docs', source: 'agent' }] }),
      asked: ['migration'],
    },
    {
      name: 'a kind the area implies',
      make: () => create({ areas: ['migrations'] }),
      asked: ['docs'],
    },
  ])('does not ask $name', async ({ make, asked }) => {
    const judge = scriptedJudge(state, answering(careful));
    const sizer = start(judge);
    const task = make();
    await sizer.settled([task.id]);
    const keys = judge.asked(JudgeDecision.TaskKinds).map((r) => /\((\w+)\)/.exec(r.question)?.[1]);
    expect(keys).toEqual(asked);
  });

  it('does not ask a kind the builder took off', async () => {
    const judge = scriptedJudge(state, answering(careful, { docs: 'yes' }));
    const sizer = start(judge);
    const task = create();
    await sizer.settled([task.id]);
    judge.requests.length = 0;
    store.db.$client
      .prepare('UPDATE tasks SET kinds_off = ? WHERE id = ?')
      .run('["docs"]', task.id);
    edit(task.id, { title: 'Alpha, again' });
    await sizer.settled([task.id]);
    expect(judge.asked(JudgeDecision.TaskKinds)).toHaveLength(1);
    expect(getTask(store.db, task.id).kinds).toEqual([]);
  });

  it('keeps the rules’ value when the answers are below the floor, and counts them below_floor', async () => {
    const sizer = start(
      scriptedJudge(state, (req) => ({
        choice: req.decision === JudgeDecision.TaskRigor ? 'critical' : 'yes',
        confidence: 0.5,
      })),
    );
    const task = create({ areas: ['migrations'] });
    await sizer.settled([task.id]);
    expect(getTask(store.db, task.id)).toMatchObject({
      rigor: null,
      kinds: [{ key: 'migration', source: 'rules' }],
    });
    expect(listJudgeCalls(store.db, 10).find((c) => c.decision === 'task_rigor')?.outcome).toBe(
      'below_floor',
    );
    expect(sizing(task.id)?.sizingCalls).toEqual({ rigor: null, kinds: {} });
  });

  it('keeps the rules’ value when the judge falls back', async () => {
    const sizer = start(scriptedJudge(state, () => ({ fallback: 'timeout' })));
    const task = create({ areas: ['migrations'] });
    await sizer.settled([task.id]);
    expect(getTask(store.db, task.id)).toMatchObject({
      rigor: null,
      sizedByRules: true,
      kinds: [{ key: 'migration', source: 'rules' }],
    });
  });

  it('never asks with the judge off, with no account or with the decision switched off', async () => {
    const off = { ...scriptedJudge(state, answering(careful)), off: true };
    const task1 = (start(off), create());
    await service?.settled([task1.id]);
    expect(off.requests).toHaveLength(0);
    service?.stop();

    state.write((ctx) => patchJudgeConfig(ctx, { accountId: null }));
    const noAccount = scriptedJudge(state, answering(careful));
    const task2 = (start(noAccount), create());
    await service?.settled([task2.id]);
    expect(noAccount.requests).toHaveLength(0);
    service?.stop();

    withAccount();
    state.write((ctx) => patchJudgeConfig(ctx, { decisions: { task_rigor: { enabled: false } } }));
    const noRigor = scriptedJudge(state, answering(careful));
    const task3 = (start(noRigor), create());
    await service?.settled([task3.id]);
    expect(noRigor.asked(JudgeDecision.TaskRigor)).toHaveLength(0);
    expect(noRigor.asked(JudgeDecision.TaskKinds)).toHaveLength(2);
    expect(getTask(store.db, task1.id).sizedByRules).toBe(true);
  });

  it('never fails creation when the judge throws', async () => {
    const sizer = start(
      scriptedJudge(state, () => {
        throw new Error('boom');
      }),
    );
    const task = create({ areas: ['migrations'] });
    await sizer.settled([task.id]);
    expect(getTask(store.db, task.id)).toMatchObject({
      sizedByRules: true,
      kinds: [{ key: 'migration', source: 'rules' }],
    });
  });

  it('asks the judge for at most four tasks at a time, in creation order', async () => {
    const release = new Map<TaskId, () => void>();
    const judge = scriptedJudge(
      state,
      (req) =>
        new Promise<ScriptedAnswer>((resolve) => {
          const id = req.taskId;
          if (id === undefined) return;
          const was = release.get(id);
          release.set(id, () => {
            was?.();
            resolve({ choice: 'light', confidence: 0.9 });
          });
        }),
    );
    const sizer = start(judge);
    const tasks = [1, 2, 3, 4, 5].map((n) => create({ title: `Task ${String(n)}` }));
    const askedTasks = () => new Set(judge.requests.map((r) => r.taskId));
    await vi.waitFor(() => {
      expect(askedTasks().size).toBe(4);
    });
    expect(askedTasks().has(tasks[4]?.id)).toBe(false);
    release.get(tasks[0]?.id ?? mintId('Task'))?.();
    await vi.waitFor(() => {
      expect(askedTasks().has(tasks[4]?.id)).toBe(true);
    });
    for (const fn of release.values()) fn();
    await sizer.settled(tasks.map((t) => t.id));
  });
});

describe('a judge answer for text or pins that have since changed', () => {
  beforeEach(withAccount);

  /** A judge whose first answers (`critical`, `yes`) wait for `release`; any task named "v2" is answered at once. */
  function held() {
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const judge = scriptedJudge(state, async (req) => {
      const rigor = req.decision === JudgeDecision.TaskRigor;
      if (req.state.includes('v2')) return { choice: rigor ? 'light' : 'no', confidence: 0.9 };
      await gate;
      return { choice: rigor ? 'critical' : 'yes', confidence: 0.9 };
    });
    return { judge, release };
  }
  const stale = () =>
    listJudgeCalls(store.db, 20).filter((c) => c.answer === 'critical' || c.answer === 'yes');

  it.each([
    {
      name: 'the builder set a rigor',
      during: (id: TaskId) => edit(id, { rigor: 'standard' }),
      then: { rigor: 'standard', rigorSource: 'builder', kinds: [] },
    },
    {
      name: 'the builder added a kind',
      during: (id: TaskId) => edit(id, { kinds: [{ key: 'docs', source: 'builder' }] }),
      then: { rigor: null, kinds: [{ key: 'docs', source: 'builder' }] },
    },
    {
      name: 'the builder took a kind off',
      during: (id: TaskId) =>
        store.db.$client.prepare('UPDATE tasks SET kinds_off = ? WHERE id = ?').run('["docs"]', id),
      then: { rigor: null, kinds: [] },
    },
    {
      name: 'the task started',
      during: (id: TaskId) =>
        state.write((ctx) =>
          insertWorkstream(ctx, id, { first: { model: 'claude-sonnet-5-5', effort: 'medium' } }),
        ),
      then: { rigor: null, kinds: [] },
    },
  ])('applies nothing and logs them stopped when $name', async ({ during, then }) => {
    const { judge, release } = held();
    const sizer = start(judge);
    const task = create();
    await vi.waitFor(() => {
      expect(judge.requests).toHaveLength(3);
    });
    during(task.id);
    release();
    await sizer.settled([task.id]);
    expect(getTask(store.db, task.id)).toMatchObject(then);
    expect(stale()).toHaveLength(3);
    expect(stale().every((c) => c.outcome === 'stopped')).toBe(true);
    expect(sizing(task.id)?.sizingCalls).toEqual({ rigor: null, kinds: {} });
  });

  it('applies nothing when the text was edited, and sizes the new text instead', async () => {
    const { judge, release } = held();
    const sizer = start(judge);
    const task = create();
    await vi.waitFor(() => {
      expect(judge.requests).toHaveLength(3);
    });
    edit(task.id, { title: 'Alpha v2' });
    await sizer.settled([task.id]);
    release();
    await vi.waitFor(() => {
      expect(stale()).toHaveLength(3);
    });
    expect(stale().every((c) => c.outcome === 'stopped')).toBe(true);
    expect(getTask(store.db, task.id)).toMatchObject({
      rigor: 'light',
      rigorReason: 'judged Light (0.90)',
      kinds: [],
    });
    expect(sizing(task.id)?.sizedFor).toBe(sizingFingerprint(getTask(store.db, task.id)));
  });

  it('does not ask again for a change that is not an edit of the text', async () => {
    const { judge, release } = held();
    const sizer = start(judge);
    const task = create();
    await vi.waitFor(() => {
      expect(judge.requests).toHaveLength(3);
    });
    state.write((ctx) => moveTask(ctx, task.id, { to: null, after: null, before: null }));
    release();
    await sizer.settled([task.id]);
    expect(judge.requests).toHaveLength(3);
    expect(getTask(store.db, task.id)).toMatchObject({ rigor: 'critical', rigorSource: 'judge' });
  });
});

describe('settled', () => {
  beforeEach(withAccount);

  /** A judge whose answers wait for `release`. */
  function held() {
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const judge = scriptedJudge(state, async () => {
      await gate;
      return { choice: 'light', confidence: 0.9 };
    });
    return { judge, release };
  }
  const pending = (promise: Promise<void>) => {
    const seen = { done: false };
    void promise.then(() => {
      seen.done = true;
    });
    return seen;
  };

  it('resolves at once for a task nothing is sizing', async () => {
    const sizer = start(offJudge);
    const task = create();
    await sizer.settled([task.id]);
    await sizer.settled([mintId('Task')]);
  });

  it('waits for the sizing in flight, for every caller', async () => {
    const { judge, release } = held();
    const sizer = start(judge);
    const task = create();
    const first = pending(sizer.settled([task.id]));
    const second = pending(sizer.settled([task.id]));
    await Promise.resolve();
    expect([first.done, second.done]).toEqual([false, false]);
    release();
    await sizer.settled([task.id]);
    await vi.waitFor(() => {
      expect([first.done, second.done]).toEqual([true, true]);
    });
    expect(getTask(store.db, task.id).rigor).toBe('light');
  });

  it('gives up at the timeout on the injected clock, and the late answer is stopped', async () => {
    const { judge, release } = held();
    const sizer = start(judge);
    const task = create();
    const waiting = pending(sizer.settled([task.id], 50));
    clock.advance(49);
    await Promise.resolve();
    expect(waiting.done).toBe(false);
    clock.advance(1);
    await vi.waitFor(() => {
      expect(waiting.done).toBe(true);
    });
    expect(getTask(store.db, task.id).rigor).toBeNull();
    state.write((ctx) =>
      insertWorkstream(ctx, task.id, { first: { model: 'claude-sonnet-5-5', effort: 'medium' } }),
    );
    release();
    await vi.waitFor(() => {
      expect(listJudgeCalls(store.db, 10).every((c) => c.outcome === 'stopped')).toBe(true);
    });
    expect(getTask(store.db, task.id).rigor).toBeNull();
  });
});

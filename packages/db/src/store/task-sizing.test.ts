import { mintId, type JudgeCallId, type TaskId, type TaskKind } from '@10db/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  applyTaskSizing,
  BUILDER_CHOSE_PLACEMENT,
  readTaskSizing,
  createTestStore,
  getTask,
  insertKind,
  insertTask,
  insertWorkstream,
  listEventsAfter,
  patchTask,
  seedProject,
  setTaskStatus,
  type Placement,
  type Store,
} from './index';

let store: Store;
let close: () => void;
beforeEach(() => {
  ({ store, close } = createTestStore());
  for (const key of ['security', 'migration', 'docs'])
    store.write((ctx) => insertKind(ctx, { key, label: key }));
});
afterEach(() => {
  close();
});

const project = () => seedProject(store, { delivery: 'pull_request', prTitlePrefix: 'feat(app)' });
const brief = { title: 'Alpha', acceptanceCriteria: ['x'], areas: ['api'] };
const sized = (key: string, source: TaskKind['source'] = 'rules'): TaskKind => ({ key, source });
const call = (): JudgeCallId => mintId('JudgeCall');
const copyForMigration = (_task: unknown, kinds: readonly TaskKind[]): Placement =>
  kinds.some((k) => k.key === 'migration')
    ? { workspaceMode: 'worktree', reason: 'touches migrations' }
    : { workspaceMode: 'shared', reason: null };

const apply = (
  id: TaskId,
  input: Partial<Parameters<typeof applyTaskSizing>[2]> = {},
  placement?: Parameters<typeof applyTaskSizing>[3],
) =>
  store.write((ctx) =>
    applyTaskSizing(ctx, id, { fingerprint: 'fp-1', kinds: [], ...input }, placement),
  ).value;
const stored = (id: TaskId) =>
  store.db.$client
    .prepare(
      'SELECT rigor, rigor_source, rigor_reason, kinds, sized_for, sizing_calls FROM tasks WHERE id = ?',
    )
    .get(id);

describe('applyTaskSizing, resetting an earlier judgement', () => {
  const judged = (id: TaskId) =>
    apply(id, {
      kinds: [sized('security', 'judge')],
      rigor: 'careful',
      rigorReason: 'judged Careful (0.86)',
      sizingCalls: { rigor: call(), kinds: { security: call() } },
    });
  const reset = { clearJudged: true, sizingCalls: { rigor: null, kinds: {} } } as const;

  it('drops a judged rigor and the calls, so the task reads as sized by rules again', () => {
    const task = store.write((ctx) => insertTask(ctx, project().id, brief)).value;
    judged(task.id);
    const after = apply(task.id, { fingerprint: 'fp-2', ...reset });
    expect(after).toMatchObject({
      rigor: null,
      rigorSource: null,
      rigorReason: null,
      sizedByRules: true,
      kinds: [],
    });
    expect(stored(task.id)).toMatchObject({ sized_for: 'fp-2', rigor: null, rigor_reason: null });
  });

  it.each(['builder', 'agent'] as const)('keeps a rigor %s set', (pin) => {
    const task = store.write((ctx) =>
      insertTask(ctx, project().id, { ...brief, rigor: 'light' }, undefined, pin),
    ).value;
    const after = apply(task.id, { fingerprint: 'fp-2', ...reset });
    expect(after).toMatchObject({ rigor: 'light', rigorSource: pin });
  });

  it('without the flag leaves a judged rigor alone', () => {
    const task = store.write((ctx) => insertTask(ctx, project().id, brief)).value;
    judged(task.id);
    expect(apply(task.id, { fingerprint: 'fp-2' })).toMatchObject({ rigor: 'careful' });
  });
});

describe('readTaskSizing', () => {
  it('reads what sizing needs of an unstarted task, and says when it has started', () => {
    const task = store.write((ctx) => insertTask(ctx, project().id, brief)).value;
    expect(readTaskSizing(store.db, task.id)).toMatchObject({
      status: 'open',
      title: 'Alpha',
      areas: ['api'],
      sizedFor: null,
      started: false,
      passId: null,
      goalId: null,
      rigorSource: null,
      kinds: [],
      kindsOff: [],
    });
    apply(task.id, { fingerprint: 'fp-1' });
    expect(readTaskSizing(store.db, task.id)?.sizedFor).toBe('fp-1');
    store.write((ctx) =>
      insertWorkstream(ctx, task.id, { first: { model: 'claude-sonnet-5-5', effort: 'medium' } }),
    );
    expect(readTaskSizing(store.db, task.id)?.started).toBe(true);
  });

  it('answers null for a task that does not exist', () => {
    expect(readTaskSizing(store.db, mintId('Task'))).toBeNull();
  });
});

describe('applyTaskSizing', () => {
  it('writes the rules’ kinds, the judge’s rigor and calls, and the fingerprint on an unstarted task', () => {
    const task = store.write((ctx) => insertTask(ctx, project().id, brief)).value;
    const rigorCall = call();
    const securityCall = call();
    const after = apply(task.id, {
      kinds: [sized('docs'), sized('security', 'judge')],
      rigor: 'careful',
      rigorReason: 'it changes how input is trusted',
      sizingCalls: { rigor: rigorCall, kinds: { security: securityCall } },
    });
    expect(after).toMatchObject({
      rigor: 'careful',
      rigorSource: 'judge',
      rigorReason: 'it changes how input is trusted',
      effectiveRigorSource: 'judge',
      kinds: [
        { key: 'docs', source: 'rules' },
        { key: 'security', source: 'judge' },
      ],
      sizedByRules: false,
    });
    expect(stored(task.id)).toMatchObject({
      sized_for: 'fp-1',
      sizing_calls: JSON.stringify({ rigor: rigorCall, kinds: { security: securityCall } }),
    });
    const events = listEventsAfter(store.db, 0, 100).filter((e) => e.entityId === task.id);
    expect(events.map((e) => e.type)).toContain('task.changed');
  });

  it.each([
    {
      name: 'a rigor the builder pinned is kept, and the kinds are still sized',
      pin: 'builder',
    },
    { name: 'a rigor an agent set is kept, and the kinds are still sized', pin: 'agent' },
  ] as const)('$name', ({ pin }) => {
    const task = store.write((ctx) =>
      insertTask(ctx, project().id, { ...brief, rigor: 'light' }, undefined, pin),
    ).value;
    const after = apply(task.id, {
      kinds: [sized('security')],
      rigor: 'critical',
      rigorReason: 'x',
    });
    expect(after).toMatchObject({
      rigor: 'light',
      rigorSource: pin,
      rigorReason: null,
      kinds: [{ key: 'security', source: 'rules' }],
    });
    expect(stored(task.id)).toMatchObject({ sized_for: 'fp-1' });
  });

  it('replaces the rigor and kinds an earlier sizing set, and keeps the builder’s and an agent’s kinds', () => {
    const task = store.write((ctx) =>
      insertTask(ctx, project().id, {
        ...brief,
        kinds: [
          { key: 'docs', source: 'builder' },
          { key: 'security', source: 'agent' },
        ],
      }),
    ).value;
    apply(task.id, {
      fingerprint: 'fp-1',
      kinds: [sized('migration', 'judge'), sized('docs', 'judge')],
      rigor: 'careful',
      rigorReason: 'first',
    });
    const after = apply(task.id, {
      fingerprint: 'fp-2',
      kinds: [sized('docs')],
      rigor: 'standard',
      rigorReason: 'second',
    });
    expect(after).toMatchObject({
      rigor: 'standard',
      rigorSource: 'judge',
      rigorReason: 'second',
      kinds: [
        { key: 'docs', source: 'builder' },
        { key: 'security', source: 'agent' },
      ],
    });
  });

  it('never adds a kind the builder took off, nor a key no kind has', () => {
    const task = store.write((ctx) => insertTask(ctx, project().id, brief)).value;
    store.write((ctx) => patchTask(ctx, task.id, { kindsOff: ['security'] }));
    const after = apply(task.id, {
      kinds: [sized('security'), sized('deleted'), sized('docs')],
    });
    expect(after?.kindsOff).toEqual(['security']);
    expect(after?.kinds).toEqual([{ key: 'docs', source: 'rules' }]);
  });

  it.each([
    {
      name: 'a task that has started',
      stop: (id: TaskId) =>
        store.write((ctx) =>
          insertWorkstream(ctx, id, { first: { model: 'claude-sonnet-5-5', effort: 'medium' } }),
        ),
    },
    {
      name: 'a removed task',
      stop: (id: TaskId) => {
        store.write((ctx) => {
          setTaskStatus(ctx, id, 'cancelled');
        });
      },
    },
  ])('writes nothing at all to $name, not even the fingerprint', ({ stop }) => {
    const task = store.write((ctx) => insertTask(ctx, project().id, brief)).value;
    stop(task.id);
    const before = stored(task.id);
    expect(
      apply(task.id, { kinds: [sized('security')], rigor: 'critical', rigorReason: 'x' }),
    ).toBeNull();
    expect(stored(task.id)).toEqual(before);
  });

  it('answers null for a task that does not exist, and does not throw', () => {
    expect(apply(mintId('Task'), { kinds: [sized('security')] })).toBeNull();
  });

  describe('when the kinds change it asks the placement rule again', () => {
    it('moves an unplaced task to a separate copy for a kind that needs one, and back when it goes', () => {
      const task = store.write((ctx) => insertTask(ctx, project().id, brief)).value;
      expect(apply(task.id, { kinds: [sized('migration')] }, copyForMigration)).toMatchObject({
        workspaceMode: 'worktree',
        placementReason: 'touches migrations',
      });
      expect(apply(task.id, { fingerprint: 'fp-2', kinds: [] }, copyForMigration)).toMatchObject({
        workspaceMode: 'shared',
        placementReason: null,
      });
    });

    it('keeps the placement the builder chose', () => {
      const task = store.write((ctx) => insertTask(ctx, project().id, brief)).value;
      store.write((ctx) => patchTask(ctx, task.id, { workspaceMode: 'shared' }));
      expect(getTask(store.db, task.id).placementReason).toBe(BUILDER_CHOSE_PLACEMENT);
      expect(apply(task.id, { kinds: [sized('migration')] }, copyForMigration)).toMatchObject({
        workspaceMode: 'shared',
        kinds: [{ key: 'migration', source: 'rules' }],
      });
    });

    it('keeps the placement when the caller has none to offer, as for a task whose join is pending', () => {
      const task = store.write((ctx) => insertTask(ctx, project().id, brief)).value;
      expect(apply(task.id, { kinds: [sized('migration')] }, () => undefined)).toMatchObject({
        workspaceMode: 'shared',
        kinds: [{ key: 'migration', source: 'rules' }],
      });
    });

    it('does not ask when the kinds are the same', () => {
      const task = store.write((ctx) => insertTask(ctx, project().id, brief)).value;
      apply(task.id, { kinds: [sized('docs')] });
      let asked = 0;
      apply(task.id, { fingerprint: 'fp-2', kinds: [sized('docs')] }, () => {
        asked += 1;
        return undefined;
      });
      expect(asked).toBe(0);
    });
  });
});

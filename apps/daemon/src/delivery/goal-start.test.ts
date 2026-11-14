import type { BatchDto, TaskDto } from '@10db/contracts';
import {
  insertGoal,
  insertKind,
  listBatches,
  listKinds,
  listWorkstreams,
  patchTask,
  transitionBatch,
} from '@10db/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDeliveryHarness, type DeliveryHarness } from '../../test/delivery-harness';

import { START_REFUSED_DETAIL } from './cards';

// A task ships with its goal when its row says so, none of its kinds has its own copy, and it works in
// a copy: tasks of one goal started together share a batch, and one started later joins the goal's open
// batch when it can, else starts its own. A start is never refused for it.

let h: DeliveryHarness;
beforeEach(() => {
  h = createDeliveryHarness({ workspaceMode: 'worktree' }, { trigger: false });
});
afterEach(() => {
  h.close();
});

interface GoalTask {
  readonly rigor?: 'light' | 'standard' | 'careful';
  readonly kinds?: readonly string[];
  readonly dependsOn?: readonly string[];
  readonly landing?: { kind: 'hold' };
}

/** A goal with one task per key, each at the rigor, kinds and landing it names. */
function goalOf(specs: Record<string, GoalTask>): Map<string, TaskDto> {
  const keys = Object.keys(specs);
  const made = h.state.write((w) =>
    insertGoal(w, h.project.id, {
      brief: {
        title: 'The goal',
        objective: 'ship it',
        criteria: [],
        people: [],
        tasks: keys.map((key) => ({
          key,
          title: key.toUpperCase(),
          headline: '',
          why: '',
          description: '',
          criteria: ['it works'],
          areas: ['api'],
          depends_on: [...(specs[key]?.dependsOn ?? [])],
        })),
      },
    }),
  );
  const tasks = new Map<string, TaskDto>();
  h.state.write((w) => {
    for (const key of keys) {
      const id = made.taskIds.get(key);
      const spec = specs[key];
      if (!id || !spec) throw new Error(`no task ${key}`);
      tasks.set(
        key,
        patchTask(w, id, {
          ...(spec.rigor ? { rigor: spec.rigor } : {}),
          ...(spec.kinds ? { kinds: spec.kinds.map((k) => ({ key: k, source: 'builder' })) } : {}),
          ...(spec.landing ? { landing: spec.landing } : {}),
        }),
      );
    }
  });
  return tasks;
}

function get(tasks: Map<string, TaskDto>, key: string): TaskDto {
  const task = tasks.get(key);
  if (!task) throw new Error(`no task ${key}`);
  return task;
}

const start = (...tasks: TaskDto[]): BatchDto[] =>
  h.starter.startBatch(h.project.id, { title: 'Start', taskIds: tasks.map((t) => t.id) });

function members(batch: BatchDto): string[] {
  return listWorkstreams(h.store.db, { batchId: batch.id }).map((w) => w.taskId);
}

describe('tasks of a goal that ship with it', () => {
  it('two Light tasks started together make one batch', async () => {
    const t = goalOf({ a: { rigor: 'light' }, b: { rigor: 'light' } });
    const started = start(get(t, 'a'), get(t, 'b'));
    expect(started).toHaveLength(1);
    await h.jobs.idle();
    expect(members(h.only(started))).toEqual([get(t, 'a').id, get(t, 'b').id]);
  });

  it("a later Standard task joins the goal's open batch", async () => {
    const t = goalOf({ a: { rigor: 'light' }, b: { rigor: 'standard' } });
    const [first] = start(get(t, 'a'));
    await h.jobs.idle();
    if (!first) throw new Error('no batch');
    const joined = start(get(t, 'b'));
    expect(joined.map((b) => b.id)).toEqual([first.id]);
    await h.jobs.idle();
    expect(listBatches(h.store.db)).toHaveLength(1);
    expect(members(first)).toEqual([get(t, 'a').id, get(t, 'b').id]);
  });

  it("a later Light task starts its own batch while the goal's batch is shipping, and is not refused", async () => {
    const t = goalOf({ a: { rigor: 'light' }, b: { rigor: 'light' } });
    const [first] = start(get(t, 'a'));
    await h.jobs.idle();
    if (!first) throw new Error('no batch');
    h.state.write((w) => transitionBatch(w, first.id, { to: 'SHIPPING' }));
    const [second] = start(get(t, 'b'));
    if (!second) throw new Error('no second batch');
    expect(second.id).not.toBe(first.id);
    await h.jobs.idle();
    expect(members(second)).toEqual([get(t, 'b').id]);
  });

  it('a goal join whose batch starts shipping before the join writes starts its own batch, with no card', async () => {
    const t = goalOf({ a: { rigor: 'light' }, b: { rigor: 'light' } });
    const [first] = start(get(t, 'a'));
    await h.jobs.idle();
    if (!first) throw new Error('no batch');
    const joined = start(get(t, 'b'));
    expect(joined.map((b) => b.id)).toEqual([first.id]);
    // The join's checks are still ahead when the batch moves on.
    h.state.write((w) => transitionBatch(w, first.id, { to: 'SHIPPING' }));
    await h.jobs.idle();
    expect(listBatches(h.store.db)).toHaveLength(2);
    expect(members(first)).toEqual([get(t, 'a').id]);
    const second = listBatches(h.store.db).find((b) => b.id !== first.id);
    expect(second && members(second)).toEqual([get(t, 'b').id]);
    expect(h.cards()).toEqual([]);
  });

  it('a goal join refused for unfinished dependencies leaves a card that names no batch', async () => {
    const t = goalOf({
      a: { rigor: 'light' },
      blocker: { rigor: 'careful' },
      c: { rigor: 'light', dependsOn: ['blocker'] },
    });
    start(get(t, 'a'));
    await h.jobs.idle();
    expect(() => start(get(t, 'c'))).toThrow(/unfinished|isn't finished|not finished/i);
    const card = h.only(h.cards());
    expect(card.detail?.[START_REFUSED_DETAIL]).not.toHaveProperty('batchId');
  });

  it('a Careful task of the goal is alone', async () => {
    const t = goalOf({ a: { rigor: 'light' }, b: { rigor: 'careful' }, c: { rigor: 'light' } });
    const started = start(get(t, 'a'), get(t, 'b'), get(t, 'c'));
    await h.jobs.idle();
    expect(started.map(members)).toEqual([[get(t, 'a').id, get(t, 'c').id], [get(t, 'b').id]]);
  });

  it("a later Careful task does not join the goal's open batch", async () => {
    const t = goalOf({ a: { rigor: 'light' }, b: { rigor: 'careful' } });
    const [first] = start(get(t, 'a'));
    await h.jobs.idle();
    const [second] = start(get(t, 'b'));
    expect(second?.id).not.toBe(first?.id);
    await h.jobs.idle();
    expect(listBatches(h.store.db)).toHaveLength(2);
  });

  it('a dependency-kind Standard task is alone', async () => {
    if (!listKinds(h.store.db).some((k) => k.key === 'dependency'))
      h.state.write((w) =>
        insertKind(w, {
          key: 'dependency',
          label: 'Dependency',
          description: 'deps',
          ownCopy: true,
        }),
      );
    const t = goalOf({
      a: { rigor: 'standard' },
      b: { rigor: 'standard', kinds: ['dependency'] },
    });
    const started = start(get(t, 'a'), get(t, 'b'));
    await h.jobs.idle();
    expect(started.map(members)).toEqual([[get(t, 'a').id], [get(t, 'b').id]]);
  });

  it('a Careful task that depends on a goal task joins it through the dependency, as before', async () => {
    const t = goalOf({ a: { rigor: 'light' }, b: { rigor: 'careful', dependsOn: ['a'] } });
    const started = start(get(t, 'a'), get(t, 'b'));
    expect(started).toHaveLength(1);
    await h.jobs.idle();
    expect(members(h.only(started))).toEqual([get(t, 'a').id, get(t, 'b').id]);
  });

  it('two Light tasks that land differently start apart and are not refused', async () => {
    const t = goalOf({ a: { rigor: 'light' }, b: { rigor: 'light', landing: { kind: 'hold' } } });
    const started = start(get(t, 'a'), get(t, 'b'));
    await h.jobs.idle();
    expect(started.map(members)).toEqual([[get(t, 'a').id], [get(t, 'b').id]]);
  });

  it("a later goal task that lands differently from the goal's open batch starts its own", async () => {
    const t = goalOf({ a: { rigor: 'light' }, b: { rigor: 'light', landing: { kind: 'hold' } } });
    const [first] = start(get(t, 'a'));
    await h.jobs.idle();
    const [second] = start(get(t, 'b'));
    expect(second?.id).not.toBe(first?.id);
    await h.jobs.idle();
    expect(listBatches(h.store.db)).toHaveLength(2);
  });

  it('tasks with no goal start apart, as before', async () => {
    const a = h.addTask('Alpha');
    const b = h.addTask('Beta');
    const started = start(a, b);
    await h.jobs.idle();
    expect(started.map(members)).toEqual([[a.id], [b.id]]);
  });
});

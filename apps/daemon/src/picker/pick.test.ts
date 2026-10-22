import { mintId, type TaskId } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import { pickCandidates, type PickerTask } from './pick';

type Spec = Partial<PickerTask> & { readonly title: string };
function tasks(...specs: Spec[]): PickerTask[] {
  return specs.map((s, i) => ({
    id: mintId('Task'),
    areas: ['a'],
    dependsOn: [],
    status: 'open',
    boardStatus: 'ready',
    boardOrder: i + 1,
    workstreamId: null,
    boardColumnId: null,
    ...s,
  }));
}

interface RunOptions {
  readonly held?: readonly [string, string][];
  readonly hazards?: readonly string[];
  readonly ruledOut?: readonly [string, string][];
  readonly size?: number;
}

function run(list: PickerTask[], opts: RunOptions = {}) {
  const byTitle = new Map(list.map((t) => [t.title, t.id]));
  const title = new Map(list.map((t) => [t.id, t.title]));
  const ruledOut = new Map<TaskId, string>();
  for (const [t, why] of opts.ruledOut ?? []) {
    const id = byTitle.get(t);
    if (id) ruledOut.set(id, why);
  }
  return pickCandidates({
    tasks: list,
    held: new Map(opts.held ?? []),
    hazards: new Set(opts.hazards ?? []),
    ruledOut,
    size: opts.size ?? 16,
  }).map((p) => ({
    title: title.get(p.taskId),
    proposed: p.proposed,
    resumed: p.resumed,
    unblocks: p.unblocks,
    conflict: p.conflict,
  }));
}

describe('pickCandidates', () => {
  it('proposes Ready tasks in board order when nothing else differs', () => {
    const list = tasks({ title: 'x', areas: ['a'] }, { title: 'y', areas: ['b'] });
    expect(run(list).map((p) => [p.title, p.proposed])).toEqual([
      ['x', true],
      ['y', true],
    ]);
  });

  it('puts a task whose earlier workstream ended first', () => {
    const list = tasks(
      { title: 'x', areas: ['a'] },
      { title: 'y', areas: ['b'], workstreamId: mintId('Workstream') },
    );
    expect(run(list).map((p) => [p.title, p.resumed])).toEqual([
      ['y', true],
      ['x', false],
    ]);
  });

  it('orders by the longest chain of open work each task unblocks, counting open dependents only', () => {
    const [leaf, root, side] = tasks(
      { title: 'leaf', areas: ['a'] },
      { title: 'root', areas: ['b'] },
      { title: 'side', areas: ['c'] },
    );
    if (!leaf || !root || !side) throw new Error('fixture');
    const [mid] = tasks({ title: 'mid', boardStatus: 'backlog', dependsOn: [root.id] });
    if (!mid) throw new Error('fixture');
    const [top] = tasks({ title: 'top', boardStatus: 'backlog', dependsOn: [mid.id] });
    const [finished] = tasks({
      title: 'finished',
      status: 'done',
      boardStatus: 'done',
      dependsOn: [side.id],
    });
    if (!top || !finished) throw new Error('fixture');
    expect(run([leaf, root, side, mid, top, finished]).map((p) => [p.title, p.unblocks])).toEqual([
      ['root', 2],
      ['leaf', 0],
      ['side', 0],
    ]);
  });

  it.each([
    {
      name: 'an area held by active work',
      areas: ['api'],
      opts: { held: [['api', 'Base']] } satisfies RunOptions,
      conflict: 'Area api is held by Base, which is already running or queued',
    },
    {
      name: 'a hazard held by active work, named as a hazard',
      areas: ['deps'],
      opts: { held: [['deps', 'Bump']], hazards: ['deps'] } satisfies RunOptions,
      conflict: 'Hazard deps is held by Bump, which is already running or queued',
    },
    {
      name: 'a plan that cannot start',
      areas: ['api'],
      opts: { ruledOut: [['x', 'Over the budget ceiling: step 2 (review)']] } satisfies RunOptions,
      conflict: 'Over the budget ceiling: step 2 (review)',
    },
  ])('leaves out a task for $name', ({ areas, opts, conflict }) => {
    expect(run(tasks({ title: 'x', areas }), opts)).toEqual([
      { title: 'x', proposed: false, resumed: false, unblocks: 0, conflict },
    ]);
  });

  it('leaves out a task that shares an area with one picked before it', () => {
    const list = tasks(
      { title: 'first', areas: ['api'] },
      { title: 'second', areas: ['api', 'ui'] },
    );
    expect(run(list).map((p) => [p.title, p.proposed, p.conflict])).toEqual([
      ['first', true, null],
      ['second', false, 'Area api is shared with first, picked before it'],
    ]);
  });

  it('proposes at most size tasks and leaves the rest unticked without a conflict', () => {
    const list = tasks(
      { title: 'x', areas: ['a'] },
      { title: 'y', areas: ['b'] },
      { title: 'z', areas: ['c'] },
    );
    expect(run(list, { size: 2 }).map((p) => [p.title, p.proposed, p.conflict])).toEqual([
      ['x', true, null],
      ['y', true, null],
      ['z', false, null],
    ]);
  });

  it('lets a left-out task claim nothing', () => {
    const list = tasks({ title: 'blocked', areas: ['api'] }, { title: 'next', areas: ['api'] });
    expect(
      run(list, { ruledOut: [['blocked', 'No plan']] }).map((p) => [p.title, p.proposed]),
    ).toEqual([
      ['blocked', false],
      ['next', true],
    ]);
  });

  it('offers only Ready tasks', () => {
    const list = tasks(
      { title: 'ready' },
      { title: 'backlog', boardStatus: 'backlog' },
      { title: 'running', boardStatus: 'in_progress' },
      { title: 'blocked', boardStatus: 'blocked' },
      { title: 'done', boardStatus: 'done', status: 'done' },
    );
    expect(run(list).map((p) => p.title)).toEqual(['ready']);
  });

  it('never offers a task parked in a human column', () => {
    const list = tasks(
      { title: 'planned' },
      { title: 'parked', boardColumnId: mintId('BoardColumn') },
    );
    expect(run(list).map((p) => p.title)).toEqual(['planned']);
  });

  it('answers an empty list when nothing is Ready', () => {
    expect(run(tasks({ title: 'b', boardStatus: 'backlog' }))).toEqual([]);
  });
});

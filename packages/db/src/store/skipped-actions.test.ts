import {
  ConflictError,
  EventType,
  TaskStatus,
  type ProjectId,
  type SkipKind,
  type TaskId,
  type WorkstreamId,
} from '@10db/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  approvedCallKeys,
  approvedSkipsForTask,
  approveSkips,
  listSkipsForWorkstream,
  recordSkip,
  type SkipInput,
} from './skipped-actions';
import type { Store } from './store';
import { insertTask, setTaskStatus } from './tasks';
import { createTestStore, seedProject } from './test-support';
import { insertWorkstream } from './workstreams';

// T4 Task 2: a skip is recorded once per call in a run, without breaking the write it is made in,
// and the builder's approvals hold for the follow-up only until it is done.

let store: Store;
let close: () => void;
beforeEach(() => ({ store, close } = createTestStore()));
afterEach(() => {
  close();
});

function taskOf(projectId: ProjectId, title = 'Alpha'): TaskId {
  return store.write((ctx) =>
    insertTask(ctx, projectId, {
      title,
      description: '',
      acceptanceCriteria: ['x'],
      areas: ['api'],
    }),
  ).value.id;
}

function runOf(taskId: TaskId): WorkstreamId {
  return store.write((ctx) =>
    insertWorkstream(ctx, taskId, { first: { model: 'claude-sonnet-5-5', effort: 'medium' } }),
  ).value.id;
}

const skip = (workstreamId: WorkstreamId, over: Partial<SkipInput> = {}): SkipInput => ({
  workstreamId,
  sessionId: null,
  toolName: 'Bash',
  toolUseId: 'tu_1',
  callKey: 'key-1',
  summary: 'vercel deploy --prod',
  kind: 'deploy',
  limit: 'writes_live',
  reason: 'a deploy',
  source: 'guard',
  ...over,
});

describe('skipped_actions', () => {
  it('records a skip and lists it with its run', () => {
    const project = seedProject(store);
    const ws = runOf(taskOf(project.id));
    const id = store.write((ctx) => recordSkip(ctx, skip(ws))).value;
    expect(id).not.toBeNull();
    expect(listSkipsForWorkstream(store.db, ws)).toMatchObject([
      {
        id,
        workstreamId: ws,
        toolName: 'Bash',
        summary: 'vercel deploy --prod',
        kind: 'deploy',
        limit: 'writes_live',
        reason: 'a deploy',
        source: 'guard',
        approval: 'exact',
      },
    ]);
  });

  it('a second skip of the same tool use id in a run is not a second row and does not throw inside the caller’s write', () => {
    const project = seedProject(store);
    const task = taskOf(project.id);
    const ws = runOf(task);
    const { value } = store.write((ctx) => {
      recordSkip(ctx, skip(ws));
      const again = recordSkip(ctx, skip(ws, { source: 'auto_mode', kind: 'classifier' }));
      setTaskStatus(ctx, task, TaskStatus.Open);
      return again;
    });
    expect(value).toBeNull();
    expect(listSkipsForWorkstream(store.db, ws)).toHaveLength(1);
  });

  it('the same tool use id in another run is its own row', () => {
    const project = seedProject(store);
    const [a, b] = [runOf(taskOf(project.id)), runOf(taskOf(project.id, 'Beta'))];
    store.write((ctx) => {
      recordSkip(ctx, skip(a));
      recordSkip(ctx, skip(b));
    });
    expect(listSkipsForWorkstream(store.db, a)).toHaveLength(1);
    expect(listSkipsForWorkstream(store.db, b)).toHaveLength(1);
  });

  it('skips with no tool use id are each kept', () => {
    const project = seedProject(store);
    const ws = runOf(taskOf(project.id));
    store.write((ctx) => {
      recordSkip(ctx, skip(ws, { toolUseId: null }));
      recordSkip(ctx, skip(ws, { toolUseId: null }));
    });
    expect(listSkipsForWorkstream(store.db, ws)).toHaveLength(2);
  });

  it('a written skip appends task.changed and an ignored one appends nothing', () => {
    const project = seedProject(store);
    const task = taskOf(project.id);
    const ws = runOf(task);
    const first = store.write((ctx) => recordSkip(ctx, skip(ws))).events;
    expect(first.map((e) => [e.type, e.entityId])).toEqual([[EventType.TaskChanged, task]]);
    expect(store.write((ctx) => recordSkip(ctx, skip(ws))).events).toEqual([]);
  });

  it('listing after an id answers only later skips', () => {
    const project = seedProject(store);
    const ws = runOf(taskOf(project.id));
    const ids = store.write((ctx) =>
      ['a', 'b', 'c'].map((t) => recordSkip(ctx, skip(ws, { toolUseId: t }))),
    ).value;
    const first = ids[0];
    if (first === null || first === undefined) throw new Error('no first skip');
    expect(listSkipsForWorkstream(store.db, ws, first).map((s) => s.id)).toEqual(ids.slice(1));
  });
});

describe('one call reported twice', () => {
  it.each<[string, Partial<SkipInput>, Partial<SkipInput>]>([
    ['as approvable, then as not', { kind: 'deploy' }, { kind: 'docker_off', source: 'broker' }],
    ['as not approvable, then as approvable', { kind: 'docker_off' }, { kind: 'deploy' }],
    [
      'uncut, then with its summary cut',
      { kind: 'classifier', source: 'auto_mode' },
      { kind: 'classifier', source: 'auto_mode', summaryCut: true },
    ],
  ])('keeps the stricter record: %s', (_name, first, second) => {
    const project = seedProject(store);
    const ws = runOf(taskOf(project.id));
    const ids = store.write((ctx) => [
      recordSkip(ctx, skip(ws, first)),
      recordSkip(ctx, skip(ws, second)),
    ]).value;
    const id = ids[0];
    if (id === null || id === undefined) throw new Error('no skip');
    expect(listSkipsForWorkstream(store.db, ws).map((s) => s.approval)).toEqual(['none']);
    const followUp = taskOf(project.id, 'Follow-up');
    expect(() =>
      store.write((ctx) => {
        approveSkips(ctx, followUp, [id]);
      }),
    ).toThrow(ConflictError);
  });
});

describe('skip_approvals', () => {
  it('lists the approved rows for the follow-up only, and none once it is done', () => {
    const project = seedProject(store);
    const ws = runOf(taskOf(project.id));
    const [a, b] = store.write((ctx) => [
      recordSkip(ctx, skip(ws, { toolUseId: 'a', callKey: 'ka' })),
      recordSkip(ctx, skip(ws, { toolUseId: 'b', callKey: 'kb' })),
    ]).value;
    if (a === null || b === null || a === undefined || b === undefined) throw new Error('no skips');
    const followUp = taskOf(project.id, 'Follow-up');
    const other = taskOf(project.id, 'Other');
    store.write((ctx) => {
      approveSkips(ctx, followUp, [a]);
    });
    expect(approvedSkipsForTask(store.db, followUp).map((s) => s.id)).toEqual([a]);
    expect(approvedCallKeys(store.db, followUp)).toEqual(['ka']);
    expect(approvedSkipsForTask(store.db, other)).toEqual([]);
    store.write((ctx) => {
      setTaskStatus(ctx, followUp, TaskStatus.Done);
    });
    expect(approvedSkipsForTask(store.db, followUp)).toEqual([]);
    expect(approvedCallKeys(store.db, followUp)).toEqual([]);
  });

  it.each<[string, SkipKind | null]>([
    ['a skip of another project', null],
    ['one that is not approvable', 'docker_off'],
  ])('approving %s is refused and writes nothing', (_name, kind) => {
    const project = seedProject(store);
    const elsewhere = seedProject(store, { name: 'elsewhere' });
    const ws = runOf(taskOf(kind === null ? elsewhere.id : project.id));
    const okWs = runOf(taskOf(project.id, 'Beta'));
    const [bad, good] = store.write((ctx) => [
      recordSkip(ctx, skip(ws, kind === null ? {} : { kind })),
      recordSkip(ctx, skip(okWs)),
    ]).value;
    if (bad === null || good === null || bad === undefined || good === undefined)
      throw new Error('no skips');
    const followUp = taskOf(project.id, 'Follow-up');
    expect(() =>
      store.write((ctx) => {
        approveSkips(ctx, followUp, [good, bad]);
      }),
    ).toThrow(ConflictError);
    expect(approvedSkipsForTask(store.db, followUp)).toEqual([]);
  });
});

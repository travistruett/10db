import {
  PlanDraft,
  Effort,
  Provider,
  SessionMode,
  TaskStatus,
  WorkstreamState,
  type TaskId,
} from '@10db/contracts';
import {
  insertSession,
  insertTask,
  insertWorkstream,
  listShapeProposals,
  schema,
  setTaskStatus,
  transitionWorkstream,
  type WriteContext,
} from '@10db/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { must, seedConversation, type ConversationFixture } from './conversation-fixture';
import { convertProposals } from './convert';
import { buildPreview } from './preview';
import { dropProposal, reconcileDraft } from './rounds';

// Shape spec §10.2 and §15: two tasks clashing on an area, work already queued holding a lane, and
// unsized running work.

let c: ConversationFixture;
beforeEach(() => {
  c = seedConversation();
});
afterEach(() => {
  c.close();
});

const write = <T>(fn: (ctx: WriteContext) => T): T => c.store.write(fn).value;
const HOUR_MS = 3_600_000;

/** A finished task of the project that took `laneMinutes` in a lane, and `wallMinutes` start to end. */
function finishedTask(laneMinutes: number, wallMinutes = laneMinutes): void {
  const workstreamId = write((ctx) => {
    const task = insertTask(ctx, c.project.id, {
      title: 'Earlier',
      acceptanceCriteria: ['x'],
      areas: ['api'],
    });
    const ws = insertWorkstream(ctx, task.id);
    ctx.tx
      .insert(schema.taskLaneTimes)
      .values({
        workstreamId: ws.id,
        taskId: task.id,
        laneMinutes,
        sessionsOnly: false,
        createdAt: ctx.now,
      })
      .run();
    setTaskStatus(ctx, task.id, TaskStatus.Done);
    return ws.id;
  });
  // The run's span: its creation and last change, as the preview reads wall time.
  const created = new Date('2026-01-01T00:00:00.000Z');
  c.store.db.$client
    .prepare('update workstreams set created_at = ?, updated_at = ? where id = ?')
    .run(
      created.toISOString(),
      new Date(created.getTime() + wallMinutes * 60_000).toISOString(),
      workstreamId,
    );
}

/** An open task of the project with a workstream: queued, or running with a session. */
function activeTask(title: string, areas: string[], state: 'queued' | 'running'): TaskId {
  return write((ctx) => {
    const task = insertTask(ctx, c.project.id, { title, acceptanceCriteria: ['x'], areas });
    const ws = insertWorkstream(ctx, task.id);
    if (state === 'running') {
      transitionWorkstream(ctx, ws.id, { to: WorkstreamState.Starting, fence: null });
      transitionWorkstream(ctx, ws.id, { to: WorkstreamState.Running, fence: null });
      insertSession(ctx, {
        workstreamId: ws.id,
        provider: Provider.Claude,
        model: 'sonnet',
        effort: Effort.Medium,
        mode: SessionMode.Managed,
        mcpTokenHash: 'hash',
      });
    }
    return task.id;
  });
}

const loose = (key: string, rest: Record<string, unknown> = {}) => ({
  key,
  title: `Task ${key}`,
  criteria: ['It works'],
  areas: ['ui'],
  size: 'M',
  ceremony: 'direct',
  ...rest,
});

function propose(...tasks: Record<string, unknown>[]): void {
  const m = c.say();
  const out = write((ctx) =>
    reconcileDraft(
      ctx,
      c.shape.id,
      PlanDraft.parse({ looseTasks: tasks.map((t) => ({ ...t, sourceMessageIds: [m] })) }),
    ),
  );
  if (!out.ok) throw new Error(out.errors.join('; '));
}

const previewAt = (offsetHours = 0) =>
  buildPreview(c.store.db, c.shape.id, new Date(Date.now() + offsetHours * HOUR_MS));

const startOf = (preview: ReturnType<typeof previewAt>, key: string): number =>
  must(
    preview.lanes.flatMap((l) => l.items).find((i) => i.key === key),
    `bar ${key}`,
  ).startHours;

describe('the factory preview', () => {
  it('is empty before anything is proposed', () => {
    expect(previewAt()).toMatchObject({
      tasks: 0,
      totalLaneHours: 0,
      scheduleHours: 0,
      clashes: [],
      criticalPath: [],
    });
    expect(previewAt().lanes).toHaveLength(2);
  });

  it("runs two tasks that claim one area one after the other and says so, in the project's lanes", () => {
    propose(
      loose('density', { areas: ['ui'], size: 'M' }),
      loose('scroll', { areas: ['ui'], size: 'S' }),
    );
    const preview = previewAt();
    expect(preview.tasks).toBe(2);
    expect(preview.totalLaneHours).toBe(2.5);
    expect(preview.scheduleHours).toBe(2.5);
    expect(preview.clashes).toEqual([
      {
        area: 'ui',
        titles: ['Task density', 'Task scroll'],
        text: "Task density and Task scroll both claim ui: they'll run one after the other",
      },
    ]);
    expect(preview.criticalPath).toEqual(['density', 'scroll']);
  });

  it('runs tasks of different areas side by side', () => {
    propose(loose('a', { areas: ['api'] }), loose('b', { areas: ['ui'] }));
    const preview = previewAt();
    expect(preview.scheduleHours).toBe(2);
    expect(preview.clashes).toEqual([]);
  });

  it('lets work already queued in the project hold the lanes first', () => {
    // Two lanes, two queued tasks of 2 hours each (the median of what finished): the draft waits.
    finishedTask(120);
    activeTask('Queued one', ['api'], 'queued');
    activeTask('Queued two', ['ui'], 'queued');
    propose(loose('new', { areas: ['api'], size: 'S' }));
    const preview = previewAt();
    expect(startOf(preview, 'new')).toBe(2);
    expect(preview.lanes.flatMap((l) => l.items).filter((i) => i.existing)).toHaveLength(2);
  });

  it("counts running work that was never sized as the project's median lane time less its lane time so far", () => {
    finishedTask(120);
    activeTask('Hand filed', ['api'], 'running');
    propose(loose('new', { areas: ['api'], size: 'S' }));
    // An hour in, of a 2 hour median: one hour left, and the draft shares its area.
    const preview = previewAt(1);
    expect(startOf(preview, 'new')).toBeCloseTo(1, 1);
  });

  it('floors the remaining hours of running work at zero', () => {
    finishedTask(60);
    activeTask('Hand filed', ['api'], 'running');
    propose(loose('new', { areas: ['api'], size: 'S' }));
    expect(startOf(previewAt(5), 'new')).toBe(0);
  });

  it('counts running work a conversation sized as its derived hours less its lane time so far', () => {
    propose(loose('old', { areas: ['api'], size: 'L' }));
    const converted = write((ctx) =>
      convertProposals(
        ctx,
        c.shape.id,
        listShapeProposals(ctx.tx, c.shape.id).map((r) => r.id),
      ),
    );
    const [taskId] = must(converted.ok ? converted : null, 'converted').results.flatMap(
      (r) => r.taskIds,
    );
    write((ctx) => {
      const ws = insertWorkstream(ctx, must(taskId, 'task'));
      transitionWorkstream(ctx, ws.id, { to: WorkstreamState.Starting, fence: null });
      transitionWorkstream(ctx, ws.id, { to: WorkstreamState.Running, fence: null });
      insertSession(ctx, {
        workstreamId: ws.id,
        provider: Provider.Claude,
        model: 'sonnet',
        effort: Effort.Medium,
        mode: SessionMode.Managed,
        mcpTokenHash: 'hash',
      });
    });
    propose(loose('new', { areas: ['api'], size: 'S' }));
    // L is 5.5 hours; an hour in, 4.5 are left.
    expect(startOf(previewAt(1), 'new')).toBeCloseTo(4.5, 1);
  });

  it('adds the median non-lane time of each task on the critical path, marked as an estimate', () => {
    // Each finished task took 2 hours in a lane and 3 from start to end: an hour outside it.
    finishedTask(120, 180);
    finishedTask(120, 180);
    propose(loose('a', { areas: ['ui'], size: 'M' }), loose('b', { areas: ['ui'], size: 'S' }));
    const preview = previewAt();
    expect(preview.nonLaneHoursPerTask).toBeCloseTo(1, 5);
    expect(preview.scheduleHours).toBe(2.5);
    expect(preview.endEstimateHours).toBeCloseTo(4.5, 5);
  });

  it('has no estimate to add before any task has finished', () => {
    propose(loose('a'));
    const preview = previewAt();
    expect(preview.nonLaneHoursPerTask).toBeNull();
    expect(preview.endEstimateHours).toBe(preview.scheduleHours);
  });

  it('leaves out rows the builder dropped and tasks already converted, and never writes', () => {
    propose(loose('keep'), loose('gone'));
    write((ctx) => {
      dropProposal(
        ctx,
        must(
          listShapeProposals(ctx.tx, c.shape.id).find((r) => r.key === 'gone'),
          'row',
        ).id,
      );
    });
    const events = () => c.store.db.$client.prepare('select count(*) as n from events').get();
    const before = events();
    expect(previewAt().tasks).toBe(1);
    expect(events()).toEqual(before);
  });
});

describe('the pull requests and CI runs a preview counts (§10.4)', () => {
  function proposeLandings(
    tasks: Record<string, unknown>[],
    landings: { key: string; keys: string[] }[],
    goalTasks: { key: string; depends_on?: string[] }[] = [],
  ): void {
    const m = c.say();
    const out = write((ctx) =>
      reconcileDraft(
        ctx,
        c.shape.id,
        PlanDraft.parse({
          goals:
            goalTasks.length === 0
              ? []
              : [
                  {
                    key: 'g',
                    title: 'Goal',
                    objective: 'Do it.',
                    ceremony: 'direct',
                    sourceMessageIds: [m],
                    tasks: goalTasks.map((t) => ({
                      title: `Task ${t.key}`,
                      areas: ['ui'],
                      size: 'S',
                      ...t,
                    })),
                  },
                ],
          looseTasks: tasks.map((t) => ({ ...t, sourceMessageIds: [m] })),
          landings: landings.map((l) => ({
            ...l,
            title: `Landing ${l.key}`,
            sourceMessageIds: [m],
          })),
        }),
      ),
    );
    if (!out.ok) throw new Error(out.errors.join('; '));
  }

  it('counts one pull request and one CI run per task when nothing lands together', () => {
    proposeLandings([loose('a'), loose('b'), loose('c')], []);
    expect(previewAt().landings).toEqual({
      pullRequests: 3,
      pullRequestsAlone: 3,
      ciRuns: 3,
      ciRunsAlone: 3,
    });
  });

  it('counts a goal in one landing as one pull request, against one each', () => {
    proposeLandings(
      [loose('solo')],
      [{ key: 'l1', keys: ['r1', 'r2', 'r3'] }],
      [{ key: 'r1' }, { key: 'r2' }, { key: 'r3' }],
    );
    expect(previewAt().landings).toEqual({
      pullRequests: 2,
      pullRequestsAlone: 4,
      ciRuns: 2,
      ciRunsAlone: 4,
    });
  });

  it('counts tasks that wait on each other as one pull request even with no landing', () => {
    proposeLandings([], [], [{ key: 'r1' }, { key: 'r2', depends_on: ['r1'] }]);
    expect(previewAt().landings).toMatchObject({ pullRequests: 1, pullRequestsAlone: 1 });
  });

  it('joins a landing and a chain that share a task into one pull request', () => {
    proposeLandings(
      [loose('a'), loose('b', { dependsOn: ['a'] }), loose('c')],
      [{ key: 'l1', keys: ['b', 'c'] }],
    );
    expect(previewAt().landings).toMatchObject({ pullRequests: 1, pullRequestsAlone: 2 });
  });

  it('ignores a landing key that names a task already converted', () => {
    proposeLandings([loose('a'), loose('b')], []);
    write((ctx) =>
      convertProposals(ctx, c.shape.id, [
        must(
          listShapeProposals(ctx.tx, c.shape.id).find((r) => r.key === 'a'),
          'row',
        ).id,
      ]),
    );
    proposeLandings([loose('b'), loose('d')], [{ key: 'l1', keys: ['a', 'b', 'd'] }]);
    expect(previewAt().landings).toMatchObject({ pullRequests: 1, pullRequestsAlone: 2 });
  });
});

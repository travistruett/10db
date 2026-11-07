import { PlanDraft, TaskStatus, type TaskId } from '@10db/contracts';
import {
  insertTask,
  insertWorkstream,
  listShapeProposals,
  schema,
  setTaskStatus,
  type WriteContext,
} from '@10db/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { must, seedConversation, type ConversationFixture } from './conversation-fixture';
import { convertProposals } from './convert';
import { editProposal, reconcileDraft } from './rounds';
import { buildSizes, sizingMeasure } from './sizing';

// Shape spec §8: one source per field. Claude writes a basis (or a bucket when there is none); the
// daemon derives hours and the bucket, shows a finished converted task's actual, and measures how
// often the derived size was within one bucket of it.

let c: ConversationFixture;
beforeEach(() => {
  c = seedConversation();
});
afterEach(() => {
  c.close();
});

const write = <T>(fn: (ctx: WriteContext) => T): T => c.store.write(fn).value;

/** Marks a task finished with this many lane minutes, as a finished workstream leaves it. */
function finish(taskId: TaskId, minutes: number): void {
  write((ctx) => {
    const ws = insertWorkstream(ctx, taskId, {
      first: { model: 'claude-sonnet-5-5', effort: 'medium' },
    });
    ctx.tx
      .insert(schema.taskLaneTimes)
      .values({
        workstreamId: ws.id,
        taskId,
        laneMinutes: minutes,
        sessionsOnly: false,
        createdAt: ctx.now,
      })
      .run();
    setTaskStatus(ctx, taskId, TaskStatus.Done);
  });
}

/** A finished task of the project, outside any conversation, taking `minutes` of lane time. */
function finishedTask(minutes: number): TaskId {
  const task = write((ctx) =>
    insertTask(ctx, c.project.id, { title: 'Earlier', acceptanceCriteria: ['x'], areas: ['api'] }),
  );
  finish(task.id, minutes);
  return task.id;
}

const loose = (key: string, sizing: Record<string, unknown>) => ({
  key,
  title: `Task ${key}`,
  criteria: ['It works'],
  areas: ['api'],
  ceremony: 'direct',
  ...sizing,
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

const rowOf = (key: string) =>
  must(
    listShapeProposals(c.store.db, c.shape.id).find((r) => r.key === key),
    `row ${key}`,
  );

function convert(...keys: string[]): TaskId[] {
  const out = write((ctx) =>
    convertProposals(
      ctx,
      c.shape.id,
      keys.map((k) => rowOf(k).id),
    ),
  );
  if (!out.ok) throw new Error(out.errors.join('; '));
  return out.results.flatMap((r) => r.taskIds);
}

const sizeOf = (key: string) =>
  must(
    buildSizes(c.store.db, c.shape.id).find((s) => s.key === key),
    `size ${key}`,
  );

describe('derived sizes', () => {
  it("takes hours from the basis tasks' median lane time, and the bucket from the hours", () => {
    const basis = [finishedTask(60), finishedTask(150), finishedTask(400)];
    propose(loose('a', { basis }));
    expect(sizeOf('a')).toMatchObject({ size: 'M', hours: 2.5, from: 'basis', taskId: null });
  });

  it.each([
    ['its midpoint while the bucket holds fewer than 10 finished tasks', 9, 5.5],
    ["the bucket's median once it holds 10", 10, 4],
  ])('sizes a task with no basis at %s', (_name, finished, hours) => {
    for (let i = 0; i < finished; i += 1) finishedTask(4 * 60);
    propose(loose('a', { size: 'L' }));
    expect(sizeOf('a')).toMatchObject({ size: 'L', hours, from: 'size' });
  });

  it("lets the builder's pinned bucket win, at that bucket's hours", () => {
    propose(loose('a', { size: 'S' }));
    write((ctx) => {
      editProposal(ctx, rowOf('a').id, { size: 'L' });
    });
    expect(sizeOf('a')).toMatchObject({ size: 'L', hours: 5.5, from: 'pinned' });
  });
});

describe('calibration', () => {
  it.each([
    ['inside its bucket', 100, false],
    ['one bucket away', 5 * 60, false],
    ['more than one bucket away', 10 * 60, true],
  ])('shows a finished converted task its actual, %s', (_name, minutes, missized) => {
    propose(loose('a', { size: 'M' }));
    const [taskId] = convert('a');
    expect(sizeOf('a')).toMatchObject({ taskId, actualHours: null, missized: false });
    finish(must(taskId, 'task'), minutes);
    expect(sizeOf('a')).toMatchObject({ actualHours: minutes / 60, missized });
  });

  it('measures the share within one bucket, by bucket, with overrides beside it', () => {
    propose(
      loose('hit', { size: 'M' }),
      loose('miss', { size: 'S' }),
      loose('pinned', { size: 'S' }),
      loose('unfinished', { size: 'M' }),
    );
    write((ctx) => {
      editProposal(ctx, rowOf('pinned').id, { size: 'L' });
    });
    const [hit, miss, pinned] = convert('hit', 'miss', 'pinned', 'unfinished');
    finish(must(hit, 'hit'), 4 * 60);
    finish(must(miss, 'miss'), 6 * 60);
    finish(must(pinned, 'pinned'), 30);
    expect(sizingMeasure(c.store.db)).toEqual({
      n: 2,
      within: 1,
      buckets: {
        S: { n: 1, within: 0 },
        M: { n: 1, within: 1 },
        L: { n: 0, within: 0 },
        XL: { n: 0, within: 0 },
      },
      overrides: 1,
    });
  });
});

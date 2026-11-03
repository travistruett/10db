import {
  mintId,
  NotFoundError,
  PlanDraft,
  ShapeMessageAuthor,
  ShapeMessageKind,
  ShapeProposalState,
  ShapeState,
  ShapeToolInputs,
  type ShapeMessageId,
  type TaskId,
} from '@10db/contracts';
import {
  getShape,
  insertShapeMessage,
  insertTask,
  insertWorkstream,
  listShapeMessages,
  listShapeProposals,
  listTasks,
  patchShape,
  type WriteContext,
} from '@10db/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { must } from './conversation-fixture';
import { convertProposals } from './convert';
import { buildDigest } from './digest';
import { reconcileDraft } from './rounds';
import { createServiceFixture, type ServiceFixture } from './service-fixture';

// Shape spec §12: Open conversation reopens a conversation with an event injected as a note. The
// reopened session sees each converted row with its current state, read-only, and re-planning
// proposes additions, changes and removals for unstarted tasks only.

let f: ServiceFixture;
beforeEach(() => {
  f = createServiceFixture();
});
afterEach(async () => {
  await f.close();
});

const shapeId = () => f.c.shape.id;
const write = <T>(fn: (ctx: WriteContext) => T): T => f.c.store.write(fn).value;

const loose = (m: ShapeMessageId, key: string) => ({
  key,
  title: `Task ${key}`,
  criteria: ['It works'],
  areas: ['api'],
  size: 'S',
  ceremony: 'direct',
  sourceMessageIds: [m],
});

function propose(draft: Record<string, unknown>): void {
  const out = write((ctx) => reconcileDraft(ctx, shapeId(), PlanDraft.parse(draft)));
  if (!out.ok) throw new Error(out.errors.join('; '));
}

/** Converts the loose tasks `keys`, returning the tasks they became in order. */
function convertTasks(...keys: string[]): TaskId[] {
  const m = f.c.say();
  propose({ looseTasks: keys.map((k) => loose(m, k)) });
  const out = write((ctx) =>
    convertProposals(
      ctx,
      shapeId(),
      listShapeProposals(ctx.tx, shapeId())
        .filter((r) => r.state === ShapeProposalState.Pending)
        .map((r) => r.id),
    ),
  );
  if (!out.ok) throw new Error(out.errors.join('; '));
  return out.results.flatMap((r) => r.taskIds);
}

const messages = () => listShapeMessages(f.c.store.db, shapeId());
const prompts = () => f.adapter.shapeSessions.map((s) => s.spec.prompt);

/** What a session's propose_plan call answers: the error text when refused, otherwise null. */
async function callPropose(draft: Record<string, unknown>): Promise<string | null> {
  write((ctx) => {
    patchShape(ctx, shapeId(), { proposeUnlocked: true });
  });
  const handler = must(
    f.service.toolsFor({ sessionId: mintId('Session'), shapeId: shapeId() }).propose_plan,
    'propose_plan',
  );
  try {
    await handler(ShapeToolInputs.propose_plan.parse({ draft: PlanDraft.parse(draft) }));
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

describe('resuming a conversation', () => {
  it('records the event as a note a proposal may cite, and starts no turn', async () => {
    convertTasks('a');
    const note = f.service.resume(shapeId(), 'Task a ran out of attempts.');
    expect(note).toMatchObject({
      author: ShapeMessageAuthor.Note,
      kind: ShapeMessageKind.Event,
      body: 'Task a ran out of attempts.',
    });
    expect(messages().some((m) => m.id === note.id)).toBe(true);
    await f.service.settled(shapeId());
    expect(prompts()).toEqual([]);
  });

  it('refuses a conversation that does not exist', () => {
    expect(() => f.service.resume('shape_missing' as never, 'x')).toThrow(NotFoundError);
  });

  it('tells the next turn the event under its id, and each converted row with its state', async () => {
    const [unstarted, started] = convertTasks('a', 'b').map((id) => must(id, 'task'));
    write((ctx) => insertWorkstream(ctx, must(started, 'started')));
    const note = f.service.resume(shapeId(), 'Task b is running late.');
    f.service.send(shapeId(), 'What should change?');
    await f.service.settled(shapeId());
    const prompt = must(prompts()[0], 'prompt');
    expect(prompt).toContain(`[m:${note.id}] Task b is running late.`);
    expect(prompt).toContain(`${unstarted ?? ''} "Task a" — not started`);
    expect(prompt).toMatch(new RegExp(`${started ?? ''} "Task b" — started \\(queued\\)`));
  });

  it('gives a fresh session the same state in its digest, the event citable', () => {
    convertTasks('a');
    write((ctx) =>
      insertShapeMessage(ctx, shapeId(), {
        author: ShapeMessageAuthor.Claude,
        kind: ShapeMessageKind.Text,
        body: 'Converted.',
      }),
    );
    const note = f.service.resume(shapeId(), 'Task a ran out of attempts.');
    const digest = buildDigest(f.c.store.db, shapeId());
    expect(digest).toContain(`[m:${note.id}] Task a ran out of attempts.`);
    expect(digest).toContain('"Task a" — not started');
  });
});

describe('re-planning a reopened conversation', () => {
  const cite = (): ShapeMessageId => f.service.resume(shapeId(), 'Reopened to re-plan.').id;

  it('proposes a change and a removal for tasks that have not started, and a new task', async () => {
    const made = convertTasks('a', 'b');
    const first = must(made[0], 'first task');
    const second = must(made[1], 'second task');
    const event = cite();
    expect(
      await callPropose({
        changes: [{ taskId: first, title: 'Renamed', sourceMessageIds: [event] }],
        removals: [{ taskId: second, why: 'Not needed', sourceMessageIds: [event] }],
        looseTasks: [loose(event, 'c')],
      }),
    ).toBeNull();
    const rows = listShapeProposals(f.c.store.db, shapeId());
    expect(
      rows
        .filter((r) => r.state === ShapeProposalState.Pending)
        .map((r) => r.key)
        .sort(),
    ).toEqual(['c', `change:${first}`, `remove:${second}`].sort());
  });

  it('moves a converted conversation back to Proposed once a round proposes something', async () => {
    const [first] = convertTasks('a').map((id) => must(id, 'task'));
    expect(getShape(f.c.store.db, shapeId()).state).toBe(ShapeState.Converted);
    const event = cite();
    await callPropose({
      changes: [{ taskId: first, title: 'Renamed', sourceMessageIds: [event] }],
    });
    expect(getShape(f.c.store.db, shapeId()).state).toBe(ShapeState.Proposed);
  });

  it.each([
    ['a change to a task that has started', 'change'],
    ['a removal of a task that has started', 'removal'],
  ])('refuses %s', async (_name, kind) => {
    const [first] = convertTasks('a').map((id) => must(id, 'task'));
    write((ctx) => insertWorkstream(ctx, must(first, 'task')));
    const event = cite();
    const answer = await callPropose(
      kind === 'change'
        ? { changes: [{ taskId: first, title: 'Renamed', sourceMessageIds: [event] }] }
        : { removals: [{ taskId: first, why: 'Gone', sourceMessageIds: [event] }] },
    );
    expect(answer).toMatch(/has started/);
    expect(listShapeProposals(f.c.store.db, shapeId()).filter((r) => r.kind !== 'task')).toEqual(
      [],
    );
  });

  it('refuses a task this conversation did not create', async () => {
    convertTasks('a');
    const handFiled = write((ctx) =>
      insertTask(ctx, f.c.project.id, {
        title: 'Hand filed',
        acceptanceCriteria: ['x'],
        areas: ['api'],
      }),
    ).id;
    const event = cite();
    const answer = await callPropose({
      changes: [{ taskId: handFiled, title: 'Renamed', sourceMessageIds: [event] }],
    });
    expect(answer).toMatch(/was not created by this conversation/);
    expect(listTasks(f.c.store.db, f.c.project.id).find((t) => t.id === handFiled)?.title).toBe(
      'Hand filed',
    );
  });
});
